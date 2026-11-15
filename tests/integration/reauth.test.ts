import { beforeEach, describe, expect, it } from 'vitest';
import { TOTP, URI } from 'otpauth';
import { authHandler } from '@/server/auth/handler';
import { auth } from '@/server/auth/auth';
import { prisma } from '@/server/db';
import { loginHeaders, PASSWORD, resetDb, seedUser } from '../support/app';

beforeEach(resetDb);
const base = 'http://localhost:3000/api/auth';
const post = (path: string, body: unknown, cookie: string, ip = '10.7.0.1') =>
  authHandler(
    new Request(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', cookie, 'x-test-ip': ip },
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
    if (/=$/.test(kv!) || /Max-Age=0/.test(c))
      map.delete(name); // cookie limpo pelo servidor
    else map.set(name, kv!);
  }
  return [...map.values()].join('; ');
};

describe('reautenticação (login por cima de uma sessão existente, com 2FA)', () => {
  it('senha + TOTP geram uma sessão NOVA e fresca', async () => {
    const u = await seedUser('alice', 'user', { mustChangePassword: false });
    const h = await loginHeaders('alice');
    const enabled = await auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers: h });
    if (enabled.method !== 'totp') throw new Error('esperava TOTP');
    const gen = () => (URI.parse(enabled.totpURI) as TOTP).generate();
    await auth.api.verifyTOTP({ body: { code: gen() }, headers: h });

    // sessão antiga "velha"
    await prisma.session.updateMany({ where: { userId: u.id }, data: { createdAt: new Date(Date.now() - 20 * 60_000) } });
    const oldCookie = h.get('cookie')!;

    const step1 = await post('/sign-in/username', { username: 'alice', password: PASSWORD }, oldCookie);
    expect(((await step1.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    const cookies = jar(step1, oldCookie);
    expect(cookies).toContain('two_factor');

    const step2 = await post('/two-factor/verify-totp', { code: gen(), trustDevice: false }, cookies);
    expect(step2.status).toBe(200);
    const fresh = jar(step2, cookies);
    const session = await auth.api.getSession({ headers: new Headers({ cookie: fresh }), query: { disableCookieCache: true } });
    expect(session).not.toBeNull();
    expect(Date.now() - session!.session.createdAt.getTime()).toBeLessThan(60_000); // sessão nova → login "fresco"
  });
});
