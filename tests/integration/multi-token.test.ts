import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/server/db';
import {
  addToken,
  getActiveToken,
  listTokens,
  replaceToken,
  resolveToken,
  rotateToken,
  setDefaultToken,
  unlinkToken,
  withGitLab,
} from '@/server/services/gitlab-token.service';
import { searchGitLabUsers } from '@/server/services/gitlab-user.service';
import { ctxFor, resetDb, seedUser, startGitLab } from '../support/app';
import type { FakeGitLab } from '../support/fake-gitlab';

let fake: FakeGitLab;
beforeEach(async () => {
  await resetDb();
  fake = await startGitLab();
});
afterEach(() => fake.close());

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? 'THROWN';
  }
  return 'OK';
};
const defaults = (userId: string) => prisma.gitLabToken.count({ where: { userId, status: 'ACTIVE', isDefault: true } });
const names = async (userId: string) => (await listTokens(userId)).map((t) => `${t.name}${t.isDefault ? '*' : ''}`);

/** Conta "alice" com 3 tokens do mesmo usuário GitLab: admin (padrão), leitura e rotação. */
async function world() {
  const gl = fake.addUser({ username: 'root', is_admin: true });
  const t = {
    admin: fake.addToken(gl.id, { name: 'admin', scopes: ['api'] }),
    leitura: fake.addToken(gl.id, { name: 'leitura', scopes: ['read_api'] }),
    rotacao: fake.addToken(gl.id, { name: 'rotacao', scopes: ['self_rotate'] }),
  };
  const alice = await seedUser('alice', 'user', { mustChangePassword: false });
  const ctx = ctxFor(alice);
  await addToken(ctx, t.admin.token);
  await addToken(ctx, t.leitura.token);
  await addToken(ctx, t.rotacao.token);
  const rows = Object.fromEntries((await listTokens(alice.id)).map((r) => [r.name, r]));
  return { gl, t, alice, ctx, rows };
}

describe('adicionar vários tokens', () => {
  it('o primeiro vira o padrão; os seguintes entram sem mudar o padrão; sempre exatamente UM padrão', async () => {
    const w = await world();
    expect(await names(w.alice.id)).toEqual(['admin*', 'rotacao', 'leitura']); // padrão primeiro, depois do mais novo ao mais antigo
    expect(await defaults(w.alice.id)).toBe(1);
  });

  it('makeDefault troca o padrão', async () => {
    const w = await world();
    const extra = fake.addToken(w.gl.id, { name: 'novo', scopes: ['api'] });
    const out = await addToken(w.ctx, extra.token, { makeDefault: true });
    expect(out.isDefault).toBe(true);
    expect(await names(w.alice.id)).toEqual(['novo*', 'rotacao', 'leitura', 'admin']);
    expect(await defaults(w.alice.id)).toBe(1);
  });

  it('cada token guarda os SEUS escopos e capacidades', async () => {
    const w = await world();
    expect(w.rows.admin!.capabilities.sort()).toEqual(['ADMIN_USERS', 'READ_USERS', 'SELF_ROTATE']);
    expect(w.rows.leitura!.scopes).toEqual(['read_api']);
    expect(w.rows.leitura!.capabilities).toEqual(['READ_USERS']);
    expect(w.rows.rotacao!.capabilities).toEqual(['SELF_ROTATE']);
  });

  it('todos os tokens da conta precisam ser do MESMO usuário GitLab', async () => {
    const w = await world();
    const stranger = fake.addUser({ username: 'outro', is_admin: true });
    expect(await code(addToken(w.ctx, fake.addToken(stranger.id).token))).toBe('GITLAB_USER_MISMATCH');
    expect(await listTokens(w.alice.id)).toHaveLength(3);
  });

  it('o mesmo PAT não entra duas vezes', async () => {
    const w = await world();
    expect(await code(addToken(w.ctx, w.t.leitura.token))).toBe('TOKEN_ALREADY_ADDED');
  });

  it('outra conta NÃO consegue ficar com o mesmo usuário GitLab (nem com um PAT que já está cadastrado)', async () => {
    const w = await world();
    const bob = await seedUser('bob', 'user', { mustChangePassword: false });
    expect(await code(addToken(ctxFor(bob), fake.addToken(w.gl.id).token))).toBe('GITLAB_USER_ALREADY_LINKED'); // outro PAT, mesmo usuário
    expect(await code(addToken(ctxFor(bob), w.t.leitura.token))).toBe('GITLAB_USER_ALREADY_LINKED'); // o mesmo PAT
    expect(await listTokens(bob.id)).toHaveLength(0);
  });

  it('o BANCO garante o padrão único e o PAT único (mesmo contornando o código)', async () => {
    const w = await world();
    const base = {
      gitlabBaseUrl: 'g',
      gitlabUserId: 7,
      gitlabUsername: 'x',
      gitlabIsAdmin: false,
      scopes: [],
      capabilities: [],
      keyVersion: 'v1',
      fingerprint: 'f',
      userId: w.alice.id,
    };
    // segundo padrão para a mesma conta
    await expect(
      prisma.gitLabToken.create({ data: { ...base, id: crypto.randomUUID(), gitlabTokenId: 777, name: 'x', isDefault: true } }),
    ).rejects.toThrow();
    // o mesmo PAT (id no GitLab) ativo duas vezes
    await expect(
      prisma.gitLabToken.create({
        data: {
          ...base,
          id: crypto.randomUUID(),
          gitlabUserId: 100,
          gitlabTokenId: w.t.leitura.id,
          gitlabBaseUrl: w.rows.admin!.gitlabBaseUrl,
          name: 'dup',
        },
      }),
    ).rejects.toThrow();
    // várias linhas ativas NÃO padrão são permitidas
    await prisma.gitLabToken.create({ data: { ...base, id: crypto.randomUUID(), gitlabTokenId: 778, name: 'ok-nao-padrao' } });
  });
});

describe('definir o padrão', () => {
  it('troca o padrão, audita de/para e é idempotente', async () => {
    const w = await world();
    expect(await setDefaultToken(w.ctx, w.rows.leitura!.id)).toEqual({ changed: true });
    expect(await names(w.alice.id)).toEqual(['leitura*', 'rotacao', 'admin']);
    expect(await defaults(w.alice.id)).toBe(1);
    const [a] = await prisma.auditLog.findMany({ where: { action: 'GITLAB_TOKEN_DEFAULT_CHANGED' } });
    expect(a).toMatchObject({ result: 'SUCCESS', actorUsername: 'alice', targetLabel: 'leitura' });
    expect(a!.metadata).toEqual({ from: 'admin', to: 'leitura' });
    expect(await setDefaultToken(w.ctx, w.rows.leitura!.id)).toEqual({ changed: false });
    expect(await prisma.auditLog.count({ where: { action: 'GITLAB_TOKEN_DEFAULT_CHANGED' } })).toBe(1);
  });

  it('só tokens ATIVOS DESTA conta', async () => {
    const w = await world();
    const bob = await seedUser('bob', 'user', { mustChangePassword: false });
    expect(await code(setDefaultToken(ctxFor(bob), w.rows.leitura!.id))).toBe('TOKEN_NOT_FOUND'); // token da alice
    await unlinkToken(w.ctx, w.rows.leitura!.id);
    expect(await code(setDefaultToken(w.ctx, w.rows.leitura!.id))).toBe('TOKEN_NOT_FOUND'); // já removido
    expect(await code(setDefaultToken(w.ctx, crypto.randomUUID()))).toBe('TOKEN_NOT_FOUND');
  });
});

describe('remover (desvincular)', () => {
  it('remover um token que NÃO é o padrão não muda o padrão', async () => {
    const w = await world();
    const out = await unlinkToken(w.ctx, w.rows.leitura!.id);
    expect(out.newDefault).toBeNull();
    expect(await names(w.alice.id)).toEqual(['admin*', 'rotacao']);
  });

  it('remover o PADRÃO promove o mais recente dos outros (e nunca deixa a conta sem padrão)', async () => {
    const w = await world();
    const out = await unlinkToken(w.ctx, w.rows.admin!.id);
    expect(out.newDefault).toBe('rotacao'); // o mais novo dos restantes
    expect(await names(w.alice.id)).toEqual(['rotacao*', 'leitura']);
    expect(await defaults(w.alice.id)).toBe(1);
  });

  it('remover o último deixa a conta sem tokens; NÃO revoga nada no GitLab; só da própria conta', async () => {
    const w = await world();
    const bob = await seedUser('bob', 'user', { mustChangePassword: false });
    expect(await code(unlinkToken(ctxFor(bob), w.rows.admin!.id))).toBe('TOKEN_NOT_FOUND'); // token da alice
    for (const r of Object.values(w.rows)) await unlinkToken(w.ctx, r.id);
    expect(await listTokens(w.alice.id)).toEqual([]);
    expect(fake.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);
    expect([...fake.tokens.values()].some((t) => t.revoked)).toBe(false); // continuam válidos no GitLab
  });
});

describe('qual token usar (em uso × padrão)', () => {
  it('resolveToken: o escolhido (se for desta conta e ativo); senão o padrão', async () => {
    const w = await world();
    const bob = await seedUser('bob', 'user', { mustChangePassword: false });
    const bobsTok = await addToken(ctxFor(bob), fake.addToken(fake.addUser({ username: 'bobgl' }).id).token);

    expect((await resolveToken(w.alice.id, w.rows.leitura!.id))?.name).toBe('leitura'); // escolhido
    expect((await resolveToken(w.alice.id))?.name).toBe('admin'); // nada escolhido → padrão
    expect((await resolveToken(w.alice.id, crypto.randomUUID()))?.name).toBe('admin'); // id inexistente → padrão
    expect((await resolveToken(w.alice.id, 'lixo'))?.name).toBe('admin'); // valor inválido (cookie forjado) → padrão
    // SEGURANÇA: id de token de OUTRA conta (cookie forjado/herdado) é ignorado
    expect((await resolveToken(w.alice.id, bobsTok.tokenId))?.name).toBe('admin');
    expect((await resolveToken(bob.id, w.rows.leitura!.id))?.gitlabUsername).toBe('bobgl');
    // token removido deixa de valer
    await unlinkToken(w.ctx, w.rows.leitura!.id);
    expect((await resolveToken(w.alice.id, w.rows.leitura!.id))?.name).toBe('admin');
  });

  it('as chamadas ao GitLab usam o PAT do token EM USO (e o padrão quando nenhum foi escolhido)', async () => {
    const w = await world();
    fake.requests.length = 0; // descarta as validações feitas ao cadastrar os tokens
    await searchGitLabUsers({ ...w.ctx, tokenId: w.rows.leitura!.id }, {}); // leitura tem READ_USERS
    expect(fake.callsWith(w.t.leitura.token).length).toBeGreaterThan(0);
    expect(fake.callsWith(w.t.admin.token)).toHaveLength(0);

    fake.requests.length = 0;
    await searchGitLabUsers(w.ctx, {}); // sem escolha → padrão
    expect(fake.callsWith(w.t.admin.token).length).toBeGreaterThan(0);
    expect(fake.callsWith(w.t.leitura.token)).toHaveLength(0);
  });

  it('a capacidade é a do token EM USO; a mensagem aponta qual outro token permite', async () => {
    const w = await world();
    fake.requests.length = 0;
    const withRotate = { ...w.ctx, tokenId: w.rows.rotacao!.id }; // só self_rotate
    try {
      await searchGitLabUsers(withRotate, {});
      expect.unreachable();
    } catch (e) {
      expect((e as { code: string }).code).toBe('MISSING_CAPABILITY');
      expect((e as Error).message).toContain('"rotacao"');
      expect((e as Error).message).toMatch(/"(admin|leitura)" permite/);
      expect((e as Error).message).toContain('Troque o token em uso');
    }
    expect(fake.requests).toHaveLength(0); // nem chegou ao GitLab
  });

  it('401 no token PADRÃO: só ele é marcado REVOKED, o outro assume como padrão e a conta segue funcionando', async () => {
    const w = await world();
    fake.tokens.get(w.t.admin.token)!.revoked = true;
    expect(await code(withGitLab(w.ctx, 'READ_USERS', (c) => c.searchUsers({})))).toBe('GITLAB_TOKEN_INVALID');
    expect((await prisma.gitLabToken.findUniqueOrThrow({ where: { id: w.rows.admin!.id } })).status).toBe('REVOKED');
    expect(await names(w.alice.id)).toEqual(['rotacao*', 'leitura']); // invariante: sempre há um padrão
    expect(await defaults(w.alice.id)).toBe(1);
    // próxima chamada já usa o novo padrão... que é só rotação; a leitura funciona escolhendo o outro
    expect(await code(withGitLab({ ...w.ctx, tokenId: w.rows.leitura!.id }, 'READ_USERS', (c) => c.searchUsers({})))).toBe('OK');
  });

  it('401 num token NÃO padrão não mexe no padrão', async () => {
    const w = await world();
    fake.tokens.get(w.t.leitura.token)!.revoked = true;
    expect(await code(withGitLab({ ...w.ctx, tokenId: w.rows.leitura!.id }, 'READ_USERS', (c) => c.searchUsers({})))).toBe(
      'GITLAB_TOKEN_INVALID',
    );
    expect(await names(w.alice.id)).toEqual(['admin*', 'rotacao']);
  });
});

describe('rotação e substituição por token', () => {
  it('rotaciona o token INDICADO (sem tocar nos outros) e o novo herda a condição de NÃO padrão', async () => {
    const w = await world();
    const out = await rotateToken(w.ctx, inDays(30), true, w.rows.rotacao!.id);
    expect(out.status).toBe('ROTATED');
    expect(fake.tokens.get(w.t.rotacao.token)!.revoked).toBe(true);
    expect(fake.tokens.get(w.t.admin.token)!.revoked).toBe(false);
    expect(fake.tokens.get(w.t.leitura.token)!.revoked).toBe(false);
    expect(await names(w.alice.id)).toEqual(['admin*', 'rotacao', 'leitura']); // o novo "rotacao" continua não-padrão
    expect(await defaults(w.alice.id)).toBe(1);
  });

  it('rotacionar o PADRÃO: o novo token continua sendo o padrão', async () => {
    const w = await world();
    await rotateToken(w.ctx, inDays(30), false, w.rows.admin!.id);
    const def = (await getActiveToken(w.alice.id))!;
    expect(def.name).toBe('admin');
    expect(def.rotatedFromId).toBe(w.rows.admin!.id);
    expect(def.isDefault).toBe(true);
    expect(await defaults(w.alice.id)).toBe(1);
  });

  it('sem tokenId, rotaciona o token EM USO', async () => {
    const w = await world();
    await rotateToken({ ...w.ctx, tokenId: w.rows.rotacao!.id }, inDays(30), false);
    expect(fake.tokens.get(w.t.rotacao.token)!.revoked).toBe(true);
    expect(fake.tokens.get(w.t.admin.token)!.revoked).toBe(false);
  });

  it('não rotaciona token de outra conta nem token sem a capacidade', async () => {
    const w = await world();
    const bob = await seedUser('bob', 'user', { mustChangePassword: false });
    expect(await code(rotateToken(ctxFor(bob), inDays(30), false, w.rows.admin!.id))).toBe('TOKEN_NOT_FOUND');
    expect(await code(rotateToken(w.ctx, inDays(30), false, w.rows.leitura!.id))).toBe('MISSING_CAPABILITY'); // read_api não rotaciona
    expect(fake.requests.filter((r) => r.path.endsWith('/rotate'))).toHaveLength(0);
  });

  it('o lock é POR TOKEN: dois tokens diferentes rotacionam em paralelo; o MESMO token, só um', async () => {
    const w = await world();
    fake.fault({ match: /POST .*\/rotate/, slowMs: 500 }); // garante a sobreposição
    fake.fault({ match: /POST .*\/rotate/, slowMs: 500 });
    const both = await Promise.allSettled([
      rotateToken(w.ctx, inDays(30), false, w.rows.admin!.id),
      rotateToken(w.ctx, inDays(30), false, w.rows.rotacao!.id),
    ]);
    expect(both.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);

    const w2rows = await listTokens(w.alice.id);
    const same = w2rows.find((r) => r.name === 'admin')!;
    fake.fault({ match: /POST .*\/rotate/, slowMs: 500 });
    const twice = await Promise.allSettled([
      rotateToken(w.ctx, inDays(30), false, same.id),
      rotateToken(w.ctx, inDays(30), false, same.id),
    ]);
    expect(twice.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((twice.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('ROTATION_IN_PROGRESS');
  });

  it('substituir um token mantém se ele era padrão ou não; PAT que já está na conta é recusado', async () => {
    const w = await world();
    const novo = fake.addToken(w.gl.id, { name: 'leitura2', scopes: ['read_api'] });
    await replaceToken(w.ctx, w.rows.leitura!.id, novo.token);
    expect(await names(w.alice.id)).toEqual(['admin*', 'leitura2', 'rotacao']);
    expect(await code(replaceToken(w.ctx, w.rows.rotacao!.id, w.t.admin.token))).toBe('TOKEN_ALREADY_ADDED');
    expect(await code(replaceToken(w.ctx, crypto.randomUUID(), novo.token))).toBe('TOKEN_NOT_FOUND');
  });
});
