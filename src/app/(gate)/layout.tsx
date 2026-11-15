import { requireSession } from '@/server/auth/guards';

// Páginas que o usuário DEVE concluir antes de entrar no app (troca de senha, setup do 2FA).
// Exigem sessão, mas não os gates, para não gerar redirecionamento em loop.
export default async function GateLayout({ children }: { children: React.ReactNode }) {
  await requireSession();
  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center p-4">
      <div className="w-full">{children}</div>
    </main>
  );
}
