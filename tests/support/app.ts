import { inject } from 'vitest';
import pg from 'pg';
import { auth } from '@/server/auth/auth';
import { prisma } from '@/server/db';
import { startFakeGitLab, type FakeGitLab } from './fake-gitlab';

export const FAKE_GITLAB_PORT = 18080;
export const PASSWORD = 'Str0ng!Password#1';

/** Limpa tudo entre testes. TRUNCATE exige o papel migrator (app_runtime não tem, de propósito). */
export async function resetDb() {
  const c = new pg.Client({ connectionString: inject('migrationUrl') });
  await c.connect();
  await c.query('TRUNCATE "user", "verification", "rateLimit", audit_log, gitlab_token, admin_scan, app_setting CASCADE');
  await c.end();
}

export const startGitLab = (o: Parameters<typeof startFakeGitLab>[0] = {}): Promise<FakeGitLab> =>
  startFakeGitLab({ port: FAKE_GITLAB_PORT, ...o });

/** Mesmo caminho do scripts/create-admin.ts: createUser sem sessão, no servidor. */
export async function seedUser(username: string, role: 'admin' | 'user' = 'user', opts: { mustChangePassword?: boolean } = {}) {
  const { user } = await auth.api.createUser({
    body: { email: `${username}@example.com`, password: PASSWORD, name: username, role, data: { username, displayUsername: username } },
  });
  if (opts.mustChangePassword === false) await prisma.user.update({ where: { id: user.id }, data: { mustChangePassword: false } });
  return user;
}

const cookieHeader = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

/** Faz login pela API e devolve os headers de uma sessão válida (cookie), como o browser enviaria. */
export async function loginHeaders(username: string, password = PASSWORD): Promise<Headers> {
  const res = await auth.api.signInUsername({ body: { username, password }, asResponse: true });
  if (!res.ok) throw new Error(`login falhou: ${res.status}`);
  return new Headers({ cookie: cookieHeader(res) });
}

export const ctxFor = (user: { id: string; username?: string | null }, headers?: Headers) => ({
  actor: { id: user.id, username: user.username ?? null },
  ...(headers && { headers }),
});
