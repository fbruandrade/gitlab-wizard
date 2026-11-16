import { PageHeader } from '@/components/common/page-header';
import { RunnerCreateForm } from '@/components/runners/runner-create-form';
import { RunnerList } from '@/components/runners/runner-list';
import { RunnerScopePicker } from '@/components/runners/runner-scope-picker';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { RUNNER_TYPE_LABEL, runnerTargetSchema, type RunnerType } from '@/lib/runner-rules';
import { requireReadySession } from '@/server/auth/guards';
import { loadGitLab } from '@/server/page-gitlab';
import { listRunners } from '@/server/services/runner.service';
import { pageCtx, resolveSelectedToken } from '@/server/token-selection';
import { Server } from 'lucide-react';

export default async function RunnersPage({ searchParams }: { searchParams: Promise<{ type?: string; id?: string }> }) {
  const session = await requireReadySession();
  const sp = await searchParams;
  const token = await resolveSelectedToken(session.user.id);
  const canCreate = Boolean(token?.capabilities.includes('RUNNERS_CREATE'));
  const canManage = Boolean(token?.capabilities.includes('RUNNERS_MANAGE'));
  const canInstance = Boolean(token?.gitlabIsAdmin);

  const parsed = runnerTargetSchema.safeParse(sp.type === 'instance_type' ? { type: sp.type } : { type: sp.type, id: Number(sp.id) });
  const scope = parsed.success ? parsed.data : null;
  const res = canManage && scope ? await loadGitLab(async () => listRunners(await pageCtx(session), scope)) : null;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader icon={Server} tone="teal" title="Runners">
        Crie runners globais (compartilhados), de grupo ou de projeto e gerencie os existentes.
      </PageHeader>

      {!canCreate && !canManage && (
        <Alert data-testid="runners-no-cap">
          <AlertDescription>
            Requer um token GitLab com o scope <code>create_runner</code> (criar) e/ou <code>manage_runner</code> (listar, pausar, remover).
          </AlertDescription>
        </Alert>
      )}

      {canCreate && (
        <Card>
          <CardHeader>
            <CardTitle>Novo runner</CardTitle>
            <CardDescription>Runner global exige admin do GitLab; de grupo ou de projeto, papel Owner.</CardDescription>
          </CardHeader>
          <CardContent>
            <RunnerCreateForm canInstance={canInstance} />
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>Runners existentes</CardTitle>
            <CardDescription>
              {scope
                ? RUNNER_TYPE_LABEL[scope.type as RunnerType] + ('id' in scope ? ` #${scope.id}` : '')
                : 'Escolha um escopo para listar.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <RunnerScopePicker
              canInstance={canInstance}
              current={scope ? { type: scope.type, id: 'id' in scope ? scope.id : undefined } : null}
            />
            {res && !res.ok && (
              <Alert variant="destructive" role="alert" data-testid="runners-error">
                <AlertDescription>{res.message}</AlertDescription>
              </Alert>
            )}
            {res?.ok && scope && (
              <RunnerList
                scope={scope}
                runners={res.data.map((r) => ({
                  id: r.id,
                  description: r.description ?? null,
                  paused: r.paused,
                  status: r.status ?? null,
                  type: r.runner_type ?? null,
                  tags: r.tag_list ?? [],
                }))}
              />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
