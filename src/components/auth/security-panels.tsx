'use client';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { authClient } from '@/lib/auth-client';
import { ChangePasswordForm } from './change-password-form';
import { SessionsList } from './sessions-list';
import { TwoFactorSetup } from './two-factor-setup';

export function SecurityPanels({ twoFactorEnabled, canDisableTwoFactor }: { twoFactorEnabled: boolean; canDisableTwoFactor: boolean }) {
  const router = useRouter();
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Trocar senha</CardTitle>
          <CardDescription>As outras sessões serão encerradas.</CardDescription>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Verificação em duas etapas (2FA)</CardTitle>
        </CardHeader>
        <CardContent>
          <TwoFactorSetup
            enabled={twoFactorEnabled}
            canDisable={canDisableTwoFactor}
            onDone={async () => {
              await authClient.getSession({ query: { disableCookieCache: true } });
              router.refresh();
            }}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Sessões ativas</CardTitle>
        </CardHeader>
        <CardContent>
          <SessionsList />
        </CardContent>
      </Card>
    </>
  );
}
