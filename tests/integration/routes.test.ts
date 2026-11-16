import { beforeEach, describe, expect, it } from 'vitest';
import { GET as exportCsv } from '@/app/(app)/admin/audit/export/route';
import { GET as scanStatus } from '@/app/(app)/admin/scans/[id]/route';
import { prisma } from '@/server/db';
import { recordAudit } from '@/server/services/audit.service';
import { readyUser, resetDb } from '../support/app';

beforeEach(resetDb);

const req = (path: string, headers?: Headers) => new Request(`http://localhost:3000${path}`, { headers });
const statusReq = (id: string, headers?: Headers) => scanStatus(req(`/admin/scans/${id}`, headers), { params: Promise.resolve({ id }) });

describe('GET /admin/scans/[id] (progresso da varredura)', () => {
  it('sem sessão 401; usuário comum 403; id malformado 404', async () => {
    const alice = await readyUser('alice');
    expect((await statusReq(crypto.randomUUID())).status).toBe(401);
    expect((await statusReq(crypto.randomUUID(), alice.headers)).status).toBe(403);
    const boss = await readyUser('boss', 'admin');
    for (const bad of ['1', '../../etc/passwd', "x' OR 1=1", 'a'.repeat(40)]) expect((await statusReq(bad, boss.headers)).status).toBe(404);
  });

  it('o dono vê o status/progresso (sem os itens); outra conta recebe 404; sem cache', async () => {
    const boss = await readyUser('boss', 'admin');
    const other = await readyUser('other', 'admin');
    const scan = await prisma.adminScan.create({
      data: {
        id: crypto.randomUUID(),
        kind: 'CLEANUP',
        actorUserId: boss.u.id,
        params: {},
        status: 'RUNNING',
        progress: { phase: 'keys', done: 3, total: 10 },
        items: [{ segredo: 'x' }],
      },
    });
    const mine = await statusReq(scan.id, boss.headers);
    expect(mine.status).toBe(200);
    expect(mine.headers.get('cache-control')).toBe('no-store');
    const body = await mine.json();
    expect(body).toEqual({ status: 'RUNNING', progress: { phase: 'keys', done: 3, total: 10 }, error: null });
    expect(JSON.stringify(body)).not.toContain('segredo'); // a resposta de polling não carrega os itens
    expect((await statusReq(scan.id, other.headers)).status).toBe(404); // varredura de outro admin
  });
});

describe('GET /admin/audit/export (CSV)', () => {
  const rows = async (res: Response) => (await res.text()).replace(/^﻿/, '').trim().split('\n');

  it('sem sessão 401; usuário comum 403', async () => {
    const alice = await readyUser('alice');
    expect((await exportCsv(req('/admin/audit/export'))).status).toBe(401);
    expect((await exportCsv(req('/admin/audit/export', alice.headers))).status).toBe(403);
    expect(await prisma.auditLog.count({ where: { action: 'AUDIT_EXPORTED' } })).toBe(0); // negado não gera evento de exportação
  });

  it('admin: CSV com BOM, cabeçalho, uma linha por registro, content-type/disposition corretos e a exportação é auditada', async () => {
    const boss = await readyUser('boss', 'admin');
    await recordAudit({
      action: 'TOOL_USER_CREATED',
      result: 'SUCCESS',
      actor: { id: boss.u.id, username: 'boss' },
      reason: 'REQ0001',
      target: { type: 'tool_user', id: 'x', label: 'maria' },
    });
    const res = await exportCsv(req('/admin/audit/export', boss.headers));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="auditoria-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const bytes = new Uint8Array(await res.clone().arrayBuffer()); // text() descarta o BOM por especificação: olha os bytes
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM: o Excel abre em UTF-8
    const lines = await rows(res);
    expect(lines[0]).toBe('data_hora_utc,conta,acao,resultado,alvo_tipo,alvo,motivo,codigo_erro,ip');
    expect(lines.some((l) => l.includes('"TOOL_USER_CREATED"') && l.includes('"maria"') && l.includes('"REQ0001"'))).toBe(true);
    // a exportação foi auditada (e vem do ator certo)
    const [ev] = await prisma.auditLog.findMany({ where: { action: 'AUDIT_EXPORTED' } });
    expect(ev).toMatchObject({ result: 'SUCCESS', actorUsername: 'boss' });
  });

  it('neutraliza injeção de fórmula (=, +, -, @) e escapa aspas e vírgulas', async () => {
    const boss = await readyUser('boss', 'admin');
    await recordAudit({
      action: 'TOOL_USER_BANNED',
      result: 'SUCCESS',
      actor: { id: boss.u.id, username: 'boss' },
      reason: '=HYPERLINK("http://evil","x")',
    });
    await recordAudit({ action: 'TOOL_USER_UNBANNED', result: 'SUCCESS', actor: { id: boss.u.id, username: 'boss' }, reason: 'a, "b"' });
    const text = (await (await exportCsv(req('/admin/audit/export?q=boss', boss.headers))).text()).replace(/^﻿/, '');
    expect(text).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`); // apóstrofo na frente + aspas dobradas
    expect(text).not.toMatch(/,"=HYPERLINK/); // nenhuma célula começa com =
    expect(text).toContain('"a, ""b"""');
  });

  it('respeita os filtros (grupo, resultado, busca) e pagina em lotes (mais de 500 linhas sai inteiro, sem repetir)', async () => {
    const boss = await readyUser('boss', 'admin');
    await prisma.auditLog.createMany({
      data: Array.from({ length: 1203 }, (_, i) => ({
        action: i % 2 ? 'AUTH_LOGIN_FAILED' : 'GITLAB_USER_BLOCKED',
        result: i % 2 ? ('FAILURE' as const) : ('SUCCESS' as const),
        actorUsername: `u${i}`,
      })),
    });
    const all = await rows(await exportCsv(req('/admin/audit/export', boss.headers)));
    // além das 1203 criadas há o login do "boss" e o próprio evento AUDIT_EXPORTED: conta as MINHAS, por tipo
    expect(all.filter((l) => l.includes('"GITLAB_USER_BLOCKED"'))).toHaveLength(602);
    expect(all.filter((l) => l.includes('"AUTH_LOGIN_FAILED"'))).toHaveLength(601);
    expect(new Set(all).size).toBe(all.length); // nenhuma linha repetida entre os lotes de 500

    const failed = await rows(await exportCsv(req('/admin/audit/export?group=AUTH_&result=FAILURE', boss.headers)));
    expect(failed.length - 1).toBe(601);
    expect(failed.slice(1).every((l) => l.includes('"AUTH_LOGIN_FAILED"'))).toBe(true);
    const one = await rows(await exportCsv(req('/admin/audit/export?q=u1', boss.headers)));
    expect(one.slice(1).every((l) => /u1/.test(l))).toBe(true);
  });
});
