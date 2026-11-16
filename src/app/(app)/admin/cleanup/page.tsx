import Link from 'next/link';
import { CleanupForm } from '@/components/admin/cleanup-form';
import { CleanupResults } from '@/components/admin/cleanup-results';
import { ScanStatus } from '@/components/admin/scan-status';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { CleanupItem } from '@/lib/cleanup-rules';
import { formatDateTime, scanStatusLabel } from '@/lib/format';
import { messageFor } from '@/lib/messages';
import { href } from '@/lib/routes';
import { requireAdminPage } from '@/server/auth/guards';
import { getScan, recentScans } from '@/server/services/cleanup.service';
import { resolveSelectedToken } from '@/server/token-selection';
import { getSettings } from '@/server/services/settings.service';
import { PageHeader } from '@/components/common/page-header';
import { Eraser } from 'lucide-react';

export default async function CleanupPage({ searchParams }: { searchParams: Promise<{ scan?: string }> }) {
  const session = await requireAdminPage();
  const { scan: scanId } = await searchParams;
  const [token, settings, recent] = await Promise.all([
    resolveSelectedToken(session.user.id),
    getSettings(),
    recentScans(session.user.id, 'CLEANUP'),
  ]);
  const canAdmin = Boolean(token?.capabilities.includes('ADMIN_USERS'));
  const scan = scanId && /^[0-9a-f-]{36}$/.test(scanId) ? await getScan(scanId, session.user.id, 'CLEANUP') : null;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader icon={Eraser} tone="rose" title="Limpeza de credenciais">
        Revoga tokens e chaves SSH de usuários bloqueados, sem uso e/ou sem validade. Sempre começa por uma simulação.
      </PageHeader>

      {!canAdmin ? (
        <Alert data-testid="cleanup-no-cap">
          <AlertDescription>
            Requer um token GitLab de <strong>administrador</strong> com scope <code>api</code> (e <code>admin_mode</code>, se aplicável)
            vinculado à sua conta.
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Nova varredura</CardTitle>
              <CardDescription>Padrão salvo: {settings.cleanupInactivityDays} dias sem uso.</CardDescription>
            </CardHeader>
            <CardContent>
              <CleanupForm defaultDays={settings.cleanupInactivityDays} savedDays={settings.cleanupInactivityDays} />
            </CardContent>
          </Card>

          {scan && (
            <Card data-testid="scan-card">
              <CardHeader>
                <CardTitle>Resultado da varredura</CardTitle>
                <CardDescription>{formatDateTime(scan.createdAt)}</CardDescription>
              </CardHeader>
              <CardContent>
                {scan.status === 'RUNNING' && <ScanStatus scanId={scan.id} />}
                {scan.status === 'FAILED' && (
                  <Alert variant="destructive" role="alert" data-testid="scan-failed">
                    <AlertDescription>A varredura falhou: {messageFor(scan.error ?? 'INTERNAL')}</AlertDescription>
                  </Alert>
                )}
                {scan.status === 'DONE' && (
                  <CleanupResults scanId={scan.id} items={(scan.items ?? []) as unknown as CleanupItem[]} summary={scan.summary as never} />
                )}
              </CardContent>
            </Card>
          )}

          {recent.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Varreduras recentes</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="divide-y text-sm">
                  {recent.map((r) => (
                    <li key={r.id} className="flex justify-between py-2">
                      <Link className="underline-offset-2 hover:underline" href={href(`/admin/cleanup?scan=${r.id}`)}>
                        {formatDateTime(r.createdAt)}
                      </Link>
                      <span className="text-muted-foreground">
                        {scanStatusLabel(r.status)}
                        {r.summary ? ` · ${(r.summary as { selectable?: number }).selectable ?? 0} revogáveis` : ''}
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
