import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as adminUsers from '@/app/(app)/admin/users/actions';
import * as cleanup from '@/app/(app)/admin/cleanup/actions';
import * as vault from '@/app/(app)/admin/vault/actions';
import * as policies from '@/app/(app)/admin/policies/actions';
import * as gitlabUsers from '@/app/(app)/gitlab/users/actions';
import * as tokens from '@/app/(app)/token/actions';
import { prisma } from '@/server/db';
import { addToken, listTokens } from '@/server/services/gitlab-token.service';
import { asRequest, nextState } from '../support/next-mocks';
import { ageSession, ctxFor, readyUser, resetDb, startGitLab } from '../support/app';
import type { FakeGitLab } from '../support/fake-gitlab';

vi.mock('next/headers', async () => (await import('../support/next-mocks')).headersModule);
vi.mock('next/navigation', async () => (await import('../support/next-mocks')).navigationModule);
vi.mock('next/cache', async () => (await import('../support/next-mocks')).cacheModule);

let fake: FakeGitLab;
beforeEach(async () => {
  await resetDb();
  fake = await startGitLab();
});
afterEach(() => fake.close());

const why = 'CHG0042 - validação das ações';
const fail = (r: unknown): { ok: false; code: string; fieldErrors?: Record<string, string[]> } => {
  expect(r).toMatchObject({ ok: false });
  return r as never;
};
const ok = <T>(r: { ok: boolean }): T => {
  expect(r).toMatchObject({ ok: true });
  return (r as unknown as { data: T }).data;
};
const waitScan = (id: string) =>
  vi.waitFor(async () => expect((await prisma.adminScan.findUniqueOrThrow({ where: { id } })).status).not.toBe('RUNNING'), {
    timeout: 15_000,
  });

/** Admin da ferramenta com um PAT de admin GitLab já vinculado. */
async function adminWorld() {
  const root = fake.addUser({ username: 'root', is_admin: true });
  const { u, headers } = await readyUser('boss', 'admin');
  await addToken(ctxFor(u), fake.addToken(root.id, { name: 'adm', scopes: ['api'] }).token);
  return { u, headers, root };
}

describe('ações de TOKEN', () => {
  it('adicionar: valida a entrada, exige sessão fresca, grava e revalida', async () => {
    const gl = fake.addUser({ username: 'root', is_admin: true });
    const { u, headers } = await readyUser('alice');
    asRequest(headers);
    expect(fail(await tokens.addGitLabTokenAction({ token: 'curto' })).fieldErrors?.token).toBeDefined(); // zod no servidor
    expect(fail(await tokens.addGitLabTokenAction(null)).code).toBe('VALIDATION');

    const t = fake.addToken(gl.id, { name: 'a', scopes: ['api'] });
    expect(ok<{ isDefault: boolean }>(await tokens.addGitLabTokenAction({ token: t.token })).isDefault).toBe(true);
    expect(nextState.revalidated).toContain('/');

    await ageSession(u.id, 20); // login velho → reautenticar
    expect(fail(await tokens.addGitLabTokenAction({ token: fake.addToken(gl.id).token })).code).toBe('REAUTH_REQUIRED');
    asRequest(new Headers());
    expect(fail(await tokens.addGitLabTokenAction({ token: t.token })).code).toBe('UNAUTHENTICATED');
  });

  it('padrão, escolha, substituição, rotação e remoção — sempre só do PRÓPRIO usuário', async () => {
    const gl = fake.addUser({ username: 'root', is_admin: true });
    const a = await readyUser('alice');
    const b = await readyUser('bob');
    asRequest(a.headers);
    const t1 = fake.addToken(gl.id, { name: 't1', scopes: ['api'] });
    const t2 = fake.addToken(gl.id, { name: 't2', scopes: ['api'] });
    ok(await tokens.addGitLabTokenAction({ token: t1.token }));
    ok(await tokens.addGitLabTokenAction({ token: t2.token }));
    const [row1, row2] = (await listTokens(a.u.id)).sort((x, y) => x.name.localeCompare(y.name));

    expect(ok<{ changed: boolean }>(await tokens.setDefaultGitLabTokenAction({ tokenId: row2!.id })).changed).toBe(true);
    expect(fail(await tokens.setDefaultGitLabTokenAction({ tokenId: 'nao-uuid' })).code).toBe('VALIDATION');

    // escolher o token em uso grava o cookie e NÃO exige login recente
    await ageSession(a.u.id, 120);
    ok(await tokens.selectGitLabTokenAction({ tokenId: row1!.id }));
    expect(nextState.setCookies.at(-1)).toMatchObject({ name: 'gw.active_token', value: row1!.id });

    // outro usuário não consegue tocar nos tokens da alice (nem escolher, nem remover, nem rotacionar)
    asRequest(b.headers);
    nextState.setCookies.length = 0;
    expect(fail(await tokens.selectGitLabTokenAction({ tokenId: row1!.id })).code).toBe('TOKEN_NOT_FOUND');
    expect(nextState.setCookies).toHaveLength(0); // nenhum cookie foi gravado
    expect(fail(await tokens.unlinkGitLabTokenAction({ tokenId: row1!.id })).code).toBe('TOKEN_NOT_FOUND');
    expect(fail(await tokens.setDefaultGitLabTokenAction({ tokenId: row1!.id })).code).toBe('TOKEN_NOT_FOUND');
    expect(
      fail(
        await tokens.rotateGitLabTokenAction({
          tokenId: row1!.id,
          expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
        }),
      ).code,
    ).toBe('TOKEN_NOT_FOUND');
    expect(fail(await tokens.replaceGitLabTokenAction({ tokenId: row1!.id, token: t1.token })).code).toBe('TOKEN_NOT_FOUND');
    expect(await listTokens(a.u.id)).toHaveLength(2);
  });

  it('rotacionar e substituir pelo servidor; data inválida é recusada antes de chamar o GitLab', async () => {
    const gl = fake.addUser({ username: 'root', is_admin: true });
    const { u, headers } = await readyUser('alice');
    asRequest(headers);
    const t = fake.addToken(gl.id, { name: 't', scopes: ['api'] });
    ok(await tokens.addGitLabTokenAction({ token: t.token }));
    const row = (await listTokens(u.id))[0]!;
    fake.requests.length = 0;

    expect(fail(await tokens.rotateGitLabTokenAction({ tokenId: row.id, expiresAt: '2020-01-01' })).code).toBe('INVALID_EXPIRY');
    expect(fail(await tokens.rotateGitLabTokenAction({ expiresAt: 'ontem' })).code).toBe('VALIDATION');
    expect(fake.requests.filter((r) => r.path.endsWith('/rotate'))).toHaveLength(0);

    const exp = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const rotated = ok<{ status: string; token?: string }>(
      await tokens.rotateGitLabTokenAction({ tokenId: row.id, expiresAt: exp, reveal: true }),
    );
    expect(rotated.status).toBe('ROTATED');
    expect(rotated.token).toMatch(/^glpat-/);

    const novo = fake.addToken(gl.id, { name: 'novo', scopes: ['api'] });
    const current = (await listTokens(u.id))[0]!;
    ok(await tokens.replaceGitLabTokenAction({ tokenId: current.id, token: novo.token }));
    ok(await tokens.unlinkGitLabTokenAction({ tokenId: (await listTokens(u.id))[0]!.id }));
    expect(await listTokens(u.id)).toHaveLength(0);
  });
});

describe('ações sobre USUÁRIOS GITLAB', () => {
  it('bloquear / desbloquear / resetar MFA: validam, exigem o token certo e gravam', async () => {
    const w = await adminWorld();
    const alvo = fake.addUser({ username: 'joao', two_factor_enabled: true });
    asRequest(w.headers);
    const input = { gitlabUserId: alvo.id, reason: why, confirmUsername: 'joao' };

    expect(fail(await gitlabUsers.blockGitLabUserAction({ ...input, reason: 'curto' })).code).toBe('VALIDATION');
    expect(fail(await gitlabUsers.blockGitLabUserAction({ ...input, confirmUsername: 'outro' })).code).toBe('USERNAME_MISMATCH');
    ok(await gitlabUsers.blockGitLabUserAction(input));
    expect(fake.users.get(alvo.id)!.state).toBe('blocked');
    expect(nextState.revalidated).toContain(`/gitlab/users/${alvo.id}`);

    ok(await gitlabUsers.unblockGitLabUserAction(input));
    expect(fake.users.get(alvo.id)!.state).toBe('active');
    ok(await gitlabUsers.disableGitLabUserTwoFactorAction(input));
    expect(fake.users.get(alvo.id)!.two_factor_enabled).toBe(false);

    // sem sessão → nada chega ao GitLab
    fake.requests.length = 0;
    asRequest(new Headers());
    expect(fail(await gitlabUsers.blockGitLabUserAction(input)).code).toBe('UNAUTHENTICATED');
    expect(fake.requests).toHaveLength(0);
  });
});

describe('ações de ADMINISTRAÇÃO DA FERRAMENTA (role=admin no SERVIDOR)', () => {
  it('quem não é admin é barrado em TODAS, inclusive as do cofre de tokens (a UI esconder o botão não basta)', async () => {
    const alice = await readyUser('alice');
    await readyUser('root', 'admin');
    const alvo = await prisma.user.findFirstOrThrow({ where: { username: 'root' } });
    asRequest(alice.headers);
    const t = { userId: alvo.id, reason: why };
    const calls = [
      adminUsers.createToolUserAction({ username: 'novo', name: 'Novo Nome', email: 'n@example.com', role: 'admin', reason: why }),
      adminUsers.resetToolUserPasswordAction(t),
      adminUsers.resetToolUserTwoFactorAction(t),
      adminUsers.setToolUserRoleAction({ ...t, role: 'user' }),
      adminUsers.banToolUserAction(t),
      adminUsers.unbanToolUserAction(t),
      adminUsers.revokeToolUserSessionsAction(t),
      cleanup.saveInactivityDaysAction({ days: 30 }),
      cleanup.startCleanupScanAction({ blockedUsers: true, unusedDays: 90, includePat: true, includeSsh: true }),
      cleanup.executeCleanupAction({ scanId: crypto.randomUUID(), keys: ['PAT:1'], reason: why, confirm: 'REVOGAR' }),
      vault.saveVaultConfigAction({ rootGroup: 'x', warnDays: 30, lifetimeDays: 90, scopes: ['read_api'], accessLevel: 40 }),
      vault.startVaultScanAction({ force: true }),
      vault.executeVaultAction({ scanId: crypto.randomUUID(), keys: ['project:1'], reason: why, confirm: 'APLICAR' }),
      policies.savePatLifetimeToolAction({ days: 30 }),
      policies.simulatePatLifetimeAction({ days: 30 }),
      policies.applyPatLifetimeGitLabAction({ scanId: crypto.randomUUID(), days: 30, reason: why, confirm: 'APLICAR 30' }),
    ];
    for (const r of await Promise.all(calls)) expect(r).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await prisma.user.count({ where: { username: 'novo' } })).toBe(0);
    expect(await prisma.appSetting.count()).toBe(0);
    expect(nextState.revalidated).toEqual([]); // nada foi revalidado: nada aconteceu
  });

  it('admin: cria conta (senha temporária só na resposta), valida entrada, e as demais ações funcionam', async () => {
    const boss = await readyUser('boss', 'admin');
    const alice = await readyUser('alice');
    asRequest(boss.headers);

    expect(fail(await adminUsers.createToolUserAction({ username: 'x y', name: 'N', email: 'ruim', role: 'god', reason: 'x' })).code).toBe(
      'VALIDATION',
    );
    const created = ok<{ tempPassword: string; username: string }>(
      await adminUsers.createToolUserAction({
        username: 'Maria',
        name: 'Maria Lima',
        email: 'maria@example.com',
        role: 'user',
        reason: why,
      }),
    );
    expect(created).toMatchObject({ username: 'maria' });
    expect(created.tempPassword).toHaveLength(20);
    expect(nextState.revalidated).toContain('/admin/users');

    const t = { userId: alice.u.id, reason: why };
    expect(ok<{ tempPassword: string }>(await adminUsers.resetToolUserPasswordAction(t)).tempPassword).toHaveLength(20);
    ok(await adminUsers.resetToolUserTwoFactorAction(t));
    ok(await adminUsers.revokeToolUserSessionsAction(t));
    ok(await adminUsers.setToolUserRoleAction({ ...t, role: 'admin' }));
    ok(await adminUsers.setToolUserRoleAction({ ...t, role: 'user' }));
    ok(await adminUsers.banToolUserAction(t));
    ok(await adminUsers.unbanToolUserAction(t));
    expect(fail(await adminUsers.banToolUserAction({ userId: boss.u.id, reason: why })).code).toBe('SELF_ACTION'); // não bane a si mesmo
    expect(fail(await adminUsers.banToolUserAction({ userId: alice.u.id, reason: 'curto' })).code).toBe('VALIDATION');
  });

  it('login velho (>15 min) → REAUTH_REQUIRED também para o admin', async () => {
    const boss = await readyUser('boss', 'admin');
    asRequest(boss.headers);
    await ageSession(boss.u.id, 20);
    expect(fail(await cleanup.saveInactivityDaysAction({ days: 30 })).code).toBe('REAUTH_REQUIRED');
  });
});

describe('ações da LIMPEZA e das POLÍTICAS', () => {
  it('padrão de dias: valida a faixa e persiste', async () => {
    const w = await adminWorld();
    asRequest(w.headers);
    expect(fail(await cleanup.saveInactivityDaysAction({ days: 0 })).code).toBe('VALIDATION');
    expect(fail(await cleanup.saveInactivityDaysAction({ days: 4000 })).code).toBe('VALIDATION');
    expect(ok<{ days: number }>(await cleanup.saveInactivityDaysAction({ days: 45 })).days).toBe(45);
    expect(nextState.revalidated).toContain('/admin/cleanup');
  });

  it('varredura → execução exige a palavra REVOGAR e só age sobre itens da varredura', async () => {
    const w = await adminWorld();
    const zumbi = fake.addUser({ username: 'zumbi', state: 'blocked' });
    const tok = fake.addToken(zumbi.id, { name: 'tz', scopes: ['api'] });
    asRequest(w.headers);

    expect(
      fail(await cleanup.startCleanupScanAction({ blockedUsers: false, unusedDays: null, includePat: true, includeSsh: true })).code,
    ).toBe('NO_CRITERIA');
    expect(fail(await cleanup.startCleanupScanAction({ blockedUsers: true, unusedDays: 'x' })).code).toBe('VALIDATION');
    const { scanId } = ok<{ scanId: string }>(
      await cleanup.startCleanupScanAction({ blockedUsers: true, unusedDays: null, includePat: true, includeSsh: false }),
    );
    await waitScan(scanId);

    const key = `PAT:${tok.id}`;
    for (const confirm of ['revogar', 'REVOGAR ', ''])
      expect(fail(await cleanup.executeCleanupAction({ scanId, keys: [key], reason: why, confirm })).code).toBe('VALIDATION');
    expect(fail(await cleanup.executeCleanupAction({ scanId, keys: ['PAT:424242'], reason: why, confirm: 'REVOGAR' })).code).toBe(
      'ITEMS_NOT_IN_SCAN',
    );
    expect(fake.tokens.get(tok.token)!.revoked).toBe(false); // nenhuma tentativa revogou nada

    const done = ok<{ revoked: number }>(await cleanup.executeCleanupAction({ scanId, keys: [key], reason: why, confirm: 'REVOGAR' }));
    expect(done.revoked).toBe(1);
    expect(fake.tokens.get(tok.token)!.revoked).toBe(true);
  });

  it('validade do PAT: salva na ferramenta; simulação → aplicar exige "APLICAR N" do MESMO valor', async () => {
    const w = await adminWorld();
    asRequest(w.headers);
    expect(fail(await policies.savePatLifetimeToolAction({ days: 366 })).code).toBe('VALIDATION');
    expect(ok<{ days: number }>(await policies.savePatLifetimeToolAction({ days: 120 })).days).toBe(120);
    expect(nextState.revalidated).toEqual(expect.arrayContaining(['/admin/policies', '/token']));

    expect(fail(await policies.simulatePatLifetimeAction({ days: 0 })).code).toBe('VALIDATION');
    const { scanId } = ok<{ scanId: string }>(await policies.simulatePatLifetimeAction({ days: 365 }));
    await waitScan(scanId);

    const base = { scanId, days: 365, reason: why };
    for (const confirm of ['APLICAR 90', 'aplicar 365', ''])
      expect(fail(await policies.applyPatLifetimeGitLabAction({ ...base, confirm })).code).toBe('VALIDATION');
    expect(fail(await policies.applyPatLifetimeGitLabAction({ ...base, days: 90, confirm: 'APLICAR 90' })).code).toBe(
      'SIMULATION_REQUIRED',
    ); // simulou 365, quer aplicar 90
    expect(fake.instance.maxPatLifetime).toBeNull(); // nada foi escrito no GitLab até aqui

    const applied = ok<{ days: number }>(await policies.applyPatLifetimeGitLabAction({ ...base, confirm: 'APLICAR 365' }));
    expect(applied.days).toBe(365);
    expect(fake.instance.maxPatLifetime).toBe(365);
  });
});

describe('ações do COFRE DE TOKENS', () => {
  it('configuração valida e persiste; varredura → aplicar exige APLICAR e só age sobre itens da varredura', async () => {
    const w = await adminWorld();
    const root = fake.addGroup('seguranca-corporativa');
    const hml = fake.addGroup('hml', root.id);
    fake.addGroup('app-x');
    const project = fake.addProject(hml.id, 'app-x');
    asRequest(w.headers);

    const cfg = { rootGroup: 'seguranca-corporativa', warnDays: 20, lifetimeDays: 90, scopes: ['read_api'], accessLevel: 40 };
    expect(fail(await vault.saveVaultConfigAction({ ...cfg, lifetimeDays: 999 })).code).toBe('VALIDATION');
    expect(fail(await vault.saveVaultConfigAction({ ...cfg, scopes: ['sudo'] })).code).toBe('VALIDATION');
    expect(ok<{ warnDays: number }>(await vault.saveVaultConfigAction(cfg)).warnDays).toBe(20);
    expect(nextState.revalidated).toContain('/admin/vault');

    const { scanId } = ok<{ scanId: string }>(await vault.startVaultScanAction());
    await waitScan(scanId);
    const key = `project:${project.id}`;
    for (const confirm of ['aplicar', 'APLICAR ', ''])
      expect(fail(await vault.executeVaultAction({ scanId, keys: [key], reason: why, confirm })).code).toBe('VALIDATION');
    expect(fail(await vault.executeVaultAction({ scanId, keys: ['project:1'], reason: why, confirm: 'APLICAR' })).code).toBe(
      'ITEMS_NOT_IN_SCAN',
    );
    expect(fake.requests.filter((r) => r.method !== 'GET')).toEqual([]); // nenhuma tentativa escreveu algo

    const out = ok<{ done: number }>(await vault.executeVaultAction({ scanId, keys: [key], reason: why, confirm: 'APLICAR' }));
    expect(out.done).toBe(1);
    expect(fake.variables.get(`${[...fake.groups.values()].find((g) => g.path === 'app-x')!.id}:PID_HML`)!.value).toBe(String(project.id));
  });
});
