import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionError } from '@/server/action-result';
import { adminCtx, gitlabCtx } from '@/server/action-context';
import { GitLabApiError } from '@/server/gitlab/errors';
import { loadGitLab } from '@/server/page-gitlab';
import { addToken, listTokens } from '@/server/services/gitlab-token.service';
import { getSelectedTokenId, pageCtx, resolveSelectedToken, setSelectedTokenId, TOKEN_COOKIE } from '@/server/token-selection';
import { asRequest, nextState, redirectOf } from '../support/next-mocks';
import { ctxFor, readyUser, resetDb, startGitLab } from '../support/app';
import type { FakeGitLab } from '../support/fake-gitlab';

vi.mock('next/headers', async () => (await import('../support/next-mocks')).headersModule);
vi.mock('next/navigation', async () => (await import('../support/next-mocks')).navigationModule);
vi.mock('next/cache', async () => (await import('../support/next-mocks')).cacheModule);

let fake: FakeGitLab;
beforeEach(async () => {
  await resetDb();
  fake = await startGitLab();
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

/** Conta pronta com 2 tokens do mesmo usuário GitLab: "admin" (padrão) e "leitura". */
async function twoTokens() {
  const gl = fake.addUser({ username: 'root', is_admin: true });
  const { u, headers } = await readyUser('alice');
  const ctx = ctxFor(u);
  await addToken(ctx, fake.addToken(gl.id, { name: 'admin', scopes: ['api'] }).token);
  await addToken(ctx, fake.addToken(gl.id, { name: 'leitura', scopes: ['read_api'] }).token);
  const rows = Object.fromEntries((await listTokens(u.id)).map((r) => [r.name, r]));
  return { u, headers, rows };
}

describe('token em uso (cookie gw.active_token)', () => {
  it('grava o id com cookie HttpOnly/SameSite=Lax, escopo "/" e validade da sessão; lê de volta', async () => {
    const w = await twoTokens();
    asRequest(w.headers);
    expect(await getSelectedTokenId()).toBeUndefined();
    await setSelectedTokenId(w.rows.leitura!.id);
    expect(await getSelectedTokenId()).toBe(w.rows.leitura!.id);
    const [c] = nextState.setCookies;
    expect(c).toMatchObject({ name: TOKEN_COOKIE, value: w.rows.leitura!.id });
    expect(c!.options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: 8 * 3600, secure: false }); // base http://localhost → sem Secure
  });

  it('resolveSelectedToken: usa o escolhido; sem escolha → padrão; cookie forjado/lixo → padrão', async () => {
    const w = await twoTokens();
    asRequest(w.headers, w.rows.leitura!.id);
    expect((await resolveSelectedToken(w.u.id))?.name).toBe('leitura');
    asRequest(w.headers);
    expect((await resolveSelectedToken(w.u.id))?.name).toBe('admin');
    asRequest(w.headers, crypto.randomUUID());
    expect((await resolveSelectedToken(w.u.id))?.name).toBe('admin');
    asRequest(w.headers, 'isto-nao-e-um-id');
    expect((await resolveSelectedToken(w.u.id))?.name).toBe('admin');
  });

  it('pageCtx carrega quem é e o token escolhido', async () => {
    const w = await twoTokens();
    asRequest(w.headers, w.rows.leitura!.id);
    expect(await pageCtx({ user: { id: w.u.id, username: 'alice' } })).toEqual({
      actor: { id: w.u.id, username: 'alice' },
      tokenId: w.rows.leitura!.id,
    });
    expect((await pageCtx({ user: { id: w.u.id } })).actor.username).toBeNull();
  });
});

describe('contexto das Server Actions', () => {
  it('gitlabCtx: exige sessão fresca e devolve ator, origem da requisição e o token escolhido', async () => {
    const w = await twoTokens();
    w.headers.set('user-agent', 'Teste/1.0');
    asRequest(w.headers, w.rows.leitura!.id);
    const ctx = await gitlabCtx();
    expect(ctx).toMatchObject({ actor: { id: w.u.id, username: 'alice' }, tokenId: w.rows.leitura!.id, meta: { userAgent: 'Teste/1.0' } });
    asRequest(new Headers());
    expect(await code(gitlabCtx())).toBe('UNAUTHENTICATED');
  });

  it('adminCtx: só role=admin; leva os headers da sessão para o plugin admin', async () => {
    const alice = await readyUser('alice');
    const root = await readyUser('root', 'admin');
    asRequest(alice.headers);
    expect(await code(adminCtx())).toBe('FORBIDDEN');
    asRequest(root.headers);
    const ctx = await adminCtx();
    expect(ctx.actor.username).toBe('root');
    expect(ctx.headers.get('cookie')).toContain('gw.session_token');
  });
});

describe('loadGitLab (leitura nas páginas)', () => {
  it('sucesso → ok com os dados', async () => {
    expect(await loadGitLab(async () => 7)).toEqual({ ok: true, data: 7 });
  });

  it.each([['NO_GITLAB_TOKEN'], ['GITLAB_TOKEN_INVALID']])(
    '%s → redireciona para /token com o aviso (a sessão da ferramenta segue)',
    async (c) => {
      const err = c === 'NO_GITLAB_TOKEN' ? new ActionError(c) : new GitLabApiError('GITLAB_TOKEN_INVALID', 401, 'x');
      expect(
        await redirectOf(async () => {
          await loadGitLab(async () => {
            throw err;
          });
        }),
      ).toBe(`/token?notice=${c}`);
    },
  );

  it('outros erros de negócio/GitLab viram estado da tela (não derrubam a página)', async () => {
    const a = await loadGitLab(async () => {
      throw new ActionError('MISSING_CAPABILITY');
    });
    expect(a).toMatchObject({ ok: false, code: 'MISSING_CAPABILITY' });
    const g = await loadGitLab(async () => {
      throw new GitLabApiError('GITLAB_UNAVAILABLE', 503, 'x');
    });
    expect(g).toMatchObject({ ok: false, code: 'GITLAB_UNAVAILABLE', message: expect.stringContaining('indisponível') });
  });

  it('erro inesperado NÃO é engolido (sobe para o error boundary do Next)', async () => {
    await expect(
      loadGitLab(async () => {
        throw new Error('bug');
      }),
    ).rejects.toThrow('bug');
  });
});
