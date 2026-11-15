'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { Field } from '@/components/common/field';
import { PasswordField } from '@/components/common/password-field';
import { PasswordPolicyHint } from '@/components/common/password-policy-hint';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { newPasswordSchema } from '@/lib/schemas';

type Values = z.input<typeof newPasswordSchema>;

export function ChangePasswordForm({ onDone }: { onDone?: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, control, reset, formState } = useForm<Values>({ resolver: zodResolver(newPasswordSchema) });
  const newPassword = useWatch({ control, name: 'newPassword' });

  async function onSubmit(v: Values) {
    setError(null);
    const { error: err } = await authClient.changePassword({
      currentPassword: v.currentPassword,
      newPassword: v.newPassword,
      revokeOtherSessions: true,
    });
    if (err)
      return setError(
        err.code === 'PASSWORD_POLICY'
          ? 'A nova senha não atende à política.'
          : err.status === 429
            ? 'Muitas tentativas. Aguarde.'
            : 'Senha atual incorreta ou dados inválidos.',
      );
    toast.success('Senha alterada. Outras sessões foram encerradas.');
    reset();
    onDone?.();
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <Field id="currentPassword" label="Senha atual" error={formState.errors.currentPassword?.message}>
        <PasswordField id="currentPassword" autoComplete="current-password" {...register('currentPassword')} />
      </Field>
      <Field id="newPassword" label="Nova senha" error={formState.errors.newPassword?.message}>
        <PasswordField id="newPassword" autoComplete="new-password" {...register('newPassword')} />
      </Field>
      <PasswordPolicyHint value={newPassword ?? ''} />
      <Field id="confirmPassword" label="Confirmar nova senha" error={formState.errors.confirmPassword?.message}>
        <PasswordField id="confirmPassword" autoComplete="new-password" {...register('confirmPassword')} />
      </Field>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" disabled={formState.isSubmitting}>
        {formState.isSubmitting ? 'Salvando…' : 'Trocar senha'}
      </Button>
    </form>
  );
}
