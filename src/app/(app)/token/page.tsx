import { Check, X } from 'lucide-react';
import { ScopeList } from '@/components/common/scope-list';
import { AddTokenForm } from '@/components/gitlab/link-token-form';
import { ReplaceTokenDialog, SetDefaultButton, UnlinkButton, UseTokenButton } from '@/components/gitlab/replace-unlink';
import { RotateForm } from '@/components/gitlab/rotate-form';
import { TokenSecretHost } from '@/components/gitlab/secret-host';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CAPABILITIES, missingReason } from '@/lib/capability-info';
import { daysUntil, formatDate, formatDateTime } from '@/lib/format';
import { messageFor } from '@/lib/messages';
import { requireReadySession } from '@/server/auth/guards';
import { prisma } from '@/server/db';
import { env } from '@/server/env';
import { listTokens, withGitLab } from '@/server/services/gitlab-token.service';
import { getSettings } from '@/server/services/settings.service';
import { getSelectedTokenId } from '@/server/token-selection';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 86_400_000);

export default async function TokenPage({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const session = await requireReadySession();
  const { notice } = await searchParams;
  const selectedId = await getSelectedTokenId();
  const actor = { id: session.user.id, username: session.user.username };

  // Consulta o GitLab (melhor esforço, em paralelo) para mostrar o último uso e detectar token revogado.
  const probed = new Map<string, { lastUsed?: string | null; error?: string }>();
  await Promise.all(
    (await listTokens(session.user.id)).map(async (t) => {
      try {
        probed.set(t.id, { lastUsed: (await withGitLab({ actor, tokenId: t.id }, null, (c) => c.getCurrentToken())).last_used_at });
      } catch (e) {
        probed.set(t.id, { error: messageFor((e as { code?: string }).code ?? 'INTERNAL') });
      }
    }),
  );

  // Relê: algum token pode ter sido marcado como revogado (401) pela consulta acima.
  const [tokens, history, { patMaxLifetimeDays: maxLifetime }] = await Promise.all([
    listTokens(session.user.id),
    prisma.gitLabToken.findMany({ where: { userId: session.user.id }, orderBy: { createdAt: 'desc' }, take: 15 }),
    getSettings(), // configurável em Políticas
  ]);
  const inUse = tokens.find((t) => t.id === selectedId) ?? tokens[0];

  return (
    <TokenSecretHost>
      <div className="mx-auto max-w-3xl space-y-4">
        <h1 className="text-2xl font-semibold">Meus tokens GitLab</h1>

        {notice && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{messageFor(notice)}</AlertDescription>
          </Alert>
        )}

        {tokens.length > 0 && (
          <p className="text-sm text-muted-foreground" data-testid="token-help">
            Você pode ter vários tokens. O <strong>padrão</strong> é o usado quando nenhum outro foi escolhido; o <strong>em uso</strong> é
            o escolhido neste navegador (também dá para trocar no cabeçalho). Todos precisam ser do mesmo usuário GitLab.
          </p>
        )}

        {tokens.map((t) => {
          const p = probed.get(t.id);
          const left = daysUntil(t.expiresAt);
          const isInUse = t.id === inUse?.id;
          return (
            <Card key={t.id} data-testid="token-card" data-token-id={t.gitlabTokenId} data-default={t.isDefault} data-in-use={isInUse}>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  <span data-testid="token-name">{t.name}</span>
                  {t.isDefault && <Badge data-testid="badge-default">Padrão</Badge>}
                  {isInUse && (
                    <Badge variant="secondary" data-testid="badge-in-use">
                      Em uso
                    </Badge>
                  )}
                </CardTitle>
                <CardDescription>
                  @{t.gitlabUsername}
                  {t.gitlabIsAdmin ? ' (admin GitLab)' : ''} · ID {t.gitlabTokenId}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <div data-testid="token-summary" className="space-y-3">
                  <div>
                    <p className="mb-1 text-xs text-muted-foreground">Escopos ({t.scopes.length})</p>
                    <ScopeList scopes={t.scopes} />
                  </div>
                  <ul className="grid gap-1 sm:grid-cols-3" data-testid="token-capabilities">
                    {CAPABILITIES.map((c) => {
                      const ok = t.capabilities.includes(c.key);
                      return (
                        <li
                          key={c.key}
                          className="flex items-start gap-1.5"
                          title={
                            ok
                              ? undefined
                              : missingReason(c.key, {
                                  isAdmin: t.gitlabIsAdmin,
                                  scopes: t.scopes,
                                  adminMode: env.GITLAB_ADMIN_MODE_ENABLED,
                                })
                          }
                        >
                          {ok ? (
                            <Check className="mt-0.5 size-4 text-emerald-600" aria-label="permite" />
                          ) : (
                            <X className="mt-0.5 size-4 text-destructive" aria-label="não permite" />
                          )}
                          <span data-testid={`tcap-${c.key}`} data-ok={ok}>
                            {c.label}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  <p>
                    Expira em: <span data-testid="token-expiry">{formatDate(t.expiresAt)}</span>
                    {left !== null && <span className="text-muted-foreground"> (em {left} dia(s))</span>} · Último uso:{' '}
                    {p?.error ? '—' : formatDateTime(p?.lastUsed)}
                  </p>
                  {p?.error && <p className="text-xs text-destructive">{p.error}</p>}
                  <p className="text-xs text-muted-foreground">Fingerprint: {t.fingerprint}</p>
                </div>

                <div className="flex flex-wrap gap-2" data-testid="token-actions">
                  {!isInUse && <UseTokenButton tokenId={t.id} />}
                  {!t.isDefault && <SetDefaultButton tokenId={t.id} />}
                  <ReplaceTokenDialog tokenId={t.id} name={t.name} />
                  <UnlinkButton tokenId={t.id} name={t.name} isDefault={t.isDefault} others={tokens.length - 1} />
                </div>

                <div className="border-t pt-3">
                  <h3 className="mb-2 font-medium">Rotacionar este token</h3>
                  {t.capabilities.includes('SELF_ROTATE') ? (
                    <RotateForm
                      tokenId={t.id}
                      min={iso(plusDays(1))}
                      max={iso(plusDays(maxLifetime))}
                      defaultDate={iso(plusDays(Math.min(90, maxLifetime)))}
                    />
                  ) : (
                    <p className="text-muted-foreground">
                      Rotação indisponível: requer scope <code>api</code> ou <code>self_rotate</code>.
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}

        <Card>
          <CardHeader>
            <CardTitle>{tokens.length ? 'Adicionar outro token' : 'Vincular token'}</CardTitle>
            <CardDescription>
              Crie um token em <code>{env.GITLAB_BASE_URL}/-/user_settings/personal_access_tokens</code> com os scopes <code>api</code> (+{' '}
              <code>admin_mode</code> se o Admin Mode estiver ativo) ou apenas <code>self_rotate</code>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AddTokenForm hasTokens={tokens.length > 0} />
          </CardContent>
        </Card>

        {history.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Histórico de tokens</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y text-sm" data-testid="token-history">
                {history.map((h) => (
                  <li key={h.id} className="flex justify-between gap-3 py-2">
                    <span>
                      #{h.gitlabTokenId} {h.name} <Badge variant={h.status === 'ACTIVE' ? 'default' : 'outline'}>{h.status}</Badge>
                    </span>
                    <span className="text-muted-foreground">
                      vinculado {formatDate(h.createdAt)} · expira {formatDate(h.expiresAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>
    </TokenSecretHost>
  );
}
