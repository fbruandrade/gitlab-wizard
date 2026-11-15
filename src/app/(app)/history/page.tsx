import { AuditFilters, AuditTable, Pager } from '@/components/common/audit-view';
import { requireReadySession } from '@/server/auth/guards';
import { parseAuditFilters, type AuditSearchParams } from '@/server/audit-filters';
import { listAudit } from '@/server/services/audit.service';

export default async function HistoryPage({ searchParams }: { searchParams: Promise<AuditSearchParams> }) {
  const session = await requireReadySession();
  const sp = await searchParams;
  const { filters, page } = parseAuditFilters(sp);
  // O histórico pessoal é sempre restrito à própria conta, independente do papel.
  const { items, pages } = await listAudit({ ...filters, q: undefined, actorUserId: session.user.id }, page);
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <h1 className="text-2xl font-semibold">Meu histórico</h1>
      <AuditFilters sp={sp} />
      <AuditTable items={items} />
      <Pager base="/history" sp={sp} page={page} pages={pages} />
    </div>
  );
}
