import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/server/db';
import { listAudit, recordAudit } from '@/server/services/audit.service';
import { runMaintenance } from '@/server/services/maintenance.service';
import { resetDb, seedUser } from '../support/app';

beforeEach(resetDb);

describe('auditoria append-only (papel app_runtime, igual à produção)', () => {
  it('o runtime consegue inserir e ler, mas NÃO atualizar, apagar nem truncar', async () => {
    await recordAudit({ action: 'X', result: 'SUCCESS' });
    const row = await prisma.auditLog.findFirstOrThrow();
    await expect(prisma.auditLog.update({ where: { id: row.id }, data: { result: 'FAILURE' } })).rejects.toThrow(/permission denied/i);
    await expect(prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/permission denied/i);
    await expect(prisma.$executeRawUnsafe('TRUNCATE audit_log')).rejects.toThrow(/permission denied/i);
    expect(await prisma.auditLog.count()).toBe(1);
  });

  it('filtra e pagina', async () => {
    const u = await seedUser('alice');
    for (let i = 0; i < 30; i++)
      await recordAudit({ action: i % 2 ? 'A' : 'B', result: 'SUCCESS', actor: { id: u.id, username: 'alice' } });
    await recordAudit({ action: 'C', result: 'FAILURE', actor: { username: 'outro' } });
    expect((await listAudit({ actorUserId: u.id }, 1, 25)).items).toHaveLength(25);
    expect((await listAudit({ actorUserId: u.id }, 2, 25)).items).toHaveLength(5);
    expect((await listAudit({ action: 'A' })).total).toBe(15);
    expect((await listAudit({ result: 'FAILURE' })).total).toBe(1);
    expect((await listAudit({ q: 'outr' })).total).toBe(1);
  });
});

describe('índices parciais do banco (vários tokens, um padrão)', () => {
  const base = {
    gitlabBaseUrl: 'g',
    gitlabUsername: 'x',
    gitlabIsAdmin: false,
    scopes: [],
    capabilities: [],
    keyVersion: 'v1',
    fingerprint: 'f',
  };
  const row = (userId: string, o: { glUser: number; pat: number; def?: boolean; status?: 'ACTIVE' | 'ROTATED' }) =>
    prisma.gitLabToken.create({
      data: {
        ...base,
        id: crypto.randomUUID(),
        userId,
        gitlabUserId: o.glUser,
        gitlabTokenId: o.pat,
        name: `p${o.pat}`,
        isDefault: o.def ?? false,
        status: o.status ?? 'ACTIVE',
      },
    });

  it('uma conta pode ter VÁRIOS tokens ativos, mas só UM padrão', async () => {
    const a = await seedUser('alice');
    await row(a.id, { glUser: 1, pat: 1, def: true });
    await row(a.id, { glUser: 1, pat: 2 });
    await row(a.id, { glUser: 1, pat: 3 });
    await expect(row(a.id, { glUser: 1, pat: 4, def: true })).rejects.toThrow(); // segundo padrão na mesma conta
    expect(await prisma.gitLabToken.count({ where: { userId: a.id, status: 'ACTIVE' } })).toBe(3);
  });

  it('o mesmo usuário GitLab não pode ser o padrão de DUAS contas (nem ter o mesmo PAT ativo duas vezes)', async () => {
    const a = await seedUser('alice');
    const b = await seedUser('bob');
    await row(a.id, { glUser: 1, pat: 1, def: true });
    await expect(row(b.id, { glUser: 1, pat: 2, def: true })).rejects.toThrow(); // mesmo usuário GitLab, outra conta
    await expect(row(b.id, { glUser: 9, pat: 1 })).rejects.toThrow(); // o mesmo PAT (id 1) ativo em outra conta
    await row(b.id, { glUser: 2, pat: 5, def: true }); // outro usuário GitLab: ok
  });

  it('tokens inativos não contam para as regras (histórico de rotação)', async () => {
    const a = await seedUser('alice');
    await row(a.id, { glUser: 1, pat: 1, def: true, status: 'ROTATED' });
    await row(a.id, { glUser: 1, pat: 1, def: true }); // o mesmo id/padrão pode voltar a existir como ATIVO
    await row(a.id, { glUser: 1, pat: 1, def: false, status: 'ROTATED' });
  });
});

describe('manutenção / retenção', () => {
  it('remove sessões e rate limits velhos e zera o ciphertext de PAT inativo há 30+ dias, preservando o resto', async () => {
    const u = await seedUser('alice');
    const day = 86_400_000;
    const now = new Date();
    await prisma.session.createMany({
      data: [
        { id: 'old', token: 't-old', userId: u.id, expiresAt: new Date(now.getTime() - 8 * day) },
        { id: 'recent', token: 't-recent', userId: u.id, expiresAt: new Date(now.getTime() - 2 * day) },
      ],
    });
    await prisma.rateLimit.createMany({
      data: [
        { id: 'r-old', key: 'k1', count: 1, lastRequest: BigInt(now.getTime() - 2 * day) },
        { id: 'r-new', key: 'k2', count: 1, lastRequest: BigInt(now.getTime()) },
      ],
    });
    const base = {
      gitlabBaseUrl: 'g',
      gitlabUsername: 'x',
      gitlabIsAdmin: false,
      scopes: [],
      capabilities: [],
      keyVersion: 'v1',
      fingerprint: 'f',
      userId: u.id,
      ciphertext: new Uint8Array([1]),
      iv: new Uint8Array([1]),
      authTag: new Uint8Array([1]),
    };
    await prisma.gitLabToken.create({
      data: {
        ...base,
        id: crypto.randomUUID(),
        gitlabUserId: 1,
        gitlabTokenId: 1,
        name: 'velho',
        status: 'ROTATED',
        inactivatedAt: new Date(now.getTime() - 31 * day),
      },
    });
    await prisma.gitLabToken.create({
      data: {
        ...base,
        id: crypto.randomUUID(),
        gitlabUserId: 1,
        gitlabTokenId: 2,
        name: 'recente',
        status: 'ROTATED',
        inactivatedAt: new Date(now.getTime() - 5 * day),
      },
    });
    await prisma.gitLabToken.create({ data: { ...base, id: crypto.randomUUID(), gitlabUserId: 1, gitlabTokenId: 3, name: 'ativo' } });

    const r = await runMaintenance(now);
    expect(r).toMatchObject({ sessions: 1, rateLimits: 1, tokensScrubbed: 1 });
    expect((await prisma.session.findMany()).map((s) => s.id)).toEqual(['recent']);
    const toks = Object.fromEntries((await prisma.gitLabToken.findMany()).map((t) => [t.name, t.ciphertext]));
    expect(toks['velho']).toBeNull();
    expect(toks['recente']).not.toBeNull();
    expect(toks['ativo']).not.toBeNull(); // PAT ativo jamais é tocado
    expect(await runMaintenance(now)).toMatchObject({ sessions: 0, rateLimits: 0, tokensScrubbed: 0 }); // idempotente
  });
});
