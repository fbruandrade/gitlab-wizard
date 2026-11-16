import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { addToken, listTokens, unlinkToken } from '@/server/services/gitlab-token.service';
import {
  autoCandidates,
  disableVaultAuto,
  enableVaultAuto,
  getAutoSettings,
  getAutoStatus,
  runVaultAuto,
  startVaultAutoScheduler,
} from '@/server/services/vault-auto.service';
import { getVaultConfig, updateVaultConfig } from '@/server/services/vault.service';
import type { VaultItem } from '@/lib/vault-rules';
import { ctxFor, resetDb, seedUser, startGitLab } from '../support/app';
import type { FakeGitLab } from '../support/fake-gitlab';

let fake: FakeGitLab;
beforeEach(async () => {
  await resetDb();
  fake = await startGitLab();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fake.close();
});

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? 'THROWN';
  }
  return 'OK';
};

/** Cofres: venc (vence em 5 d), exp (vencido), ok (200 d), semtoken, semvars (token ok, sem variáveis), multi. */
async function world() {
  const op = fake.addUser({ username: 'operador' });
  const opPat = fake.addToken(op.id, { scopes: ['api'] });
  const admin = await seedUser('alice', 'admin', { mustChangePassword: false });
  const ctx = ctxFor(admin);
  await addToken(ctx, opPat.token);

  const root = fake.addGroup('seguranca-corporativa');
  const hml = fake.addGroup('hml', root.id);
  const vaults: Record<string, { project: { id: number }; group: { id: number }; old?: ReturnType<typeof fake.addProjectToken> }> = {};
  const mk = (app: string, tokens: number[], vars: boolean) => {
    const group = fake.addGroup(app);
    const project = fake.addProject(hml.id, app);
    const toks = tokens.map((d) => fake.addProjectToken(project.id, { name: `cofre-hml-20260101`, expires_at: inDays(d) }));
    if (vars) {
      fake.setVariable(group.id, 'PID_HML', String(project.id));
      if (toks[0]) fake.setVariable(group.id, 'DEVOPS_HML', toks[0].token);
    }
    vaults[app] = { project, group, old: toks[0] };
  };
  mk('venc', [5], true);
  mk('exp', [-3], false);
  mk('ok', [200], true);
  mk('semtoken', [], false);
  mk('semvars', [200], false);
  mk('multi', [5, 6], true);
  return { ctx, admin, op, vaults };
}
const active = (projectId: number) =>
  [...fake.tokens.values()].filter((t) => (t as { projectId?: number }).projectId === projectId && !t.revoked);

describe('habilitar / desabilitar', () => {
  it('sem habilitar, nada roda; habilitar guarda QUEM e QUAL token (nunca o valor) e audita', async () => {
    const w = await world();
    fake.requests.length = 0;
    expect(await runVaultAuto()).toEqual({ ran: false, reason: 'DISABLED' });
    expect(fake.requests).toEqual([]);

    const s = await enableVaultAuto(w.ctx);
    expect(s).toMatchObject({ enabled: true, actorUserId: w.admin.id, actorUsername: 'alice' });
    expect(await getAutoSettings()).toMatchObject({ tokenName: 'wizard' });
    const dump = JSON.stringify(await prisma.appSetting.findMany()) + JSON.stringify(await prisma.auditLog.findMany());
    for (const t of fake.tokens.values()) expect(dump).not.toContain(t.token);
    expect(await prisma.auditLog.count({ where: { action: 'VAULT_AUTO_ENABLED' } })).toBe(1);

    await disableVaultAuto(w.ctx);
    expect(await getAutoSettings()).toBeNull();
    expect(await runVaultAuto()).toEqual({ ran: false, reason: 'DISABLED' });
    expect(await prisma.auditLog.count({ where: { action: 'VAULT_AUTO_DISABLED' } })).toBe(1);
    await disableVaultAuto(w.ctx); // idempotente
  });

  it('exige token vinculado com a capability do cofre', async () => {
    const lone = await seedUser('bob', 'admin', { mustChangePassword: false });
    expect(await code(enableVaultAuto(ctxFor(lone)))).toBe('NO_GITLAB_TOKEN');
    const gl = fake.addUser({ username: 'leitor' });
    await addToken(ctxFor(lone), fake.addToken(gl.id, { scopes: ['read_user'] }).token);
    expect(await code(enableVaultAuto(ctxFor(lone)))).toBe('MISSING_CAPABILITY');
    expect(await getAutoSettings()).toBeNull();
  });
});

describe('execução automática', () => {
  it('rotaciona só o que está vencido ou no prazo de alerta; o resto fica intacto', async () => {
    const w = await world();
    await enableVaultAuto(w.ctx);
    const r = await runVaultAuto();
    expect(r.ran).toBe(true);
    if (!r.ran) return;
    expect(r.status).toMatchObject({ candidates: 2, done: 2, failed: 0, partial: 0, problem: null });

    // venc: rotacionado, antigo revogado, variável com o token novo
    const venc = w.vaults.venc!;
    expect(venc.old!.revoked).toBe(true);
    const novo = active(venc.project.id);
    expect(novo).toHaveLength(1);
    expect(fake.variables.get(`${venc.group.id}:DEVOPS_HML`)!.value).toBe(novo[0]!.token);
    // exp: criou token e as variáveis
    expect(active(w.vaults.exp!.project.id).filter((t) => t.expires_at! >= inDays(0))).toHaveLength(1); // o vencido é inerte e fica
    expect(fake.variables.get(`${w.vaults.exp!.group.id}:DEVOPS_HML`)).toBeDefined();
    // ok / semtoken / semvars / multi: nada
    expect(w.vaults.ok!.old!.revoked).toBe(false);
    expect(active(w.vaults.semtoken!.project.id)).toHaveLength(0);
    expect(fake.variables.has(`${w.vaults.semvars!.group.id}:PID_HML`)).toBe(false);
    expect(active(w.vaults.multi!.project.id)).toHaveLength(2);

    // auditoria: quem fez, que foi automático, sem valores
    const rot = await prisma.auditLog.findMany({ where: { action: 'VAULT_TOKEN_ROTATED', result: 'SUCCESS' } });
    expect(rot).toHaveLength(2);
    for (const a of rot) {
      expect(a.actorUsername).toBe('alice');
      expect(a.userAgent).toBe('vault-auto');
      expect((a.metadata as { auto: boolean }).auto).toBe(true);
      expect(a.reason).toMatch(/Rotação automática/);
    }
    const run = await prisma.auditLog.findFirstOrThrow({ where: { action: 'VAULT_AUTO_RUN' } });
    expect(run.result).toBe('SUCCESS');
    const dump =
      JSON.stringify(await prisma.auditLog.findMany()) +
      JSON.stringify(await prisma.adminScan.findMany()) +
      JSON.stringify(await getAutoStatus());
    for (const t of fake.tokens.values()) expect(dump).not.toContain(t.token);
    expect(await getAutoStatus()).toMatchObject({ done: 2 });

    // segunda passada: nada mais a fazer (a concessão foi liberada)
    const again = await runVaultAuto();
    expect(again).toMatchObject({ ran: true, status: { candidates: 0, done: 0 } });
  });

  it('respeita os dias de alerta configurados', async () => {
    const w = await world();
    await updateVaultConfig(w.ctx, { ...(await getVaultConfig()), warnDays: 1 }); // 5 dias já não é "no prazo"
    await enableVaultAuto(w.ctx);
    const r = await runVaultAuto();
    expect(r).toMatchObject({ ran: true, status: { candidates: 1 } }); // só o vencido
    expect(w.vaults.venc!.old!.revoked).toBe(false);
  });

  it('falha ao gravar a variável: conta como falha, antigo intacto, auditoria PARTIAL', async () => {
    const w = await world();
    await enableVaultAuto(w.ctx);
    for (const key of ['venc', 'exp']) void key;
    fake.fault({ match: /^PUT \/groups\/\d+\/variables\/DEVOPS_HML$/, status: 500 });
    const r = await runVaultAuto();
    expect(r).toMatchObject({ ran: true, status: { candidates: 2, failed: 1, done: 1 } });
    const run = await prisma.auditLog.findFirstOrThrow({ where: { action: 'VAULT_AUTO_RUN' } });
    expect(run.result).toBe('PARTIAL');
  });

  it('quem habilitou foi banido: não age e registra o problema', async () => {
    const w = await world();
    await enableVaultAuto(w.ctx);
    await prisma.user.update({ where: { id: w.admin.id }, data: { banned: true } });
    fake.requests.length = 0;
    const r = await runVaultAuto();
    expect(r).toMatchObject({ ran: true, status: { problem: 'ACTOR_UNAVAILABLE', candidates: 0 } });
    expect(fake.requests).toEqual([]);
    expect(await prisma.auditLog.count({ where: { action: 'VAULT_AUTO_RUN', result: 'FAILURE', errorCode: 'ACTOR_UNAVAILABLE' } })).toBe(1);
  });

  it('quem habilitou deixou de ser admin: não age', async () => {
    const w = await world();
    await enableVaultAuto(w.ctx);
    await prisma.user.update({ where: { id: w.admin.id }, data: { role: 'user' } });
    expect(await runVaultAuto()).toMatchObject({ status: { problem: 'ACTOR_UNAVAILABLE' } });
  });

  it('o token usado foi desvinculado: não cai para outro token da conta', async () => {
    const w = await world();
    await addToken(w.ctx, fake.addToken(w.op.id, { scopes: ['api'], name: 'segundo' }).token); // outro token na mesma conta (vira candidato a "padrão")
    await enableVaultAuto(w.ctx);
    const used = (await getAutoSettings())!.tokenId;
    await unlinkToken(w.ctx, used);
    expect((await listTokens(w.admin.id)).length).toBeGreaterThan(0);
    fake.requests.length = 0;
    expect(await runVaultAuto()).toMatchObject({ status: { problem: 'TOKEN_UNAVAILABLE' } });
    expect(fake.requests.filter((q) => q.method !== 'GET')).toEqual([]);
  });

  it('varredura que falha (grupo raiz inexistente) vira problema registrado, sem escrever nada', async () => {
    const w = await world();
    await updateVaultConfig(w.ctx, { ...(await getVaultConfig()), rootGroup: 'nao-existe' });
    await enableVaultAuto(w.ctx);
    fake.requests.length = 0;
    expect(await runVaultAuto()).toMatchObject({ ran: true, status: { problem: 'VAULT_ROOT_NOT_FOUND' } });
    expect(fake.requests.filter((q) => q.method !== 'GET')).toEqual([]);
  });

  it('duas execuções simultâneas: uma roda, a outra recebe BUSY (concessão no banco)', async () => {
    const w = await world();
    await enableVaultAuto(w.ctx);
    const [a, b] = await Promise.all([runVaultAuto(), runVaultAuto()]);
    expect([a, b].filter((r) => r.ran)).toHaveLength(1);
    expect([a, b].find((r) => !r.ran)).toEqual({ ran: false, reason: 'BUSY' });
    expect(active(w.vaults.venc!.project.id)).toHaveLength(1);
  });
});

describe('autoCandidates', () => {
  const item = (o: Partial<VaultItem>) => ({ key: 'k', state: 'EXPIRING', action: 'ROTATE', ...o }) as VaultItem;
  it('só vencido/em alerta com ação, sem bloqueio e sem renovação forçada', () => {
    const list = [
      item({ key: 'a' }),
      item({ key: 'b', state: 'EXPIRED', action: 'CREATE' }),
      item({ key: 'c', state: 'OK' }),
      item({ key: 'd', action: null }),
      item({ key: 'e', blockedReason: 'VAR_SCOPE' }),
      item({ key: 'f', forced: true }),
      item({ key: 'g', state: 'NO_TOKEN', action: 'CREATE' }),
    ];
    expect(autoCandidates(list).map((i) => i.key)).toEqual(['a', 'b']);
  });
});

describe('agendador interno', () => {
  it('0 minutos não agenda nada; >0 agenda uma única vez (idempotente) e dispara a passada', async () => {
    const g = globalThis as { __vaultAutoTimer?: NodeJS.Timeout };
    delete g.__vaultAutoTimer;
    startVaultAutoScheduler(0);
    expect(g.__vaultAutoTimer).toBeUndefined();

    vi.useFakeTimers();
    try {
      startVaultAutoScheduler(1);
      const timer = g.__vaultAutoTimer;
      expect(timer).toBeDefined();
      startVaultAutoScheduler(1);
      expect(g.__vaultAutoTimer).toBe(timer);
      await vi.advanceTimersByTimeAsync(2 * 60_000 + 10); // 1ª passada pós-boot (desabilitada: não faz nada, mas não quebra)
    } finally {
      clearInterval(g.__vaultAutoTimer);
      delete g.__vaultAutoTimer;
      vi.useRealTimers();
    }
  });
});
