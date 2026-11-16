import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import {
  getSession,
  requireActiveSession,
  requireAdmin,
  requireAdminPage,
  requireFreshSession,
  requireReadySession,
  requireSession,
} from '@/server/auth/guards';
import { asRequest, redirectOf } from '../support/next-mocks';
import { ageSession, loginHeaders, readyUser, resetDb, seedUser } from '../support/app';

vi.mock('next/headers', async () => (await import('../support/next-mocks')).headersModule);
vi.mock('next/navigation', async () => (await import('../support/next-mocks')).navigationModule);
vi.mock('next/cache', async () => (await import('../support/next-mocks')).cacheModule);

beforeEach(resetDb);

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? 'THROWN';
  }
  return 'OK';
};

/** Remove o cookie cache (`gw.session_data`): a sessão passa a ser lida do banco (o cache pode estar até 60 s defasado). */
const withoutCache = (h: Headers) =>
  new Headers({
    cookie: (h.get('cookie') ?? '')
      .split('; ')
      .filter((c) => !c.startsWith('gw.session_data='))
      .join('; '),
  });
describe('requireSession / getSession (páginas)', () => {
  it('sem cookie → redireciona para /login', async () => {
    asRequest(new Headers());
    expect(await getSession()).toBeNull();
    expect(await redirectOf(requireSession)).toBe('/login');
  });

  it('com sessão válida devolve o usuário', async () => {
    const { headers } = await readyUser('alice');
    asRequest(headers);
    expect((await requireSession()).user.username).toBe('alice');
  });

  it('sessão além do TETO ABSOLUTO (8 h) é apagada do banco e vai para /login?expired=1', async () => {
    const { u, headers } = await readyUser('alice');
    asRequest(withoutCache(headers)); // lê do banco; com o cookie cache o createdAt ainda seria o de agora (≤ 60 s de defasagem)
    await ageSession(u.id, 9 * 60); // 9 h
    expect(await redirectOf(requireSession)).toBe('/login?expired=1');
    expect(await prisma.session.count({ where: { userId: u.id } })).toBe(0);
  });
});

describe('requireReadySession (layout autenticado)', () => {
  it('senha temporária → /account/change-password', async () => {
    await seedUser('novo'); // mustChangePassword=true por padrão
    asRequest(await loginHeaders('novo'));
    expect(await redirectOf(requireReadySession)).toBe('/account/change-password');
  });

  it('senha trocada mas SEM 2FA (obrigatório) → /setup-2fa', async () => {
    await seedUser('alice', 'user', { mustChangePassword: false });
    asRequest(await loginHeaders('alice'));
    expect(await redirectOf(requireReadySession)).toBe('/setup-2fa');
  });

  it('conta pronta passa; sem sessão → /login', async () => {
    const { headers } = await readyUser('alice');
    asRequest(headers);
    expect((await requireReadySession()).user.username).toBe('alice');
    asRequest(new Headers());
    expect(await redirectOf(requireReadySession)).toBe('/login');
  });

  it('o gate confirma no BANCO (cookie cache defasado não prende quem acabou de trocar a senha)', async () => {
    const u = await seedUser('alice'); // mustChangePassword=true
    const h = await loginHeaders('alice'); // o cookie cache carrega mustChangePassword=true
    await prisma.user.update({ where: { id: u.id }, data: { mustChangePassword: false, twoFactorEnabled: true } });
    asRequest(h);
    expect((await requireReadySession()).user.username).toBe('alice'); // não redireciona
  });
});

describe('requireFreshSession (ações sensíveis)', () => {
  it('sem sessão → UNAUTHENTICATED', async () => {
    asRequest(new Headers());
    expect(await code(requireFreshSession())).toBe('UNAUTHENTICATED');
  });

  it('senha temporária e 2FA pendente barram a ação (PASSWORD_CHANGE_REQUIRED / TWO_FACTOR_SETUP_REQUIRED)', async () => {
    await seedUser('novo');
    asRequest(await loginHeaders('novo'));
    expect(await code(requireFreshSession())).toBe('PASSWORD_CHANGE_REQUIRED');
    await seedUser('semdois', 'user', { mustChangePassword: false });
    asRequest(await loginHeaders('semdois'));
    expect(await code(requireFreshSession())).toBe('TWO_FACTOR_SETUP_REQUIRED');
  });

  it('login recente passa; com mais de 15 min exige reautenticação (REAUTH_REQUIRED)', async () => {
    const { u, headers } = await readyUser('alice');
    asRequest(headers);
    expect((await requireFreshSession()).user.id).toBe(u.id);
    await ageSession(u.id, 20);
    expect(await code(requireFreshSession())).toBe('REAUTH_REQUIRED');
  });

  it('sessão revogada no banco é negada NA HORA (não usa o cookie cache)', async () => {
    const { u, headers } = await readyUser('alice');
    asRequest(headers);
    await prisma.session.deleteMany({ where: { userId: u.id } });
    expect(await code(requireFreshSession())).toBe('UNAUTHENTICATED');
  });

  it('teto absoluto também vale aqui (sessão apagada e UNAUTHENTICATED)', async () => {
    const { u, headers } = await readyUser('alice');
    asRequest(headers);
    await ageSession(u.id, 9 * 60);
    expect(await code(requireFreshSession())).toBe('UNAUTHENTICATED');
    expect(await prisma.session.count({ where: { userId: u.id } })).toBe(0);
  });
});

describe('requireActiveSession (preferências: sem exigir login recente)', () => {
  it('aceita sessão antiga (>15 min), mas mantém os gates e o teto absoluto', async () => {
    const { u, headers } = await readyUser('alice');
    asRequest(headers);
    await ageSession(u.id, 120);
    expect((await requireActiveSession()).user.id).toBe(u.id); // 2 h: ok (abaixo de 8 h)
    await ageSession(u.id, 9 * 60);
    expect(await code(requireActiveSession())).toBe('UNAUTHENTICATED');
  });

  it('sem sessão / senha temporária / 2FA pendente → negado', async () => {
    asRequest(new Headers());
    expect(await code(requireActiveSession())).toBe('UNAUTHENTICATED');
    await seedUser('novo');
    asRequest(await loginHeaders('novo'));
    expect(await code(requireActiveSession())).toBe('PASSWORD_CHANGE_REQUIRED');
    await seedUser('semdois', 'user', { mustChangePassword: false });
    asRequest(await loginHeaders('semdois'));
    expect(await code(requireActiveSession())).toBe('TWO_FACTOR_SETUP_REQUIRED');
  });
});

describe('papel de admin da ferramenta', () => {
  it('requireAdmin: usuário comum → FORBIDDEN; admin passa', async () => {
    const alice = await readyUser('alice');
    const root = await readyUser('root', 'admin');
    asRequest(alice.headers);
    expect(await code(requireAdmin())).toBe('FORBIDDEN');
    asRequest(root.headers);
    expect((await requireAdmin()).user.role).toBe('admin');
  });

  it('requireAdmin herda a exigência de login recente', async () => {
    const { u, headers } = await readyUser('root', 'admin');
    asRequest(headers);
    await ageSession(u.id, 20);
    expect(await code(requireAdmin())).toBe('REAUTH_REQUIRED');
  });

  it('requireAdminPage: usuário comum vai para "/"; admin passa', async () => {
    const alice = await readyUser('alice');
    const root = await readyUser('root', 'admin');
    asRequest(alice.headers);
    expect(await redirectOf(requireAdminPage)).toBe('/');
    asRequest(root.headers);
    expect((await requireAdminPage()).user.username).toBe('root');
  });
});
