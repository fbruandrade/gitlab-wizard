import 'server-only';
import { cookies } from 'next/headers';
import { env } from '@/server/env';
import { resolveToken } from '@/server/services/gitlab-token.service';

/**
 * Qual dos tokens da conta está "em uso" NESTE navegador. O padrão (is_default) é a preferência permanente;
 * este cookie é a escolha da sessão. O valor é só um id: quem decide é `resolveToken`, que ignora ids de outra
 * conta ou de token que não está mais ativo — então forjar/herdar o cookie não dá acesso a nada.
 */
export const TOKEN_COOKIE = 'gw.active_token';

export async function getSelectedTokenId(): Promise<string | undefined> {
  return (await cookies()).get(TOKEN_COOKIE)?.value;
}

export async function setSelectedTokenId(id: string): Promise<void> {
  (await cookies()).set(TOKEN_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: new URL(env.BETTER_AUTH_URL).protocol === 'https:',
    path: '/',
    maxAge: env.SESSION_MAX_AGE_HOURS * 3600,
  });
}

/** Token em uso nesta requisição (escolhido, ou o padrão). */
export async function resolveSelectedToken(userId: string) {
  return resolveToken(userId, await getSelectedTokenId());
}

/** Contexto de páginas: quem é + qual token usar nas chamadas ao GitLab. */
export async function pageCtx(session: { user: { id: string; username?: string | null } }) {
  return { actor: { id: session.user.id, username: session.user.username ?? null }, tokenId: await getSelectedTokenId() };
}
