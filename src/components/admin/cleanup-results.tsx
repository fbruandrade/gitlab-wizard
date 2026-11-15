'use client';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { executeCleanupAction } from '@/app/(app)/admin/cleanup/actions';
import { useSensitiveAction } from '@/components/auth/reauth-provider';
import { Field } from '@/components/common/field';
import { ScopeBadges } from '@/components/common/scope-badges';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CLEANUP_CONFIRM_WORD } from '@/lib/admin-schemas';
import { isPrivilegedScope, usageTypeLabel, type CleanupItem } from '@/lib/cleanup-rules';
import { formatDate } from '@/lib/format';
import { reasonSchema } from '@/lib/schemas';

const MAX_ROWS = 1000;
const REASON_LABEL = { USER_BLOCKED: 'Usuário bloqueado', UNUSED: 'Sem uso' } as const;
const PROTECTED_LABEL = { SELF: 'Sua própria conta', LINKED_IN_TOOL: 'Em uso nesta ferramenta' } as const;
const CODE_LABEL: Record<string, string> = { CHANGED: 'mudou desde a varredura', ABORTED: 'execução interrompida' };

interface Summary {
  usersScanned: number;
  total: number;
  selectable: number;
  protected: number;
  pat: number;
  sshKey: number;
  blocked: number;
  unused: number;
  excluded: { bots: number; unknownOwner: number };
  sshLastUsedUnavailable: boolean;
}
interface ExecResult {
  revoked: number;
  skipped: number;
  failed: number;
  results: { key: string; status: string; code?: string }[];
}

/** Token: escopos. Chave SSH (sem escopos): tipo de uso. */
function ScopeCell({ item }: { item: CleanupItem }) {
  if (item.kind === 'SSH_KEY') {
    const label = usageTypeLabel(item.usageType);
    return label ? <Badge variant="outline">{label}</Badge> : <span className="text-muted-foreground">—</span>;
  }
  return <ScopeBadges scopes={item.scopes} />;
}

export function CleanupResults({ scanId, items, summary }: { scanId: string; items: CleanupItem[]; summary: Summary }) {
  const router = useRouter();
  const run = useSensitiveAction();
  const selectable = useMemo(() => items.filter((i) => !i.protectedReason), [items]);
  const privilegedTokens = useMemo(
    () => selectable.filter((i) => i.kind === 'PAT' && i.scopes?.some(isPrivilegedScope)).length,
    [selectable],
  );
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExecResult | null>(null);

  const shown = items.slice(0, MAX_ROWS);
  const allSelected = selectable.length > 0 && selectable.every((i) => selected.has(i.key));
  const toggle = (k: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(selectable.slice(0, 500).map((i) => i.key)));
  const byKey = new Map(items.map((i) => [i.key, i]));

  async function execute() {
    const parsed = reasonSchema.safeParse(reason);
    if (!parsed.success) return setError(parsed.error.issues[0]!.message);
    setBusy(true);
    setError(null);
    const res = await run(() => executeCleanupAction({ scanId, keys: [...selected], reason: parsed.data, confirm }));
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setOpen(false);
    setReason('');
    setConfirm('');
    setSelected(new Set());
    setResult(res.data);
    toast.success(`${res.data.revoked} credencial(is) revogada(s).`);
    router.refresh();
  }

  return (
    <div className="space-y-4" data-testid="cleanup-results">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm" data-testid="scan-summary">
        <span>
          <strong data-testid="sum-selectable">{summary.selectable}</strong> revogáveis
        </span>
        <span>
          {summary.pat} token(s) · {summary.sshKey} chave(s) SSH
        </span>
        {privilegedTokens > 0 && (
          <span data-testid="sum-privileged" className="font-medium text-destructive">
            {privilegedTokens} token(s) com escopo privilegiado
          </span>
        )}
        <span>
          {summary.blocked} por usuário bloqueado · {summary.unused} por falta de uso
        </span>
        <span className="text-muted-foreground">
          {summary.usersScanned} usuários lidos · {summary.protected} protegido(s) · {summary.excluded.bots} de bots ignorado(s)
        </span>
      </div>

      {summary.sshLastUsedUnavailable && (
        <Alert data-testid="ssh-warning">
          <AlertDescription>
            O GitLab <strong>não informou o último uso de algumas chaves SSH</strong> (campo ausente). Essas chaves <strong>não</strong>{' '}
            foram consideradas “sem uso” (sem dado, não se revoga); só entram se o usuário estiver bloqueado.
          </AlertDescription>
        </Alert>
      )}

      {result && (
        <Alert data-testid="exec-result">
          <AlertDescription>
            <strong>{result.revoked}</strong> revogada(s) · <strong>{result.skipped}</strong> ignorada(s) · <strong>{result.failed}</strong>{' '}
            com falha.
            {result.results.filter((r) => r.status !== 'REVOKED').length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-xs">
                {result.results
                  .filter((r) => r.status !== 'REVOKED')
                  .slice(0, 20)
                  .map((r) => (
                    <li key={r.key}>
                      {byKey.get(r.key)?.username} — {byKey.get(r.key)?.name}:{' '}
                      {r.status === 'SKIPPED' ? (CODE_LABEL[r.code ?? ''] ?? 'ignorada') : `falhou (${r.code})`}
                    </li>
                  ))}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="scan-empty">
          Nada a revogar com estes critérios.
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                aria-label="Selecionar todos os revogáveis"
                data-testid="select-all"
              />{' '}
              Selecionar todos os revogáveis{selectable.length > 500 ? ' (primeiros 500)' : ''}
            </label>
            <Dialog
              open={open}
              onOpenChange={(o) => {
                setOpen(o);
                if (!o) setError(null);
              }}
            >
              <DialogTrigger render={<Button variant="destructive" disabled={selected.size === 0} data-testid="revoke-open" />}>
                Revogar selecionados ({selected.size})
              </DialogTrigger>
              <DialogContent data-testid="revoke-dialog">
                <DialogHeader>
                  <DialogTitle>Revogar {selected.size} credencial(is)?</DialogTitle>
                  <DialogDescription>
                    Tokens revogados e chaves SSH removidas não podem ser restaurados. Cada item será conferido de novo no GitLab antes de
                    ser revogado.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  <Field
                    id="rv-reason"
                    label="Motivo / nº do chamado *"
                    hint="Mínimo de 10 caracteres. Fica registrado na auditoria de cada item."
                  >
                    <Input id="rv-reason" value={reason} onChange={(e) => setReason(e.target.value)} autoComplete="off" />
                  </Field>
                  <Field id="rv-confirm" label={`Digite ${CLEANUP_CONFIRM_WORD} para confirmar *`}>
                    <Input id="rv-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
                  </Field>
                  {error && (
                    <Alert variant="destructive" role="alert" data-testid="revoke-error">
                      <AlertDescription>{error}</AlertDescription>
                    </Alert>
                  )}
                </div>
                <DialogFooter>
                  <Button variant="outline" autoFocus onClick={() => setOpen(false)}>
                    Cancelar
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={busy || confirm !== CLEANUP_CONFIRM_WORD || reason.trim().length < 10}
                    onClick={() => void execute()}
                    data-testid="revoke-confirm"
                  >
                    {busy ? 'Revogando…' : 'Revogar'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>

          <Table data-testid="cleanup-table">
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <span className="sr-only">Selecionar</span>
                </TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Usuário</TableHead>
                <TableHead>Credencial</TableHead>
                <TableHead>Escopos</TableHead>
                <TableHead>Último uso</TableHead>
                <TableHead>Criada</TableHead>
                <TableHead>Motivo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((i) => (
                <TableRow key={i.key} data-key={i.key} data-protected={Boolean(i.protectedReason)}>
                  <TableCell>
                    <input
                      type="checkbox"
                      disabled={Boolean(i.protectedReason)}
                      checked={selected.has(i.key)}
                      onChange={() => toggle(i.key)}
                      aria-label={`Selecionar ${i.name} de ${i.username}`}
                    />
                  </TableCell>
                  <TableCell>{i.kind === 'PAT' ? 'Token' : 'Chave SSH'}</TableCell>
                  <TableCell>
                    {i.username} <Badge variant={i.userState === 'active' ? 'secondary' : 'destructive'}>{i.userState}</Badge>
                  </TableCell>
                  <TableCell className="max-w-48 truncate" title={i.name}>
                    {i.name}
                  </TableCell>
                  <TableCell>
                    <ScopeCell item={i} />
                  </TableCell>
                  <TableCell>{i.lastUsedAt ? formatDate(i.lastUsedAt) : 'nunca usada'}</TableCell>
                  <TableCell>{formatDate(i.createdAt)}</TableCell>
                  <TableCell className="space-x-1">
                    {i.reasons.map((r) => (
                      <Badge key={r} variant="outline">
                        {REASON_LABEL[r]}
                      </Badge>
                    ))}
                    {i.protectedReason && <Badge>{PROTECTED_LABEL[i.protectedReason]} — protegido</Badge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {items.length > MAX_ROWS && (
            <p className="text-xs text-muted-foreground">
              Exibindo os primeiros {MAX_ROWS} de {items.length}. Refine os critérios para ver o restante.
            </p>
          )}
        </>
      )}
    </div>
  );
}
