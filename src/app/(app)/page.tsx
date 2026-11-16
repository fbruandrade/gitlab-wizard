import { Check, X } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CAPABILITIES, missingReason } from '@/lib/capability-info';
import { daysUntil, formatDate, formatDateTime } from '@/lib/format';
import { href } from '@/lib/routes';
import { requireReadySession } from '@/server/auth/guards';
import { env } from '@/server/env';
import { listAudit } from '@/server/services/audit.service';
import { resolveSelectedToken } from '@/server/token-selection';
import { PageHeader } from '@/components/common/page-header';
import { WandSparkles } from 'lucide-react';

export default async function Dashboard() {
  const session = await requireReadySession();
  const [token, recent] = await Promise.all([resolveSelectedToken(session.user.id), listAudit({ actorUserId: session.user.id }, 1, 5)]);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader icon={WandSparkles} tone="violet" title={`Olá, ${session.user.name}`}>
        Suas chaves, em ordem.
      </PageHeader>

      {!token ? (
        <Card data-testid="no-token-card">
          <CardHeader>
            <CardTitle>Vincule seu token GitLab para começar</CardTitle>
            <CardDescription>
              Crie um Personal Access Token no GitLab com `api` (+ `admin_mode`, se o Admin Mode estiver ativo) para operar como
              administrador, ou apenas `self_rotate` para só rotacioná-lo.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button nativeButton={false} render={<Link href={href('/token')} />}>
              Vincular token
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Meu token</CardTitle>
              <CardDescription>
                @{token.gitlabUsername}
                {token.gitlabIsAdmin ? ' · admin GitLab' : ''}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex flex-wrap gap-1">
                {token.scopes.map((s) => (
                  <Badge key={s} variant="secondary">
                    {s}
                  </Badge>
                ))}
              </div>
              <p>
                Expira em {formatDate(token.expiresAt)}
                {token.expiresAt && <span className="text-muted-foreground"> ({daysUntil(token.expiresAt)} dia(s))</span>}
              </p>
              <Button variant="outline" size="sm" nativeButton={false} render={<Link href={href('/token')} />}>
                Gerenciar
              </Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Capacidades</CardTitle>
              <CardDescription>O que este token permite fazer aqui</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm" data-testid="capabilities">
                {CAPABILITIES.map((c) => {
                  const ok = token.capabilities.includes(c.key);
                  return (
                    <li key={c.key} className="flex gap-2">
                      {ok ? <Check className="mt-0.5 size-4 text-success" /> : <X className="mt-0.5 size-4 text-destructive" />}
                      <div>
                        <span data-testid={`cap-${c.key}`} data-ok={ok}>
                          {c.label}
                        </span>
                        {!ok && (
                          <p className="text-xs text-muted-foreground">
                            {missingReason(c.key, {
                              isAdmin: token.gitlabIsAdmin,
                              scopes: token.scopes,
                              adminMode: env.GITLAB_ADMIN_MODE_ENABLED,
                            })}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
          {token.capabilities.includes('READ_USERS') && (
            <Card>
              <CardHeader>
                <CardTitle>Atalhos</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                <Button variant="outline" nativeButton={false} render={<Link href={href('/gitlab/users')} />}>
                  Buscar usuário
                </Button>
                <Button variant="outline" nativeButton={false} render={<Link href={href('/gitlab/users?blocked=1')} />}>
                  Ver bloqueados
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Últimas ações</CardTitle>
        </CardHeader>
        <CardContent>
          {recent.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma ação registrada.</p>
          ) : (
            <ul className="divide-y text-sm">
              {recent.items.map((a) => (
                <li key={a.id} className="flex justify-between gap-3 py-2">
                  <span>
                    {a.action}
                    {a.targetLabel ? ` · ${a.targetLabel}` : ''}
                  </span>
                  <span className="text-muted-foreground">{formatDateTime(a.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
          <Button variant="link" className="px-0" nativeButton={false} render={<Link href={href('/history')} />}>
            Ver histórico completo
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
