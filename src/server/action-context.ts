import 'server-only';
import { headers } from 'next/headers';
import { requireAdmin, requireFreshSession } from '@/server/auth/guards';
import { getRequestMeta } from '@/server/services/audit.service';
import { getSelectedTokenId } from '@/server/token-selection';
import type { Ctx } from '@/server/services/gitlab-token.service';
import type { AdminCtx } from '@/server/services/tool-user.service';

/** Contexto de uma Server Action GitLab: sessão fresca + quem fez e de onde. */
export async function gitlabCtx(): Promise<Ctx> {
  const s = await requireFreshSession();
  return { actor: { id: s.user.id, username: s.user.username ?? null }, meta: await getRequestMeta(), tokenId: await getSelectedTokenId() };
}

/** Contexto de uma Server Action de admin da ferramenta: exige role=admin + sessão fresca. */
export async function adminCtx(): Promise<AdminCtx> {
  const s = await requireAdmin();
  return {
    actor: { id: s.user.id, username: s.user.username ?? null },
    headers: await headers(),
    meta: await getRequestMeta(),
    tokenId: await getSelectedTokenId(),
  };
}
