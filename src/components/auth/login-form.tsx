'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { Field } from '@/components/common/field';
import { PasswordField } from '@/components/common/password-field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authClient } from '@/lib/auth-client';
import { loginSchema } from '@/lib/schemas';

type Values = z.input<typeof loginSchema>;

export function LoginForm({ expired }: { expired?: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState } = useForm<Values>({ resolver: zodResolver(loginSchema) });

  async function onSubmit(v: Values) {
    setError(null);
    const { data, error: err } = await authClient.signIn.username({ username: v.username, password: v.password });
    if (err) {
      // Mensagem genérica de propósito: não revela se foi o usuário ou a senha.
      setError(
        err.status === 429
          ? 'Muitas tentativas. Aguarde 1 minuto.'
          : err.status === 403
            ? 'Conta desativada. Procure o administrador.'
            : 'Usuário ou senha inválidos.',
      );
      return;
    }
    if ((data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) return router.push('/login/2fa');
    router.replace('/');
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      {expired && (
        <Alert>
          <AlertDescription>Sua sessão expirou. Entre novamente.</AlertDescription>
        </Alert>
      )}
      <Field id="username" label="Usuário" error={formState.errors.username?.message}>
        <Input id="username" autoComplete="username" autoFocus {...register('username')} />
      </Field>
      <Field id="password" label="Senha" error={formState.errors.password?.message}>
        <PasswordField id="password" autoComplete="current-password" {...register('password')} />
      </Field>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" className="w-full" disabled={formState.isSubmitting}>
        {formState.isSubmitting ? 'Entrando…' : 'Entrar'}
      </Button>
    </form>
  );
}
