'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { authClient } from '@/lib/auth-client';

export function TwoFactorLoginForm() {
  const router = useRouter();
  const [backup, setBackup] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(value: string) {
    setBusy(true);
    setError(null);
    // trustDevice desligado de propósito: a ferramenta é sensível, o código é pedido em todo login.
    const { error: err } = backup
      ? await authClient.twoFactor.verifyBackupCode({ code: value.trim() })
      : await authClient.twoFactor.verifyTotp({ code: value, trustDevice: false });
    setBusy(false);
    if (err) {
      setCode(''); // limpa para o usuário digitar de novo, sem misturar com o código errado
      return setError(err.status === 429 ? 'Muitas tentativas. Aguarde um instante.' : 'Código inválido.');
    }
    router.replace('/');
    router.refresh();
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit(code);
      }}
      className="space-y-4"
    >
      {backup ? (
        <Input
          aria-label="Código de backup"
          placeholder="xxxxx-xxxxx"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoFocus
          autoComplete="off"
        />
      ) : (
        <div className="flex justify-center">
          <InputOTP
            maxLength={6}
            value={code}
            onChange={setCode}
            onComplete={(v) => void submit(v)}
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-label="Código de 6 dígitos"
            disabled={busy}
          >
            <InputOTPGroup>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <InputOTPSlot key={i} index={i} />
              ))}
            </InputOTPGroup>
          </InputOTP>
        </div>
      )}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" className="w-full" disabled={busy || code.length < 6}>
        Verificar
      </Button>
      <Button
        type="button"
        variant="link"
        className="w-full"
        onClick={() => {
          setBackup((b) => !b);
          setCode('');
          setError(null);
        }}
      >
        {backup ? 'Usar o aplicativo autenticador' : 'Usar um código de backup'}
      </Button>
    </form>
  );
}
