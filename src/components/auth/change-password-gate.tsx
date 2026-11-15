'use client';
import { useRouter } from 'next/navigation';
import { ChangePasswordForm } from './change-password-form';
import { authClient } from '@/lib/auth-client';

export function ChangePasswordGate() {
  const router = useRouter();
  return (
    <ChangePasswordForm
      onDone={async () => {
        // Renova o cookie de sessão com os dados novos (mustChangePassword=false) antes de navegar.
        await authClient.getSession({ query: { disableCookieCache: true } });
        router.replace('/');
        router.refresh();
      }}
    />
  );
}
