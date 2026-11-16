import { vi } from 'vitest';

/**
 * Simulação mínima das APIs de request do Next (`next/headers`, `next/navigation`, `next/cache`) para testar, fora do
 * Next, guards, contextos e Server Actions com o better-auth e o banco REAIS. Use no arquivo de teste:
 *
 *   vi.mock('next/headers', async () => (await import('../support/next-mocks')).headersModule);
 *   vi.mock('next/navigation', async () => (await import('../support/next-mocks')).navigationModule);
 *   vi.mock('next/cache', async () => (await import('../support/next-mocks')).cacheModule);
 */
export const nextState = {
  headers: new Headers(),
  cookies: new Map<string, string>(),
  setCookies: [] as { name: string; value: string; options: Record<string, unknown> }[],
  revalidated: [] as string[],
};

export function resetNext() {
  nextState.headers = new Headers();
  nextState.cookies.clear();
  nextState.setCookies.length = 0;
  nextState.revalidated.length = 0;
}

/** Define "quem está fazendo a requisição": cookie de sessão (como o browser enviaria) e, opcionalmente, o token escolhido. */
export function asRequest(headers: Headers, activeTokenId?: string) {
  resetNext();
  nextState.headers = headers;
  if (activeTokenId) nextState.cookies.set('gw.active_token', activeTokenId);
}

/** Imita o `redirect()` do Next: lança um erro de controle de fluxo (digest NEXT_REDIRECT) que o runAction deve repassar. */
export class RedirectError extends Error {
  digest: string;
  constructor(public readonly url: string) {
    super(`REDIRECT:${url}`);
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}

export const headersModule = {
  headers: async () => nextState.headers,
  cookies: async () => ({
    get: (name: string) => (nextState.cookies.has(name) ? { name, value: nextState.cookies.get(name)! } : undefined),
    set: (name: string, value: string, options: Record<string, unknown> = {}) => {
      nextState.cookies.set(name, value);
      nextState.setCookies.push({ name, value, options });
    },
  }),
};

export const navigationModule = {
  redirect: (url: string): never => {
    throw new RedirectError(url);
  },
  notFound: (): never => {
    throw Object.assign(new Error('NOT_FOUND'), { digest: 'NEXT_NOT_FOUND' });
  },
};

export const cacheModule = { revalidatePath: vi.fn((path: string) => void nextState.revalidated.push(path)) };

/** Executa `fn` e devolve a URL do redirect lançado (ou null se não houve). */
export async function redirectOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    if (e instanceof RedirectError) return e.url;
    throw e;
  }
}
