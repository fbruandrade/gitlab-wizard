'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { saveVaultConfigAction, startVaultScanAction } from '@/app/(app)/admin/vault/actions';
import { useSensitiveAction } from '@/components/auth/reauth-provider';
import { Field } from '@/components/common/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ACCESS_LEVELS, VAULT_SCOPES, validateVaultConfig, type VaultConfig } from '@/lib/vault-rules';

export function VaultConfigForm({ config }: { config: VaultConfig }) {
  const router = useRouter();
  const run = useSensitiveAction();
  const [rootGroup, setRoot] = useState(config.rootGroup);
  const [warnDays, setWarn] = useState(String(config.warnDays));
  const [lifetimeDays, setLife] = useState(String(config.lifetimeDays));
  const [scopes, setScopes] = useState<string[]>(config.scopes);
  const [accessLevel, setLevel] = useState(String(config.accessLevel));
  const [force, setForce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const current: VaultConfig = {
    rootGroup: rootGroup.trim(),
    warnDays: Number(warnDays),
    lifetimeDays: Number(lifetimeDays),
    scopes,
    accessLevel: Number(accessLevel),
  };
  const invalid = validateVaultConfig(current);
  const dirty = JSON.stringify(current) !== JSON.stringify(config);

  async function save() {
    setBusy(true);
    setError(null);
    const res = await run(() => saveVaultConfigAction(current));
    setBusy(false);
    if (!res.ok) return setError(res.message);
    toast.success('Configuração do cofre salva.');
    router.refresh();
  }

  async function scan() {
    setBusy(true);
    setError(null);
    const res = await run(() => startVaultScanAction({ force }));
    setBusy(false);
    if (!res.ok) return setError(res.message);
    router.push(`/admin/vault?scan=${res.data.scanId}` as never);
  }

  return (
    <form
      className="space-y-4"
      data-testid="vault-form"
      onSubmit={(e) => {
        e.preventDefault();
        void scan();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="v-root" label="Grupo raiz dos cofres" hint="Estrutura esperada: grupo/ambiente/aplicação.">
          <Input id="v-root" value={rootGroup} onChange={(e) => setRoot(e.target.value)} data-testid="vault-root" autoComplete="off" />
        </Field>
        <Field id="v-level" label="Papel do token criado">
          <select
            id="v-level"
            value={accessLevel}
            onChange={(e) => setLevel(e.target.value)}
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            data-testid="vault-level"
          >
            {Object.entries(ACCESS_LEVELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field id="v-warn" label="Avisar quando faltar (dias)">
          <Input id="v-warn" type="number" value={warnDays} onChange={(e) => setWarn(e.target.value)} data-testid="vault-warn" />
        </Field>
        <Field id="v-life" label="Validade do token novo (dias)">
          <Input id="v-life" type="number" value={lifetimeDays} onChange={(e) => setLife(e.target.value)} data-testid="vault-life" />
        </Field>
      </div>
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">Escopos do token criado (a rotação preserva os do token atual)</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {VAULT_SCOPES.map((s) => (
            <label key={s} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={scopes.includes(s)}
                onChange={(e) => setScopes((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))}
              />
              <code>{s}</code>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} data-testid="vault-force" />
        <span>
          <strong>Forçar renovação</strong>: incluir no plano também os cofres que estão OK (por segurança, ex.: suspeita de vazamento).
          Vale para cofres com um único token ativo e grupo de destino conhecido; continuam de fora os com mais de um token ativo.
        </span>
      </label>
      {(error || (dirty && invalid)) && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error ?? invalid}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy || !dirty || invalid !== null}
          onClick={() => void save()}
          data-testid="vault-save"
        >
          Salvar configuração
        </Button>
        <Button
          type="submit"
          disabled={busy || dirty || invalid !== null}
          data-testid="vault-scan"
          title={dirty ? 'Salve a configuração antes' : undefined}
        >
          {busy ? 'Iniciando…' : 'Varrer cofres (simulação)'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        A varredura apenas lê: nada é criado, gravado ou revogado. Depois você revisa o plano de cada cofre e escolhe o que aplicar.
      </p>
    </form>
  );
}
