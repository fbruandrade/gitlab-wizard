import { beforeEach, describe, expect, it } from 'vitest';
import { TOTP, URI } from 'otpauth';
import { auth } from '@/server/auth/auth';
import { authHandler } from '@/server/auth/handler';
import { prisma } from '@/server/db';
import { loginHeaders, PASSWORD, resetDb, seedUser } from '../support/app';

const base = 'http://localhost:3000/api/auth';
// Mesmo caminho do route handler do Next (inclui a auditoria do 429).
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  authHandler(
    new Request(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', ...headers },
      body: JSON.stringify(body),
    }),
  );
const totp = (uri: string) => (URI.parse(uri) as TOTP).generate();
const audit = (action: string) => prisma.auditLog.findMany({ where: { action }, orderBy: { createdAt: 'asc' } });

beforeEach(resetDb);

describe('conta criada pelo admin (seed)', () => {
  it('nasce com mustChangePassword, username normalizado e senha com hash', async () => {
    const u = await seedUser('Alice', 'user');
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id }, include: { accounts: true } });
    expect(row.username).toBe('alice');
    expect(row.mustChangePassword).toBe(true);
    expect(row.role).toBe('user');
    expect(row.accounts[0]?.password).toMatch(/^[0-9a-f]+:[0-9a-f]+$/); // scrypt: salt:hash — nunca texto puro
    expect(row.accounts[0]?.password).not.toContain(PASSWORD);
  });
});

describe('login', () => {
  it('aceita usuário+senha, cria sessão e audita AUTH_LOGIN_SUCCESS', async () => {
    await seedUser('alice');
    const res = await post('/sign-in/username', { username: 'alice', password: PASSWORD }, { 'x-test-ip': '10.0.0.1' });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join(';')).toContain('gw.session_token');
    const [ev] = await audit('AUTH_LOGIN_SUCCESS');
    expect(ev?.actorUsername).toBe('alice');
    expect(ev?.ipAddress).toBe('10.0.0.1');
  });

  it('senha errada → 401 genérico + AUTH_LOGIN_FAILED sem a senha', async () => {
    await seedUser('alice');
    const res = await post('/sign-in/username', { username: 'alice', password: 'Wrong!Password#9' }, { 'x-test-ip': '10.0.0.2' });
    expect(res.status).toBe(401);
    const [ev] = await audit('AUTH_LOGIN_FAILED');
    expect(ev?.actorUsername).toBe('alice');
    expect(JSON.stringify(ev)).not.toContain('Wrong!Password');
  });

  it('usuário inexistente tem a mesma resposta que senha errada', async () => {
    await seedUser('alice');
    const a = await post('/sign-in/username', { username: 'alice', password: 'Wrong!Password#9' }, { 'x-test-ip': '10.0.0.3' });
    const b = await post('/sign-in/username', { username: 'ninguem', password: 'Wrong!Password#9' }, { 'x-test-ip': '10.0.0.3' });
    expect(b.status).toBe(a.status);
    expect(((await b.json()) as { message: string }).message).toBe(((await a.json()) as { message: string }).message);
  });

  it('6ª tentativa em 60 s do mesmo IP → 429 (e só esse IP)', async () => {
    await seedUser('alice');
    const attempt = (ip: string) => post('/sign-in/username', { username: 'alice', password: 'Wrong!Password#9' }, { 'x-test-ip': ip });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await attempt('10.9.9.9')).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    expect((await attempt('10.8.8.8')).status).toBe(401); // outro IP não é afetado
    expect((await audit('AUTH_RATE_LIMITED')).length).toBeGreaterThan(0);
  });

  it('conta banida não loga e perde as sessões', async () => {
    const u = await seedUser('alice');
    const h = await loginHeaders('alice');
    expect(await auth.api.getSession({ headers: h })).not.toBeNull();
    const admin = await seedUser('root', 'admin');
    await prisma.user.update({ where: { id: admin.id }, data: { mustChangePassword: false } });
    await auth.api.banUser({ body: { userId: u.id, banReason: 'teste' }, headers: await loginHeaders('root') });
    expect(await auth.api.getSession({ headers: h, query: { disableCookieCache: true } })).toBeNull();
    const res = await post('/sign-in/username', { username: 'alice', password: PASSWORD }, { 'x-test-ip': '10.0.0.4' });
    expect(res.status).toBe(403);
  });
});

describe('superfície HTTP exposta', () => {
  it.each([
    ['/sign-up/email', { email: 'x@x.com', password: PASSWORD, name: 'x' }],
    ['/admin/create-user', { email: 'x@x.com', password: PASSWORD, name: 'x', role: 'admin' }],
    ['/admin/list-users', {}],
    ['/admin/impersonate-user', { userId: 'x' }],
    ['/admin/set-role', { userId: 'x', role: 'admin' }],
    ['/update-user', { name: 'hacker' }],
    ['/change-email', { newEmail: 'x@x.com' }],
    ['/two-factor/send-otp', {}],
  ])('POST %s não é alcançável (404)', async (path, body) => {
    const res = await post(path, body, { 'x-test-ip': '10.1.1.1' });
    expect(res.status).toBe(404);
  });

  it('admin logado também NÃO alcança /admin/* por HTTP (só via Server Actions)', async () => {
    const admin = await seedUser('root', 'admin', { mustChangePassword: false });
    const h = await loginHeaders('root');
    const res = await post('/admin/set-role', { userId: admin.id, role: 'user' }, { cookie: h.get('cookie')!, 'x-test-ip': '10.1.1.2' });
    expect(res.status).toBe(404);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).role).toBe('admin');
  });
});

describe('CSRF: requisições com sessão e origem forjada', () => {
  it.each([
    ['/sign-out', {}],
    ['/revoke-sessions', {}],
    ['/change-password', { currentPassword: PASSWORD, newPassword: 'N0va!SenhaForte#42' }],
  ])('POST %s com cookie válido e Origin de outro site é recusado (403) e nada muda', async (path, body) => {
    const u = await seedUser('alice', 'user', { mustChangePassword: false });
    const h = await loginHeaders('alice');
    const res = await post(path, body, { cookie: h.get('cookie')!, origin: 'https://evil.example', 'x-test-ip': '10.5.0.1' });
    expect(res.status).toBe(403);
    expect(await prisma.session.count({ where: { userId: u.id } })).toBe(1); // sessão intacta
    await expect(auth.api.signInUsername({ body: { username: 'alice', password: PASSWORD } })).resolves.toBeTruthy(); // senha intacta
  });

  it('com a origem correta a mesma operação funciona', async () => {
    await seedUser('alice', 'user', { mustChangePassword: false });
    const h = await loginHeaders('alice');
    expect((await post('/sign-out', {}, { cookie: h.get('cookie')!, 'x-test-ip': '10.5.0.2' })).status).toBe(200);
  });
});

describe('troca de senha', () => {
  it('rejeita senha fraca, aceita forte, limpa mustChangePassword, audita e revoga outras sessões', async () => {
    const u = await seedUser('alice');
    const h1 = await loginHeaders('alice');
    const h2 = await loginHeaders('alice');
    const cookie = h1.get('cookie')!;

    const weak = await post(
      '/change-password',
      { currentPassword: PASSWORD, newPassword: 'curta', revokeOtherSessions: true },
      { cookie, 'x-test-ip': '10.2.0.1' },
    );
    expect(weak.status).toBe(400);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).mustChangePassword).toBe(true);

    const ok = await post(
      '/change-password',
      { currentPassword: PASSWORD, newPassword: 'N0va!SenhaForte#42', revokeOtherSessions: true },
      { cookie, 'x-test-ip': '10.2.0.1' },
    );
    expect(ok.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).mustChangePassword).toBe(false);
    expect((await audit('AUTH_PASSWORD_CHANGED')).some((e) => e.result === 'SUCCESS')).toBe(true);
    expect(await auth.api.getSession({ headers: h2, query: { disableCookieCache: true } })).toBeNull(); // outra sessão caiu
    await expect(auth.api.signInUsername({ body: { username: 'alice', password: PASSWORD } })).rejects.toThrow(); // senha antiga não vale mais
  });

  it('não é possível forjar mustChangePassword=false pelo client', async () => {
    const u = await seedUser('alice');
    const h = await loginHeaders('alice');
    const res = await post('/update-user', { mustChangePassword: false }, { cookie: h.get('cookie')!, 'x-test-ip': '10.2.0.2' });
    expect(res.status).toBe(404);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).mustChangePassword).toBe(true);
  });
});

describe('2FA da ferramenta (TOTP)', () => {
  it('ativa, exige o código no login, aceita backup code uma única vez e audita', async () => {
    const u = await seedUser('alice', 'user', { mustChangePassword: false });
    const h = await loginHeaders('alice');
    const enabledResult = await auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers: h });
    if (enabledResult.method !== 'totp') throw new Error('esperava TOTP'); // 1.7: união totp | otp
    const enabled = enabledResult;
    expect(enabled.backupCodes).toHaveLength(10);
    await auth.api.verifyTOTP({ body: { code: totp(enabled.totpURI) }, headers: h });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).twoFactorEnabled).toBe(true);
    expect((await audit('AUTH_2FA_ENABLED')).length).toBe(1);

    // novo login: senha OK mas sessão só depois do código
    const step1 = await post('/sign-in/username', { username: 'alice', password: PASSWORD }, { 'x-test-ip': '10.3.0.1' });
    const body1 = (await step1.json()) as { twoFactorRedirect?: boolean };
    expect(body1.twoFactorRedirect).toBe(true);
    // o cookie de sessão vem limpo (Max-Age=0): nenhuma sessão com valor antes do código
    expect(step1.headers.getSetCookie().join(';')).not.toMatch(/gw\.session_token=[^;\s]+/);
    expect(await audit('AUTH_LOGIN_SUCCESS')).toHaveLength(1); // só o do primeiro login (antes do 2FA)

    const twoFactorCookie = step1.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const bad = await post('/two-factor/verify-totp', { code: '000000' }, { cookie: twoFactorCookie, 'x-test-ip': '10.3.0.1' });
    expect(bad.status).toBe(401);
    const good = await post(
      '/two-factor/verify-totp',
      { code: totp(enabled.totpURI) },
      { cookie: twoFactorCookie, 'x-test-ip': '10.3.0.1' },
    );
    expect(good.status).toBe(200);
    expect(good.headers.getSetCookie().join(';')).toContain('gw.session_token');
    expect((await audit('AUTH_LOGIN_SUCCESS')).length).toBe(2);

    // backup code: vale uma vez
    const code = enabled.backupCodes[0]!;
    const login = async () => {
      const r = await post('/sign-in/username', { username: 'alice', password: PASSWORD }, { 'x-test-ip': '10.3.0.2' });
      return r.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
    };
    expect((await post('/two-factor/verify-backup-code', { code }, { cookie: await login(), 'x-test-ip': '10.3.0.2' })).status).toBe(200);
    expect((await post('/two-factor/verify-backup-code', { code }, { cookie: await login(), 'x-test-ip': '10.3.0.2' })).status).not.toBe(
      200,
    );
  });
});
