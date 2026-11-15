import { redirect } from 'next/navigation';
import { TwoFactorSetupGate } from '@/components/auth/two-factor-setup-gate';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireSession } from '@/server/auth/guards';

export default async function Setup2faPage() {
  const s = await requireSession();
  if (s.user.mustChangePassword) redirect('/account/change-password');
  return (
    <Card>
      <CardHeader>
        <CardTitle>Configure o 2FA</CardTitle>
        <CardDescription>O segundo fator é obrigatório para usar a ferramenta.</CardDescription>
      </CardHeader>
      <CardContent>
        <TwoFactorSetupGate enabled={Boolean(s.user.twoFactorEnabled)} />
      </CardContent>
    </Card>
  );
}
