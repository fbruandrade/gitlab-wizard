import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ env: { MAINTENANCE_SECRET: undefined as string | undefined }, run: vi.fn(), query: vi.fn() }));
vi.mock('@/server/env', () => ({ env: mocks.env }));
vi.mock('@/server/services/maintenance.service', () => ({ runMaintenance: mocks.run }));
vi.mock('@/server/services/vault-auto.service', () => ({ runVaultAuto: mocks.run }));
vi.mock('@/server/db', () => ({ prisma: { $queryRaw: mocks.query } }));
vi.mock('@/server/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const SECRET = 's'.repeat(40);
const call = (headers: Record<string, string> = {}) =>
  import('@/app/api/internal/maintenance/route').then((m) =>
    m.POST(new NextRequest('http://x/api/internal/maintenance', { method: 'POST', headers })),
  );

beforeEach(() => {
  mocks.env.MAINTENANCE_SECRET = undefined;
  mocks.run.mockReset().mockResolvedValue({ sessions: 1 });
  mocks.query.mockReset();
});

describe('POST /api/internal/maintenance', () => {
  it('sem MAINTENANCE_SECRET → 404 (não revela que o endpoint existe) e não executa', async () => {
    expect((await call({ authorization: `Bearer ${SECRET}` })).status).toBe(404);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each([
    [undefined],
    ['Bearer errado'],
    [`Bearer ${SECRET}x`],
    [`Bearer ${SECRET.slice(1)}`],
    [SECRET.replace(/s/g, 'z')],
    ['Basic abc'],
  ])('credencial inválida %j → 401', async (auth) => {
    mocks.env.MAINTENANCE_SECRET = SECRET;
    expect((await call(auth ? { authorization: auth } : {})).status).toBe(401);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('segredo correto → 200 com o resumo; aceita "bearer" em minúsculas', async () => {
    mocks.env.MAINTENANCE_SECRET = SECRET;
    const r = await call({ authorization: `bearer ${SECRET}` });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ sessions: 1 });
    expect(mocks.run).toHaveBeenCalledOnce();
  });
});

describe('POST /api/internal/vault-auto', () => {
  const callAuto = (headers: Record<string, string> = {}) =>
    import('@/app/api/internal/vault-auto/route').then((m) =>
      m.POST(new NextRequest('http://x/api/internal/vault-auto', { method: 'POST', headers })),
    );

  it('sem segredo → 404; credencial errada → 401; certa → 200 com o resumo', async () => {
    expect((await callAuto({ authorization: `Bearer ${SECRET}` })).status).toBe(404);
    mocks.env.MAINTENANCE_SECRET = SECRET;
    expect((await callAuto()).status).toBe(401);
    expect((await callAuto({ authorization: 'Bearer errado' })).status).toBe(401);
    expect(mocks.run).not.toHaveBeenCalled();
    mocks.run.mockResolvedValue({ ran: false, reason: 'DISABLED' });
    const r = await callAuto({ authorization: `Bearer ${SECRET}` });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ran: false, reason: 'DISABLED' });
  });
});

describe('GET /api/health', () => {
  it('banco ok → 200; banco fora → 503 sem expor o erro', async () => {
    const { GET } = await import('@/app/api/health/route');
    mocks.query.mockResolvedValueOnce([{ '?column?': 1 }]);
    const ok = await GET();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: 'ok' });

    mocks.query.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=segredo'));
    const down = await GET();
    expect(down.status).toBe(503);
    expect(JSON.stringify(await down.json())).not.toMatch(/segredo|10\.0\.0\.5/);
  });
});
