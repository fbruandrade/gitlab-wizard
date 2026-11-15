'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { addGitLabTokenAction, replaceGitLabTokenAction } from '@/app/(app)/token/actions';
import { useSensitiveAction } from '@/components/auth/reauth-provider';
import { Field } from '@/components/common/field';
import { PasswordField } from '@/components/common/password-field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { gitlabTokenSchema } from '@/lib/schemas';

function useTokenField() {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return { token, setToken, error, setError, busy, setBusy };
}

/** Adiciona um PAT. A conta pode ter vários; se já houver algum, pergunta se este vira o padrão. */
export function AddTokenForm({ hasTokens, onDone }: { hasTokens: boolean; onDone?: () => void }) {
  const router = useRouter();
  const run = useSensitiveAction();
  const f = useTokenField();
  const [makeDefault, setMakeDefault] = useState(false);

  async function submit() {
    const parsed = gitlabTokenSchema.safeParse({ token: f.token });
    if (!parsed.success) return f.setError(parsed.error.issues[0]?.message ?? 'Token inválido.');
    f.setBusy(true);
    f.setError(null);
    const res = await run(() => addGitLabTokenAction({ token: parsed.data.token, makeDefault }));
    f.setBusy(false);
    if (!res.ok) return f.setError(res.message);
    f.setToken('');
    setMakeDefault(false);
    toast.success(
      hasTokens
        ? `Token adicionado${res.data.isDefault ? ' e definido como padrão' : ''}.`
        : `Token vinculado (@${res.data.gitlabUsername}).`,
    );
    onDone?.();
    router.refresh();
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="space-y-3"
    >
      <Field id="gl-token-add" label="Personal Access Token do GitLab" hint="Fica cifrado no servidor e não é exibido de novo.">
        <PasswordField
          id="gl-token-add"
          value={f.token}
          onChange={(e) => f.setToken(e.target.value)}
          placeholder="glpat-…"
          spellCheck={false}
        />
      </Field>
      {hasTokens && (
        <div className="flex items-center gap-2">
          <Checkbox id="add-default" checked={makeDefault} onCheckedChange={(v) => setMakeDefault(v === true)} />
          <Label htmlFor="add-default">Definir este como o token padrão</Label>
        </div>
      )}
      {f.error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{f.error}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" disabled={f.busy || !f.token} data-testid="add-token">
        {f.busy ? 'Validando…' : hasTokens ? 'Adicionar token' : 'Vincular token'}
      </Button>
    </form>
  );
}

/** Troca o PAT de UM token (rotacionado fora da ferramenta). Precisa ser do mesmo usuário GitLab. */
export function ReplaceTokenForm({ tokenId, onDone }: { tokenId: string; onDone?: () => void }) {
  const router = useRouter();
  const run = useSensitiveAction();
  const f = useTokenField();

  async function submit() {
    const parsed = gitlabTokenSchema.safeParse({ token: f.token });
    if (!parsed.success) return f.setError(parsed.error.issues[0]?.message ?? 'Token inválido.');
    f.setBusy(true);
    f.setError(null);
    const res = await run(() => replaceGitLabTokenAction({ tokenId, token: parsed.data.token }));
    f.setBusy(false);
    if (!res.ok) return f.setError(res.message);
    f.setToken('');
    toast.success('Token substituído.');
    onDone?.();
    router.refresh();
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="space-y-3"
    >
      <Field
        id={`gl-token-replace-${tokenId}`}
        label="Novo Personal Access Token"
        hint="Substitui o token escolhido e mantém a condição de padrão."
      >
        <PasswordField
          id={`gl-token-replace-${tokenId}`}
          value={f.token}
          onChange={(e) => f.setToken(e.target.value)}
          placeholder="glpat-…"
          spellCheck={false}
        />
      </Field>
      {f.error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{f.error}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" disabled={f.busy || !f.token}>
        {f.busy ? 'Validando…' : 'Substituir token'}
      </Button>
    </form>
  );
}
