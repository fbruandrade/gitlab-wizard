'use client';
import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Field } from '@/components/common/field';
import { PasswordField } from '@/components/common/password-field';
import { SecretDialog } from '@/components/common/secret-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authClient } from '@/lib/auth-client';

type Step = { kind: 'idle' } | { kind: 'verify'; uri: string; backupCodes: string[] } | { kind: 'codes'; codes: string[] };

/** Ativação do 2FA da ferramenta: senha → QR code → código de verificação → códigos de backup (uma vez). */
export function TwoFactorSetup({ enabled, canDisable, onDone }: { enabled: boolean; canDisable: boolean; onDone: () => void }) {
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = (msg: string) => {
    setError(msg);
    setBusy(false);
  };

  async function start() {
    setBusy(true);
    setError(null);
    const { data, error: err } = await authClient.twoFactor.enable({ password });
    setPassword('');
    if (err || !data || !('totpURI' in data)) return fail('Senha incorreta.');
    setBusy(false);
    setStep({ kind: 'verify', uri: data.totpURI, backupCodes: data.backupCodes });
  }
  async function verify(backupCodes: string[]) {
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.twoFactor.verifyTotp({ code: code.trim() });
    if (err) {
      setCode('');
      return fail(
        err.status === 429
          ? 'Muitas tentativas. Aguarde alguns segundos.'
          : 'Código inválido. Confira o horário do celular e tente de novo.',
      );
    }
    setBusy(false);
    setCode('');
    setStep({ kind: 'codes', codes: backupCodes });
  }
  async function disable() {
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.twoFactor.disable({ password });
    setPassword('');
    if (err) return fail('Senha incorreta.');
    setBusy(false);
    toast.success('2FA desativado.');
    onDone();
  }
  async function regenerate() {
    setBusy(true);
    setError(null);
    const { data, error: err } = await authClient.twoFactor.generateBackupCodes({ password });
    setPassword('');
    if (err || !data) return fail('Senha incorreta.');
    setBusy(false);
    setStep({ kind: 'codes', codes: data.backupCodes });
  }

  return (
    <div className="space-y-4">
      {step.kind === 'idle' && (
        <>
          <p className="text-sm text-muted-foreground">
            {enabled
              ? 'O 2FA está ativo nesta conta.'
              : 'Proteja o acesso com um aplicativo autenticador (Google Authenticator, Microsoft Authenticator, 1Password...).'}
          </p>
          <Field id="2fa-password" label="Confirme sua senha">
            <PasswordField
              id="2fa-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            {!enabled && (
              <Button onClick={() => void start()} disabled={busy || !password}>
                Ativar 2FA
              </Button>
            )}
            {enabled && (
              <Button variant="outline" onClick={() => void regenerate()} disabled={busy || !password}>
                Gerar novos códigos de backup
              </Button>
            )}
            {enabled && canDisable && (
              <Button variant="destructive" onClick={() => void disable()} disabled={busy || !password}>
                Desativar 2FA
              </Button>
            )}
          </div>
          {enabled && !canDisable && (
            <p className="text-xs text-muted-foreground">O 2FA é obrigatório nesta instalação e não pode ser desativado.</p>
          )}
        </>
      )}

      {step.kind === 'verify' && (
        <div className="space-y-4">
          <p className="text-sm">1. Escaneie o QR code no aplicativo autenticador. 2. Digite o código de 6 dígitos que ele mostrar.</p>
          <div className="w-fit rounded-md border bg-white p-3" data-testid="totp-qr">
            <QRCodeSVG value={step.uri} size={176} />
          </div>
          <p className="text-xs text-muted-foreground">
            Não consegue escanear? Digite esta chave no aplicativo:{' '}
            <code data-testid="totp-secret" className="font-mono select-all">
              {new URL(step.uri).searchParams.get('secret')}
            </code>
          </p>
          <Field id="2fa-code" label="Código de verificação">
            <Input
              id="2fa-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </Field>
          <Button onClick={() => void verify(step.backupCodes)} disabled={busy || code.length !== 6}>
            Confirmar e ativar
          </Button>
        </div>
      )}

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <SecretDialog
        open={step.kind === 'codes'}
        title="Códigos de backup"
        description="Guarde estes códigos em local seguro. Cada um vale uma vez e serve se você perder o autenticador. Eles não serão exibidos novamente."
        secret={step.kind === 'codes' ? step.codes.join('\n') : ''}
        onClose={() => {
          setStep({ kind: 'idle' });
          onDone();
        }}
      />
    </div>
  );
}
