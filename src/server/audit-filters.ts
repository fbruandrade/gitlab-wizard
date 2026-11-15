import 'server-only';
import type { AuditResult } from '@/generated/prisma/client';
import type { AuditFilters } from '@/server/services/audit.service';

const RESULTS = ['SUCCESS', 'FAILURE', 'PARTIAL', 'UNKNOWN'] as const;
export type AuditSearchParams = { group?: string; result?: string; from?: string; to?: string; q?: string; page?: string };

// America/Sao_Paulo está em UTC-3 o ano todo desde 2019 (sem horário de verão).
const day = (d?: string, end = false) =>
  d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T${end ? '23:59:59.999' : '00:00:00'}-03:00`) : undefined;

export function parseAuditFilters(sp: AuditSearchParams): { filters: AuditFilters; page: number } {
  return {
    filters: {
      actionPrefix: sp.group || undefined,
      result: (RESULTS as readonly string[]).includes(sp.result ?? '') ? (sp.result as AuditResult) : undefined,
      from: day(sp.from),
      to: day(sp.to, true),
      q: sp.q?.trim() || undefined,
    },
    page: Math.max(1, Number(sp.page) || 1),
  };
}
