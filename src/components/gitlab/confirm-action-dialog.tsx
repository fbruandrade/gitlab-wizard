'use client';
import { useState } from 'react';
import { Field } from '@/components/common/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { reasonSchema } from '@/lib/schemas';

export interface ConfirmResult {
  ok: boolean;
  message?: string;
}

/**
 * Confirmação de ação sensível: motivo/chamado obrigatório + digitar o username do alvo
 * (+ checkbox opcional de verificação de identidade). Em erro o modal NÃO fecha.
 */
export function ConfirmActionDialog(props: {
  testId: string;
  trigger: string;
  title: string;
  description: string;
  warning?: string;
  confirmLabel: string;
  username: string;
  identityCheck?: boolean;
  onConfirm: (v: { reason: string; confirmUsername: string }) => Promise<ConfirmResult>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [confirmUsername, setConfirmUsername] = useState('');
  const [identity, setIdentity] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reasonOk = reasonSchema.safeParse(reason).success;
  const ready = reasonOk && confirmUsername.trim().toLowerCase() === props.username.toLowerCase() && (!props.identityCheck || identity);

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await props.onConfirm({ reason: reason.trim(), confirmUsername: confirmUsername.trim() });
    setBusy(false);
    if (!res.ok) return setError(res.message ?? 'Não foi possível concluir.');
    setOpen(false);
    setReason('');
    setConfirmUsername('');
    setIdentity(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setError(null);
      }}
    >
      <DialogTrigger render={<Button variant="destructive" data-testid={`${props.testId}-open`} />}>{props.trigger}</DialogTrigger>
      <DialogContent data-testid={`${props.testId}-dialog`}>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        {props.warning && (
          <Alert variant="destructive">
            <AlertDescription>⚠ {props.warning}</AlertDescription>
          </Alert>
        )}
        <div className="space-y-3">
          <Field
            id={`${props.testId}-reason`}
            label="Motivo / nº do chamado *"
            hint="Mínimo de 10 caracteres. Fica registrado na auditoria."
          >
            <Input id={`${props.testId}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} autoComplete="off" />
          </Field>
          <Field id={`${props.testId}-username`} label={`Digite "${props.username}" para confirmar *`}>
            <Input
              id={`${props.testId}-username`}
              value={confirmUsername}
              onChange={(e) => setConfirmUsername(e.target.value)}
              autoComplete="off"
            />
          </Field>
          {props.identityCheck && (
            <div className="flex items-start gap-2">
              <Checkbox id={`${props.testId}-identity`} checked={identity} onCheckedChange={(v) => setIdentity(v === true)} />
              <Label htmlFor={`${props.testId}-identity`} className="leading-snug">
                Confirmei a identidade do solicitante por um canal independente.
              </Label>
            </div>
          )}
          {error && (
            <Alert variant="destructive" role="alert" data-testid={`${props.testId}-error`}>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" autoFocus onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button variant="destructive" disabled={!ready || busy} onClick={() => void submit()} data-testid={`${props.testId}-confirm`}>
            {busy ? 'Executando…' : props.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
