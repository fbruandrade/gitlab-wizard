import 'server-only';
import { clientIpFrom, recordAuditSafe, type AuditInput } from '@/server/services/audit.service';

// Contexto mínimo dos hooks do better-auth que usamos (evita acoplar aos tipos internos).
export interface AuthHookCtx {
  path?: string;
  body?: Record<string, unknown>;
  headers?: Headers;
  request?: Request;
  context: {
    returned?: unknown;
    newSession?: { user: { id: string; username?: string | null; twoFactorEnabled?: boolean | null } } | null;
    session?: { user: { id: string; username?: string | null } } | null;
  };
}

const isError = (r: unknown) =>
  r instanceof Error ||
  (typeof r === 'object' && r !== null && ('status' in r || 'statusCode' in r) && (r as { name?: string }).name === 'APIError');
const statusOf = (r: unknown) =>
  (r as { statusCode?: number; status?: number | string }).statusCode ?? Number((r as { status?: number }).status);

/** Traduz respostas do better-auth em eventos de auditoria AUTH_*. Nunca grava senha/código informados. */
export async function auditAuthEvent(ctx: AuthHookCtx): Promise<void> {
  const h = ctx.headers ?? ctx.request?.headers;
  const meta = { ip: h ? clientIpFrom(h) : null, userAgent: h?.get('user-agent')?.slice(0, 300) ?? null };
  const failed = isError(ctx.context.returned);
  const base = (i: Pick<AuditInput, 'action' | 'result'> & Partial<AuditInput>): AuditInput => ({ meta, ...i });
  const user = ctx.context.newSession?.user ?? ctx.context.session?.user;
  const actor = user ? { id: user.id, username: user.username ?? null } : undefined;

  switch (ctx.path) {
    case '/sign-in/username': {
      const body = ctx.body ?? {};
      if (failed) {
        const code = statusOf(ctx.context.returned);
        const action = code === 429 ? 'AUTH_RATE_LIMITED' : 'AUTH_LOGIN_FAILED';
        // Guarda o username informado (nunca a senha) para investigação de força bruta.
        return void (await recordAuditSafe(
          base({ action, result: 'FAILURE', actor: { username: String(body.username ?? '').slice(0, 64) }, errorCode: String(code) }),
        ));
      }
      // Com 2FA a senha foi aceita, mas o login só se completa na verificação do código
      // (o better-auth cria e descarta uma sessão interna, então `newSession` também vem preenchida aqui).
      // Nossa hook pode rodar antes da do plugin twoFactor, então olhamos também o estado do usuário.
      const pending2fa =
        (ctx.context.returned as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect ||
        (ctx.context.newSession?.user as { twoFactorEnabled?: boolean } | undefined)?.twoFactorEnabled;
      if (pending2fa) return;
      if (ctx.context.newSession) return void (await recordAuditSafe(base({ action: 'AUTH_LOGIN_SUCCESS', result: 'SUCCESS', actor })));
      return;
    }
    case '/two-factor/verify-totp':
    case '/two-factor/verify-backup-code': {
      // O cookie temporário `two_factor` só existe durante o login. Sem ele, quem verifica o TOTP já está
      // logado e está ATIVANDO o 2FA (o better-auth também emite `newSession` nesse caso).
      const loggingIn = Boolean(h?.get('cookie')?.includes('two_factor'));
      if (!loggingIn && ctx.path === '/two-factor/verify-totp') {
        return void (await recordAuditSafe(
          base({ action: 'AUTH_2FA_ENABLED', result: failed ? 'FAILURE' : 'SUCCESS', actor, ...(failed && { errorCode: '2FA_INVALID' }) }),
        ));
      }
      if (failed)
        return void (await recordAuditSafe(base({ action: 'AUTH_LOGIN_FAILED', result: 'FAILURE', actor, errorCode: '2FA_INVALID' })));
      if (ctx.context.newSession)
        return void (await recordAuditSafe(
          base({ action: 'AUTH_LOGIN_SUCCESS', result: 'SUCCESS', actor, metadata: { second_factor: true } }),
        ));
      return;
    }
    case '/change-password':
      return void (await recordAuditSafe(base({ action: 'AUTH_PASSWORD_CHANGED', result: failed ? 'FAILURE' : 'SUCCESS', actor })));
    case '/two-factor/disable':
      return void (await recordAuditSafe(base({ action: 'AUTH_2FA_DISABLED', result: failed ? 'FAILURE' : 'SUCCESS', actor })));
    case '/revoke-session':
    case '/revoke-sessions':
    case '/revoke-other-sessions':
      return void (await recordAuditSafe(
        base({ action: 'AUTH_SESSION_REVOKED', result: failed ? 'FAILURE' : 'SUCCESS', actor, metadata: { path: ctx.path } }),
      ));
  }
}
