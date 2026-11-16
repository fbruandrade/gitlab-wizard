import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cipher from '@/server/crypto/token-cipher';
import { prisma } from '@/server/db';
import { ActionError } from '@/server/action-result';
import { GitLabApiError } from '@/server/gitlab/errors';
import {
  addToken,
  getActiveToken,
  replaceToken,
  rotateToken,
  unlinkToken,
  validateExpiry,
  withGitLab,
} from '@/server/services/gitlab-token.service';
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

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? 'THROWN';
  }
  return 'OK';
};

async function linked(scopes = ['api']) {
  const gl = fake.addUser({ username: 'root', is_admin: true });
  const tok = fake.addToken(gl.id, { scopes });
  const user = await seedUser('alice', 'user', { mustChangePassword: false });
  const ctx = ctxFor(user);
  await addToken(ctx, tok.token);
  return { gl, tok, user, ctx };
}

describe('vincular PAT', () => {
  it('valida no GitLab, calcula capacidades e guarda CIFRADO (sem o token em claro no banco)', async () => {
    const { tok, user } = await linked();
    const row = (await getActiveToken(user.id))!;
    expect(row.capabilities.sort()).toEqual(['ADMIN_USERS', 'READ_USERS', 'RUNNERS_MANAGE', 'SELF_ROTATE', 'VAULT_TOKENS']);
    expect(row.gitlabUsername).toBe('root');
    expect(Buffer.from(row.ciphertext!).toString('utf8')).not.toContain(tok.token);
    expect(JSON.stringify(row)).not.toContain(tok.token);
    const dump = JSON.stringify(await prisma.auditLog.findMany());
    expect(dump).not.toContain(tok.token); // nem na auditoria
    // ida e volta com o AAD correto; AAD de outra conta falha
    const enc = {
      ciphertext: Buffer.from(row.ciphertext!),
      iv: Buffer.from(row.iv!),
      authTag: Buffer.from(row.authTag!),
      keyVersion: row.keyVersion,
    };
    expect(cipher.decryptToken(enc, cipher.tokenAad(row.userId, row.id))).toBe(tok.token);
    expect(() => cipher.decryptToken(enc, cipher.tokenAad('outro-usuario', row.id))).toThrow();
  });

  it('token sem permissão de admin → só capacidade de rotação; sem scopes úteis → nenhuma', async () => {
    const gl = fake.addUser({ username: 'dev' });
    const t1 = fake.addToken(gl.id, { scopes: ['self_rotate'] });
    const u1 = await seedUser('user1', 'user', { mustChangePassword: false });
    await addToken(ctxFor(u1), t1.token);
    expect((await getActiveToken(u1.id))!.capabilities).toEqual(['SELF_ROTATE']);

    const gl2 = fake.addUser({ username: 'readonly', is_admin: true });
    const t2 = fake.addToken(gl2.id, { scopes: ['read_user'] });
    const u2 = await seedUser('user2', 'user', { mustChangePassword: false });
    await addToken(ctxFor(u2), t2.token);
    expect((await getActiveToken(u2.id))!.capabilities).toEqual([]);
  });

  it('PAT inválido (401) → nada é gravado', async () => {
    const user = await seedUser('alice', 'user', { mustChangePassword: false });
    expect(await code(addToken(ctxFor(user), 'glpat-invalido'))).toBe('GITLAB_TOKEN_INVALID');
    expect(await prisma.gitLabToken.count()).toBe(0);
  });

  it('o mesmo PAT duas vezes → TOKEN_ALREADY_ADDED; usuário GitLab já em outra conta → GITLAB_USER_ALREADY_LINKED', async () => {
    const { tok, gl, ctx } = await linked();
    expect(await code(addToken(ctx, tok.token))).toBe('TOKEN_ALREADY_ADDED');
    const other = await seedUser('bob', 'user', { mustChangePassword: false });
    const second = fake.addToken(gl.id); // outro PAT do MESMO usuário GitLab
    expect(await code(addToken(ctxFor(other), second.token))).toBe('GITLAB_USER_ALREADY_LINKED');
  });

  it('substituir exige o MESMO usuário GitLab, troca só aquele token e mantém a condição de padrão', async () => {
    const { gl, ctx, user } = await linked();
    const row = (await getActiveToken(user.id))!;
    const stranger = fake.addUser({ username: 'outro', is_admin: true });
    expect(await code(replaceToken(ctx, row.id, fake.addToken(stranger.id).token))).toBe('GITLAB_USER_MISMATCH');

    const novo = fake.addToken(gl.id);
    await replaceToken(ctx, row.id, novo.token);
    const rows = await prisma.gitLabToken.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => [r.status, r.isDefault])).toEqual([
      ['REPLACED', false],
      ['ACTIVE', true], // o novo herda o "padrão"
    ]);
  });

  it('desvincular marca como REPLACED e libera o usuário GitLab para outra conta', async () => {
    const { ctx, gl, user } = await linked();
    await unlinkToken(ctx, (await getActiveToken(user.id))!.id);
    expect(await getActiveToken(ctx.actor.id)).toBeNull();
    const bob = await seedUser('bob', 'user', { mustChangePassword: false });
    await addToken(ctxFor(bob), fake.addToken(gl.id).token);
    expect((await getActiveToken(bob.id))?.gitlabUsername).toBe('root');
  });

  it('GitLab devolvendo 401 numa operação → PAT marcado REVOKED, conta da ferramenta intacta', async () => {
    const { tok, ctx, user } = await linked();
    fake.tokens.get(tok.token)!.revoked = true;
    expect(await code(withGitLab(ctx, 'READ_USERS', (c) => c.searchUsers({})))).toBe('GITLAB_TOKEN_INVALID');
    expect((await prisma.gitLabToken.findFirstOrThrow({ where: { userId: user.id } })).status).toBe('REVOKED');
    expect(await code(withGitLab(ctx, 'READ_USERS', (c) => c.searchUsers({})))).toBe('NO_GITLAB_TOKEN');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).banned).not.toBe(true);
  });
});

describe('validação da data de expiração', () => {
  const now = new Date('2026-11-13T12:00:00Z');
  it.each([
    ['2027-02-11', true],
    ['2026-11-14', true],
    ['2027-11-13', true],
    ['2026-11-13', false],
    ['2026-01-01', false],
    ['2027-11-14', false],
    ['2027-02-30', false],
    ['11/02/2027', false],
    ['', false],
  ])('%s → %s', (d, ok) => {
    if (ok) expect(validateExpiry(d, 365, now)).toBe(d);
    else expect(() => validateExpiry(d, 365, now)).toThrow(ActionError);
  });
});

describe('rotação', () => {
  const rotatePosts = () => fake.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/rotate'));

  it('rotaciona, grava o novo cifrado, marca o antigo e NUNCA usa o token antigo depois do 200', async () => {
    const { tok, ctx, user } = await linked();
    const exp = inDays(90);
    const out = await rotateToken(ctx, exp, true);
    expect(out.status).toBe('ROTATED');
    expect(out.token).toMatch(/^glpat-/);

    const rows = await prisma.gitLabToken.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => r.status)).toEqual(['ROTATED', 'ACTIVE']);
    expect(rows[1]!.rotatedFromId).toBe(rows[0]!.id);
    expect(rows[1]!.expiresAt?.toISOString().slice(0, 10)).toBe(exp);
    expect(fake.tokens.get(tok.token)!.revoked).toBe(true);
    expect(fake.tokens.get(out.token!)!.revoked).toBe(false); // o novo segue válido (nada disparou reuse detection)

    // propriedade crítica: depois do POST /rotate, nenhuma chamada com o token antigo
    const idx = fake.requests.findIndex((r) => r.path.endsWith('/rotate'));
    expect(fake.requests.slice(idx + 1).some((r) => r.token === tok.token)).toBe(false);

    // o token salvo é o novo e continua funcionando sem recadastrar
    await withGitLab(ctx, 'READ_USERS', (c) => c.getCurrentUser());
    expect(fake.callsWith(out.token!).length).toBeGreaterThan(0);
    expect(JSON.stringify(await prisma.auditLog.findMany())).not.toContain(out.token!);
  });

  it('sem reveal, o novo token não volta na resposta', async () => {
    const { ctx } = await linked();
    expect((await rotateToken(ctx, inDays(30), false)).token).toBeUndefined();
  });

  it('duas rotações simultâneas: o GitLab recebe UMA só', async () => {
    const { ctx } = await linked();
    fake.fault({ match: /POST .*\/rotate/, slowMs: 600 }); // garante a sobreposição das duas chamadas
    const results = await Promise.allSettled([rotateToken(ctx, inDays(30), false), rotateToken(ctx, inDays(30), false)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason.code).toBe('ROTATION_IN_PROGRESS');
    expect(rotatePosts()).toHaveLength(1);
  });

  it('data inválida ou sem capability → erro e o GitLab nem é chamado', async () => {
    const { ctx } = await linked();
    expect(await code(rotateToken(ctx, '2020-01-01', false))).toBe('INVALID_EXPIRY');
    expect(rotatePosts()).toHaveLength(0);

    const gl = fake.addUser({ username: 'readonly' });
    const ro = await seedUser('readonly', 'user', { mustChangePassword: false });
    await addToken(ctxFor(ro), fake.addToken(gl.id, { scopes: ['read_api'] }).token);
    expect(await code(rotateToken(ctxFor(ro), inDays(30), false))).toBe('MISSING_CAPABILITY');
    expect(rotatePosts()).toHaveLength(0);
  });

  it('falha ao gravar DEPOIS de rotacionar → PARTIAL: o token novo é devolvido e o antigo sai de ACTIVE', async () => {
    const { ctx, user } = await linked();
    const real = cipher.encryptToken;
    let calls = 0;
    vi.spyOn(cipher, 'encryptToken').mockImplementation((...a) => {
      if (++calls === 1) throw new Error('disco cheio (simulado)');
      return real(...a);
    });
    const out = await rotateToken(ctx, inDays(30), false);
    expect(out.status).toBe('PARTIAL');
    expect(out.token).toMatch(/^glpat-/); // não perdemos o token
    const audits = await prisma.auditLog.findMany({ where: { action: 'GITLAB_TOKEN_ROTATED' } });
    expect(audits.map((a) => a.result)).toEqual(['PARTIAL']);
    expect((await prisma.gitLabToken.findFirstOrThrow({ where: { userId: user.id } })).status).toBe('REVOKED');
  });

  it('timeout ONDE A ROTAÇÃO FOI APLICADA → sem retry, REVOKED_UNKNOWN, auditoria UNKNOWN', async () => {
    const { ctx, user } = await linked();
    fake.fault({ match: /POST .*\/rotate/, delayMs: 2500, applyThenDelay: true });
    expect(await code(rotateToken(ctx, inDays(30), false))).toBe('GITLAB_ROTATION_UNKNOWN');
    expect(rotatePosts()).toHaveLength(1); // nunca reenviou
    expect((await prisma.gitLabToken.findFirstOrThrow({ where: { userId: user.id } })).status).toBe('REVOKED_UNKNOWN');
    expect((await prisma.auditLog.findMany({ where: { action: 'GITLAB_TOKEN_ROTATED' } })).map((a) => a.result)).toEqual(['UNKNOWN']);
  });

  it('timeout ONDE A ROTAÇÃO NÃO CHEGOU A OCORRER → erro amigável e o token continua ACTIVE', async () => {
    const { ctx, user } = await linked();
    fake.fault({ match: /POST .*\/rotate/, delayMs: 2500 });
    expect(await code(rotateToken(ctx, inDays(30), false))).toBe('GITLAB_UNAVAILABLE');
    expect(rotatePosts()).toHaveLength(1);
    expect((await prisma.gitLabToken.findFirstOrThrow({ where: { userId: user.id } })).status).toBe('ACTIVE');
  });

  it('a verificação pós-rotação falha (503): a rotação CONTA como feita e fica registrado verified=false', async () => {
    const { ctx, user } = await linked();
    for (let i = 0; i < 3; i++) fake.fault({ match: /GET \/personal_access_tokens\/self/, status: 503 }); // as 3 tentativas da leitura
    expect((await rotateToken(ctx, inDays(30), false)).status).toBe('ROTATED');
    const rows = await prisma.gitLabToken.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => r.status)).toEqual(['ROTATED', 'ACTIVE']); // o novo token foi salvo normalmente
    const [a] = await prisma.auditLog.findMany({ where: { action: 'GITLAB_TOKEN_ROTATED' } });
    expect(a).toMatchObject({ result: 'SUCCESS' });
    expect(a!.metadata).toMatchObject({ verified: false });
  });

  it('timeout + a consulta de conferência TAMBÉM falha: estado inconclusivo → NÃO mexe no token, audita UNKNOWN', async () => {
    const { ctx, user } = await linked();
    fake.fault({ match: /POST .*\/rotate/, delayMs: 2500, applyThenDelay: true });
    for (let i = 0; i < 3; i++) fake.fault({ match: /GET \/personal_access_tokens\/self/, status: 503 });
    expect(await code(rotateToken(ctx, inDays(30), false))).toBe('GITLAB_ROTATION_UNKNOWN');
    expect((await prisma.gitLabToken.findFirstOrThrow({ where: { userId: user.id } })).status).toBe('ACTIVE'); // sem prova, nada muda
    expect((await prisma.auditLog.findMany({ where: { action: 'GITLAB_TOKEN_ROTATED' } })).map((a) => a.result)).toEqual(['UNKNOWN']);
    expect(fake.requests.filter((r) => r.path.endsWith('/rotate'))).toHaveLength(1);
  });

  it('401 na rotação → PAT REVOKED', async () => {
    const { tok, ctx, user } = await linked();
    fake.tokens.get(tok.token)!.revoked = true;
    await expect(rotateToken(ctx, inDays(30), false)).rejects.toBeInstanceOf(GitLabApiError);
    expect((await prisma.gitLabToken.findFirstOrThrow({ where: { userId: user.id } })).status).toBe('REVOKED');
  });
});
