import { AuditFilters, AuditTable, Pager } from '@/components/common/audit-view';
import { Button } from '@/components/ui/button';
import { href } from '@/lib/routes';
import { requireAdminPage } from '@/server/auth/guards';
import { parseAuditFilters, type AuditSearchParams } from '@/server/audit-filters';
import { listAudit } from '@/server/services/audit.service';

export default async function AdminAuditPage({ searchParams }: { searchParams: Promise<AuditSearchParams> }) {
  await requireAdminPage();
  const sp = await searchParams;
  const { filters, page } = parseAuditFilters(sp);
  const { items, pages, total } = await listAudit(filters, page);
  const exportQs = new URLSearchParams(Object.fromEntries(Object.entries(sp).filter(([k, v]) => v && k !== 'page') as [string, string][]));
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">
          Auditoria <span className="text-base font-normal text-muted-foreground">({total} registros)</span>
        </h1>
        {/* download: rota de Route Handler, não navegação do router */}
        <Button variant="outline" nativeButton={false} render={<a href={href(`/admin/audit/export?${exportQs}`) as string} download />}>
          Exportar CSV
        </Button>
      </div>
      <AuditFilters sp={sp} admin />
      <AuditTable items={items} showActor />
      <Pager base="/admin/audit" sp={sp} page={page} pages={pages} />
    </div>
  );
}
