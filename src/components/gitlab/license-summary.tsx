import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { formatDate } from '@/lib/format';
import { licenseStats } from '@/lib/license';
import type { PageResult } from '@/server/page-gitlab';
import type { GitLabLicense } from '@/server/gitlab/schemas';

/** Licença da instância: 4 números + plano/validade. Falha aqui nunca derruba a busca de usuários. */
export function LicenseSummary({ result }: { result: PageResult<GitLabLicense> }) {
  if (!result.ok) {
    const none = result.code === 'GITLAB_NOT_FOUND';
    return (
      <p className="text-sm text-muted-foreground" data-testid="license-unavailable">
        {none
          ? 'Informações de licença indisponíveis: a instância não tem licença instalada (edição Community) ou o endpoint não existe nesta versão.'
          : `Informações de licença indisponíveis. ${result.message}`}
      </p>
    );
  }
  const l = result.data;
  return (
    <Card data-testid="license-summary">
      <CardContent className="space-y-3 pt-4">
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {licenseStats(l).map((s) => (
            <div key={s.key} title={s.hint}>
              <dt className="text-xs text-muted-foreground">{s.label}</dt>
              <dd
                className={`text-2xl font-semibold ${s.over ? 'text-destructive' : ''}`}
                data-testid={`license-${s.key}`}
                data-over={s.over}
              >
                {s.value ?? '—'}
              </dd>
            </div>
          ))}
        </dl>
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {l.plan && <Badge variant="secondary">{l.plan}</Badge>}
          {l.expired ? (
            <Badge variant="destructive">licença expirada</Badge>
          ) : l.expires_at ? (
            <span>válida até {formatDate(l.expires_at)}</span>
          ) : null}
        </p>
      </CardContent>
    </Card>
  );
}
