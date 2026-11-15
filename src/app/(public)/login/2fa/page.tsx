import { TwoFactorLoginForm } from '@/components/auth/two-factor-login-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function TwoFactorPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Verificação em duas etapas</CardTitle>
          <CardDescription>Digite o código de 6 dígitos do seu aplicativo autenticador.</CardDescription>
        </CardHeader>
        <CardContent>
          <TwoFactorLoginForm />
        </CardContent>
      </Card>
    </main>
  );
}
