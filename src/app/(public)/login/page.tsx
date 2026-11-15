import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/auth/login-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getSession } from '@/server/auth/guards';
import { env } from '@/server/env';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ expired?: string }> }) {
  if (await getSession()) redirect('/');
  const { expired } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">GitLab Wizard</CardTitle>
          <CardDescription>Instância: {env.GITLAB_BASE_URL}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <LoginForm expired={expired === '1'} />
          <p className="text-xs text-muted-foreground">Esqueceu a senha? Fale com o administrador da ferramenta.</p>
        </CardContent>
      </Card>
    </main>
  );
}
