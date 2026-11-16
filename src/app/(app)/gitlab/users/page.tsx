import Link from 'next/link';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { LicenseSummary } from '@/components/gitlab/license-summary';
import { StateBadge } from '@/components/gitlab/state-badge';
import { formatDateTime } from '@/lib/format';
import { href } from '@/lib/routes';
import { pageCtx } from '@/server/token-selection';
import { requireReadySession } from '@/server/auth/guards';
import { loadGitLab } from '@/server/page-gitlab';
import { getGitLabLicense, searchGitLabUsers } from '@/server/services/gitlab-user.service';
import { PageHeader } from '@/components/common/page-header';
import { Users } from 'lucide-react';

export default async function UsersPage({ searchParams }: { searchParams: Promise<{ q?: string; blocked?: string; page?: string }> }) {
  const session = await requireReadySession();
  const sp = await searchParams;
  const q = (sp.q ?? '').trim();
  const blocked = sp.blocked === '1';
  const page = Math.max(1, Number(sp.page) || 1);
  const qs = (p: number) => `?${new URLSearchParams({ ...(q && { q }), ...(blocked && { blocked: '1' }), page: String(p) })}`;

  const ctx = await pageCtx(session);
  // Busca e licença em paralelo; a licença é informativa: se falhar, a busca continua funcionando.
  const [res, license] = await Promise.all([
    q.length === 1 ? null : loadGitLab(() => searchGitLabUsers(ctx, { search: q || undefined, blocked, page })),
    loadGitLab(() => getGitLabLicense(ctx)),
  ]);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader icon={Users} tone="blue" title="Usuários GitLab" />
      <LicenseSummary result={license} />
      <form method="get" className="flex flex-wrap items-center gap-3" role="search">
        <Input
          name="q"
          defaultValue={q}
          placeholder="Buscar por username, nome ou e-mail"
          className="max-w-sm"
          aria-label="Buscar usuário"
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="blocked" value="1" defaultChecked={blocked} /> Somente bloqueados
        </label>
        <Button type="submit">Buscar</Button>
      </form>

      {q.length === 1 && (
        <Alert>
          <AlertDescription>Digite ao menos 2 caracteres.</AlertDescription>
        </Alert>
      )}
      {res && !res.ok && (
        <Alert variant="destructive" role="alert" data-testid="users-error">
          <AlertDescription>{res.message}</AlertDescription>
        </Alert>
      )}

      {res?.ok &&
        (res.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="users-empty">
            Nenhum usuário encontrado{q ? ` para '${q}'` : ''}.
          </p>
        ) : (
          <>
            <Table data-testid="users-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Usuário</TableHead>
                  <TableHead>Nome</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead>MFA</TableHead>
                  <TableHead>Último login</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {res.data.items.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell>
                      <Link className="font-medium underline-offset-2 hover:underline" href={href(`/gitlab/users/${u.id}`)}>
                        {u.username}
                      </Link>
                    </TableCell>
                    <TableCell>{u.name}</TableCell>
                    <TableCell>
                      <StateBadge state={u.state} />
                    </TableCell>
                    <TableCell>{u.two_factor_enabled ? '✔' : '—'}</TableCell>
                    <TableCell>{formatDateTime(u.last_sign_in_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex items-center justify-between text-sm">
              {page > 1 ? <Link href={href(qs(page - 1))}>‹ Anterior</Link> : <span />}
              <span className="text-muted-foreground">
                Página {page}
                {res.data.totalPages ? ` de ${res.data.totalPages}` : ''}
              </span>
              {res.data.nextPage ? <Link href={href(qs(res.data.nextPage))}>Próxima ›</Link> : <span />}
            </div>
          </>
        ))}
    </div>
  );
}
