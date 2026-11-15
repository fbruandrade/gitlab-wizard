import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import type { CleanupItem, CleanupParams } from '@/lib/cleanup-rules';
import { executeCleanup, getScan, startCleanupScan } from '@/server/services/cleanup.service';
import { addToken } from '@/server/services/gitlab-token.service';
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

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? 'THROWN';
  }
  return 'OK';
};
const BOTH: CleanupParams = { blockedUsers: true, unusedDays: 90, includePat: true, includeSsh: true };
const why = 'INC0012345 - política de higiene de credenciais';

/** Cenário completo; devolve o necessário para as asserções. */
async function world() {
  const op = fake.addUser({ username: 'operador', is_admin: true });
  const opPat = fake.addToken(op.id, { scopes: ['api'], last_used_at: daysAgo(500) }); // velho de propósito: é a conta do operador
  const alice = await seedUser('alice', 'user', { mustChangePassword: false });
  const ctx = ctxFor(alice);
  await addToken(ctx, opPat.token);

  const blocked = fake.addUser({ username: 'bloqueado', state: 'blocked' });
  const ldap = fake.addUser({ username: 'ldapb', state: 'ldap_blocked' });
  const idle = fake.addUser({ username: 'ocioso' });
  const fresh = fake.addUser({ username: 'recente' });
  const never = fake.addUser({ username: 'nuncausado' });
  const nodata = fake.addUser({ username: 'semdado' });
  const bot = fake.addUser({ username: 'project_7_bot_x', bot: true });
  const other = fake.addUser({ username: 'outro' });

  const t = {
    blocked: fake.addToken(blocked.id, { name: 'b', last_used_at: daysAgo(1) }),
    ldap: fake.addToken(ldap.id, { name: 'l', last_used_at: daysAgo(1) }),
    idle: fake.addToken(idle.id, { name: 'i', last_used_at: daysAgo(120) }),
    fresh: fake.addToken(fresh.id, { name: 'f', last_used_at: daysAgo(2) }),
    never: fake.addToken(never.id, { name: 'n', last_used_at: null, created_at: daysAgo(200) }),
    bot: fake.addToken(bot.id, { name: 'bot', last_used_at: daysAgo(500) }),
    linked: fake.addToken(other.id, { name: 'vinculado', last_used_at: daysAgo(300) }),
  };
  // outro operador da ferramenta usa este PAT: não pode ser revogado por aqui
  await addToken(ctxFor(await seedUser('bob', 'user', { mustChangePassword: false })), t.linked.token);

  const k = {
    blocked: fake.addKey(blocked.id, { last_used_at: daysAgo(1) }),
    idle: fake.addKey(idle.id, { last_used_at: daysAgo(120) }),
    fresh: fake.addKey(fresh.id, { last_used_at: daysAgo(2) }),
    neverUsed: fake.addKey(never.id, { last_used_at: null, created_at: daysAgo(300) }),
    noField: fake.addKey(nodata.id, { created_at: daysAgo(900) }), // GitLab não informou last_used_at
    bot: fake.addKey(bot.id, { last_used_at: daysAgo(500) }),
  };
  return { ctx, op, opPat, t, k, ids: { blocked, ldap, idle, fresh, never, nodata, bot, other } };
}

async function scan(ctx: ReturnType<typeof ctxFor>, params: CleanupParams = BOTH) {
  const { scanId } = await startCleanupScan(ctx, params);
  await vi.waitFor(async () => expect((await prisma.adminScan.findUniqueOrThrow({ where: { id: scanId } })).status).not.toBe('RUNNING'), {
    timeout: 15_000,
  });
  const row = await prisma.adminScan.findUniqueOrThrow({ where: { id: scanId } });
  return { scanId, row, items: (row.items ?? []) as unknown as CleanupItem[], summary: row.summary as Record<string, unknown> };
}
const keysOf = (items: CleanupItem[]) => items.map((i) => i.key).sort();

describe('varredura (dry-run)', () => {
  it('encontra o que deve, ignora o que não deve, e NÃO altera nada no GitLab', async () => {
    const w = await world();
    const { items, summary, row } = await scan(w.ctx);
    expect(row.status).toBe('DONE');
    const sel = items.filter((i) => !i.protectedReason);
    expect(keysOf(sel)).toEqual(
      [
        `PAT:${w.t.blocked.id}`,
        `PAT:${w.t.ldap.id}`,
        `PAT:${w.t.idle.id}`,
        `PAT:${w.t.never.id}`,
        `SSH_KEY:${w.k.blocked.id}`,
        `SSH_KEY:${w.k.idle.id}`,
        `SSH_KEY:${w.k.neverUsed.id}`,
      ].sort(),
    );
    // não pega: usado recentemente, bot, chave sem last_used_at (de usuário ativo)
    for (const nope of [
      `PAT:${w.t.fresh.id}`,
      `PAT:${w.t.bot.id}`,
      `SSH_KEY:${w.k.fresh.id}`,
      `SSH_KEY:${w.k.noField.id}`,
      `SSH_KEY:${w.k.bot.id}`,
    ])
      expect(keysOf(items)).not.toContain(nope);
    // protegidos: PAT do próprio operador e PAT vinculado a outra conta da ferramenta
    expect(Object.fromEntries(items.filter((i) => i.protectedReason).map((i) => [i.key, i.protectedReason]))).toEqual({
      [`PAT:${w.opPat.id}`]: 'SELF',
      [`PAT:${w.t.linked.id}`]: 'LINKED_IN_TOOL',
    });
    expect(summary).toMatchObject({
      selectable: 7,
      protected: 2,
      sshLastUsedUnavailable: true,
      excluded: { bots: 1 } /* só o PAT: as chaves de bots nem são buscadas */,
    });
    // dry-run: nenhum token revogado, nenhuma chave removida, nenhuma escrita
    expect([...fake.tokens.values()].some((t) => t.revoked)).toBe(false);
    expect(fake.keys.size).toBe(6);
    expect(fake.requests.filter((r) => ['DELETE', 'PUT', 'POST', 'PATCH'].includes(r.method))).toHaveLength(0);
  });

  it('a varredura persiste os ESCOPOS dos tokens e o tipo de uso das chaves (para a tela)', async () => {
    const w = await world();
    fake.tokens.get(w.t.blocked.token)!.scopes = ['api', 'read_user', 'sudo', 'read_repository'];
    fake.keys.get(w.k.blocked.id)!.usage_type = 'auth_and_signing';
    const { items } = await scan(w.ctx);
    const by = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(by[`PAT:${w.t.blocked.id}`]!.scopes).toEqual(['api', 'read_user', 'sudo', 'read_repository']);
    expect(by[`PAT:${w.t.idle.id}`]!.scopes).toEqual(['api']); // padrão do token do cenário
    expect(by[`SSH_KEY:${w.k.blocked.id}`]).toMatchObject({ usageType: 'auth_and_signing' });
    expect(by[`SSH_KEY:${w.k.blocked.id}`]!.scopes).toBeUndefined();
  });

  it('motivos: bloqueado e/ou sem uso (cada critério isolado e combinado)', async () => {
    const w = await world();
    const only = async (p: Partial<CleanupParams>) =>
      keysOf((await scan(w.ctx, { ...BOTH, ...p })).items.filter((i) => !i.protectedReason));
    expect(await only({ unusedDays: null })).toEqual([`PAT:${w.t.blocked.id}`, `PAT:${w.t.ldap.id}`, `SSH_KEY:${w.k.blocked.id}`].sort());
    expect(await only({ blockedUsers: false, includeSsh: false })).toEqual([`PAT:${w.t.idle.id}`, `PAT:${w.t.never.id}`].sort());
    expect(await only({ blockedUsers: false, includePat: false })).toEqual(
      [`SSH_KEY:${w.k.idle.id}`, `SSH_KEY:${w.k.neverUsed.id}`].sort(),
    );
  });

  it('o número de dias é respeitado (a mesma base muda de resultado)', async () => {
    const w = await world();
    const count = async (days: number) =>
      (await scan(w.ctx, { ...BOTH, blockedUsers: false, includeSsh: false, unusedDays: days })).items.filter((i) => !i.protectedReason)
        .length;
    expect(await count(90)).toBe(2); // ocioso (120d) + nunca usado (criado há 200d)
    expect(await count(150)).toBe(1); // só o nunca usado
    expect(await count(250)).toBe(0);
  });

  it('parâmetros inválidos → NO_CRITERIA; PAT sem permissão de admin → varredura FALHA com MISSING_CAPABILITY', async () => {
    const w = await world();
    expect(await code(startCleanupScan(w.ctx, { ...BOTH, blockedUsers: false, unusedDays: null }))).toBe('NO_CRITERIA');
    expect(await code(startCleanupScan(w.ctx, { ...BOTH, includePat: false, includeSsh: false }))).toBe('NO_CRITERIA');

    const gl = fake.addUser({ username: 'comum' });
    const u = await seedUser('carol', 'user', { mustChangePassword: false });
    await addToken(ctxFor(u), fake.addToken(gl.id, { scopes: ['api'] }).token);
    const r = await scan(ctxFor(u));
    expect(r.row).toMatchObject({ status: 'FAILED', error: 'MISSING_CAPABILITY' });
  });

  it('varredura é privada de quem a criou; RUNNING sem sinal de vida vira FAILED', async () => {
    const w = await world();
    const { scanId } = await scan(w.ctx);
    expect(await getScan(scanId, w.ctx.actor.id)).not.toBeNull();
    expect(await getScan(scanId, 'outra-conta')).toBeNull();

    const stale = await prisma.adminScan.create({
      data: { id: crypto.randomUUID(), kind: 'CLEANUP', actorUserId: w.ctx.actor.id, params: {}, status: 'RUNNING' },
    });
    await prisma.$executeRaw`UPDATE admin_scan SET updated_at = now() - interval '10 minutes' WHERE id = ${stale.id}::uuid`;
    expect((await getScan(stale.id, w.ctx.actor.id))?.status).toBe('FAILED');
  });
});

describe('execução', () => {
  const selectable = (items: CleanupItem[]) => items.filter((i) => !i.protectedReason).map((i) => i.key);

  it('revoga tokens e remove chaves, audita ITEM A ITEM com motivo e registra o resumo', async () => {
    const w = await world();
    const { scanId, items } = await scan(w.ctx);
    const res = await executeCleanup(w.ctx, { scanId, keys: selectable(items), reason: why });
    expect(res).toMatchObject({ revoked: 7, skipped: 0, failed: 0 });

    for (const t of [w.t.blocked, w.t.ldap, w.t.idle, w.t.never]) expect(fake.tokens.get(t.token)!.revoked).toBe(true);
    expect([...fake.keys.keys()].sort()).toEqual([w.k.fresh.id, w.k.noField.id, w.k.bot.id].sort());
    // intocados: recente, bot, protegidos
    for (const t of [w.t.fresh, w.t.bot, w.t.linked, w.opPat]) expect(fake.tokens.get(t.token)!.revoked).toBe(false);

    const audits = await prisma.auditLog.findMany({
      where: { action: { in: ['GITLAB_CLEANUP_PAT_REVOKED', 'GITLAB_CLEANUP_SSH_KEY_DELETED'] } },
    });
    expect(audits).toHaveLength(7);
    expect(audits.every((a) => a.result === 'SUCCESS' && a.reason === why && a.actorUsername === 'alice')).toBe(true);
    expect(audits.find((a) => a.targetLabel === 'bloqueado')!.metadata).toMatchObject({
      reasons: expect.arrayContaining(['USER_BLOCKED']),
      scanId,
    });
    const [sum] = await prisma.auditLog.findMany({ where: { action: 'GITLAB_CLEANUP_EXECUTED' } });
    expect(sum).toMatchObject({ result: 'SUCCESS', reason: why });
    expect(sum!.metadata).toMatchObject({ requested: 7, revoked: 7, skipped: 0, failed: 0 });
    expect(JSON.stringify(await prisma.auditLog.findMany())).not.toMatch(/glpat-/); // nunca token em claro
  });

  it('REAVALIA antes de revogar: usado ou desbloqueado depois da varredura → ignorado, continua intacto', async () => {
    const w = await world();
    const { scanId, items } = await scan(w.ctx);
    fake.tokens.get(w.t.idle.token)!.last_used_at = new Date().toISOString(); // alguém voltou a usar
    w.ids.blocked.state = 'active'; // e o usuário foi desbloqueado
    const res = await executeCleanup(w.ctx, { scanId, keys: selectable(items), reason: why });
    const by = Object.fromEntries(res.results.map((r) => [r.key, `${r.status}${r.code ? ':' + r.code : ''}`]));
    expect(by[`PAT:${w.t.idle.id}`]).toBe('SKIPPED:CHANGED');
    expect(by[`PAT:${w.t.blocked.id}`]).toBe('SKIPPED:CHANGED');
    expect(by[`SSH_KEY:${w.k.blocked.id}`]).toBe('SKIPPED:CHANGED');
    expect(by[`PAT:${w.t.ldap.id}`]).toBe('REVOKED');
    expect(fake.tokens.get(w.t.idle.token)!.revoked).toBe(false);
    expect(fake.tokens.get(w.t.blocked.token)!.revoked).toBe(false);
    expect(fake.keys.has(w.k.blocked.id)).toBe(true);
    expect(res.skipped).toBeGreaterThanOrEqual(3);
  });

  it('só age sobre itens da varredura e nunca sobre protegidos; limite de 500 por execução', async () => {
    const w = await world();
    const { scanId, items } = await scan(w.ctx);
    expect(await code(executeCleanup(w.ctx, { scanId, keys: ['PAT:999999'], reason: why }))).toBe('ITEMS_NOT_IN_SCAN');
    expect(await code(executeCleanup(w.ctx, { scanId, keys: [`PAT:${w.opPat.id}`], reason: why }))).toBe('ITEMS_NOT_IN_SCAN'); // própria conta
    expect(await code(executeCleanup(w.ctx, { scanId, keys: [`PAT:${w.t.linked.id}`], reason: why }))).toBe('ITEMS_NOT_IN_SCAN'); // vinculado à ferramenta
    expect(await code(executeCleanup(w.ctx, { scanId, keys: [...selectable(items), `PAT:${w.opPat.id}`], reason: why }))).toBe(
      'ITEMS_NOT_IN_SCAN',
    ); // um protegido contamina o lote
    expect(await code(executeCleanup(w.ctx, { scanId, keys: Array.from({ length: 501 }, (_, i) => `PAT:${i}`), reason: why }))).toBe(
      'TOO_MANY_ITEMS',
    );
    expect(await code(executeCleanup(w.ctx, { scanId, keys: [], reason: why }))).toBe('ITEMS_NOT_IN_SCAN');
    expect(fake.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);
  });

  it('varredura de outra conta, em andamento/falha ou antiga demais é recusada', async () => {
    const w = await world();
    const { scanId, items } = await scan(w.ctx);
    const outra = await seedUser('mallory', 'user', { mustChangePassword: false });
    expect(await code(executeCleanup(ctxFor(outra), { scanId, keys: selectable(items), reason: why }))).toBe('SCAN_NOT_FOUND');
    await prisma.$executeRaw`UPDATE admin_scan SET finished_at = now() - interval '7 hours' WHERE id = ${scanId}::uuid`;
    expect(await code(executeCleanup(w.ctx, { scanId, keys: selectable(items), reason: why }))).toBe('SCAN_STALE');
    await prisma.adminScan.update({ where: { id: scanId }, data: { status: 'FAILED' } });
    expect(await code(executeCleanup(w.ctx, { scanId, keys: selectable(items), reason: why }))).toBe('SCAN_NOT_READY');
  });

  it('falha em UM item (403 do GitLab) não derruba o lote: demais seguem, resumo PARTIAL', async () => {
    const w = await world();
    const { scanId, items } = await scan(w.ctx);
    fake.fault({ match: new RegExp(`DELETE /personal_access_tokens/${w.t.ldap.id}$`), status: 403 });
    const res = await executeCleanup(w.ctx, { scanId, keys: selectable(items), reason: why });
    expect(res).toMatchObject({ revoked: 6, failed: 1 });
    expect(res.results.find((r) => r.key === `PAT:${w.t.ldap.id}`)).toMatchObject({ status: 'FAILED', code: 'GITLAB_FORBIDDEN' });
    expect(fake.tokens.get(w.t.ldap.token)!.revoked).toBe(false);
    const fail = await prisma.auditLog.findMany({ where: { result: 'FAILURE', action: 'GITLAB_CLEANUP_PAT_REVOKED' } });
    expect(fail).toHaveLength(1);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'GITLAB_CLEANUP_EXECUTED' } })).result).toBe('PARTIAL');
  });

  it('PAT do operador invalidado no meio: aborta, marca o PAT como REVOKED e audita PARTIAL', async () => {
    const w = await world();
    const { scanId, items } = await scan(w.ctx);
    fake.tokens.get(w.opPat.token)!.revoked = true;
    expect(await code(executeCleanup(w.ctx, { scanId, keys: selectable(items), reason: why }))).toBe('GITLAB_TOKEN_INVALID');
    expect((await prisma.gitLabToken.findFirstOrThrow({ where: { userId: w.ctx.actor.id } })).status).toBe('REVOKED');
    expect(fake.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);
  });

  it('escritas não têm retry: um 503 vira falha daquele item com UMA única chamada', async () => {
    const w = await world();
    const { scanId, items } = await scan(w.ctx);
    fake.fault({ match: new RegExp(`DELETE /users/${w.ids.idle.id}/keys/${w.k.idle.id}$`), status: 503 });
    const res = await executeCleanup(w.ctx, { scanId, keys: [`SSH_KEY:${w.k.idle.id}`], reason: why });
    expect(res.failed).toBe(1);
    expect(fake.requests.filter((r) => r.method === 'DELETE' && r.path.endsWith(`/keys/${w.k.idle.id}`))).toHaveLength(1);
    void items;
  });
});
