import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { AuditLog } from '@/generated/prisma/client';
import { ACTION_GROUPS, labelFor } from '@/lib/audit-labels';
import { formatDateTime } from '@/lib/format';
import { href } from '@/lib/routes';
import type { AuditSearchParams } from '@/server/audit-filters';

const select = 'h-8 rounded-lg border border-input bg-background px-2 text-sm';

export function AuditFilters({ sp, admin }: { sp: AuditSearchParams; admin?: boolean }) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-3" role="search" aria-label="Filtros">
      <label className="text-xs">
        Tipo
        <br />
        <select name="group" defaultValue={sp.group ?? ''} className={select}>
          <option value="">Todos</option>
          {ACTION_GROUPS.map((g) => (
            <option key={g.value} value={g.value}>
              {g.label}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs">
        Resultado
        <br />
        <select name="result" defaultValue={sp.result ?? ''} className={select}>
          <option value="">Todos</option>
          {['SUCCESS', 'FAILURE', 'PARTIAL', 'UNKNOWN'].map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </label>
      <label className="text-xs">
        De
        <br />
        <Input type="date" name="from" defaultValue={sp.from} className="w-40" />
      </label>
      <label className="text-xs">
        Até
        <br />
        <Input type="date" name="to" defaultValue={sp.to} className="w-40" />
      </label>
      {admin && (
        <label className="text-xs">
          Conta, alvo ou motivo
          <br />
          <Input name="q" defaultValue={sp.q} className="w-56" />
        </label>
      )}
      <Button type="submit">Filtrar</Button>
    </form>
  );
}

const variant = (r: string) =>
  (r === 'SUCCESS' ? 'secondary' : r === 'FAILURE' ? 'destructive' : 'outline') as 'secondary' | 'destructive' | 'outline';

export function AuditTable({ items, showActor }: { items: AuditLog[]; showActor?: boolean }) {
  if (items.length === 0)
    return (
      <p className="text-sm text-muted-foreground" data-testid="audit-empty">
        Nenhum registro encontrado.
      </p>
    );
  return (
    <Table data-testid="audit-table">
      <TableHeader>
        <TableRow>
          <TableHead>Data/hora</TableHead>
          {showActor && <TableHead>Conta</TableHead>}
          <TableHead>Ação</TableHead>
          <TableHead>Alvo</TableHead>
          <TableHead>Resultado</TableHead>
          <TableHead>Motivo</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((a) => (
          <TableRow key={a.id}>
            <TableCell className="whitespace-nowrap">{formatDateTime(a.createdAt)}</TableCell>
            {showActor && <TableCell>{a.actorUsername ?? '—'}</TableCell>}
            <TableCell data-action={a.action}>{labelFor(a.action)}</TableCell>
            <TableCell>{a.targetLabel ?? '—'}</TableCell>
            <TableCell>
              <Badge variant={variant(a.result)}>
                {a.result}
                {a.errorCode ? ` · ${a.errorCode}` : ''}
              </Badge>
            </TableCell>
            <TableCell className="max-w-xs truncate" title={a.reason ?? ''}>
              {a.reason ?? '—'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function Pager({ base, sp, page, pages }: { base: string; sp: AuditSearchParams; page: number; pages: number }) {
  const link = (p: number) =>
    href(
      `${base}?${new URLSearchParams({ ...(Object.fromEntries(Object.entries(sp).filter(([, v]) => v)) as Record<string, string>), page: String(p) })}`,
    );
  return (
    <div className="flex items-center justify-between text-sm">
      {page > 1 ? <Link href={link(page - 1)}>‹ Anterior</Link> : <span />}
      <span className="text-muted-foreground">
        Página {page} de {pages}
      </span>
      {page < pages ? <Link href={link(page + 1)}>Próxima ›</Link> : <span />}
    </div>
  );
}
