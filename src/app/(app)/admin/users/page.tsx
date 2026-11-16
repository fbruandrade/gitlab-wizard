import { AdminUsers, CreateUserDialog } from '@/components/admin/admin-users';
import { Pager } from '@/components/common/audit-view';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { requireAdminPage } from '@/server/auth/guards';
import { listToolUsers } from '@/server/services/tool-user.service';
import { PageHeader } from '@/components/common/page-header';
import { ShieldUser } from 'lucide-react';

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const session = await requireAdminPage();
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const { items, pages } = await listToolUsers(sp.q?.trim() || undefined, page);
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader icon={ShieldUser} tone="blue" title="Contas da ferramenta" />
        <CreateUserDialog />
      </div>
      <form method="get" className="flex gap-2" role="search">
        <Input
          name="q"
          defaultValue={sp.q}
          placeholder="Buscar por usuário, nome ou e-mail"
          className="max-w-sm"
          aria-label="Buscar conta"
        />
        <Button type="submit">Buscar</Button>
      </form>
      <AdminUsers
        currentUserId={session.user.id}
        rows={items.map((u) => ({
          id: u.id,
          username: u.username,
          name: u.name,
          email: u.email,
          role: u.role,
          banned: u.banned,
          twoFactorEnabled: u.twoFactorEnabled,
          gitlabUsername: u.gitlabTokens[0]?.gitlabUsername ?? null,
        }))}
      />
      <Pager base="/admin/users" sp={{ q: sp.q }} page={page} pages={pages} />
    </div>
  );
}
