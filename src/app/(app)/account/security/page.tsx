import { SecurityPanels } from '@/components/auth/security-panels';
import { requireReadySession } from '@/server/auth/guards';
import { env } from '@/server/env';

export default async function SecurityPage() {
  const s = await requireReadySession();
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold">Minha conta</h1>
      <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm" data-testid="account-data">
        <dt className="text-muted-foreground">Nome</dt>
        <dd>{s.user.name}</dd>
        <dt className="text-muted-foreground">Usuário</dt>
        <dd>{s.user.username}</dd>
        <dt className="text-muted-foreground">E-mail</dt>
        <dd>{s.user.email}</dd>
      </dl>
      <SecurityPanels twoFactorEnabled={Boolean(s.user.twoFactorEnabled)} canDisableTwoFactor={!env.REQUIRE_APP_2FA} />
    </div>
  );
}
