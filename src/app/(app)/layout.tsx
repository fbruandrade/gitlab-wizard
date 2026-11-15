import Link from 'next/link';
import { ReauthProvider } from '@/components/auth/reauth-provider';
import { Nav, type NavItem } from '@/components/layout/nav';
import { SignOutButton } from '@/components/layout/sign-out-button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { daysUntil, formatDate } from '@/lib/format';
import { href } from '@/lib/routes';
import { requireReadySession } from '@/server/auth/guards';
import { env } from '@/server/env';
import { listTokens } from '@/server/services/gitlab-token.service';
import { getSelectedTokenId } from '@/server/token-selection';
import { TokenSwitcher } from '@/components/layout/token-switcher';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireReadySession();
  const tokens = await listTokens(session.user.id);
  const selectedId = await getSelectedTokenId();
  const token = tokens.find((t) => t.id === selectedId) ?? tokens[0] ?? null; // em uso: o escolhido, senão o padrão
  const isAdmin = session.user.role === 'admin';
  const left = daysUntil(token?.expiresAt);

  const items: NavItem[] = [
    { href: '/', label: 'Início' },
    ...(token?.capabilities.includes('READ_USERS') ? [{ href: '/gitlab/users', label: 'Usuários GitLab' }] : []),
    { href: '/token', label: 'Meu token GitLab' },
    { href: '/history', label: 'Histórico' },
    { href: '/account/security', label: 'Minha conta' },
    ...(isAdmin
      ? [
          { href: '/admin/users', label: 'Contas da ferramenta' },
          { href: '/admin/cleanup', label: 'Limpeza de credenciais' },
          { href: '/admin/policies', label: 'Políticas' },
          { href: '/admin/audit', label: 'Auditoria' },
        ]
      : []),
  ];

  return (
    <ReauthProvider username={session.user.username ?? ''}>
      <div className="flex min-h-screen">
        <aside className="hidden w-56 shrink-0 border-r md:block">
          <div className="p-4 text-lg font-semibold">GitLab Wizard</div>
          <Nav items={items} />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between gap-3 border-b px-4 py-2">
            <div className="flex items-center gap-2 text-sm">
              {token ? (
                tokens.length > 1 ? (
                  <TokenSwitcher
                    username={token.gitlabUsername}
                    isAdmin={token.gitlabIsAdmin}
                    currentId={token.id}
                    tokens={tokens.map((t) => ({
                      id: t.id,
                      gitlabTokenId: t.gitlabTokenId,
                      name: t.name,
                      isDefault: t.isDefault,
                      scopes: t.scopes,
                    }))}
                  />
                ) : (
                  <Badge variant="secondary" data-testid="gitlab-badge">
                    @{token.gitlabUsername}
                    {token.gitlabIsAdmin ? ' (admin)' : ''}
                  </Badge>
                )
              ) : (
                <Badge variant="outline">PAT não vinculado</Badge>
              )}
              {env.GITLAB_TLS_INSECURE && (
                <Badge variant="destructive" title="O certificado do GitLab não está sendo verificado (GITLAB_TLS_INSECURE=true)">
                  TLS do GitLab sem verificação
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span data-testid="whoami">{session.user.name}</span>
              {isAdmin && <Badge>admin</Badge>}
              <SignOutButton />
            </div>
          </header>
          {left !== null && left <= 7 && (
            <Alert variant={left <= 1 ? 'destructive' : 'default'} className="m-4 mb-0" data-testid="expiry-banner">
              <AlertTitle>
                {left < 0
                  ? 'Seu token GitLab expirou'
                  : `Seu token GitLab expira ${left === 0 ? 'hoje' : `em ${left} dia(s)`} (${formatDate(token?.expiresAt)})`}
              </AlertTitle>
              <AlertDescription>
                <Link href={href('/token')} className="underline">
                  Rotacione agora
                </Link>{' '}
                para não perder o acesso às operações.
              </AlertDescription>
            </Alert>
          )}
          <main className="flex-1 p-4 md:p-6">{children}</main>
        </div>
      </div>
    </ReauthProvider>
  );
}
