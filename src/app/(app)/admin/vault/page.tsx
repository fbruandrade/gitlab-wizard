import Link from 'next/link';
import { ScanStatus } from '@/components/admin/scan-status';
import { VaultConfigForm } from '@/components/admin/vault-config-form';
import { VaultResults } from '@/components/admin/vault-results';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime, scanStatusLabel } from '@/lib/format';
import { messageFor } from '@/lib/messages';
import { href } from '@/lib/routes';
import type { VaultItem } from '@/lib/vault-rules';
import { requireAdminPage } from '@/server/auth/guards';
import { getScan, recentScans } from '@/server/services/cleanup.service';
import { resolveSelectedToken } from '@/server/token-selection';
import { getVaultConfig } from '@/server/services/vault.service';
import { getAutoSettings, getAutoStatus } from '@/server/services/vault-auto.service';
import { VaultAutoCard } from '@/components/admin/vault-auto-card';
import { env } from '@/server/env';
import { PageHeader } from '@/components/common/page-header';
import { Vault } from 'lucide-react';

export default async function VaultPage({ searchParams }: { searchParams: Promise<{ scan?: string }> }) {
  const session = await requireAdminPage();
  const { scan: scanId } = await searchParams;
  const [token, config, recent, auto, autoStatus] = await Promise.all([
    resolveSelectedToken(session.user.id),
    getVaultConfig(),
    recentScans(session.user.id, 'VAULT'),
    getAutoSettings(),
    getAutoStatus(),
  ]);
  const canVault = Boolean(token?.capabilities.includes('VAULT_TOKENS'));
  const scan = scanId && /^[0-9a-f-]{36}$/.test(scanId) ? await getScan(scanId, session.user.id, 'VAULT') : null;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader icon={Vault} tone="violet" title="Cofres de token">
        Valida a expiração do token de cada projeto-cofre em <code>{config.rootGroup}/&lt;ambiente&gt;/&lt;aplicação&gt;</code>, rotaciona
        ou cria o token e grava <code>PID_&lt;AMBIENTE&gt;</code> e <code>DEVOPS_&lt;AMBIENTE&gt;</code> no grupo da aplicação.
      </PageHeader>

      {!canVault ? (
        <Alert data-testid="vault-no-cap">
          <AlertDescription>
            Requer um token GitLab com scope <code>api</code> vinculado à sua conta, e papel <strong>Maintainer</strong> nos cofres e nos
            grupos das aplicações.
          </AlertDescription>
        </Alert>
      ) : (
        <>
          {scan && (
            <Card data-testid="vault-scan-card">
              <CardHeader>
                <CardTitle>Resultado da varredura</CardTitle>
                <CardDescription>{formatDateTime(scan.createdAt)}</CardDescription>
              </CardHeader>
              <CardContent>
                {scan.status === 'RUNNING' && <ScanStatus scanId={scan.id} />}
                {scan.status === 'FAILED' && (
                  <Alert variant="destructive" role="alert" data-testid="vault-scan-failed">
                    <AlertDescription>A varredura falhou: {messageFor(scan.error ?? 'INTERNAL')}</AlertDescription>
                  </Alert>
                )}
                {scan.status === 'DONE' && (
                  <VaultResults scanId={scan.id} items={(scan.items ?? []) as unknown as VaultItem[]} summary={scan.summary as never} />
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Configuração e varredura</CardTitle>
              <CardDescription>Padrões da criação e da rotação de tokens.</CardDescription>
            </CardHeader>
            <CardContent>
              <VaultConfigForm config={config} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Rotação automática</CardTitle>
              <CardDescription>Renova sozinha os tokens que vencem, sem ninguém na tela.</CardDescription>
            </CardHeader>
            <CardContent>
              <VaultAutoCard
                view={{
                  settings: auto && { actorUsername: auto.actorUsername, tokenName: auto.tokenName, enabledAt: auto.enabledAt },
                  status: autoStatus,
                  warnDays: config.warnDays,
                  intervalMinutes: env.VAULT_AUTO_INTERVAL_MINUTES,
                }}
                currentTokenName={token?.name ?? null}
              />
            </CardContent>
          </Card>

          {recent.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Varreduras recentes</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="divide-y text-sm">
                  {recent.map((r) => (
                    <li key={r.id} className="flex justify-between py-2">
                      <Link className="underline-offset-2 hover:underline" href={href(`/admin/vault?scan=${r.id}`)}>
                        {formatDateTime(r.createdAt)}
                      </Link>
                      <span className="text-muted-foreground">
                        {scanStatusLabel(r.status)}
                        {r.summary ? ` · ${(r.summary as { actionable?: number }).actionable ?? 0} com ação` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
