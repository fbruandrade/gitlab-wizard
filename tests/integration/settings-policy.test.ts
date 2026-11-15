import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { applyGitLabPatLifetime, getGitLabPatLifetime, startPatLifetimeSimulation } from '@/server/services/pat-policy.service';
import { rotateToken, addToken } from '@/server/services/gitlab-token.service';
import { getSettings, updateSetting } from '@/server/services/settings.service';
import { ctxFor, resetDb, seedUser, startGitLab } from '../support/app';
import type { FakeGitLab } from '../support/fake-gitlab';

let fake: FakeGitLab;
beforeEach(async () => {
  await resetDb();
  fake = await startGitLab();
});
afterEach(async () => {
  await fake.close();
});

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? 'THROWN';
  }
  return 'OK';
};
const why = 'CHG0001234 - política de validade de tokens';

describe('configurações editáveis na interface', () => {
  it('padrões: 90 dias sem uso e o TOKEN_MAX_LIFETIME_DAYS do .env', async () => {
    expect(await getSettings()).toEqual({ cleanupInactivityDays: 90, patMaxLifetimeDays: 365 });
  });

  it('salva, relê, audita com antes/depois', async () => {
    const u = await seedUser('alice');
    await updateSetting({ actor: { id: u.id, username: 'alice' } }, 'cleanupInactivityDays', 45, 'ajuste');
    await updateSetting({ actor: { id: u.id, username: 'alice' } }, 'patMaxLifetimeDays', 180);
    expect(await getSettings()).toEqual({ cleanupInactivityDays: 45, patMaxLifetimeDays: 180 });
    const rows = await prisma.auditLog.findMany({ where: { action: 'SETTINGS_CHANGED' }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => r.metadata)).toEqual([
      { setting: 'cleanup.inactivityDays', from: 90, to: 45 },
      { setting: 'pat.maxLifetimeDays', from: 365, to: 180 },
    ]);
  });

  it.each([
    ['cleanupInactivityDays', 0],
    ['cleanupInactivityDays', 3651],
    ['cleanupInactivityDays', 1.5],
    ['cleanupInactivityDays', '90'],
    ['patMaxLifetimeDays', 366],
    ['patMaxLifetimeDays', -1],
    ['patMaxLifetimeDays', null],
  ] as const)('%s = %j é recusado e nada muda', async (name, value) => {
    const u = await seedUser('alice');
    expect(await code(updateSetting({ actor: { id: u.id } }, name, value))).toBe('INVALID_SETTING');
    expect(await prisma.appSetting.count()).toBe(0);
  });

  it('valor corrompido no banco volta ao padrão em vez de quebrar', async () => {
    await prisma.appSetting.create({ data: { key: 'cleanup.inactivityDays', value: 'abc' } });
    expect((await getSettings()).cleanupInactivityDays).toBe(90);
  });

  it('a validade máxima configurada passa a LIMITAR a rotação do token (sem chamar o GitLab)', async () => {
    const gl = fake.addUser({ username: 'root', is_admin: true });
    const u = await seedUser('alice', 'user', { mustChangePassword: false });
    const ctx = ctxFor(u);
    await addToken(ctx, fake.addToken(gl.id, { scopes: ['api'] }).token);
    await updateSetting({ actor: ctx.actor }, 'patMaxLifetimeDays', 30);

    expect(await code(rotateToken(ctx, inDays(45), false))).toBe('INVALID_EXPIRY');
    expect(fake.requests.filter((r) => r.path.endsWith('/rotate'))).toHaveLength(0);
    expect((await rotateToken(ctx, inDays(20), false)).status).toBe('ROTATED');
  });
});

describe('política de validade máxima do PAT no GitLab (simulação → aplicação)', () => {
  async function setup() {
    const op = fake.addUser({ username: 'operador', is_admin: true });
    const opPat = fake.addToken(op.id, { scopes: ['api'], expires_at: inDays(300) }); // seria revogado pelo limite!
    const alice = await seedUser('alice', 'user', { mustChangePassword: false });
    const ctx = ctxFor(alice);
    await addToken(ctx, opPat.token);
    const a = fake.addUser({ username: 'ana' });
    const bot = fake.addUser({ username: 'project_1_bot_z', bot: true });
    const t = {
      long: fake.addToken(a.id, { name: 'longo', expires_at: inDays(200) }),
      ok: fake.addToken(a.id, { name: 'curto', expires_at: inDays(30) }),
      noExp: fake.addToken(a.id, { name: 'sem-exp', expires_at: null }),
      bot: fake.addToken(bot.id, { name: 'bot', expires_at: inDays(365) }),
    };
    return { ctx, opPat, t };
  }
  const simulate = async (ctx: ReturnType<typeof ctxFor>, days: number) => {
    const { scanId } = await startPatLifetimeSimulation(ctx, days);
    await vi.waitFor(async () => expect((await prisma.adminScan.findUniqueOrThrow({ where: { id: scanId } })).status).toBe('DONE'), {
      timeout: 15_000,
    });
    return { scanId, row: await prisma.adminScan.findUniqueOrThrow({ where: { id: scanId } }) };
  };

  it('a SIMULAÇÃO lista o que seria revogado, sinaliza o que quebra a ferramenta e NÃO altera o GitLab', async () => {
    const w = await setup();
    const { row } = await simulate(w.ctx, 90);
    expect(row.summary).toMatchObject({ privileged: 3 }); // todos os afetados têm `api` (padrão do cenário)
    expect(row.summary).toMatchObject({
      days: 90,
      affected: 3,
      withoutExpiry: 1,
      users: 3,
      linkedInTool: 1,
      bots: 1,
      selfAffected: true,
    });
    const items = row.items as { tokenId: number; self: boolean; linkedInTool: boolean; bot: boolean }[];
    expect(items.map((i) => i.tokenId).sort()).toEqual([w.t.long.id, w.t.bot.id, w.opPat.id].sort());
    expect(items.find((i) => i.tokenId === w.opPat.id)).toMatchObject({ self: true, linkedInTool: true });
    expect(fake.instance.maxPatLifetime).toBeNull();
    expect([...fake.tokens.values()].some((t) => t.revoked)).toBe(false);
    expect(fake.requests.filter((r) => r.method === 'PUT')).toHaveLength(0);
  });

  it('a simulação registra os ESCOPOS de cada token (e conta só os privilegiados)', async () => {
    const w = await setup();
    fake.tokens.get(w.t.long.token)!.scopes = ['read_user', 'read_api']; // sem privilégio
    fake.tokens.get(w.t.bot.token)!.scopes = ['api', 'sudo'];
    const { row } = await simulate(w.ctx, 90);
    const items = row.items as { tokenId: number; scopes: string[] }[];
    expect(items.find((i) => i.tokenId === w.t.long.id)!.scopes).toEqual(['read_user', 'read_api']);
    expect(items.find((i) => i.tokenId === w.t.bot.id)!.scopes).toEqual(['api', 'sudo']);
    expect(items.find((i) => i.tokenId === w.opPat.id)!.scopes).toEqual(['api']);
    expect(row.summary).toMatchObject({ affected: 3, privileged: 2 }); // bot (api,sudo) e o token do operador (api)
  });

  it('aplicar exige simulação do MESMO valor; depois aplica, o GitLab revoga o previsto e tudo é auditado', async () => {
    const w = await setup();
    expect(await code(applyGitLabPatLifetime(w.ctx, { scanId: crypto.randomUUID(), days: 90, reason: why }))).toBe('SCAN_NOT_FOUND');
    const { scanId } = await simulate(w.ctx, 90);
    expect(await code(applyGitLabPatLifetime(w.ctx, { scanId, days: 60, reason: why }))).toBe('SIMULATION_REQUIRED'); // outro valor
    expect(fake.requests.filter((r) => r.method === 'PUT')).toHaveLength(0);

    const out = await applyGitLabPatLifetime(w.ctx, { scanId, days: 90, reason: why });
    expect(out).toEqual({ days: 90, expectedRevocations: 3 });
    expect(fake.instance.maxPatLifetime).toBe(90);
    expect(fake.tokens.get(w.t.long.token)!.revoked).toBe(true);
    expect(fake.tokens.get(w.t.ok.token)!.revoked).toBe(false);
    expect(fake.tokens.get(w.t.noExp.token)!.revoked).toBe(false);

    const [a] = await prisma.auditLog.findMany({ where: { action: 'GITLAB_POLICY_PAT_LIFETIME_APPLIED' } });
    expect(a).toMatchObject({ result: 'SUCCESS', reason: why });
    expect(a!.metadata).toMatchObject({ days: 90, expectedRevocations: 3, linkedInTool: 1, selfAffected: true });
    expect(await prisma.auditLog.count({ where: { action: 'GITLAB_POLICY_PAT_LIFETIME_SIMULATED' } })).toBe(1);
  });

  it('simulação antiga (>30 min) ou de outra conta não vale', async () => {
    const w = await setup();
    const { scanId } = await simulate(w.ctx, 90);
    expect(
      await code(
        applyGitLabPatLifetime(ctxFor(await seedUser('mallory', 'user', { mustChangePassword: false })), { scanId, days: 90, reason: why }),
      ),
    ).toBe('SCAN_NOT_FOUND');
    await prisma.$executeRaw`UPDATE admin_scan SET finished_at = now() - interval '31 minutes' WHERE id = ${scanId}::uuid`;
    expect(await code(applyGitLabPatLifetime(w.ctx, { scanId, days: 90, reason: why }))).toBe('SCAN_STALE');
    expect(fake.instance.maxPatLifetime).toBeNull();
  });

  it('instância SEM o recurso (não Ultimate): o GitLab responde 200 ignorando o campo → erro claro e auditoria FAILURE', async () => {
    const w = await setup();
    fake.instance.ultimate = false;
    const { scanId } = await simulate(w.ctx, 90);
    expect(await code(applyGitLabPatLifetime(w.ctx, { scanId, days: 90, reason: why }))).toBe('GITLAB_SETTING_NOT_APPLIED');
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'GITLAB_POLICY_PAT_LIFETIME_APPLIED' } })).result).toBe('FAILURE');
    expect([...fake.tokens.values()].some((t) => t.revoked)).toBe(false);
  });

  it('valor fora de 1–365 não inicia simulação; leitura do limite atual do GitLab', async () => {
    const w = await setup();
    for (const bad of [0, 366, 1.5]) expect(await code(startPatLifetimeSimulation(w.ctx, bad))).toBe('INVALID_SETTING');
    expect(await getGitLabPatLifetime(w.ctx)).toEqual({ available: true, days: null });
    fake.instance.maxPatLifetime = 120;
    expect(await getGitLabPatLifetime(w.ctx)).toEqual({ available: true, days: 120 });
  });

  it('sem permissão de admin: a leitura devolve "indisponível" em vez de quebrar', async () => {
    const gl = fake.addUser({ username: 'comum' });
    const u = await seedUser('carol', 'user', { mustChangePassword: false });
    await addToken(ctxFor(u), fake.addToken(gl.id, { scopes: ['api'] }).token);
    expect(await getGitLabPatLifetime(ctxFor(u))).toMatchObject({ available: false });
  });
});
