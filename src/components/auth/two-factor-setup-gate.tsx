'use client';
import { useRouter } from 'next/navigation';
import { TwoFactorSetup } from './two-factor-setup';
import { authClient } from '@/lib/auth-client';

export function TwoFactorSetupGate({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  return (
    <TwoFactorSetup
      enabled={enabled}
      canDisable={false}
      onDone={async () => {
        await authClient.getSession({ query: { disableCookieCache: true } });
        router.replace('/');
        router.refresh();
      }}
    />
  );
}
