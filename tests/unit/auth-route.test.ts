import { describe, expect, it, vi } from 'vitest';

vi.mock('@/server/auth/handler', () => ({ authHandler: vi.fn() }));

describe('/api/auth/[...all]', () => {
  it('expõe GET e POST apontando para o authHandler (que audita o 429) e é sempre dinâmica', async () => {
    const route = await import('@/app/api/auth/[...all]/route');
    const { authHandler } = await import('@/server/auth/handler');
    expect(route.GET).toBe(authHandler);
    expect(route.POST).toBe(authHandler);
    expect(route.dynamic).toBe('force-dynamic');
    expect((route as Record<string, unknown>).PUT).toBeUndefined(); // só os métodos usados pela UI
    expect((route as Record<string, unknown>).DELETE).toBeUndefined();
  });
});
