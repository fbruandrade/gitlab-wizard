import { ChangePasswordGate } from '@/components/auth/change-password-gate';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function ChangePasswordPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Defina uma nova senha</CardTitle>
        <CardDescription>Sua senha atual é temporária. Escolha uma nova para continuar.</CardDescription>
      </CardHeader>
      <CardContent>
        <ChangePasswordGate />
      </CardContent>
    </Card>
  );
}
