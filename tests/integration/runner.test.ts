import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateRunnerInput } from '@/lib/runner-rules';
import { prisma } from '@/server/db';
import { addToken } from '@/server/services/gitlab-token.service';
import { createRunner, deleteRunner, listRunners, searchRunnerTargets, setRunnerPaused } from '@/server/services/runner.service';
import { ctxFor, resetDb, seedUser, startGitLab } from '../support/app';
import type { FakeGitLab } from '../support/fake-gitlab';

let fake: FakeGitLab;
beforeEach(async () => {
  await resetDb();
  fake = await startGitLab();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fake.close();
});

const why = 'CHG0200 - provisionamento de runners';
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? 'THROWN';
  }
  return 'OK';
};
const input = (o: Partial<CreateRunnerInput> = {}): CreateRunnerInput => ({
  target: { type: 'instance_type' },
  description: 'runner de teste',
  tags: ['docker', 'linux'],
  runUntagged: false,
  locked: false,
  protectedRefs: false,
  paused: false,
  maximumTimeout: null,
  reason: why,
  ...o,
});

async function world() {
  const root = fake.addUser({ username: 'root', is_admin: true });
  const dono = fake.addUser({ username: 'dono' });
  const sem = fake.addUser({ username: 'semescopo' });
  const adminCtx = ctxFor(await seedUser('alice', 'user', { mustChangePassword: false }));
  await addToken(adminCtx, fake.addToken(root.id, { scopes: ['api', 'create_runner'] }).token);
  const ownerCtx = ctxFor(await seedUser('bob', 'user', { mustChangePassword: false }));
  await addToken(ownerCtx, fake.addToken(dono.id, { scopes: ['create_runner', 'manage_runner'] }).token);
  const semCtx = ctxFor(await seedUser('carol', 'user', { mustChangePassword: false }));
  await addToken(semCtx, fake.addToken(sem.id, { scopes: ['api'] }).token); // api NÃO basta para criar
  const grupo = fake.addGroup('time-a');
  const projeto = fake.addProject(grupo.id, 'app');
  return { adminCtx, ownerCtx, semCtx, grupo, projeto };
}

describe('criar runner', () => {
  it('global (admin): devolve o token UMA vez, cria com os parâmetros e audita SEM o token', async () => {
    const w = await world();
    const r = await createRunner(w.adminCtx, input({ runUntagged: true, protectedRefs: true, paused: true, maximumTimeout: 3600 }));
    expect(r.token).toMatch(/^glrt-/);
    expect(r.gitlabUrl).toMatch(/^https?:\/\//);
    const created = fake.runners.get(r.runnerId)!;
    expect(created).toMatchObject({
      runner_type: 'instance_type',
      description: 'runner de teste',
      tag_list: ['docker', 'linux'],
      run_untagged: true,
      paused: true,
      access_level: 'ref_protected',
      maximum_timeout: 3600,
    });
    expect(created.token).toBe(r.token);

    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: 'RUNNER_CREATED' } });
    expect(a).toMatchObject({ result: 'SUCCESS', reason: why, targetType: 'gitlab_runner' });
    expect(a.metadata).toMatchObject({ runnerId: r.runnerId, runnerType: 'instance_type', tags: ['docker', 'linux'] });
    expect(JSON.stringify(await prisma.auditLog.findMany())).not.toContain(r.token);
  });

  it('de grupo e de projeto (Owner não precisa ser admin); travar vale para projeto', async () => {
    const w = await world();
    const g = await createRunner(w.ownerCtx, input({ target: { type: 'group_type', id: w.grupo.id } }));
    expect(fake.runners.get(g.runnerId)).toMatchObject({ runner_type: 'group_type', groupId: w.grupo.id });
    const p = await createRunner(w.ownerCtx, input({ target: { type: 'project_type', id: w.projeto.id }, locked: true }));
    expect(fake.runners.get(p.runnerId)).toMatchObject({ runner_type: 'project_type', projectId: w.projeto.id, locked: true });
  });

  it('global por quem não é admin do GitLab: recusado ANTES de chamar o GitLab', async () => {
    const w = await world();
    fake.requests.length = 0;
    expect(await code(createRunner(w.ownerCtx, input()))).toBe('RUNNER_INSTANCE_ADMIN_ONLY');
    expect(fake.requests.filter((r) => r.method === 'POST')).toEqual([]);
    expect(fake.runners.size).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { action: 'RUNNER_CREATED', result: 'FAILURE', errorCode: 'RUNNER_INSTANCE_ADMIN_ONLY' } }),
    ).toBe(1);
  });

  it('token só com `api` (sem create_runner) não cria: MISSING_CAPABILITY', async () => {
    const w = await world();
    expect(await code(createRunner(w.semCtx, input({ target: { type: 'group_type', id: w.grupo.id } })))).toBe('MISSING_CAPABILITY');
    expect(fake.runners.size).toBe(0);
  });

  it('o GitLab recusa (sem ser Owner / registro desabilitado): erro auditado, nada criado', async () => {
    const w = await world();
    fake.denyProjects.add(w.projeto.id);
    expect(await code(createRunner(w.ownerCtx, input({ target: { type: 'project_type', id: w.projeto.id } })))).toBe('GITLAB_FORBIDDEN');
    expect(fake.runners.size).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'RUNNER_CREATED', result: 'FAILURE', errorCode: 'GITLAB_FORBIDDEN' } })).toBe(1);
  });

  it('grupo inexistente → GITLAB_NOT_FOUND; falha do GitLab (500) não é repetida (escrita sem retry)', async () => {
    const w = await world();
    expect(await code(createRunner(w.ownerCtx, input({ target: { type: 'group_type', id: 99999 } })))).toBe('GITLAB_NOT_FOUND');
    fake.requests.length = 0;
    fake.fault({ match: /^POST \/user\/runners$/, status: 500 });
    expect(await code(createRunner(w.adminCtx, input()))).toBe('GITLAB_UNAVAILABLE');
    expect(fake.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });
});

describe('buscar alvos, listar, pausar e remover', () => {
  it('busca grupos/projetos por texto e devolve o caminho completo', async () => {
    const w = await world();
    fake.addGroup('outro-time');
    expect((await searchRunnerTargets(w.ownerCtx, 'group', 'time-a')).map((t) => t.path)).toEqual(['time-a']);
    expect((await searchRunnerTargets(w.ownerCtx, 'group', '')).length).toBe(2);
    expect((await searchRunnerTargets(w.ownerCtx, 'project', 'app')).map((t) => t.path)).toEqual(['time-a/app']);
    expect(await code(searchRunnerTargets(w.semCtx, 'group', ''))).toBe('MISSING_CAPABILITY');
  });

  it('lista por escopo; global só para admin', async () => {
    const w = await world();
    const g = await createRunner(w.ownerCtx, input({ target: { type: 'group_type', id: w.grupo.id } }));
    await createRunner(w.adminCtx, input());
    expect((await listRunners(w.ownerCtx, { type: 'group_type', id: w.grupo.id })).map((r) => r.id)).toEqual([g.runnerId]);
    expect((await listRunners(w.adminCtx, { type: 'instance_type' })).length).toBe(1);
    expect(await code(listRunners(w.ownerCtx, { type: 'instance_type' }))).toBe('GITLAB_FORBIDDEN');
    expect((await listRunners(w.ownerCtx, { type: 'project_type', id: w.projeto.id })).length).toBe(0);
  });

  it('pausar e retomar; audita; só age em runner do escopo informado', async () => {
    const w = await world();
    const scope = { type: 'group_type' as const, id: w.grupo.id };
    const g = await createRunner(w.ownerCtx, input({ target: scope }));
    await setRunnerPaused(w.ownerCtx, { runnerId: g.runnerId, paused: true, scope });
    expect(fake.runners.get(g.runnerId)!.paused).toBe(true);
    await setRunnerPaused(w.ownerCtx, { runnerId: g.runnerId, paused: false, scope });
    expect(fake.runners.get(g.runnerId)!.paused).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: 'RUNNER_PAUSED', result: 'SUCCESS' } })).toBe(2);
    // id de um runner global, mas escopo de grupo: NOT_FOUND e nada muda
    const global = await createRunner(w.adminCtx, input());
    expect(await code(setRunnerPaused(w.ownerCtx, { runnerId: global.runnerId, paused: true, scope }))).toBe('NOT_FOUND');
    expect(fake.runners.get(global.runnerId)!.paused).toBe(false);
  });

  it('remover: audita com motivo; recusa runner fora do escopo', async () => {
    const w = await world();
    const scope = { type: 'group_type' as const, id: w.grupo.id };
    const g = await createRunner(w.ownerCtx, input({ target: scope }));
    const global = await createRunner(w.adminCtx, input());
    expect(await code(deleteRunner(w.ownerCtx, { runnerId: global.runnerId, reason: why, scope }))).toBe('NOT_FOUND');
    expect(fake.runners.has(global.runnerId)).toBe(true);
    await deleteRunner(w.ownerCtx, { runnerId: g.runnerId, reason: why, scope });
    expect(fake.runners.has(g.runnerId)).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: 'RUNNER_DELETED', result: 'SUCCESS', reason: why } })).toBe(1);
  });
});
