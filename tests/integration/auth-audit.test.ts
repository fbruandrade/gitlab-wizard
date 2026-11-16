import { beforeEach, describe, expect, it } from 'vitest';
import { TOTP, URI } from 'otpauth';
import { auth } from '@/server/auth/auth';
import { authHandler } from '@/server/auth/handler';
import { prisma } from '@/server/db';
import { loginHeaders, PASSWORD, resetDb, seedUser } from '../support/app';

beforeEach(resetDb);

let ipSeq = 0;
const ip = () => `10.60.0.${++ipSeq}`; // um IP novo por chamada: o rate limit (por IP) nunca atrapalha
const base = 'http://localhost:3000/api/auth';
const post = (path: string, body: unknown, cookie = '') =>
  authHandler(
    new Request(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', 'x-test-ip': ip(), ...(cookie && { cookie }) },
      body: JSON.stringify(body),
    }),
  );
const jar = (res: Response, prev = '') => {
  const map = new Map(
    prev
      .split('; ')
      .filter(Boolean)
      .map((c) => [c.split('=')[0]!, c]),
  );
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(';');
    const name = kv!.split('=')[0]!;
    if (/=$/.test(kv!) || /Max-Age=0/.test(c)) map.delete(name);
    else map.set(name, kv!);
  }
  return [...map.values()].join('; ');
};
const events = (action: string) => prisma.auditLog.findMany({ where: { action }, orderBy: { createdAt: 'asc' } });
const gen = (uri: string) => (URI.parse(uri) as TOTP).generate();

/** Usuário com 2FA ATIVO de verdade (enable + verify), devolvendo o segredo e os códigos de backup. */
async function withTwoFactor(username = 'alice') {
  const u = await seedUser(username, 'user', { mustChangePassword: false });
  const h = await loginHeaders(username);
  const en = await auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers: h });
  if (en.method !== 'totp') throw new Error('esperava TOTP');
  await auth.api.verifyTOTP({ body: { code: gen(en.totpURI) }, headers: h });
  return { u, h, uri: en.totpURI, backup: en.backupCodes };
}

describe('logout', () => {
  it('POST /sign-out audita AUTH_LOGOUT com o ator e encerra a sessão', async () => {
    const u = await seedUser('alice', 'user', { mustChangePassword: false });
    const h = await loginHeaders('alice');
    expect((await post('/sign-out', {}, h.get('cookie')!)).status).toBe(200);
    const [e] = await events('AUTH_LOGOUT');
    expect(e).toMatchObject({ result: 'SUCCESS', actorUserId: u.id, actorUsername: 'alice' });
    expect(await prisma.session.count({ where: { userId: u.id } })).toBe(0);
  });

  it('logout SEM sessão não gera evento (nada para auditar)', async () => {
    await post('/sign-out', {});
    expect(await events('AUTH_LOGOUT')).toHaveLength(0);
  });
});

describe('troca de senha (falha)', () => {
  it('senha atual errada → AUTH_PASSWORD_CHANGED FAILURE e mustChangePassword NÃO é limpo', async () => {
    const u = await seedUser('alice'); // mustChangePassword = true
    const h = await loginHeaders('alice');
    const res = await post('/change-password', { currentPassword: 'Errada!Senha#1', newPassword: 'N0va!SenhaForte#42' }, h.get('cookie')!);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const [e] = await events('AUTH_PASSWORD_CHANGED');
    expect(e).toMatchObject({ result: 'FAILURE', actorUsername: 'alice' });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).mustChangePassword).toBe(true);
    expect(JSON.stringify(e)).not.toContain('Errada!Senha'); // nunca a senha informada
  });
});

describe('2FA da ferramenta: trilha de auditoria', () => {
  it('código ERRADO ao ATIVAR o 2FA → AUTH_2FA_ENABLED FAILURE (2FA_INVALID); o certo → SUCCESS', async () => {
    await seedUser('alice', 'user', { mustChangePassword: false });
    const h = await loginHeaders('alice');
    const en = await auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers: h });
    if (en.method !== 'totp') throw new Error('esperava TOTP');
    const cookie = h.get('cookie')!;
    expect((await post('/two-factor/verify-totp', { code: '000000' }, cookie)).status).toBeGreaterThanOrEqual(400);
    expect((await post('/two-factor/verify-totp', { code: gen(en.totpURI) }, cookie)).status).toBe(200);
    expect((await events('AUTH_2FA_ENABLED')).map((e) => [e.result, e.errorCode])).toEqual([
      ['FAILURE', '2FA_INVALID'],
      ['SUCCESS', null],
    ]);
  });

  it('login: código errado → AUTH_LOGIN_FAILED (2FA_INVALID); código de backup → LOGIN_SUCCESS com second_factor', async () => {
    const w = await withTwoFactor();
    const step1 = await post('/sign-in/username', { username: 'alice', password: PASSWORD });
    const cookies = jar(step1);
    expect((await post('/two-factor/verify-totp', { code: '000000' }, cookies)).status).toBeGreaterThanOrEqual(400);
    const failed = (await events('AUTH_LOGIN_FAILED')).filter((e) => e.errorCode === '2FA_INVALID');
    expect(failed).toHaveLength(1);

    const ok = await post('/two-factor/verify-backup-code', { code: w.backup[0] }, cookies);
    expect(ok.status).toBe(200);
    const success = (await events('AUTH_LOGIN_SUCCESS')).filter((e) => (e.metadata as { second_factor?: boolean } | null)?.second_factor);
    expect(success).toHaveLength(1);
  });

  it('login completo com TOTP certo também audita SUCCESS com second_factor', async () => {
    const w = await withTwoFactor();
    const cookies = jar(await post('/sign-in/username', { username: 'alice', password: PASSWORD }));
    expect((await post('/two-factor/verify-totp', { code: gen(w.uri) }, cookies)).status).toBe(200);
    expect((await events('AUTH_LOGIN_SUCCESS')).some((e) => (e.metadata as { second_factor?: boolean } | null)?.second_factor)).toBe(true);
  });

  it('desativar o 2FA: senha errada → AUTH_2FA_DISABLED FAILURE; senha certa → SUCCESS e o usuário volta a logar sem código', async () => {
    const w = await withTwoFactor();
    const cookies = jar(await post('/sign-in/username', { username: 'alice', password: PASSWORD }));
    const session = jar(await post('/two-factor/verify-totp', { code: gen(w.uri) }, cookies), cookies);
    expect((await post('/two-factor/disable', { password: 'Errada!Senha#1' }, session)).status).toBeGreaterThanOrEqual(400);
    expect((await post('/two-factor/disable', { password: PASSWORD }, session)).status).toBe(200);
    expect((await events('AUTH_2FA_DISABLED')).map((e) => e.result)).toEqual(['FAILURE', 'SUCCESS']);
    const again = await post('/sign-in/username', { username: 'alice', password: PASSWORD });
    expect(((await again.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBeUndefined(); // sem 2FA: login direto
  });
});

describe('revogação de sessões (auditoria)', () => {
  it('revoke-other-sessions, revoke-session e revoke-sessions geram AUTH_SESSION_REVOKED com o caminho; falha também', async () => {
    const u = await seedUser('alice', 'user', { mustChangePassword: false });
    const a = await loginHeaders('alice');
    const b = await loginHeaders('alice');
    const c = await loginHeaders('alice');
    const cookie = a.get('cookie')!;
    const tokenOf = async (h: Headers) => (await auth.api.getSession({ headers: h, query: { disableCookieCache: true } }))!.session.token;

    expect((await post('/revoke-other-sessions', {}, cookie)).status).toBe(200); // derruba b e c
    expect(await prisma.session.count({ where: { userId: u.id } })).toBe(1);

    const d = await loginHeaders('alice');
    expect((await post('/revoke-session', { token: await tokenOf(d) }, cookie)).status).toBe(200);
    await post('/revoke-session', { token: 'token-inexistente' }, cookie); // mesmo que falhe ou seja no-op, a tentativa é auditada
    expect((await post('/revoke-sessions', {}, cookie)).status).toBe(200);

    const ev = await events('AUTH_SESSION_REVOKED');
    expect(ev.map((e) => (e.metadata as { path: string }).path)).toEqual(
      expect.arrayContaining(['/revoke-other-sessions', '/revoke-session', '/revoke-sessions']),
    );
    expect(ev).toHaveLength(4); // other-sessions, session (ok), session (inexistente), sessions
    expect(ev.every((e) => e.actorUsername === 'alice')).toBe(true);
    void b;
    void c;
  });
});

describe('login: ramos restantes', () => {
  it('rota de rate limit na própria resposta é auditada com o caminho (via authHandler)', async () => {
    await seedUser('alice');
    const same = '10.99.99.99';
    const attempt = () =>
      authHandler(
        new Request(`${base}/sign-in/username`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', 'x-test-ip': same },
          body: JSON.stringify({ username: 'alice', password: 'Errada!Senha#1' }),
        }),
      );
    for (let i = 0; i < 6; i++) await attempt();
    const [e] = await events('AUTH_RATE_LIMITED');
    expect(e).toMatchObject({ result: 'FAILURE', ipAddress: same });
    expect(e!.metadata).toEqual({ path: '/api/auth/sign-in/username' });
  });
});
