import 'server-only';
import { APIError, betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { nextCookies } from 'better-auth/next-js';
import { admin, twoFactor, username } from 'better-auth/plugins';
import { passwordPolicyIssues, PASSWORD_MAX, PASSWORD_MIN } from '@/lib/password-policy';
import { prisma } from '@/server/db';
import { env } from '@/server/env';
import { recordAuditSafe } from '@/server/services/audit.service';
import { auditAuthEvent, type AuthHookCtx } from './audit-hooks';

/**
 * Pela rota HTTP pública (/api/auth/*) só passam os endpoints que a UI usa. Todo o resto
 * (admin/*, impersonate, update-user, sign-up...) fica acessível apenas por chamadas no servidor
 * (`auth.api.*` dentro das Server Actions), onde exigimos sessão fresca, motivo e auditoria.
 */
const HTTP_ALLOWED = new Set([
  '/ok',
  '/error',
  '/get-session',
  '/sign-in/username',
  '/sign-out',
  '/change-password',
  '/list-sessions',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/two-factor/enable',
  '/two-factor/disable',
  '/two-factor/get-totp-uri',
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
  '/two-factor/generate-backup-codes',
]);

const appOrigin = () => new URL(env.BETTER_AUTH_URL).origin;

function createAuth() {
  return betterAuth({
    appName: 'GitLab Wizard',
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [appOrigin(), ...env.BETTER_AUTH_TRUSTED_ORIGINS],
    database: prismaAdapter(prisma, { provider: 'postgresql' }),

    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: PASSWORD_MIN,
      maxPasswordLength: PASSWORD_MAX,
      revokeSessionsOnPasswordReset: true,
    },

    user: {
      additionalFields: {
        // input:false → o client não consegue alterar; só o servidor (changePassword hook, admin actions).
        mustChangePassword: { type: 'boolean', defaultValue: true, input: false },
      },
    },

    session: {
      expiresIn: env.SESSION_IDLE_MINUTES * 60, // inatividade: cada uso renova (updateAge)
      updateAge: Math.min(5 * 60, Math.floor((env.SESSION_IDLE_MINUTES * 60) / 2)),
      freshAge: env.FRESH_SESSION_MINUTES * 60,
      cookieCache: { enabled: true, maxAge: 60 },
    },

    rateLimit: {
      enabled: true,
      storage: 'database',
      customRules: {
        '/sign-in/username': { window: 60, max: env.AUTH_RATE_LIMIT_SIGNIN_MAX },
      },
    },

    advanced: {
      cookiePrefix: 'gw',
      // Explícito: o default do better-auth DESLIGA a checagem de origem quando NODE_ENV=test. Segurança não pode
      // depender do ambiente; assim os testes validam exatamente o comportamento de produção.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      useSecureCookies: appOrigin().startsWith('https://'),
      ipAddress: env.CLIENT_IP_HEADER ? { ipAddressHeaders: [env.CLIENT_IP_HEADER] } : {},
    },

    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // ctx.request só existe quando a chamada veio do handler HTTP (não de auth.api no servidor).
        if (ctx.request && !HTTP_ALLOWED.has(ctx.path)) throw new APIError('NOT_FOUND');

        if (ctx.path === '/change-password') {
          const pw = String((ctx.body as { newPassword?: unknown } | undefined)?.newPassword ?? '');
          if (passwordPolicyIssues(pw).length) {
            throw new APIError('BAD_REQUEST', { message: 'PASSWORD_POLICY', code: 'PASSWORD_POLICY' });
          }
        }
        if (ctx.path === '/sign-out') {
          const s = await getSessionFromCtx(ctx).catch(() => null);
          if (s)
            await recordAuditSafe({
              action: 'AUTH_LOGOUT',
              result: 'SUCCESS',
              actor: { id: s.user.id, username: (s.user as { username?: string | null }).username ?? null },
            });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        await auditAuthEvent(ctx as unknown as AuthHookCtx);
        // Troca de senha bem-sucedida encerra a obrigação de trocar a senha temporária.
        if (ctx.path === '/change-password' && !(ctx.context.returned instanceof Error)) {
          const userId = ctx.context.session?.user.id ?? ctx.context.newSession?.user.id;
          if (userId) await prisma.user.update({ where: { id: userId }, data: { mustChangePassword: false } });
        }
      }),
    },

    plugins: [
      username({ minUsernameLength: 3, maxUsernameLength: 32 }),
      twoFactor({ issuer: 'GitLab Wizard' }),
      admin({ defaultRole: 'user', adminRoles: ['admin'] }),
      nextCookies(), // sempre o último: grava cookies em Server Actions
    ],
  });
}

type Auth = ReturnType<typeof createAuth>;
let instance: Auth | undefined;

/**
 * Criação preguiçosa: `next build` importa as rotas sem as variáveis de runtime (a imagem Docker não tem
 * .env), então a configuração só é lida — e validada — no primeiro uso, em runtime.
 */
export const auth: Auth = new Proxy({} as Auth, {
  get: (_t, prop) => Reflect.get((instance ??= createAuth()), prop),
});

export type Session = Auth['$Infer']['Session'];
