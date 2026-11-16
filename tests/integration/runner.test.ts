import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateRunnerInput } from '@/lib/runner-rules';
import { prisma } from '@/server/db';
import { addToken } from '@/server/services/gitlab-token.service';
import {
  createRunner,
  deleteRunner,
  listRunners,
  searchRunnerTargets,
  setRunnerPaused,
  updateRunnerTags,
} from '@/server/services/runner.service';
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

describe('tags na listagem (o GitLab não as devolve nas listas, só no detalhe)', () => {
  it('a listagem traz as tags de cada runner, buscadas no detalhe', async () => {
    const w = await world();
    const scope = { type: 'group_type' as const, id: w.grupo.id };
    const a = await createRunner(w.ownerCtx, input({ target: scope, tags: ['linux', 'gpu'] }));
    const b = await createRunner(w.ownerCtx, input({ target: scope, tags: [], runUntagged: true }));
    fake.requests.length = 0;
    const list = await listRunners(w.ownerCtx, scope);
    expect(Object.fromEntries(list.map((r) => [r.id, r.tag_list]))).toEqual({ [a.runnerId]: ['linux', 'gpu'], [b.runnerId]: [] });
    // lista paginada + 1 detalhe por runner
    expect(fake.requests.filter((r) => /^\/runners\/\d+$/.test(r.path)).length).toBe(2);
  });

  it('falha ao buscar o detalhe de um runner: ele aparece sem tags (desconhecido) e os outros seguem', async () => {
    const w = await world();
    const scope = { type: 'group_type' as const, id: w.grupo.id };
    const a = await createRunner(w.ownerCtx, input({ target: scope, tags: ['a'] }));
    const b = await createRunner(w.ownerCtx, input({ target: scope, tags: ['b'] }));
    for (let i = 0; i < 3; i++) fake.fault({ match: new RegExp(`^GET /runners/${a.runnerId}$`), status: 500 }); // GET tem 3 tentativas
    const list = await listRunners(w.ownerCtx, scope);
    expect(list.find((r) => r.id === a.runnerId)!.tag_list).toBeUndefined();
    expect(list.find((r) => r.id === b.runnerId)!.tag_list).toEqual(['b']);
  });

  it('token do operador inválido durante o detalhe: o erro sobe (não é engolido)', async () => {
    const w = await world();
    const scope = { type: 'group_type' as const, id: w.grupo.id };
    const a = await createRunner(w.ownerCtx, input({ target: scope }));
    fake.fault({ match: new RegExp(`^GET /runners/${a.runnerId}$`), status: 401 });
    expect(await code(listRunners(w.ownerCtx, scope))).toBe('GITLAB_TOKEN_INVALID');
  });
});

describe('editar tags', () => {
  it('substitui as tags, devolve o que mudou e audita antes/depois com o motivo', async () => {
    const w = await world();
    const scope = { type: 'group_type' as const, id: w.grupo.id };
    const r = await createRunner(w.ownerCtx, input({ target: scope, tags: ['linux', 'docker'] }));
    const out = await updateRunnerTags(w.ownerCtx, { runnerId: r.runnerId, tags: ['docker', 'gpu', 'gpu'], reason: why, scope });
    expect(out).toEqual({ before: ['linux', 'docker'], after: ['docker', 'gpu'], added: ['gpu'], removed: ['linux'] });
    expect(fake.runners.get(r.runnerId)!.tag_list).toEqual(['docker', 'gpu']);
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: 'RUNNER_TAGS_UPDATED' } });
    expect(a).toMatchObject({ result: 'SUCCESS', reason: why });
    expect(a.metadata).toMatchObject({
      runnerId: r.runnerId,
      before: ['linux', 'docker'],
      after: ['docker', 'gpu'],
      added: ['gpu'],
      removed: ['linux'],
    });
    // a listagem já mostra as novas tags
    expect((await listRunners(w.ownerCtx, scope))[0]!.tag_list).toEqual(['docker', 'gpu']);
  });

  it('esvaziar as tags de um runner que não aceita jobs sem tag é recusado pelo GitLab, nada muda', async () => {
    const w = await world();
    const scope = { type: 'group_type' as const, id: w.grupo.id };
    const r = await createRunner(w.ownerCtx, input({ target: scope, tags: ['a'] }));
    expect(await code(updateRunnerTags(w.ownerCtx, { runnerId: r.runnerId, tags: [], reason: why, scope }))).toBe('GITLAB_BAD_REQUEST');
    expect(fake.runners.get(r.runnerId)!.tag_list).toEqual(['a']);
    expect(
      await prisma.auditLog.count({ where: { action: 'RUNNER_TAGS_UPDATED', result: 'FAILURE', errorCode: 'GITLAB_BAD_REQUEST' } }),
    ).toBe(1);
    // com "jobs sem tag" permitido, pode esvaziar
    const u = await createRunner(w.ownerCtx, input({ target: scope, tags: ['b'], runUntagged: true }));
    await updateRunnerTags(w.ownerCtx, { runnerId: u.runnerId, tags: [], reason: why, scope });
    expect(fake.runners.get(u.runnerId)!.tag_list).toEqual([]);
  });

  it('só edita runner do escopo informado e exige a capability', async () => {
    const w = await world();
    const scope = { type: 'group_type' as const, id: w.grupo.id };
    const global = await createRunner(w.adminCtx, input({ tags: ['g'] }));
    expect(await code(updateRunnerTags(w.ownerCtx, { runnerId: global.runnerId, tags: ['x'], reason: why, scope }))).toBe('NOT_FOUND');
    expect(fake.runners.get(global.runnerId)!.tag_list).toEqual(['g']);
    // `api` (sem create_runner) basta para GERIR runners já existentes (RUNNERS_MANAGE)
    const mine = await createRunner(w.ownerCtx, input({ target: scope, tags: ['m'] }));
    expect(await code(updateRunnerTags(w.semCtx, { runnerId: mine.runnerId, tags: ['n'], reason: why, scope }))).toBe('OK');
    expect(fake.runners.get(mine.runnerId)!.tag_list).toEqual(['n']);
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
