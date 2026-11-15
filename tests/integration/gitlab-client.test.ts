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
