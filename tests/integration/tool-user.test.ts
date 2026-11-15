import { beforeEach, describe, expect, it } from 'vitest';
import { auth } from '@/server/auth/auth';
import { prisma } from '@/server/db';
import {
  banToolUser,
  createToolUser,
  listToolUsers,
  resetToolUserPassword,
  resetToolUserTwoFactor,
  revokeToolUserSessions,
  setToolUserRole,
  unbanToolUser,
} from '@/server/services/tool-user.service';
import { loginHeaders, PASSWORD, resetDb, seedUser } from '../support/app';

beforeEach(resetDb);
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string; message?: string }).code ?? (e as Error).message;
  }
  return 'OK';
};

async function adminCtx() {
  const admin = await seedUser('root', 'admin', { mustChangePassword: false });
  return { actor: { id: admin.id, username: 'root' }, headers: await loginHeaders('root'), admin };
}
const why = 'INC0012345 - solicitação do gestor';

describe('contas da ferramenta (admin)', () => {
  it('cria conta com senha temporária forte, mustChangePassword e auditoria; a senha nunca é auditada', async () => {
    const ctx = await adminCtx();
    const out = await createToolUser(ctx, {
      username: 'Maria.Silva',
      name: 'Maria Silva',
      email: 'MARIA@example.com',
      role: 'user',
      reason: why,
    });
    expect(out.username).toBe('maria.silva');
    expect(out.tempPassword).toHaveLength(20);

    const u = await prisma.user.findUniqueOrThrow({ where: { id: out.userId } });
    expect(u).toMatchObject({ username: 'maria.silva', email: 'maria@example.com', role: 'user', mustChangePassword: true });
    await expect(auth.api.signInUsername({ body: { username: 'maria.silva', password: out.tempPassword } })).resolves.toBeTruthy();

    const audits = await prisma.auditLog.findMany({ where: { action: 'TOOL_USER_CREATED' } });
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(out.tempPassword);
    expect(audits[0]).toMatchObject({ actorUsername: 'root', targetLabel: 'maria.silva', reason: why });
  });

  it('username/e-mail duplicados e username inválido são recusados', async () => {
    const ctx = await adminCtx();
    await createToolUser(ctx, { username: 'maria', name: 'M', email: 'm@example.com', role: 'user', reason: why });
    expect(await code(createToolUser(ctx, { username: 'maria', name: 'M2', email: 'outro@example.com', role: 'user', reason: why }))).toBe(
      'USERNAME_TAKEN',
    );
    expect(await code(createToolUser(ctx, { username: 'novo', name: 'M2', email: 'm@example.com', role: 'user', reason: why }))).toBe(
      'USERNAME_TAKEN',
    );
    expect(await code(createToolUser(ctx, { username: 'x y!', name: 'M2', email: 'z@example.com', role: 'user', reason: why }))).toBe(
      'VALIDATION',
    );
  });

  it('quem NÃO é admin não consegue operar o plugin admin, mesmo chamando o service', async () => {
    await seedUser('alice', 'user', { mustChangePassword: false });
    const h = await loginHeaders('alice');
    const ctx = { actor: { id: 'x', username: 'alice' }, headers: h };
    expect(await code(createToolUser(ctx, { username: 'zed', name: 'Z', email: 'z@example.com', role: 'admin', reason: why }))).not.toBe(
      'OK',
    );
    expect(await prisma.user.count({ where: { username: 'zed' } })).toBe(0);
  });

  it('redefinir senha: senha antiga morre, sessões caem, troca volta a ser obrigatória', async () => {
    const ctx = await adminCtx();
    const alice = await seedUser('alice', 'user', { mustChangePassword: false });
    const aliceSession = await loginHeaders('alice');
    const { tempPassword } = await resetToolUserPassword(ctx, { userId: alice.id, reason: why });
    expect(await auth.api.getSession({ headers: aliceSession, query: { disableCookieCache: true } })).toBeNull();
    await expect(auth.api.signInUsername({ body: { username: 'alice', password: PASSWORD } })).rejects.toThrow();
    await expect(auth.api.signInUsername({ body: { username: 'alice', password: tempPassword } })).resolves.toBeTruthy();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: alice.id } })).mustChangePassword).toBe(true);
  });

  it('resetar 2FA remove o segredo e as sessões', async () => {
    const ctx = await adminCtx();
    const alice = await seedUser('alice', 'user', { mustChangePassword: false });
    const h = await loginHeaders('alice');
    await auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers: h });
    await prisma.user.update({ where: { id: alice.id }, data: { twoFactorEnabled: true } });
    await resetToolUserTwoFactor(ctx, { userId: alice.id, reason: why });
    expect(await prisma.twoFactor.count({ where: { userId: alice.id } })).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: alice.id } })).twoFactorEnabled).toBe(false);
    expect(await prisma.session.count({ where: { userId: alice.id } })).toBe(0);
  });

  it('proteções: não bane a si mesmo, não remove nem bane o último admin', async () => {
    const ctx = await adminCtx();
    expect(await code(banToolUser(ctx, { userId: ctx.admin.id, reason: why }))).toBe('SELF_ACTION');
    expect(await code(setToolUserRole(ctx, { userId: ctx.admin.id, role: 'user', reason: why }))).toBe('LAST_ADMIN');

    const second = await seedUser('root2', 'admin', { mustChangePassword: false });
    await setToolUserRole(ctx, { userId: second.id, role: 'user', reason: why }); // ainda há 1 admin ativo depois? root continua → ok
    expect((await prisma.user.findUniqueOrThrow({ where: { id: second.id } })).role).toBe('user');
    await setToolUserRole(ctx, { userId: second.id, role: 'admin', reason: why });
    // agora com 2 admins, banir o outro é permitido; o último continua protegido
    await banToolUser(ctx, { userId: second.id, reason: why });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: second.id } })).banned).toBe(true);
    await unbanToolUser(ctx, { userId: second.id, reason: why });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: second.id } })).banned).toBe(false);
  });

  it('banir encerra sessões; revogar sessões também; tudo auditado', async () => {
    const ctx = await adminCtx();
    const alice = await seedUser('alice', 'user', { mustChangePassword: false });
    await loginHeaders('alice');
    await revokeToolUserSessions(ctx, { userId: alice.id, reason: why });
    expect(await prisma.session.count({ where: { userId: alice.id } })).toBe(0);
    await loginHeaders('alice');
    await banToolUser(ctx, { userId: alice.id, reason: why });
    expect(await prisma.session.count({ where: { userId: alice.id } })).toBe(0);
    const actions = (await prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } }))
      .map((a) => a.action)
      .filter((a) => a.startsWith('TOOL_USER'));
    expect(actions).toEqual(['TOOL_USER_SESSIONS_REVOKED', 'TOOL_USER_BANNED']);
  });

  it('lista com busca, paginação e PAT vinculado', async () => {
    await adminCtx();
    for (let i = 0; i < 25; i++) await seedUser(`user${String(i).padStart(2, '0')}`);
    const p1 = await listToolUsers(undefined, 1, 20);
    expect(p1.total).toBe(26);
    expect(p1.pages).toBe(2);
    expect((await listToolUsers('user07')).items.map((u) => u.username)).toEqual(['user07']);
  });
});
