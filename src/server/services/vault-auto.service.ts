import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client';
import { ActionError } from '@/server/action-result';
import { prisma } from '@/server/db';
import { logger } from '@/server/logger';
import { recordAuditSafe, type RequestMeta } from './audit.service';
import { resolveToken, type Ctx } from './gitlab-token.service';
import { executeVault, getVaultConfig, MAX_VAULT_ITEMS_PER_EXECUTION, runVaultScan } from './vault.service';
import type { VaultItem } from '@/lib/vault-rules';

const AUTO_KEY = 'vault.auto';
const STATUS_KEY = 'vault.autoStatus';
const LEASE_KEY = 'vault.autoLease';
const LEASE_MS = 30 * 60_000;

/** Rotação automática: roda COM o token GitLab de quem a habilitou (escolha explícita e revogável). */
export interface VaultAutoSettings {
  enabled: boolean;
  actorUserId: string;
  actorUsername: string | null;
  /** Linha de gitlab_token (não o valor!) usada nas chamadas. */
  tokenId: string;
  tokenName: string;
  enabledAt: string;
}
export interface VaultAutoStatus {
  at: string;
  scanId: string | null;
  candidates: number;
  done: number;
  partial: number;
  skipped: number;
  failed: number;
  /** Por que nada foi feito (token indisponível, conta banida, varredura falhou…). */
  problem: string | null;
}

const meta: RequestMeta = { ip: null, userAgent: 'vault-auto' };

export async function getAutoSettings(): Promise<VaultAutoSettings | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: AUTO_KEY } });
  const v = row?.value as Partial<VaultAutoSettings> | undefined;
  return v?.enabled && v.actorUserId && v.tokenId ? (v as VaultAutoSettings) : null;
}
export async function getAutoStatus(): Promise<VaultAutoStatus | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: STATUS_KEY } });
  return (row?.value as unknown as VaultAutoStatus | undefined) ?? null;
}
const saveStatus = (s: VaultAutoStatus) =>
  prisma.appSetting.upsert({
    where: { key: STATUS_KEY },
    create: { key: STATUS_KEY, value: s as unknown as Prisma.InputJsonObject },
    update: { value: s as unknown as Prisma.InputJsonObject },
  });

/** Habilita usando o token em uso por quem está logado (precisa da capability do cofre). */
export async function enableVaultAuto(ctx: Ctx): Promise<VaultAutoSettings> {
  const row = await resolveToken(ctx.actor.id, ctx.tokenId);
  if (!row) throw new ActionError('NO_GITLAB_TOKEN');
  if (!row.capabilities.includes('VAULT_TOKENS')) throw new ActionError('MISSING_CAPABILITY');
  const value: VaultAutoSettings = {
    enabled: true,
    actorUserId: ctx.actor.id,
    actorUsername: ctx.actor.username ?? null,
    tokenId: row.id,
    tokenName: row.name,
    enabledAt: new Date().toISOString(),
  };
  await prisma.appSetting.upsert({
    where: { key: AUTO_KEY },
    create: { key: AUTO_KEY, value: value as unknown as Prisma.InputJsonObject, updatedBy: ctx.actor.id },
    update: { value: value as unknown as Prisma.InputJsonObject, updatedBy: ctx.actor.id },
  });
  await recordAuditSafe({
    action: 'VAULT_AUTO_ENABLED',
    result: 'SUCCESS',
    actor: ctx.actor,
    meta: ctx.meta,
    metadata: { tokenId: row.id, tokenName: row.name, gitlabTokenId: row.gitlabTokenId },
  });
  return value;
}

export async function disableVaultAuto(ctx: Ctx, why = 'manual'): Promise<void> {
  const cur = await prisma.appSetting.findUnique({ where: { key: AUTO_KEY } });
  if (!cur) return;
  await prisma.appSetting.update({
    where: { key: AUTO_KEY },
    data: { value: { ...(cur.value as object), enabled: false }, updatedBy: ctx.actor.id },
  });
  await recordAuditSafe({ action: 'VAULT_AUTO_DISABLED', result: 'SUCCESS', actor: ctx.actor, meta: ctx.meta, metadata: { why } });
}

/** Concessão com prazo no banco: duas instâncias (ou dois gatilhos) nunca rodam ao mesmo tempo. */
async function acquireLease(): Promise<boolean> {
  const until = new Date(Date.now() + LEASE_MS).toISOString();
  const rows = await prisma.$queryRaw<{ key: string }[]>`
    INSERT INTO app_setting (key, value, updated_at) VALUES (${LEASE_KEY}, jsonb_build_object('until', ${until}::text), now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    WHERE (app_setting.value->>'until')::timestamptz < now()
    RETURNING key`;
  return rows.length > 0;
}
const releaseLease = () =>
  prisma.appSetting.update({ where: { key: LEASE_KEY }, data: { value: { until: new Date(0).toISOString() } } }).catch(() => undefined);

/** Itens que a automação trata: só os que venceram ou estão no prazo de alerta (nunca criação "do nada" nem correção de variáveis). */
export const autoCandidates = (items: VaultItem[]) =>
  items.filter((i) => (i.state === 'EXPIRING' || i.state === 'EXPIRED') && i.action && !i.blockedReason && !i.forced);

export type VaultAutoRun = { ran: false; reason: 'DISABLED' | 'BUSY' } | { ran: true; status: VaultAutoStatus };

/**
 * Uma passada da rotação automática: varre, escolhe os cofres no prazo de alerta/vencidos e aplica o mesmo fluxo seguro
 * da tela (criar → gravar → validar → revogar). Chamada pelo agendador interno ou por POST /api/internal/vault-auto.
 */
export async function runVaultAuto(): Promise<VaultAutoRun> {
  const auto = await getAutoSettings();
  if (!auto) return { ran: false, reason: 'DISABLED' };
  if (!(await acquireLease())) return { ran: false, reason: 'BUSY' };

  const status: VaultAutoStatus = {
    at: new Date().toISOString(),
    scanId: null,
    candidates: 0,
    done: 0,
    partial: 0,
    skipped: 0,
    failed: 0,
    problem: null,
  };
  const actor = { id: auto.actorUserId, username: auto.actorUsername };
  try {
    // Quem habilitou perdeu o acesso (banido, deixou de ser admin, token trocado/revogado): para e avisa, sem agir.
    const user = await prisma.user.findUnique({ where: { id: auto.actorUserId }, select: { role: true, banned: true } });
    const row = await resolveToken(auto.actorUserId, auto.tokenId);
    if (!user || user.banned || user.role !== 'admin') status.problem = 'ACTOR_UNAVAILABLE';
    else if (!row || row.id !== auto.tokenId || !row.capabilities.includes('VAULT_TOKENS')) status.problem = 'TOKEN_UNAVAILABLE';
    if (status.problem) return await finish(status, actor);

    const ctx: Ctx = { actor, meta, tokenId: auto.tokenId };
    const config = await getVaultConfig();
    const scanId = randomUUID();
    status.scanId = scanId;
    await prisma.adminScan.create({
      data: {
        id: scanId,
        kind: 'VAULT',
        actorUserId: actor.id,
        params: { ...config, force: false } as unknown as Prisma.InputJsonObject,
        progress: { phase: 'starting' },
      },
    });
    try {
      await runVaultScan(ctx, scanId);
    } catch (e) {
      status.problem = (e as { code?: string }).code ?? 'SCAN_FAILED';
      return await finish(status, actor);
    }
    const scan = await prisma.adminScan.findUniqueOrThrow({ where: { id: scanId } });
    const picked = autoCandidates((scan.items ?? []) as unknown as VaultItem[]).slice(0, MAX_VAULT_ITEMS_PER_EXECUTION);
    status.candidates = picked.length;
    if (picked.length > 0) {
      try {
        const r = await executeVault(ctx, {
          scanId,
          keys: picked.map((i) => i.key),
          reason: `Rotação automática: token vencido ou a ${config.warnDays} dias ou menos de vencer`,
          auto: true,
        });
        Object.assign(status, { done: r.done, partial: r.partial, skipped: r.skipped, failed: r.failed });
      } catch (e) {
        status.problem = (e as { code?: string }).code ?? 'EXECUTE_FAILED';
      }
    }
    return await finish(status, actor);
  } finally {
    await releaseLease();
  }
}

async function finish(status: VaultAutoStatus, actor: Ctx['actor']): Promise<VaultAutoRun> {
  await saveStatus(status);
  const bad = Boolean(status.problem) || status.failed > 0 || status.partial > 0;
  await recordAuditSafe({
    action: 'VAULT_AUTO_RUN',
    result: status.problem ? 'FAILURE' : bad ? 'PARTIAL' : 'SUCCESS',
    actor,
    meta,
    errorCode: status.problem,
    metadata: { ...status },
  });
  if (status.problem) logger.warn({ problem: status.problem }, 'rotação automática dos cofres não executou');
  return { ran: true, status };
}

/** Agendador interno (instrumentation.ts). `minutes` = 0 desliga; a concessão no banco evita execução simultânea. */
export function startVaultAutoScheduler(minutes: number): void {
  if (minutes <= 0) return;
  const g = globalThis as { __vaultAutoTimer?: NodeJS.Timeout };
  if (g.__vaultAutoTimer) return;
  const tick = () =>
    void runVaultAuto().catch((e) => logger.error({ err: e instanceof Error ? e.message : 'unknown' }, 'rotação automática falhou'));
  g.__vaultAutoTimer = setInterval(tick, minutes * 60_000);
  g.__vaultAutoTimer.unref();
  setTimeout(tick, 2 * 60_000).unref(); // primeira passada logo depois do boot
}
