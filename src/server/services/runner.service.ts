import 'server-only';
import type { Prisma } from '@/generated/prisma/client';
import { diffTags, type CreateRunnerInput } from '@/lib/runner-rules';
import { ActionError } from '@/server/action-result';
import { env } from '@/server/env';
import { GitLabApiError } from '@/server/gitlab/errors';
import { pool } from '@/server/pool';
import { withAudit } from './audit.service';
import { withGitLab, type Ctx } from './gitlab-token.service';

export type RunnerScope = { type: 'instance_type' } | { type: 'group_type'; id: number } | { type: 'project_type'; id: number };

const targetLabel = (s: RunnerScope) =>
  s.type === 'instance_type' ? 'instância' : `${s.type === 'group_type' ? 'grupo' : 'projeto'} #${s.id}`;
const targetOf = (s: RunnerScope) => ({
  type: 'gitlab_runner' as const,
  id: s.type === 'instance_type' ? 'instance' : `${s.type}:${s.id}`,
  label: targetLabel(s),
});

/** Grupos/projetos em que o usuário pode criar runner (Owner). */
export const searchRunnerTargets = (ctx: Ctx, kind: 'group' | 'project', q: string) =>
  withGitLab(ctx, 'RUNNERS_CREATE', async (c) =>
    (await c.searchRunnerTargets(kind, q)).map((t) => ({ id: t.id, name: t.name, path: t.full_path ?? t.path_with_namespace ?? t.name })),
  );

/**
 * Runners do escopo COM as tags. As listas do GitLab (`/runners/all`, `/groups/:id/runners`, `/projects/:id/runners`) não
 * trazem `tag_list`; ela só existe no detalhe (`GET /runners/:id`), então buscamos cada um (4 em paralelo). Se o detalhe
 * de algum falhar, ele aparece sem tags (`tag_list` ausente = desconhecido) em vez de derrubar a lista.
 */
export const listRunners = (ctx: Ctx, scope: RunnerScope) =>
  withGitLab(ctx, 'RUNNERS_MANAGE', async (c) => {
    const list = await c.listRunners(scope);
    await pool(list, 4, async (r) => {
      try {
        r.tag_list = (await c.getRunner(r.id)).tag_list ?? [];
      } catch (e) {
        // 401 invalida o token do operador: precisa subir. O resto (404 de um runner removido agora, 5xx) só deixa sem tags.
        if (e instanceof GitLabApiError && e.code === 'GITLAB_TOKEN_INVALID') throw e;
        delete r.tag_list;
      }
    });
    return list;
  });

/**
 * Cria o runner no GitLab e devolve o token de autenticação UMA vez (nunca é gravado nem auditado). A auditoria guarda o
 * que foi pedido (tipo, alvo, tags…) e o id do runner, sem o token.
 */
export async function createRunner(ctx: Ctx, i: CreateRunnerInput) {
  const scope: RunnerScope = i.target;
  return withAudit({ action: 'RUNNER_CREATED', actor: ctx.actor, meta: ctx.meta, reason: i.reason, target: targetOf(scope) }, () =>
    withGitLab(ctx, 'RUNNERS_CREATE', async (c, row) => {
      if (i.target.type === 'instance_type' && !row.gitlabIsAdmin) throw new ActionError('RUNNER_INSTANCE_ADMIN_ONLY');
      const r = await c.createRunner({
        type: i.target.type,
        targetId: i.target.type === 'instance_type' ? undefined : i.target.id,
        description: i.description,
        tags: i.tags,
        runUntagged: i.runUntagged,
        locked: i.locked,
        protectedRefs: i.protectedRefs,
        paused: i.paused,
        maximumTimeout: i.maximumTimeout,
      });
      const metadata: Prisma.InputJsonObject = {
        runnerId: r.id,
        runnerType: i.target.type,
        targetId: i.target.type === 'instance_type' ? null : i.target.id,
        description: i.description ?? null,
        tags: i.tags,
        runUntagged: i.runUntagged,
        locked: i.locked,
        protectedRefs: i.protectedRefs,
        paused: i.paused,
        tokenExpiresAt: r.token_expires_at ?? null,
      };
      return { value: { runnerId: r.id, token: r.token, gitlabUrl: env.GITLAB_BASE_URL.replace(/\/+$/, '') }, metadata };
    }),
  );
}

export const setRunnerPaused = (ctx: Ctx, i: { runnerId: number; paused: boolean; scope: RunnerScope }) =>
  withAudit({ action: 'RUNNER_PAUSED', actor: ctx.actor, meta: ctx.meta, target: targetOf(i.scope) }, () =>
    withGitLab(ctx, 'RUNNERS_MANAGE', async (c) => {
      await assertInScope(c, i.runnerId, i.scope);
      await c.setRunnerPaused(i.runnerId, i.paused);
      return { value: undefined, metadata: { runnerId: i.runnerId, paused: i.paused } };
    }),
  );

export const updateRunnerTags = (ctx: Ctx, i: { runnerId: number; tags: string[]; reason: string; scope: RunnerScope }) =>
  withAudit({ action: 'RUNNER_TAGS_UPDATED', actor: ctx.actor, meta: ctx.meta, reason: i.reason, target: targetOf(i.scope) }, () =>
    withGitLab(ctx, 'RUNNERS_MANAGE', async (c) => {
      await assertInScope(c, i.runnerId, i.scope);
      const before = (await c.getRunner(i.runnerId)).tag_list ?? [];
      const tags = [...new Set(i.tags)];
      await c.setRunnerTags(i.runnerId, tags);
      const diff = diffTags(before, tags);
      return { value: { before, after: tags, ...diff }, metadata: { runnerId: i.runnerId, before, after: tags, ...diff } };
    }),
  );

export const deleteRunner = (ctx: Ctx, i: { runnerId: number; reason: string; scope: RunnerScope }) =>
  withAudit({ action: 'RUNNER_DELETED', actor: ctx.actor, meta: ctx.meta, reason: i.reason, target: targetOf(i.scope) }, () =>
    withGitLab(ctx, 'RUNNERS_MANAGE', async (c) => {
      await assertInScope(c, i.runnerId, i.scope);
      await c.deleteRunner(i.runnerId);
      return { value: undefined, metadata: { runnerId: i.runnerId } };
    }),
  );

/** Só age em runner que está na lista do escopo pedido (evita apagar por id de outro lugar). */
async function assertInScope(c: import('@/server/gitlab/client').GitLabClient, runnerId: number, scope: RunnerScope) {
  const list = await c.listRunners(scope);
  if (!list.some((r) => r.id === runnerId)) throw new ActionError('NOT_FOUND');
}
