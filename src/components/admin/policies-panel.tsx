'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { applyPatLifetimeGitLabAction, savePatLifetimeToolAction, simulatePatLifetimeAction } from '@/app/(app)/admin/policies/actions';
import { useSensitiveAction } from '@/components/auth/reauth-provider';
import { Field } from '@/components/common/field';
import { ScopeBadges } from '@/components/common/scope-badges';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { applyConfirmWord } from '@/lib/admin-schemas';
import { formatDate } from '@/lib/format';
import { reasonSchema } from '@/lib/schemas';
import { SETTING_BOUNDS } from '@/lib/settings';
import { ScanStatus } from './scan-status';

export interface SimItem {
  scopes?: string[];
  tokenId: number;
  username: string;
  bot: boolean;
  name: string;
  expiresAt: string;
  lastUsedAt: string | null;
  linkedInTool: boolean;
  self: boolean;
}
export interface SimData {
  id: string;
  status: 'RUNNING' | 'DONE' | 'FAILED';
  days: number;
  error?: string | null;
  summary?: {
    cutoff: string;
    activeTokens: number;
    affected: number;
    withoutExpiry: number;
    users: number;
    privileged?: number;
    linkedInTool: number;
    bots: number;
    selfAffected: boolean;
    truncated: boolean;
  };
  items?: SimItem[];
}
export type GitLabLimit = { available: true; days: number | null } | { available: false; reason: string };

const B = SETTING_BOUNDS.patMaxLifetimeDays;

export function PoliciesPanel({
  toolDays,
  gitlab,
  sim,
  failedMessage,
}: {
  toolDays: number;
  gitlab: GitLabLimit;
  sim: SimData | null;
  failedMessage?: string;
}) {
  const router = useRouter();
  const run = useSensitiveAction();
  const [days, setDays] = useState(String(sim?.days ?? toolDays));
  const n = Number(days);
  const valid = Number.isInteger(n) && n >= B.min && n <= B.max;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [applied, setApplied] = useState<{ days: number; expectedRevocations: number } | null>(null);

  async function saveTool() {
    setBusy(true);
    setError(null);
    const res = await run(() => savePatLifetimeToolAction({ days: n }));
    setBusy(false);
    if (!res.ok) return setError(res.message);
    toast.success(`Validade máxima na ferramenta: ${n} dias.`);
    router.refresh();
  }
  async function simulate() {
    setBusy(true);
    setError(null);
    const res = await run(() => simulatePatLifetimeAction({ days: n }));
    setBusy(false);
    if (!res.ok) return setError(res.message);
    router.push(`/admin/policies?sim=${res.data.scanId}` as never);
  }
  async function apply() {
    const parsed = reasonSchema.safeParse(reason);
    if (!parsed.success) return setError(parsed.error.issues[0]!.message);
    setBusy(true);
    setError(null);
    const res = await run(() => applyPatLifetimeGitLabAction({ scanId: sim!.id, days: sim!.days, reason: parsed.data, confirm }));
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setOpen(false);
    setReason('');
    setConfirm('');
    setApplied(res.data);
    router.refresh();
  }

  const gitlabText = !gitlab.available ? 'indisponível' : gitlab.days === null ? 'sem limite' : `${gitlab.days} dias`;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Validade máxima do PAT</CardTitle>
          <CardDescription>
            Na ferramenta: <strong data-testid="tool-days">{toolDays} dias</strong> · No GitLab:{' '}
            <strong data-testid="gitlab-days">{gitlabText}</strong>
            {gitlab.available && gitlab.days !== toolDays && (
              <Badge variant="outline" className="ml-2">
                valores diferentes
              </Badge>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field
            id="pat-days"
            label={`Dias (${B.min}–${B.max})`}
            hint="Vale para o seletor de validade ao rotacionar o token nesta ferramenta. Para o GitLab, use a simulação abaixo."
          >
            <Input
              id="pat-days"
              type="number"
              min={B.min}
              max={B.max}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="w-32"
              data-testid="pat-days"
            />
          </Field>
          {error && (
            <Alert variant="destructive" role="alert" data-testid="policy-error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button onClick={() => void saveTool()} disabled={busy || !valid || n === toolDays} data-testid="save-tool">
            Salvar na ferramenta
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Aplicar no GitLab (instância inteira)</CardTitle>
          <CardDescription>
            Só no plano <strong>Ultimate</strong>. Ao definir ou alterar o limite, o GitLab <strong>revoga na hora</strong> os tokens com
            expiração além do prazo. Por isso a aplicação exige antes uma simulação.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button variant="outline" onClick={() => void simulate()} disabled={busy || !valid} data-testid="simulate">
            Simular efeito de {valid ? n : '…'} dias no GitLab
          </Button>

          {sim?.status === 'RUNNING' && <ScanStatus scanId={sim.id} />}
          {sim?.status === 'FAILED' && (
            <Alert variant="destructive" role="alert" data-testid="sim-failed">
              <AlertDescription>A simulação falhou: {failedMessage}</AlertDescription>
            </Alert>
          )}

          {sim?.status === 'DONE' && sim.summary && (
            <div className="space-y-3" data-testid="sim-result">
              <p className="text-sm">
                Simulação para <strong>{sim.days} dias</strong> (corte em {formatDate(sim.summary.cutoff)}):{' '}
                <strong data-testid="sim-affected">{sim.summary.affected}</strong> token(s) de <strong>{sim.summary.users}</strong>{' '}
                usuário(s) seriam revogados, de {sim.summary.activeTokens} ativos.
                {sim.summary.withoutExpiry > 0 &&
                  ` ${sim.summary.withoutExpiry} token(s) sem expiração (o tratamento depende da versão do GitLab).`}
              </p>
              {sim.summary.selfAffected && (
                <Alert variant="destructive" data-testid="sim-self">
                  <AlertDescription>
                    ⚠ <strong>O seu próprio token seria revogado</strong> e você perderia o acesso a esta ferramenta até vincular outro.
                    Rotacione-o para uma validade menor antes.
                  </AlertDescription>
                </Alert>
              )}
              {sim.summary.linkedInTool > 0 && (
                <Alert variant="destructive" data-testid="sim-linked">
                  <AlertDescription>
                    ⚠ <strong>{sim.summary.linkedInTool}</strong> token(s) em uso por contas desta ferramenta seriam revogados (essas contas
                    precisarão vincular outro).
                  </AlertDescription>
                </Alert>
              )}
              {sim.summary.bots > 0 && (
                <Alert data-testid="sim-bots">
                  <AlertDescription>
                    {sim.summary.bots} são tokens de bots (projeto/grupo): pipelines e integrações podem parar.
                  </AlertDescription>
                </Alert>
              )}
              {(sim.summary.privileged ?? 0) > 0 && (
                <p className="text-sm font-medium text-destructive" data-testid="sim-privileged">
                  {sim.summary.privileged} dos tokens afetados têm escopo privilegiado (api, sudo ou admin_mode).
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Estimativa: considera tokens ativos com expiração depois de hoje + {sim.days} dias. Confirme a regra de corte na sua versão
                do GitLab.
              </p>

              {sim.items && sim.items.length > 0 && (
                <Table data-testid="sim-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Usuário</TableHead>
                      <TableHead>Token</TableHead>
                      <TableHead>Escopos</TableHead>
                      <TableHead>Expira em</TableHead>
                      <TableHead>Último uso</TableHead>
                      <TableHead>Observação</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sim.items.slice(0, 50).map((i) => (
                      <TableRow key={i.tokenId}>
                        <TableCell>{i.username}</TableCell>
                        <TableCell>{i.name}</TableCell>
                        <TableCell>
                          <ScopeBadges scopes={i.scopes} />
                        </TableCell>
                        <TableCell>{formatDate(i.expiresAt)}</TableCell>
                        <TableCell>{i.lastUsedAt ? formatDate(i.lastUsedAt) : 'nunca'}</TableCell>
                        <TableCell className="space-x-1">
                          {i.self && <Badge variant="destructive">seu token</Badge>}
                          {i.linkedInTool && <Badge variant="outline">vinculado à ferramenta</Badge>}
                          {i.bot && <Badge variant="outline">bot</Badge>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {sim.summary.affected > 50 && (
                <p className="text-xs text-muted-foreground">Exibindo os 50 primeiros de {sim.summary.affected}.</p>
              )}

              <Dialog
                open={open}
                onOpenChange={(o) => {
                  setOpen(o);
                  if (!o) setError(null);
                }}
              >
                <DialogTrigger render={<Button variant="destructive" data-testid="apply-open" />}>
                  Aplicar {sim.days} dias no GitLab…
                </DialogTrigger>
                <DialogContent data-testid="apply-dialog">
                  <DialogHeader>
                    <DialogTitle>Aplicar {sim.days} dias no GitLab?</DialogTitle>
                    <DialogDescription>
                      Afeta <strong>todos os usuários</strong> da instância e revoga ~{sim.summary.affected} token(s) imediatamente. Não há
                      como desfazer as revogações.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-3">
                    <Field id="ap-reason" label="Motivo / nº da mudança *">
                      <Input id="ap-reason" value={reason} onChange={(e) => setReason(e.target.value)} autoComplete="off" />
                    </Field>
                    <Field id="ap-confirm" label={`Digite ${applyConfirmWord(sim.days)} para confirmar *`}>
                      <Input id="ap-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
                    </Field>
                    {error && (
                      <Alert variant="destructive" role="alert" data-testid="apply-error">
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
                      disabled={busy || confirm !== applyConfirmWord(sim.days) || reason.trim().length < 10}
                      onClick={() => void apply()}
                      data-testid="apply-confirm"
                    >
                      {busy ? 'Aplicando…' : 'Aplicar no GitLab'}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          )}

          {applied && (
            <Alert data-testid="applied">
              <AlertDescription>
                Aplicado: o GitLab agora limita o PAT a <strong>{applied.days} dias</strong>. Eram esperadas ~{applied.expectedRevocations}{' '}
                revogações.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
