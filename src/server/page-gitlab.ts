import 'server-only';
import { redirect } from 'next/navigation';
import { ActionError } from '@/server/action-result';
import { GitLabApiError } from '@/server/gitlab/errors';
import { messageFor } from '@/lib/messages';

export type PageResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

/**
 * Para páginas que leem do GitLab: converte falhas em estado de tela. PAT ausente/inválido manda para
 * /token (a sessão da ferramenta continua); o restante vira uma mensagem na própria página.
 */
export async function loadGitLab<T>(fn: () => Promise<T>): Promise<PageResult<T>> {
  let failure: { code: string } | undefined;
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof ActionError || e instanceof GitLabApiError) failure = { code: e.code };
    else throw e;
  }
  if (failure.code === 'NO_GITLAB_TOKEN' || failure.code === 'GITLAB_TOKEN_INVALID') redirect(`/token?notice=${failure.code}`);
  return { ok: false, code: failure.code, message: messageFor(failure.code) };
}
