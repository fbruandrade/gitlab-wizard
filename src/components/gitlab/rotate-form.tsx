'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { rotateGitLabTokenAction } from '@/app/(app)/token/actions';
import { useSensitiveAction } from '@/components/auth/reauth-provider';
import { Field } from '@/components/common/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatDate } from '@/lib/format';
import { useShowTokenSecret } from './secret-host';

export function RotateForm({ tokenId, min, max, defaultDate }: { tokenId: string; min: string; max: string; defaultDate: string }) {
  const router = useRouter();
  const run = useSensitiveAction();
  const [date, setDate] = useState(defaultDate);
  const [reveal, setReveal] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const showSecret = useShowTokenSecret();

  async function rotate() {
    setBusy(true);
    setError(null);
    const res = await run(() => rotateGitLabTokenAction({ tokenId, expiresAt: date, reveal }));
    setBusy(false);
    setConfirm(false);
    if (!res.ok) return setError(res.message);
    if (res.data.status === 'PARTIAL') return showSecret({ token: res.data.token, partial: true });
    toast.success(`Token rotacionado. Novo vencimento: ${formatDate(res.data.expiresAt)}`);
    if (res.data.token) showSecret({ token: res.data.token, partial: false });
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <Field id={`rotate-date-${tokenId}`} label="Nova data de expiração" hint={`Entre ${formatDate(min)} e ${formatDate(max)}.`}>
        <Input
          id={`rotate-date-${tokenId}`}
          data-testid="rotate-date"
          type="date"
          min={min}
          max={max}
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="w-48"
        />
      </Field>
      <div className="flex items-center gap-2">
        <Checkbox id={`rotate-reveal-${tokenId}`} checked={reveal} onCheckedChange={(v) => setReveal(v === true)} />
        <Label htmlFor={`rotate-reveal-${tokenId}`}>Quero visualizar o novo token uma vez após a rotação</Label>
      </div>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button onClick={() => setConfirm(true)} disabled={busy || !date}>
        Rotacionar agora
      </Button>

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rotacionar o token?</DialogTitle>
            <DialogDescription>
              O token atual será revogado imediatamente no GitLab. Scripts e integrações que o usam deixarão de funcionar. O novo token
              ficará salvo aqui.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" autoFocus onClick={() => setConfirm(false)}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={() => void rotate()} disabled={busy} data-testid="confirm-rotate">
              {busy ? 'Rotacionando…' : 'Rotacionar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
