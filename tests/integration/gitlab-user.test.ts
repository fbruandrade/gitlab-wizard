import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/server/db';
import {
  blockGitLabUser,
  disableGitLabUserTwoFactor,
  getGitLabLicense,
  searchGitLabUsers,
  unblockGitLabUser,
} from '@/server/services/gitlab-user.service';
import { addToken } from '@/server/services/gitlab-token.service';
import { runAction } from '@/server/action-result';
import { ctxFor, resetDb, seedUser, startGitLab } from '../support/app';
import type { FakeGitLab } from '../support/fake-gitlab';

let fake: FakeGitLab;
beforeEach(async () => {
  await resetDb();
  fake = await startGitLab({ adminMode: true });
});
afterEach(() => fake.close());

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? 'THROWN';
  }
  return 'OK';
};
const writes = () => fake.requests.filter((r) => ['POST', 'PATCH'].includes(r.method));

async function operator(scopes = ['api', 'admin_mode'], isAdmin = true) {
  const gl = fake.addUser({ username: 'operador', is_admin: isAdmin });
  const user = await seedUser('alice', 'user', { mustChangePassword: false });
  const ctx = ctxFor(user);
  await addToken(ctx, fake.addToken(gl.id, { scopes }).token);
  return ctx;
}
const input = (u: { id: number; username: string }, reason = 'INC0012345 - pedido do usuário') => ({
  gitlabUserId: u.id,
  reason,
  confirmUsername: u.username,
});

describe('bloqueio de usuário GitLab', () => {
  it('bloqueia um usuário active, audita com motivo e estado antes/depois; depois desbloqueia (ida e volta)', async () => {
    const ctx = await operator();
    const target = fake.addUser({ username: 'joao' });
    await blockGitLabUser(ctx, input(target));
    expect(fake.users.get(target.id)!.state).toBe('blocked');
    const [a] = await prisma.auditLog.findMany({ where: { action: 'GITLAB_USER_BLOCKED' } });
    expect(a).toMatchObject({ result: 'SUCCESS', actorUsername: 'alice', targetLabel: 'joao', reason: 'INC0012345 - pedido do usuário' });
    expect(a!.metadata).toMatchObject({ stateBefore: { state: 'active' }, stateAfter: { state: 'blocked' } });

    await unblockGitLabUser(ctx, input(target));
    expect(fake.users.get(target.id)!.state).toBe('active');
  });

  it('NÃO permite bloquear a própria conta GitLab (o operador perderia o acesso) — nada é escrito', async () => {
    const ctx = await operator();
    const self = [...fake.users.values()].find((u) => u.username === 'operador')!;
    expect(await code(blockGitLabUser(ctx, input(self)))).toBe('SELF_ACTION');
    expect(writes()).toHaveLength(0);
    expect(fake.users.get(self.id)!.state).toBe('active');
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'GITLAB_USER_BLOCKED' } })).errorCode).toBe('SELF_ACTION');
  });

  it.each([
    ['username de confirmação diferente', { state: 'active' }, { confirmUsername: 'outro' }, 'USERNAME_MISMATCH'],
    ['já está blocked (estado mudou)', { state: 'blocked' }, {}, 'STATE_CHANGED'],
    ['ldap_blocked', { state: 'ldap_blocked' }, {}, 'GITLAB_LDAP_BLOCKED'],
    ['deactivated (não suportado)', { state: 'deactivated' }, {}, 'STATE_CHANGED'],
  ] as const)('%s → %s, sem escrita', async (_n, userState, override, expected) => {
    const ctx = await operator();
    const target = fake.addUser({ username: 'joao', ...userState });
    expect(await code(blockGitLabUser(ctx, { ...input(target), ...override }))).toBe(expected);
    expect(writes()).toHaveLength(0);
  });

  it('PAT sem permissão de admin → MISSING_CAPABILITY sem consultar o alvo', async () => {
    const ctx = await operator(['api', 'admin_mode'], false);
    const target = fake.addUser({ username: 'joao' });
    expect(await code(blockGitLabUser(ctx, input(target)))).toBe('MISSING_CAPABILITY');
    expect(fake.requests.some((r) => r.path.startsWith('/users'))).toBe(false);
  });

  it('403 do GitLab (ex.: proteção da instância) → GITLAB_FORBIDDEN, auditado como FAILURE', async () => {
    const ctx = await operator();
    const target = fake.addUser({ username: 'joao' });
    fake.fault({ match: /POST \/users\/\d+\/block/, status: 403 });
    expect(await code(blockGitLabUser(ctx, input(target)))).toBe('GITLAB_FORBIDDEN');
    expect(fake.users.get(target.id)!.state).toBe('active');
  });

  it('escrita sem retry: 503 → uma única chamada', async () => {
    const ctx = await operator();
    const target = fake.addUser({ username: 'joao' });
    fake.fault({ match: /POST \/users\/\d+\/block/, status: 503 });
    expect(await code(blockGitLabUser(ctx, input(target)))).toBe('GITLAB_UNAVAILABLE');
    expect(fake.requests.filter((r) => r.path.endsWith('/block'))).toHaveLength(1);
  });
});

describe('desbloqueio de usuário GitLab', () => {
  it('desbloqueia `blocked`, audita com motivo e estado antes/depois', async () => {
    const ctx = await operator();
    const target = fake.addUser({ username: 'joao', state: 'blocked' });
    await unblockGitLabUser(ctx, input(target));
    expect(fake.users.get(target.id)!.state).toBe('active');
    const [a] = await prisma.auditLog.findMany({ where: { action: 'GITLAB_USER_UNBLOCKED' } });
    expect(a).toMatchObject({ result: 'SUCCESS', actorUsername: 'alice', targetLabel: 'joao', reason: 'INC0012345 - pedido do usuário' });
    expect(a!.metadata).toMatchObject({ stateBefore: { state: 'blocked' }, stateAfter: { state: 'active' } });
  });

  it('username de confirmação diferente → nada é escrito no GitLab', async () => {
    const ctx = await operator();
    const target = fake.addUser({ username: 'joao', state: 'blocked' });
    expect(await code(unblockGitLabUser(ctx, { ...input(target), confirmUsername: 'maria' }))).toBe('USERNAME_MISMATCH');
    expect(writes()).toHaveLength(0);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'GITLAB_USER_UNBLOCKED' } })).result).toBe('FAILURE');
  });

  it('estado mudou desde a tela (já está active) → STATE_CHANGED, sem escrita', async () => {
    const ctx = await operator();
    const target = fake.addUser({ username: 'joao', state: 'active' });
    expect(await code(unblockGitLabUser(ctx, input(target)))).toBe('STATE_CHANGED');
    expect(writes()).toHaveLength(0);
  });

  it('ldap_blocked → erro específico, sem escrita', async () => {
    const ctx = await operator();
    const target = fake.addUser({ username: 'joao', state: 'ldap_blocked' });
    expect(await code(unblockGitLabUser(ctx, input(target)))).toBe('GITLAB_LDAP_BLOCKED');
    expect(writes()).toHaveLength(0);
  });

  it('PAT sem permissão de admin → MISSING_CAPABILITY sem sequer consultar o alvo', async () => {
    const ctx = await operator(['api', 'admin_mode'], false);
    const target = fake.addUser({ username: 'joao', state: 'blocked' });
    expect(await code(unblockGitLabUser(ctx, input(target)))).toBe('MISSING_CAPABILITY');
    expect(fake.requests.some((r) => r.path.startsWith('/users'))).toBe(false);
  });

  it('a ferramenta não sabe do Admin Mode, mas o GitLab exige: o 403 dele prevalece e nada é escrito', async () => {
    const ctx = await operator(['api']); // sem admin_mode; env de teste = Admin Mode desligado
    const target = fake.addUser({ username: 'joao', state: 'blocked' });
    expect(await code(unblockGitLabUser(ctx, input(target)))).toBe('GITLAB_FORBIDDEN');
    expect(fake.users.get(target.id)!.state).toBe('blocked');
  });

  it('usuário inexistente → GITLAB_NOT_FOUND, auditado como FAILURE', async () => {
    const ctx = await operator();
    expect(await code(unblockGitLabUser(ctx, { gitlabUserId: 99999, reason: 'INC0000001 teste', confirmUsername: 'x' }))).toBe(
      'GITLAB_NOT_FOUND',
    );
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'GITLAB_USER_UNBLOCKED' } })).errorCode).toBe('GITLAB_NOT_FOUND');
  });
});

describe('reset de MFA de usuário GitLab', () => {
  it('desabilita o 2FA e audita', async () => {
    const ctx = await operator();
    const target = fake.addUser({ username: 'maria', two_factor_enabled: true });
    await disableGitLabUserTwoFactor(ctx, input(target));
    expect(fake.users.get(target.id)!.two_factor_enabled).toBe(false);
    const [a] = await prisma.auditLog.findMany({ where: { action: 'GITLAB_USER_2FA_DISABLED' } });
    expect(a!.metadata).toMatchObject({ stateBefore: { twoFactorEnabled: true }, stateAfter: { twoFactorEnabled: false } });
  });

  it('usuário sem 2FA → STATE_CHANGED sem escrita; username errado → sem escrita', async () => {
    const ctx = await operator();
    const target = fake.addUser({ username: 'maria', two_factor_enabled: false });
    expect(await code(disableGitLabUserTwoFactor(ctx, input(target)))).toBe('STATE_CHANGED');
    const t2 = fake.addUser({ username: 'pedro', two_factor_enabled: true });
    expect(await code(disableGitLabUserTwoFactor(ctx, { ...input(t2), confirmUsername: 'outro' }))).toBe('USERNAME_MISMATCH');
    expect(writes()).toHaveLength(0);
  });
});

describe('reset de MFA: regras do GitLab para administradores', () => {
  it('alvo é administrador GitLab → erro específico e NENHUMA chamada de escrita (a API devolveria 403)', async () => {
    const ctx = await operator();
    const target = fake.addUser({ username: 'chefe', is_admin: true, two_factor_enabled: true });
    expect(await code(disableGitLabUserTwoFactor(ctx, input(target)))).toBe('GITLAB_ADMIN_2FA_UNSUPPORTED');
    expect(writes()).toHaveLength(0);
    expect(fake.users.get(target.id)!.two_factor_enabled).toBe(true);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'GITLAB_USER_2FA_DISABLED' } })).errorCode).toBe(
      'GITLAB_ADMIN_2FA_UNSUPPORTED',
    );
  });

  it('a própria conta GitLab do operador também não', async () => {
    const ctx = await operator();
    const self = [...fake.users.values()].find((u) => u.username === 'operador')!;
    self.two_factor_enabled = true;
    expect(await code(disableGitLabUserTwoFactor(ctx, input(self)))).toBe('GITLAB_ADMIN_2FA_UNSUPPORTED');
    expect(writes()).toHaveLength(0);
  });

  it('um 403 do GitLab em outro cenário mostra a explicação e o motivo devolvido pelo GitLab (sem culpar o scope)', async () => {
    const ctx = await operator();
    const target = fake.addUser({ username: 'maria', two_factor_enabled: true });
    fake.fault({ match: /PATCH .*disable_two_factor/, status: 403, body: { message: '403 Forbidden - regra da instância' } });
    const res = await runAction(() => disableGitLabUserTwoFactor(ctx, input(target)));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('GITLAB_FORBIDDEN');
      expect(res.message).toContain('O GitLab recusou a ação (403)');
      expect(res.message).toContain('regra da instância'); // motivo do GitLab
      expect(res.message).not.toMatch(/não tem o scope|Requer admin GitLab/);
    }
  });
});

describe('licença da instância', () => {
  it('lê os 4 números de GET /license', async () => {
    const ctx = await operator();
    fake.setLicense({
      plan: 'ultimate',
      user_limit: 100,
      maximum_user_count: 300,
      active_users: 300,
      overage: 200,
      expires_at: '2027-01-27',
      expired: false,
    });
    const l = await getGitLabLicense(ctx);
    expect(l).toMatchObject({ plan: 'ultimate', user_limit: 100, maximum_user_count: 300, active_users: 300, overage: 200 });
  });

  it('sem licença (404) → GITLAB_NOT_FOUND, sem marcar o PAT como inválido', async () => {
    const ctx = await operator();
    fake.setLicense(null);
    expect(await code(getGitLabLicense(ctx))).toBe('GITLAB_NOT_FOUND');
    expect((await prisma.gitLabToken.findFirstOrThrow()).status).toBe('ACTIVE');
  });

  it('resposta sem os campos numéricos não quebra (campos viram null)', async () => {
    const ctx = await operator();
    fake.setLicense({ plan: 'free' });
    const l = await getGitLabLicense(ctx);
    expect(l.user_limit ?? null).toBeNull();
  });

  it('exige capacidade de leitura de usuários (admin)', async () => {
    const ctx = await operator(['api', 'admin_mode'], false);
    expect(await code(getGitLabLicense(ctx))).toBe('MISSING_CAPABILITY');
  });
});

describe('busca', () => {
  it('filtra por texto e por bloqueados', async () => {
    const ctx = await operator();
    fake.addUser({ username: 'joao', state: 'blocked' });
    fake.addUser({ username: 'jonas' });
    expect((await searchGitLabUsers(ctx, { search: 'jo' })).items.map((u) => u.username).sort()).toEqual(['joao', 'jonas']);
    expect((await searchGitLabUsers(ctx, { blocked: true })).items.map((u) => u.username)).toEqual(['joao']);
  });
});
