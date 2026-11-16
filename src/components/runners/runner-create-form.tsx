'use client';
import { useState } from 'react';
import { createRunnerAction } from '@/app/(app)/runners/actions';
import { useSensitiveAction } from '@/components/auth/reauth-provider';
import { Field } from '@/components/common/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createRunnerSchema, parseTags, RUNNER_TIMEOUT, type RunnerType } from '@/lib/runner-rules';
import { RunnerCreatedDialog, type CreatedRunner } from './runner-created-dialog';
import { TargetPicker, type PickedTarget } from './target-picker';

export function RunnerCreateForm({ canInstance }: { canInstance: boolean }) {
  const run = useSensitiveAction();
  const [type, setType] = useState<RunnerType>(canInstance ? 'instance_type' : 'group_type');
  const [target, setTarget] = useState<PickedTarget | null>(null);
  const [description, setDescription] = useState('');
  const [tagsText, setTags] = useState('');
  const [runUntagged, setUntagged] = useState(false);
  const [locked, setLocked] = useState(false);
  const [protectedRefs, setProtected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [timeoutMin, setTimeoutMin] = useState('');
  const [executor, setExecutor] = useState<'docker' | 'shell'>('docker');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedRunner | null>(null);

  async function submit() {
    setError(null);
    const input = {
      target: type === 'instance_type' ? { type } : { type, id: target?.id ?? 0 },
      description: description.trim() || undefined,
      tags: parseTags(tagsText),
      runUntagged,
      locked: type === 'project_type' && locked,
      protectedRefs,
      paused,
      maximumTimeout: timeoutMin.trim() ? Math.round(Number(timeoutMin) * 60) : null,
      reason,
    };
    const parsed = createRunnerSchema.safeParse(input);
    if (!parsed.success) return setError(parsed.error.issues[0]!.message);
    if (type !== 'instance_type' && !target) return setError('Escolha o alvo do runner.');
    setBusy(true);
    const res = await run(() => createRunnerAction(parsed.data));
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setCreated({ runnerId: res.data.runnerId, token: res.data.token, url: res.data.gitlabUrl, executor });
    setReason('');
  }

  const ready = (type === 'instance_type' || target) && reason.trim().length >= 10;

  return (
    <form
      className="space-y-4"
      data-testid="runner-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <TargetPicker idPrefix="rc" type={type} onType={setType} target={target} onTarget={setTarget} canInstance={canInstance} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="rc-desc" label="Descrição" hint="Aparece na lista de runners do GitLab.">
          <Input id="rc-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={255} data-testid="rc-desc" />
        </Field>
        <Field id="rc-tags" label="Tags (separadas por vírgula)" hint="Os jobs escolhem o runner por estas tags.">
          <Input id="rc-tags" value={tagsText} onChange={(e) => setTags(e.target.value)} data-testid="rc-tags" />
        </Field>
        <Field
          id="rc-timeout"
          label="Tempo máximo do job (minutos)"
          hint={`Opcional. De ${RUNNER_TIMEOUT.min / 60} min a ${RUNNER_TIMEOUT.max / 86400} dias.`}
        >
          <Input
            id="rc-timeout"
            type="number"
            min={RUNNER_TIMEOUT.min / 60}
            value={timeoutMin}
            onChange={(e) => setTimeoutMin(e.target.value)}
          />
        </Field>
        <Field id="rc-exec" label="Executor (comando para máquina com gitlab-runner)">
          <select
            id="rc-exec"
            value={executor}
            onChange={(e) => setExecutor(e.target.value as 'docker' | 'shell')}
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          >
            <option value="docker">docker</option>
            <option value="shell">shell</option>
          </select>
        </Field>
      </div>

      <fieldset className="space-y-1 text-sm">
        <legend className="mb-1 font-medium">Comportamento</legend>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={runUntagged} onChange={(e) => setUntagged(e.target.checked)} data-testid="rc-untagged" /> Executar
          jobs sem tag
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={protectedRefs} onChange={(e) => setProtected(e.target.checked)} /> Só branches/tags protegidos (
          <code>ref_protected</code>)
        </label>
        {type === 'project_type' && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={locked} onChange={(e) => setLocked(e.target.checked)} /> Travar neste projeto
          </label>
        )}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} /> Criar pausado
        </label>
      </fieldset>

      <Field id="rc-reason" label="Motivo / nº do chamado *" hint="Mínimo de 10 caracteres. Fica na auditoria.">
        <Input id="rc-reason" value={reason} onChange={(e) => setReason(e.target.value)} autoComplete="off" data-testid="rc-reason" />
      </Field>

      {error && (
        <Alert variant="destructive" role="alert" data-testid="rc-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" disabled={busy || !ready} data-testid="rc-submit">
        {busy ? 'Criando…' : 'Criar runner'}
      </Button>
      <p className="text-xs text-muted-foreground">
        O GitLab devolve o token do runner uma única vez; ele não é guardado aqui. Depois é só rodar o comando de registro na máquina do
        runner.
      </p>

      <RunnerCreatedDialog created={created} onClose={() => setCreated(null)} />
    </form>
  );
}
