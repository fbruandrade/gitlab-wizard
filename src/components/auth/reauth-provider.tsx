'use client';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { Field } from '@/components/common/field';
import { PasswordField } from '@/components/common/password-field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { authClient } from '@/lib/auth-client';

/** Resultado padrão das Server Actions (espelha src/server/action-result.ts, sem importar código de servidor). */
export type ActionResult<T = undefined> =
  { ok: true; data: T } | { ok: false; code: string; message: string; fieldErrors?: Record<string, string[]> };

type Run = <T>(fn: () => Promise<ActionResult<T>>) => Promise<ActionResult<T>>;
const Ctx = createContext<Run | null>(null);

/** Executa uma Server Action sensível; se o login ficou velho (REAUTH_REQUIRED), pede senha/TOTP e repete UMA vez. */
export const useSensitiveAction = () => {
  const run = useContext(Ctx);
  if (!run) throw new Error('useSensitiveAction fora do ReauthProvider');
  return run;
};

export function ReauthProvider({ username, children }: { username: string; children: React.ReactNode }) {
  const router = useRouter();
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const [open, setOpen] = useState(false);
  const [needsCode, setNeedsCode] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const finish = (ok: boolean) => {
    setOpen(false);
    setNeedsCode(false);
    setPassword('');
    setCode('');
    setError(null);
    resolver.current?.(ok);
    resolver.current = null;
  };

  const run: Run = useCallback(
    async (fn) => {
      let result = await fn();
      if (!result.ok && result.code === 'REAUTH_REQUIRED') {
        const ok = await new Promise<boolean>((resolve) => {
          resolver.current = resolve;
          setOpen(true);
        });
        if (ok) result = await fn();
      }
      if (!result.ok && result.code === 'UNAUTHENTICATED') router.replace('/login?expired=1');
      return result;
    },
    [router],
  );

  async function submit() {
    setBusy(true);
    setError(null);
    if (needsCode) {
      const { error: err } = await authClient.twoFactor.verifyTotp({ code, trustDevice: false });
      setBusy(false);
      if (err) {
        setCode('');
        return setError(err.status === 429 ? 'Muitas tentativas. Aguarde alguns segundos e tente de novo.' : 'Código inválido.');
      }
      return finish(true);
    }
    const { data, error: err } = await authClient.signIn.username({ username, password });
    setBusy(false);
    if (err) return setError(err.status === 429 ? 'Muitas tentativas. Aguarde um minuto.' : 'Senha incorreta.');
    if ((data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
      setNeedsCode(true);
      return;
    }
    finish(true);
  }

  return (
    <Ctx.Provider value={run}>
      {children}
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o) finish(false);
        }}
      >
        <DialogContent data-testid="reauth-dialog">
          <DialogHeader>
            <DialogTitle>Confirme sua identidade</DialogTitle>
            <DialogDescription>Por segurança, esta ação exige um login recente. Entre novamente para continuar.</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            className="space-y-3"
          >
            {needsCode ? (
              <Field id="reauth-code" label="Código do autenticador">
                <Input
                  id="reauth-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  autoFocus
                />
              </Field>
            ) : (
              <Field id="reauth-password" label={`Senha de ${username}`}>
                <PasswordField
                  id="reauth-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  autoFocus
                />
              </Field>
            )}
            {error && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => finish(false)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={busy || (needsCode ? code.length !== 6 : !password)}>
                Continuar
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Ctx.Provider>
  );
}
