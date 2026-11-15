import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client';
import { isPrivilegedScope } from '@/lib/cleanup-rules';
import { ActionError } from '@/server/action-result';
import { prisma } from '@/server/db';
import { GitLabApiError } from '@/server/gitlab/errors';
import { logger } from '@/server/logger';
import { recordAudit, recordAuditSafe } from './audit.service';
import { loadUsers, progressWriter, getScan } from './cleanup.service';
import { withGitLab, type Ctx } from './gitlab-token.service';

const SIMULATION_MAX_AGE_MS = 30 * 60_000;
const MAX_STORED_ITEMS = 2000;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export interface PatLifetimeItem {
  tokenId: number;
  gitlabUserId: number;
  username: string;
  bot: boolean;
  name: string;
  expiresAt: string;
  lastUsedAt: string | null;
  /** Escopos do token (PAT): ajudam a priorizar o risco de cada revogação. */
  scopes: string[];
  linkedInTool: boolean;
  self: boolean;
}

/** Limite configurado hoje no GitLab (null = sem limite). `available:false` quando não dá para ler (edição/permissão). */
export async function getGitLabPatLifetime(
  ctx: Ctx,
): Promise<{ available: true; days: number | null } | { available: false; reason: string }> {
  try {
    return { available: true, days: await withGitLab(ctx, 'ADMIN_USERS', (c) => c.getMaxPatLifetime()) };
  } catch (e) {
    return { available: false, reason: e instanceof GitLabApiError ? e.code : 'INTERNAL' };
  }
}

export async function startPatLifetimeSimulation(ctx: Ctx, days: number): Promise<{ scanId: string }> {
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new ActionError('INVALID_SETTING', 'Informe um inteiro entre 1 e 365 dias.');
  const scanId = randomUUID();
  await prisma.adminScan.create({
    data: { id: scanId, kind: 'PAT_LIFETIME', actorUserId: ctx.actor.id, params: { days }, progress: { phase: 'starting' } },
  });
  void runPatLifetimeSimulation(ctx, scanId).catch((e) =>
    logger.error({ scanId, err: e instanceof Error ? e.message : 'unknown' }, 'simulação falhou'),
  );
  return { scanId };
}

/**
 * Dry-run do efeito de `max_personal_access_token_lifetime = N` no GitLab: quais PATs ATIVOS têm expiração
 * além de hoje + N dias (o GitLab revoga esses ao aplicar). A regra exata de corte é o que a doc descreve
 * ("tokens com expiração além do prazo máximo"); trate o resultado como estimativa.
 */
export async function runPatLifetimeSimulation(ctx: Ctx, scanId: string): Promise<void> {
  const scan = await prisma.adminScan.findUniqueOrThrow({ where: { id: scanId } });
  const days = (scan.params as { days: number }).days;
  const progress = progressWriter(scanId);
  try {
    const out = await withGitLab(ctx, 'ADMIN_USERS', async (c, row) => {
      await progress({ phase: 'users', done: 0 }, true);
      const users = await loadUsers(c, (n) => void progress({ phase: 'users', done: n }));
      await progress({ phase: 'tokens' }, true);
      const pats = await c.listActivePersonalAccessTokens();
      const cutoff = isoDate(new Date(Date.now() + days * 86_400_000));
      const linked = new Set(
        (await prisma.gitLabToken.findMany({ where: { status: 'ACTIVE' }, select: { gitlabTokenId: true } })).map((t) => t.gitlabTokenId),
      );

      const affected: PatLifetimeItem[] = pats
        .filter((p) => p.expires_at && p.expires_at.slice(0, 10) > cutoff)
        .map((p) => ({
          tokenId: p.id,
          gitlabUserId: p.user_id,
          username: users.get(p.user_id)?.username ?? `#${p.user_id}`,
          bot: Boolean(users.get(p.user_id)?.bot),
          name: p.name,
          expiresAt: p.expires_at!.slice(0, 10),
          lastUsedAt: p.last_used_at ?? null,
          scopes: p.scopes ?? [],
          linkedInTool: linked.has(p.id),
          self: p.user_id === row.gitlabUserId,
        }))
        .sort((a, b) => b.expiresAt.localeCompare(a.expiresAt));
      return {
        affected,
        summary: {
          days,
          cutoff,
          activeTokens: pats.length,
          affected: affected.length,
          withoutExpiry: pats.filter((p) => !p.expires_at).length,
          users: new Set(affected.map((a) => a.gitlabUserId)).size,
          linkedInTool: affected.filter((a) => a.linkedInTool).length,
          bots: affected.filter((a) => a.bot).length,
          privileged: affected.filter((a) => a.scopes.some(isPrivilegedScope)).length,
          selfAffected: affected.some((a) => a.self),
          truncated: affected.length > MAX_STORED_ITEMS,
        },
      };
    });
    await prisma.adminScan.update({
      where: { id: scanId },
      data: {
        status: 'DONE',
        items: out.affected.slice(0, MAX_STORED_ITEMS) as unknown as Prisma.InputJsonArray,
        summary: out.summary,
        progress: { phase: 'done' },
        finishedAt: new Date(),
      },
    });
    await recordAuditSafe({
      action: 'GITLAB_POLICY_PAT_LIFETIME_SIMULATED',
      result: 'SUCCESS',
      actor: ctx.actor,
      meta: ctx.meta,
      metadata: { scanId, ...out.summary },
    });
  } catch (e) {
    const code = (e as { code?: string }).code ?? 'INTERNAL';
    await prisma.adminScan
      .update({ where: { id: scanId }, data: { status: 'FAILED', error: code, finishedAt: new Date() } })
      .catch(() => undefined);
    throw e;
  }
}

/** Aplica o limite NO GITLAB. Exige uma simulação concluída, recente e para o MESMO valor. Irreversível: o GitLab revoga os tokens. */
export async function applyGitLabPatLifetime(ctx: Ctx, i: { scanId: string; days: number; reason: string }) {
  const scan = await getScan(i.scanId, ctx.actor.id, 'PAT_LIFETIME');
  if (!scan) throw new ActionError('SCAN_NOT_FOUND');
  if (scan.status !== 'DONE') throw new ActionError('SCAN_NOT_READY');
  if ((scan.params as { days: number }).days !== i.days) throw new ActionError('SIMULATION_REQUIRED');
  if (Date.now() - (scan.finishedAt ?? scan.createdAt).getTime() > SIMULATION_MAX_AGE_MS) throw new ActionError('SCAN_STALE');
  const summary = scan.summary as { affected: number; linkedInTool: number; selfAffected: boolean };
  const meta = {
    scanId: scan.id,
    days: i.days,
    expectedRevocations: summary.affected,
    linkedInTool: summary.linkedInTool,
    selfAffected: summary.selfAffected,
  };
  const audit = { action: 'GITLAB_POLICY_PAT_LIFETIME_APPLIED', actor: ctx.actor, meta: ctx.meta, reason: i.reason };

  let applied: number | null;
  try {
    applied = await withGitLab(ctx, 'ADMIN_USERS', (c) => c.setMaxPatLifetime(i.days));
  } catch (e) {
    await recordAuditSafe({ ...audit, result: 'FAILURE', errorCode: (e as { code?: string }).code ?? 'INTERNAL', metadata: meta });
    throw e;
  }
  // Edições sem suporte (não Ultimate) podem responder 200 ignorando o campo: só vale se o valor voltou igual.
  if (applied !== i.days) {
    await recordAuditSafe({
      ...audit,
      result: 'FAILURE',
      errorCode: 'GITLAB_SETTING_NOT_APPLIED',
      metadata: { ...meta, returned: applied },
    });
    throw new ActionError('GITLAB_SETTING_NOT_APPLIED');
  }
  await recordAudit({ ...audit, result: 'SUCCESS', metadata: meta });
  return { days: applied, expectedRevocations: summary.affected };
}
