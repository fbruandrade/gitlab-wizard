'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { saveInactivityDaysAction, startCleanupScanAction } from '@/app/(app)/admin/cleanup/actions';
import { useSensitiveAction } from '@/components/auth/reauth-provider';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { validateCleanupParams } from '@/lib/cleanup-rules';
import { SETTING_BOUNDS } from '@/lib/settings';

const box = 'flex items-start gap-2 text-sm';

export function CleanupForm({ defaultDays, savedDays }: { defaultDays: number; savedDays: number }) {
  const router = useRouter();
  const run = useSensitiveAction();
  const [blockedUsers, setBlocked] = useState(true);
  const [useUnused, setUseUnused] = useState(true);
  const [days, setDays] = useState(String(defaultDays));
  const [includePat, setPat] = useState(true);
  const [includeSsh, setSsh] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const n = Number(days);
  const params = { blockedUsers, unusedDays: useUnused ? n : null, includePat, includeSsh };
  const invalid = validateCleanupParams(params);

  async function start() {
    if (invalid) return setError(invalid);
    setBusy(true);
    setError(null);
    const res = await run(() => startCleanupScanAction(params));
    setBusy(false);
    if (!res.ok) return setError(res.message);
    router.push(`/admin/cleanup?scan=${res.data.scanId}` as never);
  }

  async function saveDefault() {
    const res = await run(() => saveInactivityDaysAction({ days: n }));
    if (!res.ok) return toast.error(res.message);
    toast.success(`Padrão salvo: ${n} dias.`);
    router.refresh();
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
      className="space-y-4"
      data-testid="cleanup-form"
    >
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">Critérios (basta atender a um)</legend>
        <label className={box}>
          <input type="checkbox" checked={blockedUsers} onChange={(e) => setBlocked(e.target.checked)} data-testid="crit-blocked" />
          <span>
            Credenciais de <strong>usuários bloqueados</strong> (<code>blocked</code> e <code>ldap_blocked</code>)
          </span>
        </label>
        <div className={box}>
          <input
            id="crit-unused"
            type="checkbox"
            checked={useUnused}
            onChange={(e) => setUseUnused(e.target.checked)}
            data-testid="crit-unused"
          />
          <Label htmlFor="crit-unused" className="flex flex-wrap items-center gap-2 font-normal">
            Credenciais <strong>sem uso há mais de</strong>
            <Input
              aria-label="Dias sem uso"
              type="number"
              min={SETTING_BOUNDS.cleanupInactivityDays.min}
              max={SETTING_BOUNDS.cleanupInactivityDays.max}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="w-24"
              data-testid="unused-days"
              disabled={!useUnused}
            />
            dias
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void saveDefault()}
              disabled={!useUnused || !Number.isInteger(n) || n < 1 || n > 3650 || n === savedDays}
              data-testid="save-days"
            >
              Salvar como padrão{n === savedDays ? ' (já é)' : ''}
            </Button>
          </Label>
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">Tipos de credencial</legend>
        <label className={box}>
          <input type="checkbox" checked={includePat} onChange={(e) => setPat(e.target.checked)} data-testid="type-pat" /> Tokens de acesso
          pessoal (PAT)
        </label>
        <label className={box}>
          <input type="checkbox" checked={includeSsh} onChange={(e) => setSsh(e.target.checked)} data-testid="type-ssh" /> Chaves SSH
        </label>
      </fieldset>

      <p className="text-xs text-muted-foreground">
        A varredura é uma <strong>simulação</strong>: nada é revogado. Depois você revisa a lista e escolhe o que revogar. Ficam de fora a
        sua própria conta, tokens em uso por contas desta ferramenta e tokens de bots (projeto/grupo).
      </p>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" disabled={busy || invalid !== null} data-testid="start-scan">
        {busy ? 'Iniciando…' : 'Iniciar varredura (simulação)'}
      </Button>
    </form>
  );
}
