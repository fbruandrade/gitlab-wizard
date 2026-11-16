import 'server-only';
import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ActionError } from '@/server/action-result';
import { prisma } from '@/server/db';
import { env } from '@/server/env';
import { isOverAbsoluteLifetime } from '@/lib/session-lifetime';
import { auth, type Session } from './auth';

const MIN = 60_000;

/** Memoizada pelo objeto de headers da requisição (dedupe dentro da requisição; sem estado global entre requisições). */
const sessionFor = cache(async (h: Headers): Promise<Session | null> => auth.api.getSession({ headers: h }));
export const getSession = async (): Promise<Session | null> => sessionFor(await headers());

/** Leitura sem cookie cache: reflete revogações/banimentos na hora. Usada em ações sensíveis. */
async function getSessionNoCache(): Promise<Session | null> {
  return auth.api.getSession({ headers: await headers(), query: { disableCookieCache: true } });
}

/** Teto absoluto (SESSION_MAX_AGE_HOURS), além da expiração por inatividade do better-auth. */
const overLifetime = (createdAt: Date) => isOverAbsoluteLifetime(createdAt, env.SESSION_MAX_AGE_HOURS);

async function dropSession(token: string) {
  await prisma.session.deleteMany({ where: { token } });
}

/** Páginas: sem sessão (ou sessão vencida em termos absolutos) → login. */
export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) redirect('/login');
  if (overLifetime(s.session.createdAt)) {
    await dropSession(s.session.token);
    redirect('/login?expired=1');
  }
  return s;
}

/** Layout autenticado: além da sessão, exige senha trocada e 2FA configurado. */
export async function requireReadySession(): Promise<Session> {
  let s = await requireSession();
  const pending = (x: Session) => x.user.mustChangePassword || (env.REQUIRE_APP_2FA && !x.user.twoFactorEnabled);
  // O cookie cache (60 s) pode estar defasado logo após trocar a senha / ativar o 2FA: confirma no banco antes de barrar.
  if (pending(s)) s = (await getSessionNoCache()) ?? redirect('/login');
  if (s.user.mustChangePassword) redirect('/account/change-password');
  if (env.REQUIRE_APP_2FA && !s.user.twoFactorEnabled) redirect('/setup-2fa');
  return s;
}

/** Server Actions sensíveis: sessão sem cache, requisitos de conta cumpridos e login recente. */
export async function requireFreshSession(): Promise<Session> {
  const s = await getSessionNoCache();
  if (!s) throw new ActionError('UNAUTHENTICATED');
  if (overLifetime(s.session.createdAt)) {
    await dropSession(s.session.token);
    throw new ActionError('UNAUTHENTICATED');
  }
  if (s.user.mustChangePassword) throw new ActionError('PASSWORD_CHANGE_REQUIRED');
  if (env.REQUIRE_APP_2FA && !s.user.twoFactorEnabled) throw new ActionError('TWO_FACTOR_SETUP_REQUIRED');
  if (Date.now() - s.session.createdAt.getTime() > env.FRESH_SESSION_MINUTES * MIN) throw new ActionError('REAUTH_REQUIRED');
  return s;
}

/** Ações de baixo risco (preferências): exige sessão válida e conta pronta, mas NÃO login recente. */
export async function requireActiveSession(): Promise<Session> {
  const s = await getSessionNoCache();
  if (!s) throw new ActionError('UNAUTHENTICATED');
  if (overLifetime(s.session.createdAt)) {
    await dropSession(s.session.token);
    throw new ActionError('UNAUTHENTICATED');
  }
  if (s.user.mustChangePassword) throw new ActionError('PASSWORD_CHANGE_REQUIRED');
  if (env.REQUIRE_APP_2FA && !s.user.twoFactorEnabled) throw new ActionError('TWO_FACTOR_SETUP_REQUIRED');
  return s;
}

export async function requireAdmin(): Promise<Session> {
  const s = await requireFreshSession();
  if (s.user.role !== 'admin') throw new ActionError('FORBIDDEN');
  return s;
}

/** Páginas de admin: não exigem sessão fresca para ler, mas exigem o papel. */
export async function requireAdminPage(): Promise<Session> {
  const s = await requireReadySession();
  if (s.user.role !== 'admin') redirect('/');
  return s;
}
