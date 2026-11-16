'use client';
import { CircleCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { executeVaultAction } from '@/app/(app)/admin/vault/actions';
import { useSensitiveAction } from '@/components/auth/reauth-provider';
import { Field } from '@/components/common/field';
import { ScopeBadges } from '@/components/common/scope-badges';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { VAULT_CONFIRM_WORD } from '@/lib/admin-schemas';
import { formatDate } from '@/lib/format';
import { messageFor } from '@/lib/messages';
import { reasonSchema } from '@/lib/schemas';
import { ACCESS_LEVELS, ACTION_LABEL, BLOCKED_LABEL, STATE_LABEL, daysUntil, type VaultItem, type VaultState } from '@/lib/vault-rules';

interface Summary {
  projects: number;
  total: number;
  actionable: number;
  byState: Record<string, number>;
  inaccessible: { projectPath: string; code: string }[];
}
interface ExecResult {
  done: number;
  partial: number;
  skipped: number;
  failed: number;
  results: { key: string; projectPath: string; status: string; code?: string }[];
}

const TONE: Record<VaultState, 'success' | 'warning' | 'destructive' | 'info'> = {
  OK: 'success',
  EXPIRING: 'warning',
  OUT_OF_SYNC: 'warning',
  VARS_MISSING: 'warning',
  NO_TARGET_GROUP: 'warning',
  EXPIRED: 'destructive',
  NO_TOKEN: 'destructive',
  MULTIPLE_TOKENS: 'destructive',
  UNVERIFIED: 'info',
};
const variantFor = (s: VaultState) => TONE[s];

function Validity({ item }: { item: VaultItem }) {
  if (item.tokens.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <ul className="space-y-1">
      {item.tokens.map((t) => {
        const d = daysUntil(t.expiresAt, new Date());
        return (
          <li key={t.id} className="text-xs">
            {t.expiresAt ? formatDate(t.expiresAt) : 'sem validade'}
            {d !== null && <span className="text-muted-foreground"> ({d < 0 ? `venceu há ${-d} d` : `${d} d`})</span>}
          </li>
        );
      })}
    </ul>
  );
}

function Plan({ item }: { item: VaultItem }) {
  if (item.blockedReason) return <span className="text-xs text-muted-foreground">{BLOCKED_LABEL[item.blockedReason]}</span>;
  if (!item.action || !item.plan) return <span className="text-muted-foreground">—</span>;
  const p = item.plan;
  return (
    <div className="space-y-1 text-xs" data-testid="vault-plan">
      <div className="font-medium">
        {ACTION_LABEL[item.action]}
        {item.forced && (
          <Badge variant="warning" className="ml-1" data-testid="vault-forced">
            renovação forçada
          </Badge>
        )}
      </div>
      {item.action !== 'WRITE_VARS' && (
        <div>
          Token novo <code>{p.tokenName}</code> · {p.scopes.join(', ')} ·{' '}
          {ACCESS_LEVELS[p.accessLevel as keyof typeof ACCESS_LEVELS] ?? p.accessLevel} · até {formatDate(p.expiresAt)}
        </div>
      )}
      {p.vars.map((v) => (
        <div key={v.key}>
          {v.op === 'CREATE' ? 'Criar' : 'Atualizar'} <code>{v.key}</code> em <code>/{item.targetGroup?.fullPath}</code>
        </div>
      ))}
      {p.revokeTokenId !== null && <div>Revogar o token antigo (#{p.revokeTokenId}) só depois de validar o novo.</div>}
    </div>
  );
}

export function VaultResults({ scanId, items, summary }: { scanId: string; items: VaultItem[]; summary: Summary }) {
  const router = useRouter();
  const run = useSensitiveAction();
  const actionable = useMemo(() => items.filter((i) => i.action && !i.blockedReason), [items]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState<'ALL' | 'ACTION'>('ALL');
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExecResult | null>(null);

  const shown = filter === 'ACTION' ? actionable : items;
  const allSelected = actionable.length > 0 && actionable.every((i) => selected.has(i.key));
  const toggle = (k: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const selectedItems = items.filter((i) => selected.has(i.key));

  async function execute() {
    const parsed = reasonSchema.safeParse(reason);
    if (!parsed.success) return setError(parsed.error.issues[0]!.message);
    setBusy(true);
    setError(null);
    const res = await run(() => executeVaultAction({ scanId, keys: [...selected], reason: parsed.data, confirm }));
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setOpen(false);
    setReason('');
    setConfirm('');
    setSelected(new Set());
    setResult(res.data);
    toast.success(`${res.data.done} cofre(s) concluído(s).`);
    router.refresh();
  }

  return (
    <div className="space-y-4" data-testid="vault-results">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm" data-testid="vault-summary">
        <span>
          <strong data-testid="vault-sum-actionable">{summary.actionable}</strong> com ação possível
        </span>
        <span>{summary.total} cofre(s) analisado(s)</span>
        {Object.entries(summary.byState).map(([s, n]) => (
          <span key={s} className="text-muted-foreground">
            {STATE_LABEL[s as VaultState] ?? s}: {n}
          </span>
        ))}
      </div>

      {summary.total > 0 && Object.keys(summary.byState).every((s) => s === 'OK') && (
        <div
          className="flex items-center gap-2 rounded-lg bg-success-soft px-3 py-2 text-sm font-medium text-success"
          data-testid="vault-all-ok"
        >
          <CircleCheck className="size-4" aria-hidden="true" />
          Tudo em ordem: nenhum token vencido ou perto de vencer, e as variáveis estão em sincronia.
        </div>
      )}

      {summary.inaccessible.length > 0 && (
        <Alert data-testid="vault-inaccessible">
          <AlertDescription>
            {summary.inaccessible.length} projeto(s) não puderam ser lidos com o seu token (sem papel Maintainer?):{' '}
            {summary.inaccessible
              .slice(0, 5)
              .map((p) => p.projectPath)
              .join(', ')}
            {summary.inaccessible.length > 5 ? '…' : ''}
          </AlertDescription>
        </Alert>
      )}

      {result && (
        <Alert data-testid="vault-exec-result">
          <AlertDescription>
            <strong>{result.done}</strong> concluído(s) · <strong>{result.partial}</strong> parcial(is) · <strong>{result.skipped}</strong>{' '}
            ignorado(s) · <strong>{result.failed}</strong> com falha.
            {result.results.filter((r) => r.status !== 'DONE').length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-xs">
                {result.results
                  .filter((r) => r.status !== 'DONE')
                  .map((r) => (
                    <li key={r.key}>
                      <code>{r.projectPath}</code>:{' '}
                      {r.code === 'CHANGED'
                        ? 'mudou desde a varredura'
                        : r.code === 'IN_PROGRESS'
                          ? 'já em andamento'
                          : messageFor(r.code ?? 'INTERNAL')}
                    </li>
                  ))}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="vault-empty">
          Nenhum cofre encontrado no formato grupo/ambiente/aplicação.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(actionable.slice(0, 50).map((i) => i.key)))}
                  aria-label="Selecionar todos com ação"
                  data-testid="vault-select-all"
                />
                Selecionar todos com ação{actionable.length > 50 ? ' (primeiros 50)' : ''}
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={filter === 'ACTION'} onChange={(e) => setFilter(e.target.checked ? 'ACTION' : 'ALL')} /> Só
                com ação
              </label>
            </div>
            <Dialog
              open={open}
              onOpenChange={(o) => {
                setOpen(o);
                if (!o) setError(null);
              }}
            >
              <DialogTrigger render={<Button disabled={selected.size === 0} data-testid="vault-apply-open" />}>
                Aplicar nos selecionados ({selected.size})
              </DialogTrigger>
              <DialogContent data-testid="vault-dialog">
                <DialogHeader>
                  <DialogTitle>Aplicar em {selected.size} cofre(s)?</DialogTitle>
                  <DialogDescription>
                    Cada cofre é conferido de novo no GitLab antes. O token antigo só é revogado depois que o novo estiver gravado e
                    validado. Os valores dos tokens nunca são exibidos nem registrados.
                  </DialogDescription>
                </DialogHeader>
                <ul className="max-h-40 overflow-auto text-xs">
                  {selectedItems.map((i) => (
                    <li key={i.key}>
                      <code>{i.projectPath}</code> — {i.action ? ACTION_LABEL[i.action] : ''}
                    </li>
                  ))}
                </ul>
                <div className="space-y-3">
                  <Field id="vt-reason" label="Motivo / nº do chamado *" hint="Mínimo de 10 caracteres. Fica na auditoria.">
                    <Input id="vt-reason" value={reason} onChange={(e) => setReason(e.target.value)} autoComplete="off" />
                  </Field>
                  <Field id="vt-confirm" label={`Digite ${VAULT_CONFIRM_WORD} para confirmar *`}>
                    <Input id="vt-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
                  </Field>
                  {error && (
                    <Alert variant="destructive" role="alert" data-testid="vault-error">
                      <AlertDescription>{error}</AlertDescription>
                    </Alert>
                  )}
                </div>
                <DialogFooter>
                  <Button variant="outline" autoFocus onClick={() => setOpen(false)}>
                    Cancelar
                  </Button>
                  <Button
                    disabled={busy || confirm !== VAULT_CONFIRM_WORD || reason.trim().length < 10}
                    onClick={() => void execute()}
                    data-testid="vault-apply-confirm"
                  >
                    {busy ? 'Aplicando…' : 'Aplicar'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>

          <Table data-testid="vault-table">
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <span className="sr-only">Selecionar</span>
                </TableHead>
                <TableHead>Cofre</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Escopos / papel</TableHead>
                <TableHead>Validade</TableHead>
                <TableHead>Grupo de destino</TableHead>
                <TableHead>O que será feito</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((i) => (
                <TableRow key={i.key} data-key={i.key} data-state={i.state}>
                  <TableCell>
                    <input
                      type="checkbox"
                      disabled={!i.action || Boolean(i.blockedReason)}
                      checked={selected.has(i.key)}
                      onChange={() => toggle(i.key)}
                      aria-label={`Selecionar ${i.projectPath}`}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{i.app}</div>
                    <div className="text-xs text-muted-foreground">{i.env}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={variantFor(i.state)}>{STATE_LABEL[i.state]}</Badge>
                  </TableCell>
                  <TableCell>
                    {i.tokens[0] ? (
                      <div className="space-y-1">
                        <ScopeBadges scopes={i.tokens[0].scopes} />
                        <div className="text-xs text-muted-foreground">
                          {ACCESS_LEVELS[i.tokens[0].accessLevel as keyof typeof ACCESS_LEVELS] ?? '—'}
                        </div>
                      </div>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>
                    <Validity item={i} />
                  </TableCell>
                  <TableCell>{i.targetGroup ? <code className="text-xs">/{i.targetGroup.fullPath}</code> : '—'}</TableCell>
                  <TableCell>
                    <Plan item={i} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </div>
  );
}
