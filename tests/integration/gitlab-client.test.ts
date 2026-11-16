import { createServer as createNetServer } from 'node:net';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fetch as undiciFetch } from 'undici';
import { GitLabClient } from '@/server/gitlab/client';
import { GitLabApiError } from '@/server/gitlab/errors';
import { startFakeGitLab, type FakeGitLab } from '../support/fake-gitlab';
import { selfSignedCert } from '../support/self-signed';

let fake: FakeGitLab | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const rejects = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as GitLabApiError;
  }
  throw new Error('deveria ter falhado');
};

describe('TLS com certificado auto-assinado', () => {
  let tls: { key: string; cert: string };
  beforeAll(() => {
    tls = selfSignedCert();
  });

  it('por padrão REJEITA o certificado e explica como resolver', async () => {
    fake = await startFakeGitLab({ tls });
    const u = fake.addUser({ username: 'root', is_admin: true });
    const t = fake.addToken(u.id);
    const err = await rejects(new GitLabClient(t.token, { baseUrl: fake.url }).getCurrentUser());
    expect(err).toBeInstanceOf(GitLabApiError);
    expect(err.code).toBe('GITLAB_TLS_ERROR');
    expect(err.message).toMatch(/NODE_EXTRA_CA_CERTS|GITLAB_TLS_INSECURE/);
    expect(fake.requests).toHaveLength(0); // nem chegou a enviar o token
  });

  it('com insecureTls=true conecta e funciona normalmente', async () => {
    fake = await startFakeGitLab({ tls });
    const u = fake.addUser({ username: 'root', is_admin: true });
    const t = fake.addToken(u.id);
    const me = await new GitLabClient(t.token, { baseUrl: fake.url, insecureTls: true }).getCurrentUser();
    expect(me.username).toBe('root');
    expect(fake.url.startsWith('https://')).toBe(true);
  });

  it('a opção vale só para o GitLab: outras conexões do processo continuam verificando TLS', async () => {
    fake = await startFakeGitLab({ tls });
    const u = fake.addUser({ username: 'root', is_admin: true });
    await new GitLabClient(fake.addToken(u.id).token, { baseUrl: fake.url, insecureTls: true }).getCurrentUser();
    await expect(fetch(fake.url)).rejects.toThrow(); // fetch global, sem o dispatcher inseguro
    await expect(undiciFetch(fake.url)).rejects.toThrow();
  });
});

describe('resiliência e mapeamento de erros', () => {
  const setup = async () => {
    fake = await startFakeGitLab();
    const admin = fake.addUser({ username: 'root', is_admin: true });
    const token = fake.addToken(admin.id);
    return { admin, token, client: new GitLabClient(token.token, { baseUrl: fake.url, timeoutMs: 1500 }) };
  };

  it('GET tem retry em 503 e em 429 e depois funciona', async () => {
    const { client } = await setup();
    fake!.fault({ match: /GET \/user$/, status: 503 });
    fake!.fault({ match: /GET \/user$/, status: 429 });
    expect((await client.getCurrentUser()).username).toBe('root');
    expect(fake!.requests.filter((r) => r.path === '/user')).toHaveLength(3);
  });

  it('escrita (unblock) NÃO tem retry: 503 vira erro com uma única chamada', async () => {
    const { client } = await setup();
    const u = fake!.addUser({ username: 'joao', state: 'blocked' });
    fake!.fault({ match: /POST \/users\/\d+\/unblock/, status: 503 });
    const err = await rejects(client.unblockUser(u.id));
    expect(err.code).toBe('GITLAB_UNAVAILABLE');
    expect(fake!.requests.filter((r) => r.path.endsWith('/unblock'))).toHaveLength(1);
  });

  it.each([
    [401, 'GITLAB_TOKEN_INVALID'],
    [404, 'GITLAB_NOT_FOUND'],
    [403, 'GITLAB_FORBIDDEN'],
  ])('HTTP %i → %s', async (status, code) => {
    const { client } = await setup();
    fake!.fault({ match: /GET \/version/, status });
    expect((await rejects(client.getVersion())).code).toBe(code);
  });

  it('resposta 200 fora do formato esperado → GITLAB_UNEXPECTED_RESPONSE (sem vazar o corpo)', async () => {
    const { client } = await setup();
    fake!.fault({ match: /GET \/version/, status: 200 }); // o falso responde {"message":"injected"}
    const err = await rejects(client.getVersion());
    expect(err.code).toBe('GITLAB_UNEXPECTED_RESPONSE');
    expect(err.message).not.toContain('injected');
  });

  it('mensagens de erro nunca contêm o token', async () => {
    const { client, token } = await setup();
    fake!.fault({ match: /GET \/version/, status: 401 });
    const err = await rejects(client.getVersion());
    expect(`${err.message} ${err.stack}`).not.toContain(token.token);
  });

  it('o detalhe devolvido pelo GitLab é repassado, curto, e NUNCA contém o token', async () => {
    const { client, token } = await setup();
    fake!.fault({
      match: /GET \/version/,
      status: 403,
      body: { message: `403 Forbidden - token ${token.token} sem permissão ${'x'.repeat(400)}` },
    });
    const err = await rejects(client.getVersion());
    expect(err.code).toBe('GITLAB_FORBIDDEN');
    expect(err.detail).toContain('[token]');
    expect(err.detail).not.toContain(token.token);
    expect(err.detail!.length).toBeLessThanOrEqual(200);
    expect(`${err.message} ${err.stack}`).not.toContain(token.token);
  });

  it('GitLab fora do ar → GITLAB_UNAVAILABLE (leitura)', async () => {
    const down = new GitLabClient('x', { baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000 });
    expect((await rejects(down.getVersion())).code).toBe('GITLAB_UNAVAILABLE');
  });

  it('paginação lê os headers do GitLab', async () => {
    const { client } = await setup();
    for (let i = 0; i < 25; i++) fake!.addUser({ username: `user${i}` });
    const p1 = await client.searchUsers({ perPage: 20, page: 1 });
    expect(p1.items).toHaveLength(20);
    expect(p1.nextPage).toBe(2);
    expect(p1.totalPages).toBe(2);
    const p2 = await client.searchUsers({ perPage: 20, page: 2 });
    expect(p2.nextPage).toBeNull();
  });
});

describe('paginação completa (listAll)', () => {
  const setup = async () => {
    fake = await startFakeGitLab();
    const admin = fake.addUser({ username: 'root', is_admin: true });
    return { admin, client: new GitLabClient(fake.addToken(admin.id).token, { baseUrl: fake.url, timeoutMs: 1500 }) };
  };

  it('lista TODOS os usuários em várias páginas de 100 (sem perder nem repetir) e avisa o progresso', async () => {
    const { client } = await setup();
    for (let i = 0; i < 249; i++) fake!.addUser({ username: `user${String(i).padStart(3, '0')}` }); // + root = 250
    const seen: number[] = [];
    const users = await client.listAllUsers({}, (n) => seen.push(n));
    expect(users).toHaveLength(250);
    expect(new Set(users.map((u) => u.id)).size).toBe(250);
    expect(seen).toEqual([100, 200, 250]); // 3 páginas
    expect(fake!.requests.filter((r) => r.path === '/users')).toHaveLength(3);
  });

  it('o filtro de bloqueados também percorre as páginas', async () => {
    const { client } = await setup();
    for (let i = 0; i < 130; i++) fake!.addUser({ username: `b${i}`, state: 'blocked' });
    expect(await client.listAllUsers({ blocked: true })).toHaveLength(130);
  });

  it('PATs ativos e chaves SSH também paginam', async () => {
    const { admin, client } = await setup();
    for (let i = 0; i < 230; i++) fake!.addToken(admin.id, { name: `t${i}` });
    expect((await client.listActivePersonalAccessTokens()).length).toBeGreaterThanOrEqual(230);
    for (let i = 0; i < 105; i++) fake!.addKey(admin.id, { last_used_at: null });
    expect(await client.listUserSshKeys(admin.id)).toHaveLength(105);
  });

  it('uma página só não pede a seguinte', async () => {
    const { client } = await setup();
    await client.listAllUsers();
    expect(fake!.requests.filter((r) => r.path === '/users')).toHaveLength(1);
  });
});

describe('mapeamento de status do GitLab', () => {
  const setup = async () => {
    fake = await startFakeGitLab();
    const admin = fake.addUser({ username: 'root', is_admin: true });
    return { admin, client: new GitLabClient(fake.addToken(admin.id).token, { baseUrl: fake.url, timeoutMs: 1500 }) };
  };

  it.each([
    [400, { message: '400 Bad request - User does not have two-factor authentication enabled' }, 'GITLAB_2FA_NOT_ENABLED'],
    [400, { message: '400 Bad request - parâmetro inválido' }, 'GITLAB_BAD_REQUEST'],
    [403, { message: '403 Forbidden - LDAP blocked users cannot be unblocked' }, 'GITLAB_LDAP_BLOCKED'],
    [405, { message: 'Method Not Allowed' }, 'GITLAB_TOKEN_INVALID'],
    [418, { message: 'sou um bule' }, 'GITLAB_BAD_REQUEST'],
    [502, { message: 'bad gateway' }, 'GITLAB_UNAVAILABLE'],
  ])('HTTP %i (%j) → %s', async (status, body, expected) => {
    const { admin, client } = await setup();
    for (let i = 0; i < 3; i++) fake!.fault({ match: /PATCH .*disable_two_factor/, status, body }); // escrita não repete; 3 por segurança
    expect((await rejects(client.disableTwoFactor(admin.id))).code).toBe(expected);
  });

  it('429 com Retry-After é repetido em leituras e funciona na tentativa seguinte', async () => {
    const { client } = await setup();
    fake!.fault({ match: /GET \/version/, status: 429 });
    await expect(client.getVersion()).resolves.toBe('18.11.0');
  });

  it('5xx persistente em leitura: esgota as 3 tentativas e falha como indisponível', async () => {
    const { client } = await setup();
    for (let i = 0; i < 5; i++) fake!.fault({ match: /GET \/version/, status: 503 });
    expect((await rejects(client.getVersion())).code).toBe('GITLAB_UNAVAILABLE');
    expect(fake!.requests.filter((r) => r.path === '/version')).toHaveLength(3);
  });

  it('corpo que NÃO é JSON (página de erro de proxy) não quebra e não vira "detalhe"', async () => {
    const { client } = await setup();
    fake!.fault({ match: /GET \/version/, status: 403, rawBody: '<html>403 Forbidden by proxy</html>' });
    const err = await rejects(client.getVersion());
    expect(err.code).toBe('GITLAB_FORBIDDEN');
    expect(err.detail).toBeUndefined();
  });

  it.each([[{ errors: ['x'] }], [['lista']], [{ message: 42 }], [{ message: '' }]])(
    'JSON sem mensagem textual útil (%j) → sem detalhe',
    async (body) => {
      const { client } = await setup();
      fake!.fault({ match: /GET \/version/, status: 404, body });
      expect((await rejects(client.getVersion())).detail).toBeUndefined();
    },
  );

  it('usa error_description/error quando não há message', async () => {
    const { client } = await setup();
    fake!.fault({ match: /GET \/version/, status: 401, body: { error: 'invalid_token', error_description: 'O token expirou' } });
    expect((await rejects(client.getVersion())).detail).toBe('O token expirou');
    fake!.fault({ match: /GET \/version/, status: 401, body: { error: 'invalid_token' } });
    expect((await rejects(client.getVersion())).detail).toBe('invalid_token');
  });
});

describe('rotateSelf: quando o resultado é (ou não é) ambíguo', () => {
  it('conexão RECUSADA / host inexistente (nada foi enviado) → indisponível, NÃO ambíguo', async () => {
    // Porta 1 não serve: o fetch a bloqueia ("bad port") sem tentar conectar. Usa uma porta efêmera que de fato recusa.
    const srv = createNetServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    await new Promise<void>((r) => srv.close(() => r()));
    const refused = new GitLabClient('glpat-x', { baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 2000 });
    expect((await rejects(refused.rotateSelf('2027-01-01'))).code).toBe('GITLAB_UNAVAILABLE');

    const noHost = new GitLabClient('glpat-x', { baseUrl: 'http://nao-existe.invalid', timeoutMs: 4000 });
    expect((await rejects(noHost.rotateSelf('2027-01-01'))).code).toBe('GITLAB_UNAVAILABLE'); // ENOTFOUND vem em cause.code
  });

  it('conexão derrubada DEPOIS do envio → ambíguo (a rotação pode ter ocorrido): GITLAB_ROTATION_UNKNOWN, sem retry', async () => {
    fake = await startFakeGitLab();
    const admin = fake.addUser({ username: 'root', is_admin: true });
    const client = new GitLabClient(fake.addToken(admin.id).token, { baseUrl: fake.url, timeoutMs: 1500 });
    fake.fault({ match: /POST .*\/rotate/, reset: true });
    expect((await rejects(client.rotateSelf('2027-01-01'))).code).toBe('GITLAB_ROTATION_UNKNOWN');
    expect(fake.requests.filter((r) => r.path.endsWith('/rotate'))).toHaveLength(1);
  });

  it('timeout → ambíguo', async () => {
    fake = await startFakeGitLab();
    const admin = fake.addUser({ username: 'root', is_admin: true });
    const client = new GitLabClient(fake.addToken(admin.id).token, { baseUrl: fake.url, timeoutMs: 1000 });
    fake.fault({ match: /POST .*\/rotate/, delayMs: 2000 });
    expect((await rejects(client.rotateSelf('2027-01-01'))).code).toBe('GITLAB_ROTATION_UNKNOWN');
  });

  it('leitura com a conexão derrubada é repetida e, esgotada, vira indisponível', async () => {
    fake = await startFakeGitLab();
    const admin = fake.addUser({ username: 'root', is_admin: true });
    const client = new GitLabClient(fake.addToken(admin.id).token, { baseUrl: fake.url, timeoutMs: 1500 });
    for (let i = 0; i < 3; i++) fake.fault({ match: /GET \/version/, reset: true });
    expect((await rejects(client.getVersion())).code).toBe('GITLAB_UNAVAILABLE');
    expect(fake.requests.filter((r) => r.path === '/version')).toHaveLength(3);
  });
});
