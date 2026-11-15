import { PoliciesPanel, type SimData, type SimItem } from '@/components/admin/policies-panel';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { messageFor } from '@/lib/messages';
import { pageCtx } from '@/server/token-selection';
import { requireAdminPage } from '@/server/auth/guards';
import { getScan } from '@/server/services/cleanup.service';
import { resolveSelectedToken } from '@/server/token-selection';
import { getGitLabPatLifetime } from '@/server/services/pat-policy.service';
import { getSettings } from '@/server/services/settings.service';

export default async function PoliciesPage({ searchParams }: { searchParams: Promise<{ sim?: string }> }) {
  const session = await requireAdminPage();
  const { sim: simId } = await searchParams;
  const ctx = await pageCtx(session);
  const [token, settings] = await Promise.all([resolveSelectedToken(session.user.id), getSettings()]);
  const canAdmin = Boolean(token?.capabilities.includes('ADMIN_USERS'));

  const scan = canAdmin && simId && /^[0-9a-f-]{36}$/.test(simId) ? await getScan(simId, session.user.id, 'PAT_LIFETIME') : null;
  const gitlab = canAdmin ? await getGitLabPatLifetime(ctx) : ({ available: false, reason: 'MISSING_CAPABILITY' } as const);
  const sim: SimData | null = scan
    ? {
        id: scan.id,
        status: scan.status,
        days: (scan.params as { days: number }).days,
        summary: (scan.summary ?? undefined) as SimData['summary'],
        items: (scan.items ?? undefined) as unknown as SimItem[] | undefined,
      }
    : null;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Políticas</h1>
        <p className="text-sm text-muted-foreground">Prazo máximo de validade do PAT, na ferramenta e no GitLab.</p>
      </div>
      {!canAdmin && (
        <Alert data-testid="policies-no-cap">
          <AlertDescription>
            Para simular ou aplicar no GitLab, vincule um token de <strong>administrador</strong> GitLab (scope <code>api</code> e{' '}
            <code>admin_mode</code>, se aplicável). A configuração da ferramenta continua disponível.
          </AlertDescription>
        </Alert>
      )}
      <PoliciesPanel
        toolDays={settings.patMaxLifetimeDays}
        gitlab={gitlab}
        sim={sim}
        failedMessage={scan?.error ? messageFor(scan.error) : undefined}
      />
    </div>
  );
}
