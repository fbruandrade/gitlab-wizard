import 'server-only';
import { headers } from 'next/headers';
import { Prisma } from '@/generated/prisma/client';
import type { AuditResult } from '@/generated/prisma/client';
import { prisma } from '@/server/db';
import { env } from '@/server/env';
import { logger } from '@/server/logger';

export interface Actor {
  id?: string | null;
  username?: string | null;
}
export interface AuditTarget {
  type: 'gitlab_user' | 'tool_user' | 'gitlab_token' | 'gitlab_project' | 'gitlab_runner';
  id?: string | number | null;
  label?: string | null;
}
export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}
export interface AuditInput {
  action: string;
  result: AuditResult;
  actor?: Actor;
  target?: AuditTarget;
  reason?: string | null;
  errorCode?: string | null;
  metadata?: Prisma.InputJsonObject;
  meta?: RequestMeta;
}

/** IP só é lido de um header configurado (CLIENT_IP_HEADER): sem proxy confiável, o header é forjável. */
export function clientIpFrom(h: Headers): string | null {
  if (!env.CLIENT_IP_HEADER) return null;
  return h.get(env.CLIENT_IP_HEADER)?.split(',')[0]?.trim() || null;
}

export async function getRequestMeta(): Promise<RequestMeta> {
  const h = await headers();
  return { ip: clientIpFrom(h), userAgent: h.get('user-agent')?.slice(0, 300) ?? null };
}

export async function recordAudit(i: AuditInput): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorUserId: i.actor?.id ?? null,
      actorUsername: i.actor?.username ?? null,
      action: i.action,
      result: i.result,
      targetType: i.target?.type ?? null,
      targetId: i.target?.id != null ? String(i.target.id) : null,
      targetLabel: i.target?.label ?? null,
      reason: i.reason ?? null,
      errorCode: i.errorCode ?? null,
      metadata: i.metadata,
      ipAddress: i.meta?.ip ?? null,
      userAgent: i.meta?.userAgent ?? null,
    },
  });
}

/** Auditoria de eventos que acontecem fora de um request Next (ex.: hooks do better-auth, scripts). */
export async function recordAuditSafe(i: AuditInput): Promise<void> {
  try {
    await recordAudit(i);
  } catch (e) {
    // Falhar em auditar não pode derrubar login; fica registrado no log estruturado.
    logger.error({ err: e instanceof Error ? e.message : 'unknown', action: i.action }, 'falha ao gravar auditoria');
  }
}

/**
 * Executa `fn` e audita SUCCESS/FAILURE. Falhas também são auditadas (com o código de erro) e relançadas.
 * `fn` pode devolver `metadata` (ex.: estado antes/depois) e `result` para casos PARTIAL/UNKNOWN.
 */
export async function withAudit<T>(
  base: Omit<AuditInput, 'result' | 'errorCode' | 'metadata'>,
  fn: () => Promise<{ value: T; metadata?: Prisma.InputJsonObject; result?: AuditResult }>,
): Promise<T> {
  try {
    const { value, metadata, result } = await fn();
    await recordAuditSafe({ ...base, result: result ?? 'SUCCESS', metadata });
    return value;
  } catch (e) {
    const errorCode = (e as { code?: string }).code ?? 'INTERNAL';
    await recordAuditSafe({ ...base, result: 'FAILURE', errorCode: String(errorCode) });
    throw e;
  }
}

export interface AuditFilters {
  actorUserId?: string;
  action?: string;
  actionPrefix?: string;
  result?: AuditResult;
  from?: Date;
  to?: Date;
  q?: string;
}

export function auditWhere(f: AuditFilters): Prisma.AuditLogWhereInput {
  return {
    ...(f.actorUserId && { actorUserId: f.actorUserId }),
    ...(f.action && { action: f.action }),
    ...(f.actionPrefix && { action: { startsWith: f.actionPrefix } }),
    ...(f.result && { result: f.result }),
    ...((f.from || f.to) && { createdAt: { ...(f.from && { gte: f.from }), ...(f.to && { lte: f.to }) } }),
    ...(f.q && {
      OR: [
        { actorUsername: { contains: f.q, mode: 'insensitive' } },
        { targetLabel: { contains: f.q, mode: 'insensitive' } },
        { reason: { contains: f.q, mode: 'insensitive' } },
      ],
    }),
  };
}

export async function listAudit(f: AuditFilters, page = 1, pageSize = 25) {
  const where = auditWhere(f);
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.auditLog.count({ where }),
  ]);
  return { items, total, pages: Math.max(1, Math.ceil(total / pageSize)) };
}
