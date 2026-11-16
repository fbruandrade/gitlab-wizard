import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client';
import {
  classifyVault,
  parseVaultPath,
  pidVarName,
  tokenVarName,
  validateVaultConfig,
  VAULT_DEFAULTS,
  type VarCheck,
  type VaultConfig,
  type VaultItem,
  type VaultToken,
} from '@/lib/vault-rules';
import { ActionError } from '@/server/action-result';
import { prisma } from '@/server/db';
import { GitLabClient } from '@/server/gitlab/client';
import { GitLabApiError } from '@/server/gitlab/errors';
import type { GitLabAccessToken, GitLabGroup, GitLabProject } from '@/server/gitlab/schemas';
import { logger } from '@/server/logger';
import { pool } from '@/server/pool';
import { recordAudit, recordAuditSafe } from './audit.service';
import { getScan, progressWriter } from './cleanup.service';
import { withGitLab, type Ctx } from './gitlab-token.service';

export const MAX_VAULT_ITEMS_PER_EXECUTION = 50;
const SCAN_MAX_AGE_MS = 6 * 3_600_000;
const CONFIG_KEY = 'vault.config';

// ── configuração (app_setting) ──────────────────────────────────────────────────────────────────────────────────
export async function getVaultConfig(): Promise<VaultConfig> {
  const row = await prisma.appSetting.findUnique({ where: { key: CONFIG_KEY } });
  const stored = (row?.value ?? {}) as Partial<VaultConfig>;
  const merged: VaultConfig = { ...VAULT_DEFAULTS, ...stored };
  return validateVaultConfig(merged) ? VAULT_DEFAULTS : merged;
}

export async function updateVaultConfig(
  ctx: { actor: { id: string; username?: string | null }; meta?: Ctx['meta'] },
  config: VaultConfig,
  reason?: string,
) {
  const err = validateVaultConfig(config);
  if (err) throw new ActionError('INVALID_SETTING', err);
  const before = await getVaultConfig();
  await prisma.appSetting.upsert({
    where: { key: CONFIG_KEY },
    create: { key: CONFIG_KEY, value: config as unknown as Prisma.InputJsonObject, updatedBy: ctx.actor.id },
    update: { value: config as unknown as Prisma.InputJsonObject, updatedBy: ctx.actor.id },
  });
  await recordAudit({
    action: 'SETTINGS_CHANGED',
    result: 'SUCCESS',
    actor: ctx.actor,
    meta: ctx.meta,
    reason,
    metadata: { setting: CONFIG_KEY, from: before as unknown as Prisma.InputJsonObject, to: config as unknown as Prisma.InputJsonObject },
  });
  return config;
}

// ── inspeção de um cofre (usada pela varredura e, de novo, imediatamente antes de aplicar) ──────────────────────
const toVaultToken = (t: GitLabAccessToken): VaultToken => ({
  id: t.id,
  name: t.name,
  scopes: t.scopes,
  accessLevel: t.access_level ?? null,
  createdAt: t.created_at ?? null,
  expiresAt: t.expires_at ?? null,
  lastUsedAt: t.last_used_at ?? null,
});

/**
 * Grupo RAIZ com o mesmo nome do projeto, por caminho exato. Qualquer outra coisa (inexistente, ou um id numérico que
 * resolveu para outro grupo) → null: nunca adivinha.
 */
async function findTargetGroup(c: GitLabClient, app: string, cache: Map<string, GitLabGroup | null>): Promise<GitLabGroup | null> {
  if (cache.has(app)) return cache.get(app)!;
  const g = await c.findGroup(app);
  const exact = g && g.parent_id == null && g.full_path.toLowerCase() === app.toLowerCase() ? g : null;
  cache.set(app, exact);
  return exact;
}

/** O valor de DEVOPS_* ainda é um token válido DESTE cofre? (usa o próprio valor; nada é guardado) */
async function checkDevopsValue(value: string, liveTokenId: number | null): Promise<VarCheck> {
  try {
    const self = await new GitLabClient(value).getCurrentToken();
    return liveTokenId !== null && self.id === liveTokenId ? 'OK' : 'MISMATCH';
  } catch (e) {
    return e instanceof GitLabApiError && e.code === 'GITLAB_TOKEN_INVALID' ? 'MISMATCH' : 'UNVERIFIED';
  }
}

export async function inspectProject(
  c: GitLabClient,
  project: Pick<GitLabProject, 'id' | 'path_with_namespace'>,
  config: VaultConfig,
  groups: Map<string, GitLabGroup | null>,
  now = new Date(),
  force = false,
): Promise<VaultItem | null> {
  const parsed = parseVaultPath(project.path_with_namespace, config.rootGroup);
  if (!parsed) return null;
  const tokens = (await c.listProjectAccessTokens(project.id)).filter((t) => t.active && !t.revoked).map(toVaultToken);
  const group = await findTargetGroup(c, parsed.app, groups);

  let pid: VarCheck = 'MISSING';
  let devops: VarCheck = 'MISSING';
  let blockedReason: VaultItem['blockedReason'];
  if (group) {
    const [pidVar, devopsVar] = await Promise.all([
      c.getGroupVariable(group.id, pidVarName(parsed.env)),
      c.getGroupVariable(group.id, tokenVarName(parsed.env)),
    ]);
    if (pidVar) pid = pidVar.value == null ? 'UNVERIFIED' : pidVar.value.trim() === String(project.id) ? 'OK' : 'MISMATCH';
    if (devopsVar) {
      const live = tokens.filter((t) => !t.expiresAt || t.expiresAt.slice(0, 10) >= now.toISOString().slice(0, 10));
      devops = devopsVar.value ? await checkDevopsValue(devopsVar.value, live.length === 1 ? live[0]!.id : null) : 'UNVERIFIED';
    }
    if ([pidVar, devopsVar].some((v) => v && v.environment_scope !== '*')) blockedReason = 'VAR_SCOPE';
  }
  return classifyVault({
    now,
    config,
    projectId: project.id,
    projectPath: project.path_with_namespace,
    env: parsed.env,
    app: parsed.app,
    tokens,
    targetGroup: group ? { id: group.id, fullPath: group.full_path } : null,
    checks: { pid, devops },
    blockedReason,
    force,
  });
}

// ── varredura (dry-run) ─────────────────────────────────────────────────────────────────────────────────────────
export async function startVaultScan(ctx: Ctx, opts: { force?: boolean } = {}): Promise<{ scanId: string }> {
  const config = { ...(await getVaultConfig()), force: Boolean(opts.force) };
  const scanId = randomUUID();
  await prisma.adminScan.create({
    data: {
      id: scanId,
      kind: 'VAULT',
      actorUserId: ctx.actor.id,
      params: config as unknown as Prisma.InputJsonObject,
      progress: { phase: 'starting' },
    },
  });
  void runVaultScan(ctx, scanId).catch((e) =>
    logger.error({ scanId, err: e instanceof Error ? e.message : 'unknown' }, 'varredura do cofre falhou'),
  );
  return { scanId };
}

const STATE_ORDER = [
  'EXPIRED',
  'NO_TOKEN',
  'EXPIRING',
  'OUT_OF_SYNC',
  'VARS_MISSING',
  'NO_TARGET_GROUP',
  'MULTIPLE_TOKENS',
  'UNVERIFIED',
  'OK',
];

export async function runVaultScan(ctx: Ctx, scanId: string): Promise<void> {
  const scan = await prisma.adminScan.findUniqueOrThrow({ where: { id: scanId } });
  const { force, ...config } = scan.params as unknown as VaultConfig & { force?: boolean };
  const progress = progressWriter(scanId);
  try {
    const out = await withGitLab(ctx, 'VAULT_TOKENS', async (c) => {
      await progress({ phase: 'groups' }, true);
      const root = await c.findGroup(config.rootGroup);
      if (!root) throw new ActionError('VAULT_ROOT_NOT_FOUND');
      const projects: GitLabProject[] = [];
      for (const envGroup of await c.listSubgroups(root.id)) projects.push(...(await c.listGroupProjects(envGroup.id)));

      const groups = new Map<string, GitLabGroup | null>();
      const items: VaultItem[] = [];
      const inaccessible: { projectPath: string; code: string }[] = [];
      let done = 0;
      await progress({ phase: 'vaults', done: 0, total: projects.length }, true);
      await pool(projects, 4, async (p) => {
        try {
          const it = await inspectProject(c, p, config, groups, new Date(), force);
          if (it) items.push(it);
        } catch (e) {
          // Sem papel no projeto (403/404): registra e segue; os demais cofres continuam.
          if (e instanceof GitLabApiError && ['GITLAB_FORBIDDEN', 'GITLAB_NOT_FOUND'].includes(e.code))
            inaccessible.push({ projectPath: p.path_with_namespace, code: e.code });
          else throw e;
        }
        await progress({ phase: 'vaults', done: ++done, total: projects.length });
      });
      items.sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || a.projectPath.localeCompare(b.projectPath));
      return { items, inaccessible, projects: projects.length };
    });

    const byState: Record<string, number> = {};
    for (const it of out.items) byState[it.state] = (byState[it.state] ?? 0) + 1;
    const summary = {
      projects: out.projects,
      total: out.items.length,
      actionable: out.items.filter((i) => i.action).length,
      byState,
      inaccessible: out.inaccessible,
    };
    await prisma.adminScan.update({
      where: { id: scanId },
      data: {
        status: 'DONE',
        items: out.items as unknown as Prisma.InputJsonArray,
        summary: summary as unknown as Prisma.InputJsonObject,
        progress: { phase: 'done' },
        finishedAt: new Date(),
      },
    });
    await recordAuditSafe({
      action: 'VAULT_SCANNED',
      result: 'SUCCESS',
      actor: ctx.actor,
      meta: ctx.meta,
      metadata: { scanId, projects: summary.projects, actionable: summary.actionable, byState },
    });
  } catch (e) {
    const code = (e as { code?: string }).code ?? 'INTERNAL';
    await prisma.adminScan
      .update({ where: { id: scanId }, data: { status: 'FAILED', error: code, finishedAt: new Date() } })
      .catch(() => undefined);
    await recordAuditSafe({
      action: 'VAULT_SCANNED',
      result: 'FAILURE',
      actor: ctx.actor,
      meta: ctx.meta,
      errorCode: code,
      metadata: { scanId },
    });
    throw e;
  }
}

// ── execução ────────────────────────────────────────────────────────────────────────────────────────────────────
export type VaultItemStatus = 'DONE' | 'PARTIAL' | 'SKIPPED' | 'FAILED';
export interface VaultResult {
  done: number;
  partial: number;
  skipped: number;
  failed: number;
  results: { key: string; projectPath: string; status: VaultItemStatus; code?: string }[];
}

/** Cofres em aplicação neste processo (a instância é única; a reavaliação cobre o resto). */
const inFlight = new Set<number>();

async function writeVar(c: GitLabClient, groupId: number, key: string, value: string, secret: boolean) {
  const existing = await c.getGroupVariable(groupId, key);
  // Preserva atributos existentes; só um segredo novo nasce mascarado. `protected` nunca é ligado em silêncio.
  const attrs = {
    key,
    value,
    masked: existing ? existing.masked : secret,
    protected: existing ? existing.protected : false,
    environmentScope: '*',
  };
  if (existing) await c.updateGroupVariable(groupId, attrs);
  else await c.createGroupVariable(groupId, attrs);
}

async function applyItem(
  c: GitLabClient,
  item: VaultItem,
  fresh: VaultItem,
  audit: (action: string, result: 'SUCCESS' | 'FAILURE' | 'PARTIAL', errorCode: string | null, md: Prisma.InputJsonObject) => Promise<void>,
): Promise<{ status: VaultItemStatus; code?: string }> {
  const plan = fresh.plan!;
  const group = fresh.targetGroup!;
  const base = { projectId: item.projectId, projectPath: item.projectPath, group: group.fullPath, forced: Boolean(fresh.forced) };
  const pidVar = plan.vars.find((v) => v.key === pidVarName(item.env));

  // 1) PID_: não é segredo e é idempotente. Se falhar, nada mudou ainda.
  if (pidVar) {
    try {
      await writeVar(c, group.id, pidVar.key, String(item.projectId), false);
    } catch (e) {
      const code = e instanceof GitLabApiError ? e.code : 'INTERNAL';
      await audit('VAULT_VARIABLE_WRITTEN', 'FAILURE', code, { ...base, variable: pidVar.key });
      return { status: 'FAILED', code };
    }
    await audit('VAULT_VARIABLE_WRITTEN', 'SUCCESS', null, { ...base, variable: pidVar.key });
  }
  if (fresh.action === 'WRITE_VARS') return { status: 'DONE' };

  // 2) token novo (o antigo continua valendo até o fim)
  let created;
  try {
    created = await c.createProjectAccessToken(item.projectId, {
      name: plan.tokenName,
      scopes: plan.scopes,
      accessLevel: plan.accessLevel,
      expiresAt: plan.expiresAt,
    });
  } catch (e) {
    const code = e instanceof GitLabApiError ? e.code : 'INTERNAL';
    await audit('VAULT_TOKEN_CREATED', 'FAILURE', code, base);
    return { status: 'FAILED', code };
  }
  await audit('VAULT_TOKEN_CREATED', 'SUCCESS', null, {
    ...base,
    tokenId: created.id,
    name: created.name,
    scopes: created.scopes,
    expiresAt: created.expires_at ?? null,
  });

  // 3) grava DEVOPS_*. Se falhar, descobre se o GitLab chegou a aplicar (resposta perdida) antes de descartar o token novo.
  const devopsKey = tokenVarName(item.env);
  let written = false;
  try {
    await writeVar(c, group.id, devopsKey, created.token, true);
    written = true;
  } catch (e) {
    const code = e instanceof GitLabApiError ? e.code : 'INTERNAL';
    let appliedAnyway: boolean | null;
    try {
      const v = await c.getGroupVariable(group.id, devopsKey);
      appliedAnyway = v?.value === created.token ? true : v?.value ? false : null;
    } catch {
      appliedAnyway = null;
    }
    if (appliedAnyway === true) written = true;
    else if (appliedAnyway === false) {
      // Nada foi gravado: descarta o token novo. O antigo segue valendo; as esteiras não foram afetadas.
      const revoked = await c.revokeProjectAccessToken(item.projectId, created.id).then(
        () => true,
        () => false,
      );
      await audit('VAULT_VARIABLE_WRITTEN', 'FAILURE', code, { ...base, variable: devopsKey, newTokenRevoked: revoked });
      return { status: 'FAILED', code };
    } else {
      // Estado desconhecido: NÃO revoga nada. O token novo fica ativo para conferência manual.
      await audit('VAULT_VARIABLE_WRITTEN', 'FAILURE', 'NEEDS_ATTENTION', { ...base, variable: devopsKey, newTokenId: created.id });
      return { status: 'FAILED', code: 'NEEDS_ATTENTION' };
    }
  }
  if (written) await audit('VAULT_VARIABLE_WRITTEN', 'SUCCESS', null, { ...base, variable: devopsKey, tokenId: created.id });

  // 4) valida: o valor lido de volta tem que ser o token novo, e o token tem que funcionar.
  try {
    const v = await c.getGroupVariable(group.id, devopsKey);
    const self = await new GitLabClient(created.token).getCurrentToken();
    if (self.id !== created.id || (v?.value && v.value !== created.token)) throw new Error('mismatch');
  } catch {
    await audit('VAULT_TOKEN_ROTATED', 'PARTIAL', 'VERIFY_FAILED', { ...base, newTokenId: created.id, oldTokenId: plan.revokeTokenId });
    return { status: 'PARTIAL', code: 'VERIFY_FAILED' };
  }

  // 5) só agora revoga o antigo
  if (plan.revokeTokenId !== null) {
    try {
      await c.revokeProjectAccessToken(item.projectId, plan.revokeTokenId);
    } catch (e) {
      const code = e instanceof GitLabApiError ? e.code : 'INTERNAL';
      await audit('VAULT_TOKEN_ROTATED', 'PARTIAL', 'OLD_NOT_REVOKED', {
        ...base,
        newTokenId: created.id,
        oldTokenId: plan.revokeTokenId,
        error: code,
      });
      return { status: 'PARTIAL', code: 'OLD_NOT_REVOKED' };
    }
  }
  await audit('VAULT_TOKEN_ROTATED', 'SUCCESS', null, { ...base, newTokenId: created.id, oldTokenId: plan.revokeTokenId });
  return { status: 'DONE' };
}

/**
 * Aplica o plano dos cofres escolhidos. Só age sobre itens da varredura e cada um é REINSPECIONADO no GitLab antes:
 * se a ação mudou desde o dry-run, é ignorado. Sequencial (um cofre por vez). Nunca grava o valor do token em log/auditoria.
 */
export async function executeVault(ctx: Ctx, i: { scanId: string; keys: string[]; reason: string; auto?: boolean }): Promise<VaultResult> {
  const scan = await getScan(i.scanId, ctx.actor.id, 'VAULT');
  if (!scan) throw new ActionError('SCAN_NOT_FOUND');
  if (scan.status !== 'DONE') throw new ActionError('SCAN_NOT_READY');
  if (Date.now() - (scan.finishedAt ?? scan.createdAt).getTime() > SCAN_MAX_AGE_MS) throw new ActionError('SCAN_STALE');

  const keys = [...new Set(i.keys)];
  if (keys.length === 0) throw new ActionError('ITEMS_NOT_IN_SCAN');
  if (keys.length > MAX_VAULT_ITEMS_PER_EXECUTION) throw new ActionError('TOO_MANY_ITEMS');
  const byKey = new Map((scan.items as unknown as VaultItem[]).map((it) => [it.key, it]));
  const items = keys.map((k) => byKey.get(k));
  if (items.some((it) => !it || !it.action || it.blockedReason)) throw new ActionError('ITEMS_NOT_IN_SCAN');
  const { force, ...config } = scan.params as unknown as VaultConfig & { force?: boolean };

  const results: VaultResult['results'] = [];
  try {
    await withGitLab(ctx, 'VAULT_TOKENS', async (c) => {
      const groups = new Map<string, GitLabGroup | null>();
      for (const it of items as VaultItem[]) {
        const push = (status: VaultItemStatus, code?: string) =>
          void results.push({ key: it.key, projectPath: it.projectPath, status, code });
        if (inFlight.has(it.projectId)) {
          push('SKIPPED', 'IN_PROGRESS');
          continue;
        }
        inFlight.add(it.projectId);
        try {
          const fresh = await inspectProject(
            c,
            { id: it.projectId, path_with_namespace: it.projectPath },
            config,
            groups,
            new Date(),
            force,
          );
          if (!fresh?.action || fresh.blockedReason || fresh.action !== it.action || fresh.plan?.revokeTokenId !== it.plan?.revokeTokenId) {
            push('SKIPPED', 'CHANGED');
            continue;
          }
          const audit = (
            action: string,
            result: 'SUCCESS' | 'FAILURE' | 'PARTIAL',
            errorCode: string | null,
            metadata: Prisma.InputJsonObject,
          ) =>
            recordAuditSafe({
              action,
              result,
              actor: ctx.actor,
              meta: ctx.meta,
              reason: i.reason,
              errorCode,
              target: { type: 'gitlab_project', id: it.projectId, label: it.projectPath },
              metadata: { scanId: scan.id, ...(i.auto && { auto: true }), ...metadata },
            });
          const r = await applyItem(c, it, fresh, audit);
          push(r.status, r.code);
        } catch (e) {
          // 401 do PAT do operador interrompe tudo (withGitLab marca o token); o resto vira erro do item.
          if (e instanceof GitLabApiError && e.code === 'GITLAB_TOKEN_INVALID') throw e;
          push('FAILED', e instanceof GitLabApiError ? e.code : 'INTERNAL');
        } finally {
          inFlight.delete(it.projectId);
        }
      }
    });
  } finally {
    const n = (s: VaultItemStatus) => results.filter((r) => r.status === s).length;
    await recordAuditSafe({
      action: 'VAULT_EXECUTED',
      result: n('FAILED') || n('PARTIAL') ? 'PARTIAL' : 'SUCCESS',
      actor: ctx.actor,
      meta: ctx.meta,
      reason: i.reason,
      metadata: {
        scanId: scan.id,
        requested: items.length,
        done: n('DONE'),
        partial: n('PARTIAL'),
        skipped: n('SKIPPED'),
        failed: n('FAILED'),
      },
    });
  }
  const n = (s: VaultItemStatus) => results.filter((r) => r.status === s).length;
  return { done: n('DONE'), partial: n('PARTIAL'), skipped: n('SKIPPED'), failed: n('FAILED'), results };
}
