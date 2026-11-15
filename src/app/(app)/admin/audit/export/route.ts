import { NextResponse } from 'next/server';
import { csvCell } from '@/lib/csv';
import { auth } from '@/server/auth/auth';
import { clientIpFrom, auditWhere, recordAuditSafe } from '@/server/services/audit.service';
import { parseAuditFilters, type AuditSearchParams } from '@/server/audit-filters';
import { prisma } from '@/server/db';

export const dynamic = 'force-dynamic';

const HEADER = ['data_hora_utc', 'conta', 'acao', 'resultado', 'alvo_tipo', 'alvo', 'motivo', 'codigo_erro', 'ip'];

export async function GET(req: Request) {
  const session = await auth.api.getSession({ headers: req.headers, query: { disableCookieCache: true } });
  if (!session) return new NextResponse(null, { status: 401 });
  if (session.user.role !== 'admin') return new NextResponse(null, { status: 403 });

  const sp = Object.fromEntries(new URL(req.url).searchParams) as AuditSearchParams;
  const { filters } = parseAuditFilters(sp);
  const where = auditWhere(filters);

  await recordAuditSafe({
    action: 'AUDIT_EXPORTED',
    result: 'SUCCESS',
    actor: { id: session.user.id, username: session.user.username },
    meta: { ip: clientIpFrom(req.headers), userAgent: req.headers.get('user-agent') },
    metadata: { filters: sp as Record<string, string> },
  });

  const encoder = new TextEncoder();
  let cursor: string | undefined;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('\uFEFF' + HEADER.join(',') + '\n')); // BOM: Excel abre em UTF-8
    },
    async pull(controller) {
      const rows = await prisma.auditLog.findMany({
        where,
        orderBy: { id: 'asc' },
        take: 500,
        ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      });
      if (rows.length === 0) return controller.close();
      cursor = rows.at(-1)!.id;
      controller.enqueue(
        encoder.encode(
          rows
            .map((a) =>
              [
                a.createdAt.toISOString(),
                a.actorUsername,
                a.action,
                a.result,
                a.targetType,
                a.targetLabel,
                a.reason,
                a.errorCode,
                a.ipAddress,
              ]
                .map(csvCell)
                .join(','),
            )
            .join('\n') + '\n',
        ),
      );
    },
  });
  return new NextResponse(stream, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="auditoria-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
