'use client';
import { MoreHorizontal } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  banToolUserAction,
  createToolUserAction,
  resetToolUserPasswordAction,
  resetToolUserTwoFactorAction,
  revokeToolUserSessionsAction,
  setToolUserRoleAction,
  unbanToolUserAction,
} from '@/app/(app)/admin/users/actions';
import { useSensitiveAction, type ActionResult } from '@/components/auth/reauth-provider';
import { Field } from '@/components/common/field';
import { SecretDialog } from '@/components/common/secret-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { createToolUserSchema, reasonSchema } from '@/lib/schemas';

export interface ToolUserRow {
  id: string;
  username: string | null;
  name: string;
  email: string;
  role: string | null;
  banned: boolean | null;
  twoFactorEnabled: boolean | null;
  gitlabUsername: string | null;
}
type Pending = { kind: 'password' | 'twofactor' | 'role' | 'ban' | 'unban' | 'sessions'; user: ToolUserRow; role?: 'user' | 'admin' };

const COPY: Record<Pending['kind'], { title: string; confirm: string; warning?: string }> = {
  password: {
    title: 'Redefinir a senha',
    confirm: 'Redefinir',
    warning: 'Uma nova senha temporária será gerada, as sessões da conta serão encerradas e a troca será obrigatória.',
  },
  twofactor: {
    title: 'Resetar o 2FA da ferramenta',
    confirm: 'Resetar 2FA',
    warning: 'Use quando a pessoa perdeu o autenticador. Ela terá de configurar o 2FA de novo no próximo login.',
  },
  role: { title: 'Alterar o papel', confirm: 'Alterar' },
  ban: { title: 'Banir a conta', confirm: 'Banir', warning: 'A conta não poderá entrar e as sessões serão encerradas.' },
  unban: { title: 'Reativar a conta', confirm: 'Reativar' },
  sessions: { title: 'Encerrar todas as sessões', confirm: 'Encerrar' },
};

export function AdminUsers({ rows, currentUserId }: { rows: ToolUserRow[]; currentUserId: string }) {
  const router = useRouter();
  const run = useSensitiveAction();
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<{ title: string; description: string; value: string } | null>(null);

  async function confirm() {
    if (!pending) return;
    const parsed = reasonSchema.safeParse(reason);
    if (!parsed.success) return setError(parsed.error.issues[0]!.message);
    setBusy(true);
    setError(null);
    const base = { userId: pending.user.id, reason: parsed.data };
    let res: ActionResult<unknown>;
    switch (pending.kind) {
      case 'password':
        res = await run(() => resetToolUserPasswordAction(base));
        break;
      case 'twofactor':
        res = await run(() => resetToolUserTwoFactorAction(base));
        break;
      case 'role':
        res = await run(() => setToolUserRoleAction({ ...base, role: pending.role }));
        break;
      case 'ban':
        res = await run(() => banToolUserAction(base));
        break;
      case 'unban':
        res = await run(() => unbanToolUserAction(base));
        break;
      default:
        res = await run(() => revokeToolUserSessionsAction(base));
    }
    setBusy(false);
    if (!res.ok) return setError(res.message);
    if (pending.kind === 'password') {
      setSecret({
        title: `Nova senha temporária de ${pending.user.username}`,
        description: 'Entregue por um canal seguro. Ela precisará ser trocada no primeiro acesso e não será exibida de novo.',
        value: (res.data as { tempPassword: string }).tempPassword,
      });
    } else toast.success('Ação concluída.');
    setPending(null);
    setReason('');
    router.refresh();
  }

  return (
    <>
      <Table data-testid="tool-users">
        <TableHeader>
          <TableRow>
            <TableHead>Usuário</TableHead>
            <TableHead>Nome</TableHead>
            <TableHead>Papel</TableHead>
            <TableHead>2FA</TableHead>
            <TableHead>PAT GitLab</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((u) => (
            <TableRow key={u.id} data-username={u.username}>
              <TableCell className="font-medium">{u.username}</TableCell>
              <TableCell>{u.name}</TableCell>
              <TableCell>
                <Badge variant={u.role === 'admin' ? 'default' : 'secondary'}>{u.role}</Badge>
              </TableCell>
              <TableCell>{u.twoFactorEnabled ? '✔' : '✖'}</TableCell>
              <TableCell>{u.gitlabUsername ? `@${u.gitlabUsername}` : '—'}</TableCell>
              <TableCell>{u.banned ? <Badge variant="destructive">Banida</Badge> : <Badge variant="success">Ativa</Badge>}</TableCell>
              <TableCell>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button variant="ghost" size="icon-sm" aria-label={`Ações de ${u.username}`} data-testid={`menu-${u.username}`} />
                    }
                  >
                    <MoreHorizontal />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setPending({ kind: 'password', user: u })}>Redefinir senha</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setPending({ kind: 'twofactor', user: u })}>Resetar 2FA</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setPending({ kind: 'sessions', user: u })}>Encerrar sessões</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setPending({ kind: 'role', user: u, role: u.role === 'admin' ? 'user' : 'admin' })}>
                      {u.role === 'admin' ? 'Tornar usuário comum' : 'Tornar admin'}
                    </DropdownMenuItem>
                    {u.banned ? (
                      <DropdownMenuItem onClick={() => setPending({ kind: 'unban', user: u })}>Reativar conta</DropdownMenuItem>
                    ) : (
                      u.id !== currentUserId && (
                        <DropdownMenuItem onClick={() => setPending({ kind: 'ban', user: u })}>Banir conta</DropdownMenuItem>
                      )
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog
        open={pending !== null}
        onOpenChange={(o) => {
          if (!o) {
            setPending(null);
            setReason('');
            setError(null);
          }
        }}
      >
        <DialogContent data-testid="admin-reason-dialog">
          <DialogHeader>
            <DialogTitle>
              {pending && COPY[pending.kind].title}: {pending?.user.username}
            </DialogTitle>
            <DialogDescription>
              {pending?.kind === 'role'
                ? `Novo papel: ${pending.role}.`
                : 'Informe o motivo / nº do chamado. Fica registrado na auditoria.'}
            </DialogDescription>
          </DialogHeader>
          {pending && COPY[pending.kind].warning && (
            <Alert variant="destructive">
              <AlertDescription>⚠ {COPY[pending.kind].warning}</AlertDescription>
            </Alert>
          )}
          <Field id="admin-reason" label="Motivo / nº do chamado *">
            <Input id="admin-reason" value={reason} onChange={(e) => setReason(e.target.value)} autoComplete="off" />
          </Field>
          {error && (
            <Alert variant="destructive" role="alert" data-testid="admin-error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button variant="outline" autoFocus onClick={() => setPending(null)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              disabled={busy || reason.trim().length < 10}
              onClick={() => void confirm()}
              data-testid="admin-confirm"
            >
              {pending && COPY[pending.kind].confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SecretDialog
        open={secret !== null}
        title={secret?.title ?? ''}
        description={secret?.description ?? ''}
        secret={secret?.value ?? ''}
        onClose={() => setSecret(null)}
      />
    </>
  );
}

export function CreateUserDialog() {
  const router = useRouter();
  const run = useSensitiveAction();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ username: '', name: '', email: '', role: 'user', reason: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<{ username: string; value: string } | null>(null);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setV((p) => ({ ...p, [k]: e.target.value }));

  async function submit() {
    const parsed = createToolUserSchema.safeParse(v);
    if (!parsed.success) return setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
    setErrors({});
    setFormError(null);
    setBusy(true);
    const res = await run(() => createToolUserAction(parsed.data));
    setBusy(false);
    if (!res.ok) return setFormError(res.message);
    setOpen(false);
    setV({ username: '', name: '', email: '', role: 'user', reason: '' });
    setSecret({ username: res.data.username, value: res.data.tempPassword });
    router.refresh();
  }

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger render={<Button data-testid="new-account" />}>+ Nova conta</DialogTrigger>
        <DialogContent data-testid="create-user-dialog">
          <DialogHeader>
            <DialogTitle>Nova conta da ferramenta</DialogTitle>
            <DialogDescription>Uma senha temporária será gerada e exibida uma vez.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Field id="nu-username" label="Usuário" error={errors.username}>
              <Input id="nu-username" value={v.username} onChange={set('username')} autoComplete="off" />
            </Field>
            <Field id="nu-name" label="Nome" error={errors.name}>
              <Input id="nu-name" value={v.name} onChange={set('name')} autoComplete="off" />
            </Field>
            <Field id="nu-email" label="E-mail" error={errors.email}>
              <Input id="nu-email" type="email" value={v.email} onChange={set('email')} autoComplete="off" />
            </Field>
            <Field id="nu-role" label="Papel">
              <select
                id="nu-role"
                value={v.role}
                onChange={set('role')}
                className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm"
              >
                <option value="user">user</option>
                <option value="admin">admin</option>
              </select>
            </Field>
            <Field id="nu-reason" label="Motivo / nº do chamado *" error={errors.reason}>
              <Input id="nu-reason" value={v.reason} onChange={set('reason')} autoComplete="off" />
            </Field>
            {formError && (
              <Alert variant="destructive" role="alert" data-testid="create-error">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={() => void submit()} disabled={busy} data-testid="create-submit">
              Criar conta
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <SecretDialog
        open={secret !== null}
        title={`Conta criada: ${secret?.username}`}
        description="Senha temporária. Entregue por um canal seguro; será exigida a troca no primeiro acesso. Não será exibida de novo."
        secret={secret?.value ?? ''}
        onClose={() => setSecret(null)}
      />
    </>
  );
}
