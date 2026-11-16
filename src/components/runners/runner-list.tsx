'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { deleteRunnerAction, setRunnerPausedAction } from '@/app/(app)/runners/actions';
import { useSensitiveAction } from '@/components/auth/reauth-provider';
import { Field } from '@/components/common/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DELETE_RUNNER_WORD, type RunnerType } from '@/lib/runner-rules';

export interface RunnerRow {
  id: number;
  description: string | null;
  paused: boolean;
  status: string | null;
  type: string | null;
  /** undefined = o GitLab não devolveu as tags deste runner (falha ao buscar o detalhe). */
  tags?: string[];
}
type Scope = { type: 'instance_type' } | { type: Exclude<RunnerType, 'instance_type'>; id: number };

const STATUS: Record<string, { label: string; variant: 'success' | 'warning' | 'outline' | 'destructive' }> = {
  online: { label: 'online', variant: 'success' },
  offline: { label: 'offline', variant: 'warning' },
  stale: { label: 'sem contato', variant: 'destructive' },
  never_contacted: { label: 'nunca conectou', variant: 'outline' },
};

export function RunnerList({ runners, scope }: { runners: RunnerRow[]; scope: Scope }) {
  const router = useRouter();
  const run = useSensitiveAction();
  const [target, setTarget] = useState<RunnerRow | null>(null);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(r: RunnerRow) {
    const res = await run(() => setRunnerPausedAction({ runnerId: r.id, paused: !r.paused, scope }));
    if (!res.ok) return toast.error(res.message);
    toast.success(r.paused ? 'Runner retomado.' : 'Runner pausado.');
    router.refresh();
  }

  async function remove() {
    if (!target) return;
    setBusy(true);
    setError(null);
    const res = await run(() => deleteRunnerAction({ runnerId: target.id, reason, confirm, scope }));
    setBusy(false);
    if (!res.ok) return setError(res.message);
    toast.success(`Runner #${target.id} removido.`);
    setTarget(null);
    setReason('');
    setConfirm('');
    router.refresh();
  }

  if (runners.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="runners-empty">
        Nenhum runner neste escopo.
      </p>
    );
  }

  return (
    <>
      <Table data-testid="runners-table">
        <TableHeader>
          <TableRow>
            <TableHead>#</TableHead>
            <TableHead>Descrição</TableHead>
            <TableHead>Estado</TableHead>
            <TableHead>Tags</TableHead>
            <TableHead className="text-right">Ações</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runners.map((r) => {
            const st = STATUS[r.status ?? ''] ?? { label: r.status ?? '—', variant: 'outline' as const };
            return (
              <TableRow key={r.id} data-runner={r.id}>
                <TableCell>{r.id}</TableCell>
                <TableCell className="max-w-64 truncate" title={r.description ?? ''}>
                  {r.description || <span className="text-muted-foreground">sem descrição</span>}
                </TableCell>
                <TableCell className="space-x-1">
                  <Badge variant={st.variant}>{st.label}</Badge>
                  {r.paused && <Badge variant="warning">pausado</Badge>}
                </TableCell>
                <TableCell>
                  {r.tags === undefined ? (
                    <span className="text-muted-foreground" title="O GitLab não devolveu as tags deste runner.">
                      indisponível
                    </span>
                  ) : r.tags.length === 0 ? (
                    <span className="text-muted-foreground">sem tags</span>
                  ) : (
                    <span className="flex max-w-56 flex-wrap gap-1" data-testid={`runner-tags-${r.id}`}>
                      {r.tags.map((t) => (
                        <Badge key={t} variant="secondary">
                          {t}
                        </Badge>
                      ))}
                    </span>
                  )}
                </TableCell>
                <TableCell className="space-x-2 text-right">
                  <Button variant="outline" size="sm" onClick={() => void toggle(r)} data-testid={`runner-pause-${r.id}`}>
                    {r.paused ? 'Retomar' : 'Pausar'}
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => setTarget(r)} data-testid={`runner-delete-${r.id}`}>
                    Remover
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <Dialog open={target !== null} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent data-testid="runner-delete-dialog">
          <DialogHeader>
            <DialogTitle>Remover o runner #{target?.id}?</DialogTitle>
            <DialogDescription>
              O runner deixa de existir no GitLab e os jobs que dependem das tags dele ficam sem executor. Não há como desfazer.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Field id="rd-reason" label="Motivo / nº do chamado *">
              <Input id="rd-reason" value={reason} onChange={(e) => setReason(e.target.value)} autoComplete="off" />
            </Field>
            <Field id="rd-confirm" label={`Digite ${DELETE_RUNNER_WORD} para confirmar *`}>
              <Input id="rd-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
            </Field>
            {error && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" autoFocus onClick={() => setTarget(null)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              disabled={busy || confirm !== DELETE_RUNNER_WORD || reason.trim().length < 10}
              onClick={() => void remove()}
              data-testid="runner-delete-confirm"
            >
              {busy ? 'Removendo…' : 'Remover'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
