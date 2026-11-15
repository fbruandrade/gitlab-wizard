import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client';
import {
  classify,
  isBlockedState,
  isBotUser,
  validateCleanupParams,
  type CleanupItem,
  type CleanupParams,
  type RuleUser,
} from '@/lib/cleanup-rules';
import { ActionError } from '@/server/action-result';
import { prisma } from '@/server/db';
import { GitLabApiError } from '@/server/gitlab/errors';
import type { GitLabUser } from '@/server/gitlab/schemas';
import { logger } from '@/server/logger';
import { pool } from '@/server/pool';
import { recordAuditSafe } from './audit.service';
import { withGitLab, type Ctx } from './gitlab-token.service';

export const MAX_ITEMS_PER_EXECUTION = 500;
const SCAN_MAX_AGE_MS = 6 * 3_600_000; // depois disso, exige nova varredura
const STALE_MS = 3 * 60_000; // varredura RUNNING sem sinal de vida por 3 min = falhou (processo reiniciou)

export const toRuleUser = (u: GitLabUser): RuleUser => ({ id: u.id, username: u.username, state: u.state, bot: isBotUser(u) });

/** Atualiza o progresso no banco no máximo a cada ~700 ms (a tela faz polling). */
export function progressWriter(scanId: string) {
  let last = 0;
  return async (p: Prisma.InputJsonObject, force = false) => {
    const now = Date.now();
    if (!force && now - last < 700) return;
    last = now;
    await prisma.adminScan.update({ where: { id: scanId }, data: { progress: p } }).catch(() => undefined);
  };
}

/** Usuários da instância (todos + bloqueados, mesclados: não dependemos do default do GitLab incluir bloqueados). */
export async function loadUsers(
  c: import('@/server/gitlab/client').GitLabClient,
  onCount?: (n: number) => void,
): Promise<Map<number, RuleUser>> {
  const all = await c.listAllUsers({}, onCount);
  const blocked = await c.listAllUsers({ blocked: true });
  return new Map([...all, ...blocked].map((u) => [u.id, toRuleUser(u)]));
}

// ── varredura (dry-run) ─────────────────────────────────────────────────────────────────────────────────────────
export async function startCleanupScan(ctx: Ctx, params: CleanupParams): Promise<{ scanId: string }> {
  const err = validateCleanupParams(params);
  if (err) throw new ActionError('NO_CRITERIA', err);
  const scanId = randomUUID();
  await prisma.adminScan.create({
    data: {
      id: scanId,
      kind: 'CLEANUP',
      actorUserId: ctx.actor.id,
      params: params as unknown as Prisma.InputJsonObject,
      progress: { phase: 'starting' },
    },
  });
  // Em segundo plano: a tela acompanha por polling. Falhas ficam registradas na própria varredura.
  void runCleanupScan(ctx, scanId).catch((e) =>
    logger.error({ scanId, err: e instanceof Error ? e.message : 'unknown' }, 'varredura falhou'),
  );
  return { scanId };
}

export async function runCleanupScan(ctx: Ctx, scanId: string): Promise<void> {
  const scan = await prisma.adminScan.findUniqueOrThrow({ where: { id: scanId } });
  const params = scan.params as unknown as CleanupParams;
  const progress = progressWriter(scanId);
  try {
    const result = await withGitLab(ctx, 'ADMIN_USERS', async (c, row) => {
      await progress({ phase: 'users', done: 0 }, true);
      const users = await loadUsers(c, (n) => void progress({ phase: 'users', done: n }));

      let pats: Awaited<ReturnType<typeof c.listActivePersonalAccessTokens>> = [];
      if (params.includePat) {
        await progress({ phase: 'tokens' }, true);
        pats = await c.listActivePersonalAccessTokens();
        // Dono ausente da lista (ex.: o GitLab não devolveu esse usuário): resolve individualmente, até 200.
        const missing = [...new Set(pats.map((p) => p.user_id).filter((id) => !users.has(id)))].slice(0, 200);
        await pool(missing, 4, async (id) => {
          try {
            users.set(id, toRuleUser(await c.getUser(id)));
          } catch (e) {
            if (!(e instanceof GitLabApiError && e.code === 'GITLAB_NOT_FOUND')) throw e;
          }
        });
      }

      const keysByUser = new Map<number, Awaited<ReturnType<typeof c.listUserSshKeys>>>();
      if (params.includeSsh) {
        // Chaves: usuários bloqueados (critério 1) e/ou TODOS os humanos (critério "sem uso"; só dá para listar por usuário).
        const targets = [...users.values()].filter(
          (u) => !u.bot && u.id !== row.gitlabUserId && (params.unusedDays !== null || (params.blockedUsers && isBlockedState(u.state))),
        );
        let done = 0;
        await progress({ phase: 'keys', done: 0, total: targets.length }, true);
        await pool(targets, 6, async (u) => {
          keysByUser.set(u.id, await c.listUserSshKeys(u.id));
          await progress({ phase: 'keys', done: ++done, total: targets.length });
        });
      }

      await progress({ phase: 'classify' }, true);
      const linked = new Set(
        (await prisma.gitLabToken.findMany({ where: { status: 'ACTIVE' }, select: { gitlabTokenId: true } })).map((t) => t.gitlabTokenId),
      );
      return {
        ...classify({ params, now: new Date(), users, pats, keysByUser, selfGitlabUserId: row.gitlabUserId, linkedTokenIds: linked }),
        usersScanned: users.size,
      };
    });

    const selectable = result.items.filter((i) => !i.protectedReason);
    const summary = {
      usersScanned: result.usersScanned,
      total: result.items.length,
      selectable: selectable.length,
      protected: result.items.length - selectable.length,
      pat: result.items.filter((i) => i.kind === 'PAT').length,
      sshKey: result.items.filter((i) => i.kind === 'SSH_KEY').length,
      blocked: result.items.filter((i) => i.reasons.includes('USER_BLOCKED')).length,
      unused: result.items.filter((i) => i.reasons.includes('UNUSED')).length,
      excluded: result.excluded,
      sshLastUsedUnavailable: result.sshLastUsedUnavailable,
    };
    await prisma.adminScan.update({
      where: { id: scanId },
      data: {
        status: 'DONE',
        items: result.items as unknown as Prisma.InputJsonArray,
        summary,
        progress: { phase: 'done' },
        finishedAt: new Date(),
      },
    });
    await recordAuditSafe({
      action: 'GITLAB_CLEANUP_SCANNED',
      result: 'SUCCESS',
      actor: ctx.actor,
      meta: ctx.meta,
      metadata: { scanId, params: params as unknown as Prisma.InputJsonObject, ...summary },
    });
  } catch (e) {
    const code = (e as { code?: string }).code ?? 'INTERNAL';
    await prisma.adminScan
      .update({ where: { id: scanId }, data: { status: 'FAILED', error: code, finishedAt: new Date() } })
      .catch(() => undefined);
    await recordAuditSafe({
      action: 'GITLAB_CLEANUP_SCANNED',
      result: 'FAILURE',
      actor: ctx.actor,
      meta: ctx.meta,
      errorCode: code,
      metadata: { scanId },
    });
    throw e;
  }
}

/** Lê uma varredura; uma RUNNING sem sinal de vida há muito tempo vira FAILED (o processo pode ter reiniciado). */
export async function getScan(scanId: string, actorUserId: string, kind?: 'CLEANUP' | 'PAT_LIFETIME') {
  const scan = await prisma.adminScan.findFirst({ where: { id: scanId, actorUserId, ...(kind && { kind }) } });
  if (!scan) return null;
  if (scan.status === 'RUNNING' && Date.now() - scan.updatedAt.getTime() > STALE_MS) {
    return prisma.adminScan.update({ where: { id: scan.id }, data: { status: 'FAILED', error: 'STALE', finishedAt: new Date() } });
  }
  return scan;
}

export const recentScans = (actorUserId: string, kind: 'CLEANUP' | 'PAT_LIFETIME', take = 5) =>
  prisma.adminScan.findMany({
    where: { actorUserId, kind },
    orderBy: { createdAt: 'desc' },
    take,
    select: { id: true, status: true, createdAt: true, summary: true, params: true },
  });

// ── execução ────────────────────────────────────────────────────────────────────────────────────────────────────
export interface CleanupResult {
  revoked: number;
  skipped: number;
  failed: number;
  results: { key: string; status: 'REVOKED' | 'SKIPPED' | 'FAILED'; code?: string }[];
}

/**
 * Revoga os itens escolhidos. Só age sobre itens que constam na varredura, e cada um é REAVALIADO no GitLab
 * imediatamente antes (usado/desbloqueado desde a varredura → ignorado). Auditoria item a item.
 */
export async function executeCleanup(ctx: Ctx, i: { scanId: string; keys: string[]; reason: string }): Promise<CleanupResult> {
  const scan = await getScan(i.scanId, ctx.actor.id, 'CLEANUP');
  if (!scan) throw new ActionError('SCAN_NOT_FOUND');
  if (scan.status !== 'DONE') throw new ActionError('SCAN_NOT_READY');
  if (Date.now() - (scan.finishedAt ?? scan.createdAt).getTime() > SCAN_MAX_AGE_MS) throw new ActionError('SCAN_STALE');

  const keys = [...new Set(i.keys)];
  if (keys.length === 0) throw new ActionError('ITEMS_NOT_IN_SCAN');
  if (keys.length > MAX_ITEMS_PER_EXECUTION) throw new ActionError('TOO_MANY_ITEMS');
  const byKey = new Map((scan.items as unknown as CleanupItem[]).map((it) => [it.key, it]));
  const selected = keys.map((k) => byKey.get(k));
  if (selected.some((it) => !it || it.protectedReason)) throw new ActionError('ITEMS_NOT_IN_SCAN');
  const items = selected as CleanupItem[];
  const params = scan.params as unknown as CleanupParams;

  const results: CleanupResult['results'] = [];
  let fatal: GitLabApiError | undefined;

  try {
    await withGitLab(ctx, 'ADMIN_USERS', async (c, row) => {
      const linked = new Set(
        (await prisma.gitLabToken.findMany({ where: { status: 'ACTIVE' }, select: { gitlabTokenId: true } })).map((t) => t.gitlabTokenId),
      );
      // 1) reavalia por usuário, com dados frescos
      const stillMatches = new Set<string>();
      const userIds = [...new Set(items.map((it) => it.gitlabUserId))];
      await pool(userIds, 4, async (uid) => {
        let user: GitLabUser;
        try {
          user = await c.getUser(uid);
        } catch (e) {
          if (e instanceof GitLabApiError && e.code === 'GITLAB_NOT_FOUND') return;
          throw e;
        }
        const mine = items.filter((it) => it.gitlabUserId === uid);
        const pats = mine.some((it) => it.kind === 'PAT') ? await c.listActivePersonalAccessTokens(uid) : [];
        const sshKeys = mine.some((it) => it.kind === 'SSH_KEY') ? await c.listUserSshKeys(uid) : [];
        const fresh = classify({
          params,
          now: new Date(),
          users: new Map([[uid, toRuleUser(user)]]),
          pats,
          keysByUser: new Map([[uid, sshKeys]]),
          selfGitlabUserId: row.gitlabUserId,
          linkedTokenIds: linked,
        });
        for (const it of fresh.items) if (!it.protectedReason) stillMatches.add(it.key);
      });

      // 2) revoga (sem retry; um 401 interrompe tudo)
      await pool(items, 4, async (it) => {
        if (fatal) return void results.push({ key: it.key, status: 'SKIPPED', code: 'ABORTED' });
        if (!stillMatches.has(it.key)) return void results.push({ key: it.key, status: 'SKIPPED', code: 'CHANGED' });
        const base = {
          action: it.kind === 'PAT' ? 'GITLAB_CLEANUP_PAT_REVOKED' : 'GITLAB_CLEANUP_SSH_KEY_DELETED',
          actor: ctx.actor,
          meta: ctx.meta,
          reason: i.reason,
          target: { type: 'gitlab_user' as const, id: it.gitlabUserId, label: it.username },
        };
        const metadata = {
          scanId: scan.id,
          credentialId: it.credentialId,
          name: it.name,
          reasons: it.reasons,
          lastUsedAt: it.lastUsedAt,
          userState: it.userState,
        };
        try {
          if (it.kind === 'PAT') await c.revokePersonalAccessToken(it.credentialId);
          else await c.deleteUserSshKey(it.gitlabUserId, it.credentialId);
          results.push({ key: it.key, status: 'REVOKED' });
          await recordAuditSafe({ ...base, result: 'SUCCESS', metadata });
        } catch (e) {
          const code = e instanceof GitLabApiError ? e.code : 'INTERNAL';
          if (e instanceof GitLabApiError && e.code === 'GITLAB_TOKEN_INVALID') fatal = e;
          results.push({ key: it.key, status: 'FAILED', code });
          await recordAuditSafe({ ...base, result: 'FAILURE', errorCode: code, metadata });
        }
      });
    });
  } finally {
    const count = (s: string) => results.filter((r) => r.status === s).length;
    await recordAuditSafe({
      action: 'GITLAB_CLEANUP_EXECUTED',
      result: fatal ? 'PARTIAL' : count('FAILED') ? 'PARTIAL' : 'SUCCESS',
      actor: ctx.actor,
      meta: ctx.meta,
      reason: i.reason,
      metadata: { scanId: scan.id, requested: items.length, revoked: count('REVOKED'), skipped: count('SKIPPED'), failed: count('FAILED') },
    });
  }
  if (fatal) throw fatal; // deixa o withGitLab/handlers tratarem o 401 (PAT do operador inválido)
  const count = (s: string) => results.filter((r) => r.status === s).length;
  return { revoked: count('REVOKED'), skipped: count('SKIPPED'), failed: count('FAILED'), results };
}
