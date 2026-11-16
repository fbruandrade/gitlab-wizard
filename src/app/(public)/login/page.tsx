import { redirect } from 'next/navigation';
import { BrandMark } from '@/components/common/brand-mark';
import { LoginForm } from '@/components/auth/login-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getSession } from '@/server/auth/guards';
import { env } from '@/server/env';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ expired?: string }> }) {
  if (await getSession()) redirect('/');
  const { expired } = await searchParams;
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-sidebar p-4 text-sidebar-foreground">
      <div className="flex flex-col items-center gap-2 text-center">
        <BrandMark className="size-14" />
        <p className="text-sm text-sidebar-foreground/80">Suas chaves, em ordem.</p>
      </div>
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
