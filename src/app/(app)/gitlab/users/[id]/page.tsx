import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StateBadge } from '@/components/gitlab/state-badge';
import { UserActions } from '@/components/gitlab/user-actions';
import { formatDateTime, initials } from '@/lib/format';
import { href } from '@/lib/routes';
import { requireReadySession } from '@/server/auth/guards';
import { loadGitLab } from '@/server/page-gitlab';
import { pageCtx, resolveSelectedToken } from '@/server/token-selection';
import { getGitLabUser } from '@/server/services/gitlab-user.service';

export default async function UserDetail({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireReadySession();
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const ctx = await pageCtx(session);
  const res = await loadGitLab(() => getGitLabUser(ctx, id));
  const token = await resolveSelectedToken(session.user.id);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link href={href('/gitlab/users')} className="text-sm text-muted-foreground hover:underline">
        ‹ Voltar
      </Link>
      {!res.ok ? (
        <Alert variant="destructive" role="alert" data-testid="user-error">
          <AlertDescription>{res.message}</AlertDescription>
        </Alert>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-3">
                <span className="flex size-10 items-center justify-center rounded-full bg-muted text-sm">{initials(res.data.name)}</span>
                <span>
                  {res.data.name}{' '}
                  <span className="text-base font-normal text-muted-foreground" data-testid="user-username">
                    @{res.data.username}
                  </span>
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
              <p>E-mail: {res.data.email ?? '—'}</p>
              <p>
                Estado: <StateBadge state={res.data.state} />
                {res.data.locked && ' · temporariamente trancado'}
              </p>
              <p>
                MFA: <span data-testid="user-mfa">{res.data.two_factor_enabled ? 'habilitado' : 'não habilitado'}</span>
              </p>
              <p>Criado em: {formatDateTime(res.data.created_at)}</p>
              <p>Último login: {formatDateTime(res.data.last_sign_in_at)}</p>
            </CardContent>
          </Card>
          <UserActions
            id={res.data.id}
            username={res.data.username}
            state={res.data.state}
            twoFactorEnabled={res.data.two_factor_enabled}
            canAdmin={Boolean(token?.capabilities.includes('ADMIN_USERS'))}
            isSelf={token?.gitlabUserId === res.data.id}
            isAdmin={Boolean(res.data.is_admin)}
            operatorUsername={token?.gitlabUsername ?? ''}
          />
        </>
      )}
    </div>
  );
}
