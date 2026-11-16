import { AuditFilters, AuditTable, Pager } from '@/components/common/audit-view';
import { Button } from '@/components/ui/button';
import { href } from '@/lib/routes';
import { requireAdminPage } from '@/server/auth/guards';
import { parseAuditFilters, type AuditSearchParams } from '@/server/audit-filters';
import { listAudit } from '@/server/services/audit.service';
import { PageHeader } from '@/components/common/page-header';
import { ClipboardList } from 'lucide-react';

export default async function AdminAuditPage({ searchParams }: { searchParams: Promise<AuditSearchParams> }) {
  await requireAdminPage();
  const sp = await searchParams;
  const { filters, page } = parseAuditFilters(sp);
  const { items, pages, total } = await listAudit(filters, page);
  const exportQs = new URLSearchParams(Object.fromEntries(Object.entries(sp).filter(([k, v]) => v && k !== 'page') as [string, string][]));
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader
          icon={ClipboardList}
          tone="slate"
          title={
            <>
              Auditoria <span className="text-base font-normal text-muted-foreground">({total} registros)</span>
            </>
          }
        />
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
