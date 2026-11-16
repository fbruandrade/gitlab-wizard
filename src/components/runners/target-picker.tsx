'use client';
import { useState } from 'react';
import { searchRunnerTargetsAction } from '@/app/(app)/runners/actions';
import { useSensitiveAction } from '@/components/auth/reauth-provider';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RUNNER_TYPE_LABEL, type RunnerType } from '@/lib/runner-rules';

export interface PickedTarget {
  id: number;
  name: string;
  path: string;
}

/** Tipo do runner + (para grupo/projeto) busca do alvo entre os que o usuário é Owner. */
export function TargetPicker({
  idPrefix,
  type,
  onType,
  target,
  onTarget,
  canInstance,
}: {
  idPrefix: string;
  type: RunnerType;
  onType: (t: RunnerType) => void;
  target: PickedTarget | null;
  onTarget: (t: PickedTarget | null) => void;
  canInstance: boolean;
}) {
  const run = useSensitiveAction();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<PickedTarget[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search() {
    setBusy(true);
    setError(null);
    const res = await run(() => searchRunnerTargetsAction({ kind: type === 'group_type' ? 'group' : 'project', q }));
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setResults(res.data);
  }

  return (
    <div className="space-y-3">
      <fieldset className="space-y-1">
        <legend className="mb-1 text-sm font-medium">Tipo de runner</legend>
        {(Object.keys(RUNNER_TYPE_LABEL) as RunnerType[]).map((t) => {
          const disabled = t === 'instance_type' && !canInstance;
          return (
            <label key={t} className={`flex items-center gap-2 text-sm ${disabled ? 'text-muted-foreground' : ''}`}>
              <input
                type="radio"
                name={`${idPrefix}-type`}
                checked={type === t}
                disabled={disabled}
                onChange={() => {
                  onType(t);
                  onTarget(null);
                  setResults(null);
                }}
                data-testid={`${idPrefix}-type-${t}`}
              />
              {RUNNER_TYPE_LABEL[t]}
              {disabled && <span className="text-xs">(requer admin do GitLab)</span>}
            </label>
          );
        })}
      </fieldset>

      {type !== 'instance_type' && (
        <div className="space-y-2" data-testid={`${idPrefix}-target`}>
          <p className="text-sm">
            {target ? (
              <>
                {type === 'group_type' ? 'Grupo' : 'Projeto'}: <strong>{target.path}</strong>{' '}
                <button type="button" className="text-primary underline" onClick={() => onTarget(null)}>
                  trocar
                </button>
              </>
            ) : (
              <>Escolha o {type === 'group_type' ? 'grupo' : 'projeto'} (só aparecem os que você é Owner).</>
            )}
          </p>
          {!target && (
            <>
              <div className="flex gap-2">
                <Input
                  aria-label={type === 'group_type' ? 'Buscar grupo' : 'Buscar projeto'}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void search();
                    }
                  }}
                  data-testid={`${idPrefix}-q`}
                  className="max-w-xs"
                />
                <Button type="button" variant="outline" disabled={busy} onClick={() => void search()} data-testid={`${idPrefix}-search`}>
                  {busy ? 'Buscando…' : 'Buscar'}
                </Button>
              </div>
              {results && results.length === 0 && <p className="text-sm text-muted-foreground">Nada encontrado.</p>}
              {results && results.length > 0 && (
                <ul className="max-h-48 divide-y overflow-auto rounded-md border text-sm" data-testid={`${idPrefix}-results`}>
                  {results.map((r) => (
                    <li key={r.id}>
                      <button type="button" className="w-full px-3 py-2 text-left hover:bg-muted" onClick={() => onTarget(r)}>
                        {r.path}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
      )}
    </div>
  );
}
