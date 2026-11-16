import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { addToken } from '@/server/services/gitlab-token.service';
import { getScan } from '@/server/services/cleanup.service';
import { executeVault, getVaultConfig, startVaultScan, updateVaultConfig } from '@/server/services/vault.service';
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

const why = 'INC0099999 - rotação programada dos cofres';
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? 'THROWN';
  }
  return 'OK';
};
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** Operador (não precisa ser admin do GitLab) + estrutura seguranca-corporativa/{hml,prd}/<app> e grupos raiz das aplicações. */
async function world() {
  const op = fake.addUser({ username: 'operador' });
  const opPat = fake.addToken(op.id, { scopes: ['api'] });
  const admin = await seedUser('alice', 'admin', { mustChangePassword: false });
  const ctx = ctxFor(admin);
  await addToken(ctx, opPat.token);

  const root = fake.addGroup('seguranca-corporativa');
  const hml = fake.addGroup('hml', root.id);
  const prd = fake.addGroup('prd', root.id);
  const appGroup = fake.addGroup('areacorp-jks');
  const vaultHml = fake.addProject(hml.id, 'areacorp-jks');
  const vaultPrd = fake.addProject(prd.id, 'areacorp-jks');
  return { ctx, op, root, hml, prd, appGroup, vaultHml, vaultPrd };
}

async function scan(ctx: ReturnType<typeof ctxFor>) {
  const { scanId } = await startVaultScan(ctx);
  for (let i = 0; i < 100; i++) {
    const s = await getScan(scanId, ctx.actor.id, 'VAULT');
    if (s && s.status !== 'RUNNING') {
      return { scan: s, items: (s.items ?? []) as unknown as VaultItem[] };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('varredura não terminou');
}
const byEnv = (items: VaultItem[], env: string) => items.find((i) => i.env === env)!;

describe('varredura (somente leitura)', () => {
  it('classifica cada cofre e não altera nada no GitLab', async () => {
    const w = await world();
    // hml: token que vence em 10 dias; variáveis corretas e sincronizadas com o token
    const tHml = fake.addProjectToken(w.vaultHml.id, { expires_at: inDays(10) });
    fake.setVariable(w.appGroup.id, 'PID_HML', String(w.vaultHml.id));
    fake.setVariable(w.appGroup.id, 'DEVOPS_HML', tHml.token);
    // prd: sem token
    const { items, scan: s } = await scan(w.ctx);
    expect(s.status).toBe('DONE');
    expect(items).toHaveLength(2);

    const hml = byEnv(items, 'hml');
    expect(hml.state).toBe('EXPIRING');
    expect(hml.action).toBe('ROTATE');
    expect(hml.targetGroup?.fullPath).toBe('areacorp-jks');
    expect(hml.checks).toEqual({ pid: 'OK', devops: 'OK' });
    expect(hml.plan?.revokeTokenId).toBe(tHml.id);
    expect(hml.plan?.scopes).toEqual(['read_api']);
    expect(hml.plan?.vars).toEqual([{ key: 'DEVOPS_HML', op: 'UPDATE' }]);

    const prd = byEnv(items, 'prd');
    expect(prd.state).toBe('NO_TOKEN');
    expect(prd.action).toBe('CREATE');
    expect(prd.plan?.vars).toEqual([
      { key: 'DEVOPS_PRD', op: 'CREATE' },
      { key: 'PID_PRD', op: 'CREATE' },
    ]);

    // dry-run de verdade: nenhuma escrita
    expect(fake.requests.filter((r) => r.method !== 'GET')).toEqual([]);
    expect(JSON.stringify(s.items)).not.toContain(tHml.token);
  });

  it('estados: OK, vencido, fora de sincronia, sem variáveis, grupo ausente, vários tokens, oculta', async () => {
    const w = await world();
    const extra = (env: string, app: string) => fake.addProject(env === 'hml' ? w.hml.id : w.prd.id, app);

    const ok = extra('hml', 'ok');
    const okG = fake.addGroup('ok');
    const okT = fake.addProjectToken(ok.id, { expires_at: inDays(200) });
    fake.setVariable(okG.id, 'PID_HML', String(ok.id));
    fake.setVariable(okG.id, 'DEVOPS_HML', okT.token);

    const expired = extra('hml', 'vencido');
    fake.addGroup('vencido');
    fake.addProjectToken(expired.id, { expires_at: inDays(-3) });

    const drift = extra('hml', 'drift');
    const driftG = fake.addGroup('drift');
    fake.addProjectToken(drift.id, { expires_at: inDays(200) });
    fake.setVariable(driftG.id, 'PID_HML', String(drift.id));
    fake.setVariable(driftG.id, 'DEVOPS_HML', 'glpat-valor-antigo-que-nao-existe');

    const novars = extra('hml', 'novars');
    fake.addGroup('novars');
    fake.addProjectToken(novars.id, { expires_at: inDays(200) });

    extra('hml', 'semgrupo');
    fake.addProjectToken(fake.projects.size + 799, {}); // token em projeto qualquer (ignorado)

    const multi = extra('hml', 'multi');
    fake.addGroup('multi');
    fake.addProjectToken(multi.id, { expires_at: inDays(200) });
    fake.addProjectToken(multi.id, { expires_at: inDays(250) });

    const hid = extra('hml', 'oculta');
    const hidG = fake.addGroup('oculta');
    fake.addProjectToken(hid.id, { expires_at: inDays(200) });
    fake.setVariable(hidG.id, 'PID_HML', String(hid.id));
    fake.setVariable(hidG.id, 'DEVOPS_HML', 'qualquer-valor-oculto', { hidden: true });

    const { items } = await scan(w.ctx);
    const st = (app: string) => items.find((i) => i.app === app)!;
    expect(st('ok').state).toBe('OK');
    expect(st('ok').action).toBeNull();
    expect(st('vencido').state).toBe('EXPIRED');
    expect(st('vencido').action).toBe('CREATE');
    expect(st('drift').state).toBe('OUT_OF_SYNC');
    expect(st('drift').action).toBe('ROTATE');
    expect(st('novars').state).toBe('VARS_MISSING');
    expect(st('semgrupo').state).toBe('NO_TARGET_GROUP');
    expect(st('semgrupo').action).toBeNull();
    expect(st('multi').state).toBe('MULTIPLE_TOKENS');
    expect(st('multi').action).toBeNull();
    expect(st('oculta').state).toBe('UNVERIFIED');
    expect(st('oculta').action).toBeNull();
  });

  it('projeto sem permissão é listado como inacessível e não derruba a varredura', async () => {
    const w = await world();
    fake.denyProjects.add(w.vaultPrd.id);
    const { scan: s, items } = await scan(w.ctx);
    expect(s.status).toBe('DONE');
    expect(items).toHaveLength(1);
    expect((s.summary as { inaccessible: unknown[] }).inaccessible).toEqual([
      { projectPath: 'seguranca-corporativa/prd/areacorp-jks', code: 'GITLAB_FORBIDDEN' },
    ]);
  });

  it('grupo raiz inexistente → varredura FAILED com código claro', async () => {
    const w = await world();
    await updateVaultConfig(w.ctx, { ...(await getVaultConfig()), rootGroup: 'nao-existe' });
    const { scan: s } = await scan(w.ctx);
    expect(s.status).toBe('FAILED');
    expect(s.error).toBe('VAULT_ROOT_NOT_FOUND');
  });

  it('ignora projetos fora do formato grupo/ambiente/aplicação', async () => {
    const w = await world();
    fake.addProject(w.root.id, 'solto'); // direto na raiz: não é subgrupo de ambiente
    const nested = fake.addGroup('extra', w.hml.id);
    fake.addProject(nested.id, 'fundo'); // 4 níveis
    const { items } = await scan(w.ctx);
    expect(items.map((i) => i.projectPath).sort()).toEqual([
      'seguranca-corporativa/hml/areacorp-jks',
      'seguranca-corporativa/prd/areacorp-jks',
    ]);
  });

  it('grupo de destino: só vale caminho exato de grupo raiz (aninhado ou id numérico não é adivinhado)', async () => {
    const w = await world();
    fake.groups.delete(w.appGroup.id);
    const other = fake.addGroup('empresa');
    fake.addGroup('areacorp-jks', other.id); // mesmo nome, mas aninhado: não é o grupo raiz
    // app numérico: o GitLab resolveria "700" como o id do grupo raiz dos cofres
    fake.addProject(w.hml.id, String(w.root.id));
    const { items } = await scan(w.ctx);
    expect(byEnv(items, 'hml').targetGroup).toBeNull();
    expect(items.find((i) => i.app === String(w.root.id))!.targetGroup).toBeNull();
    expect(byEnv(items, 'hml').state).toBe('NO_TARGET_GROUP');
  });

  it('erro inesperado do GitLab (500) falha a varredura em vez de esconder cofres', async () => {
    const w = await world();
    for (let i = 0; i < 6; i++) fake.fault({ match: /^GET \/projects\/\d+\/access_tokens$/, status: 500 });
    const { scan: s } = await scan(w.ctx);
    expect(s).toMatchObject({ status: 'FAILED', error: 'GITLAB_UNAVAILABLE' });
  });

  it('inspectProject ignora projeto fora do formato', async () => {
    const w = await world();
    const { GitLabClient } = await import('@/server/gitlab/client');
    const { inspectProject } = await import('@/server/services/vault.service');
    const c = new GitLabClient(fake.tokens.values().next().value!.token);
    expect(await inspectProject(c, { id: 1, path_with_namespace: 'x/y/z' }, await getVaultConfig(), new Map())).toBeNull();
    void w;
  });

  it('sem a capability (token sem scope api) → MISSING_CAPABILITY', async () => {
    const w = await world();
    await prisma.gitLabToken.updateMany({ data: { capabilities: [] } });
    expect(await code(startVaultScan(w.ctx).then(async (r) => (await getScan(r.scanId, w.ctx.actor.id, 'VAULT'))?.status))).toBe('OK'); // a varredura nasce RUNNING e falha em segundo plano
    const { scan: s } = await scan(w.ctx);
    expect(s.status).toBe('FAILED');
    expect(s.error).toBe('MISSING_CAPABILITY');
  });
});

describe('execução', () => {
  async function ready(opts: { prd?: boolean } = {}) {
    const w = await world();
    const old = fake.addProjectToken(w.vaultHml.id, { name: 'cofre-hml-20260101', expires_at: inDays(5), scopes: ['read_api'] });
    fake.setVariable(w.appGroup.id, 'PID_HML', String(w.vaultHml.id), { protected: true });
    fake.setVariable(w.appGroup.id, 'DEVOPS_HML', old.token, { protected: true });
    const { scan: s, items } = await scan(w.ctx);
    return { ...w, old, scanId: s.id, items, hml: byEnv(items, 'hml'), prd: opts.prd ? byEnv(items, 'prd') : undefined };
  }
  const devops = (w: { appGroup: { id: number } }, env = 'HML') => fake.variables.get(`${w.appGroup.id}:DEVOPS_${env}`)!;
  const activeTokens = (projectId: number) =>
    [...fake.tokens.values()].filter((t) => (t as { projectId?: number }).projectId === projectId && !t.revoked);

  it('rotaciona: cria → grava → valida → revoga o antigo; preserva protected/masked e perfil do token', async () => {
    const w = await ready();
    const r = await executeVault(w.ctx, { scanId: w.scanId, keys: [w.hml.key], reason: why });
    expect(r).toMatchObject({ done: 1, partial: 0, failed: 0 });

    const act = activeTokens(w.vaultHml.id);
    expect(act).toHaveLength(1);
    expect(act[0]!.id).not.toBe(w.old.id);
    expect(w.old.revoked).toBe(true);
    expect(act[0]!.name).toMatch(/^cofre-hml-\d{8}$/);
    expect(act[0]!.scopes).toEqual(['read_api']);

    const v = devops(w);
    expect(v.value).toBe(act[0]!.token); // a esteira passa a ler o token novo
    expect(v.protected).toBe(true); // atributo existente preservado
    expect(v.masked).toBe(true);

    // ordem: o antigo só é revogado DEPOIS de gravar a variável
    const log = fake.requests.filter((q) => q.method !== 'GET').map((q) => `${q.method} ${q.path.replace(/\d+/g, 'N')}`);
    expect(log).toEqual(['POST /projects/N/access_tokens', 'PUT /groups/N/variables/DEVOPS_HML', 'DELETE /projects/N/access_tokens/N']);
  });

  it('o valor do token nunca aparece na auditoria nem na varredura', async () => {
    const w = await ready();
    await executeVault(w.ctx, { scanId: w.scanId, keys: [w.hml.key], reason: why });
    const dump = JSON.stringify(await prisma.auditLog.findMany()) + JSON.stringify(await prisma.adminScan.findMany());
    for (const t of fake.tokens.values()) expect(dump).not.toContain(t.token);
    const actions = (await prisma.auditLog.findMany({ select: { action: true } })).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(['VAULT_SCANNED', 'VAULT_TOKEN_CREATED', 'VAULT_VARIABLE_WRITTEN', 'VAULT_TOKEN_ROTATED', 'VAULT_EXECUTED']),
    );
  });

  it('cria o token e as duas variáveis quando o cofre não tem token (nova variável nasce mascarada, sem protected)', async () => {
    const w = await ready({ prd: true });
    const r = await executeVault(w.ctx, { scanId: w.scanId, keys: [w.prd!.key], reason: why });
    expect(r.done).toBe(1);
    const t = activeTokens(w.vaultPrd.id);
    expect(t).toHaveLength(1);
    expect(t[0]!.scopes).toEqual(['read_api']);
    expect(devops(w, 'PRD').value).toBe(t[0]!.token);
    expect(devops(w, 'PRD')).toMatchObject({ masked: true, protected: false });
    expect(fake.variables.get(`${w.appGroup.id}:PID_PRD`)!.value).toBe(String(w.vaultPrd.id));
  });

  it('falha ao gravar a variável: o token novo é descartado e o antigo segue valendo', async () => {
    const w = await ready();
    fake.fault({ match: /^PUT \/groups\/\d+\/variables\/DEVOPS_HML$/, status: 500 });
    const r = await executeVault(w.ctx, { scanId: w.scanId, keys: [w.hml.key], reason: why });
    expect(r).toMatchObject({ done: 0, failed: 1 });
    expect(w.old.revoked).toBe(false);
    expect(devops(w).value).toBe(w.old.token);
    expect(activeTokens(w.vaultHml.id).map((t) => t.id)).toEqual([w.old.id]);
  });

  it('resposta perdida mas escrita aplicada: segue em frente e conclui a rotação', async () => {
    const w = await ready();
    fake.fault({ match: /^PUT \/groups\/\d+\/variables\/DEVOPS_HML$/, applyThenReset: true });
    const r = await executeVault(w.ctx, { scanId: w.scanId, keys: [w.hml.key], reason: why });
    expect(r).toMatchObject({ done: 1, failed: 0 });
    expect(w.old.revoked).toBe(true);
    expect(devops(w).value).toBe(activeTokens(w.vaultHml.id)[0]!.token);
  });

  it('não consegue nem reler a variável: não revoga nada e pede conferência (NEEDS_ATTENTION)', async () => {
    const w = await ready();
    // GET com retry (3 tentativas): a leitura de dentro do writeVar e a releitura de conferência falham (a reinspeção passa: skip 1)
    for (let i = 0; i < 6; i++) fake.fault({ match: /^GET \/groups\/\d+\/variables\/DEVOPS_HML$/, status: 500, skip: i === 0 ? 1 : 0 });
    const r = await executeVault(w.ctx, { scanId: w.scanId, keys: [w.hml.key], reason: why });
    expect(r.results[0]).toMatchObject({ status: 'FAILED', code: 'NEEDS_ATTENTION' });
    expect(w.old.revoked).toBe(false);
    expect(activeTokens(w.vaultHml.id)).toHaveLength(2); // o novo fica ativo para conferência
  });

  it('não consegue revogar o antigo: resultado parcial, o novo já está em uso', async () => {
    const w = await ready();
    fake.fault({ match: /^DELETE \/projects\/\d+\/access_tokens\/\d+$/, status: 500 });
    const r = await executeVault(w.ctx, { scanId: w.scanId, keys: [w.hml.key], reason: why });
    expect(r).toMatchObject({ done: 0, partial: 1 });
    expect(r.results[0]!.code).toBe('OLD_NOT_REVOKED');
    expect(devops(w).value).toBe(activeTokens(w.vaultHml.id).find((t) => t.id !== w.old.id)!.token);
  });

  it('reavalia antes de aplicar: se mudou desde o dry-run, ignora', async () => {
    const w = await ready();
    // alguém rotacionou à mão entre a varredura e a execução
    w.old.revoked = true;
    const manual = fake.addProjectToken(w.vaultHml.id, { expires_at: inDays(300) });
    fake.setVariable(w.appGroup.id, 'DEVOPS_HML', manual.token, { protected: true });
    const r = await executeVault(w.ctx, { scanId: w.scanId, keys: [w.hml.key], reason: why });
    expect(r).toMatchObject({ done: 0, skipped: 1 });
    expect(r.results[0]!.code).toBe('CHANGED');
    expect(fake.requests.filter((q) => q.method === 'POST')).toEqual([]);
  });

  it('só PID_ ausente: grava a variável sem tocar nos tokens', async () => {
    const w = await world();
    const t = fake.addProjectToken(w.vaultHml.id, { expires_at: inDays(300) });
    fake.setVariable(w.appGroup.id, 'DEVOPS_HML', t.token);
    const { scan: s, items } = await scan(w.ctx);
    const it = byEnv(items, 'hml');
    expect(it).toMatchObject({ state: 'VARS_MISSING', action: 'WRITE_VARS' });
    const r = await executeVault(w.ctx, { scanId: s.id, keys: [it.key], reason: why });
    expect(r.done).toBe(1);
    expect(fake.variables.get(`${w.appGroup.id}:PID_HML`)!.value).toBe(String(w.vaultHml.id));
    expect(t.revoked).toBe(false);
    expect(fake.requests.some((q) => q.method === 'POST' && q.path.includes('access_tokens'))).toBe(false);
  });

  it('variável com escopo de ambiente diferente de * bloqueia a ação', async () => {
    const w = await world();
    fake.addProjectToken(w.vaultHml.id, { expires_at: inDays(5) });
    fake.setVariable(w.appGroup.id, 'DEVOPS_HML', 'x'.repeat(20), { environment_scope: 'prod/*' });
    const { items } = await scan(w.ctx);
    const it = byEnv(items, 'hml');
    expect(it.blockedReason).toBe('VAR_SCOPE');
    expect(it.action).toBeNull();
  });

  it('falha ao criar o token: nada é gravado nem revogado', async () => {
    const w = await ready();
    fake.fault({ match: /^POST \/projects\/\d+\/access_tokens$/, status: 500 });
    const r = await executeVault(w.ctx, { scanId: w.scanId, keys: [w.hml.key], reason: why });
    expect(r).toMatchObject({ failed: 1 });
    expect(w.old.revoked).toBe(false);
    expect(devops(w).value).toBe(w.old.token);
  });

  it('falha ao gravar PID_: aborta antes de criar qualquer token', async () => {
    const w = await ready({ prd: true });
    fake.fault({ match: /^POST \/groups\/\d+\/variables$/, status: 500 });
    const r = await executeVault(w.ctx, { scanId: w.scanId, keys: [w.prd!.key], reason: why });
    expect(r.results[0]).toMatchObject({ status: 'FAILED', code: 'GITLAB_UNAVAILABLE' });
    expect(activeTokens(w.vaultPrd.id)).toHaveLength(0);
  });

  it('não grava a variável e também não consegue descartar o token novo: falha, antigo intacto', async () => {
    const w = await ready();
    fake.fault({ match: /^PUT \/groups\/\d+\/variables\/DEVOPS_HML$/, status: 500 });
    fake.fault({ match: /^DELETE \/projects\/\d+\/access_tokens\/\d+$/, status: 500 });
    const r = await executeVault(w.ctx, { scanId: w.scanId, keys: [w.hml.key], reason: why });
    expect(r.results[0]!.status).toBe('FAILED');
    expect(w.old.revoked).toBe(false);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'VAULT_VARIABLE_WRITTEN', result: 'FAILURE' } });
    expect((audit.metadata as { newTokenRevoked: boolean }).newTokenRevoked).toBe(false);
  });

  it('validação do token novo falha: mantém o antigo (PARTIAL/VERIFY_FAILED)', async () => {
    const w = await ready();
    // a 1ª chamada a /personal_access_tokens/self é a da reinspeção (passa); as seguintes (validação) falham
    for (let i = 0; i < 3; i++) fake.fault({ match: /^GET \/personal_access_tokens\/self$/, status: 500, skip: i === 0 ? 1 : 0 });
    const r = await executeVault(w.ctx, { scanId: w.scanId, keys: [w.hml.key], reason: why });
    expect(r.results[0]).toMatchObject({ status: 'PARTIAL', code: 'VERIFY_FAILED' });
    expect(w.old.revoked).toBe(false);
  });

  it('duas execuções simultâneas do mesmo cofre: só uma aplica', async () => {
    const w = await ready();
    const [a, b] = await Promise.all([
      executeVault(w.ctx, { scanId: w.scanId, keys: [w.hml.key], reason: why }),
      executeVault(w.ctx, { scanId: w.scanId, keys: [w.hml.key], reason: why }),
    ]);
    expect([a.results[0]!.status, b.results[0]!.status].sort()).toEqual(['DONE', 'SKIPPED']);
    expect([a, b].flatMap((r) => r.results).find((r) => r.status === 'SKIPPED')!.code).toBe('IN_PROGRESS');
    expect(activeTokens(w.vaultHml.id)).toHaveLength(1);
  });

  it('PAT do operador revogado no meio: a execução para e marca o token como inválido', async () => {
    const w = await ready();
    fake.tokens.forEach((t) => {
      if (t.userId === w.op.id) t.revoked = true;
    });
    expect(await code(executeVault(w.ctx, { scanId: w.scanId, keys: [w.hml.key], reason: why }))).toBe('GITLAB_TOKEN_INVALID');
    expect(w.old.revoked).toBe(false);
  });

  it('varredura que falhou não pode ser executada (SCAN_NOT_READY)', async () => {
    const w = await world();
    await updateVaultConfig(w.ctx, { ...(await getVaultConfig()), rootGroup: 'nao-existe' });
    const { scan: s } = await scan(w.ctx);
    expect(await code(executeVault(w.ctx, { scanId: s.id, keys: ['project:1'], reason: why }))).toBe('SCAN_NOT_READY');
  });

  it('validações: item sem ação, fora da varredura, varredura inexistente, demais de 50', async () => {
    const w = await ready();
    expect(await code(executeVault(w.ctx, { scanId: w.scanId, keys: ['project:1'], reason: why }))).toBe('ITEMS_NOT_IN_SCAN');
    expect(await code(executeVault(w.ctx, { scanId: w.scanId, keys: [], reason: why }))).toBe('ITEMS_NOT_IN_SCAN');
    expect(await code(executeVault(w.ctx, { scanId: crypto.randomUUID(), keys: [w.hml.key], reason: why }))).toBe('SCAN_NOT_FOUND');
    expect(
      await code(executeVault(w.ctx, { scanId: w.scanId, keys: Array.from({ length: 51 }, (_, i) => `project:${i}`), reason: why })),
    ).toBe('TOO_MANY_ITEMS');
    await prisma.adminScan.update({ where: { id: w.scanId }, data: { finishedAt: new Date(Date.now() - 7 * 3_600_000) } });
    expect(await code(executeVault(w.ctx, { scanId: w.scanId, keys: [w.hml.key], reason: why }))).toBe('SCAN_STALE');
  });

  it('a varredura de outro admin não pode ser executada', async () => {
    const w = await ready();
    const bob = await seedUser('bob', 'admin', { mustChangePassword: false });
    expect(await code(executeVault(ctxFor(bob), { scanId: w.scanId, keys: [w.hml.key], reason: why }))).toBe('SCAN_NOT_FOUND');
  });
});

describe('renovação forçada', () => {
  async function okWorld() {
    const w = await world();
    const old = fake.addProjectToken(w.vaultHml.id, { name: 'cofre-hml-20260101', expires_at: inDays(300) });
    fake.setVariable(w.appGroup.id, 'PID_HML', String(w.vaultHml.id));
    fake.setVariable(w.appGroup.id, 'DEVOPS_HML', old.token);
    return { ...w, old };
  }
  const forcedScan = async (ctx: ReturnType<typeof ctxFor>) => {
    const { scanId } = await startVaultScan(ctx, { force: true });
    for (let i = 0; i < 100; i++) {
      const s = await getScan(scanId, ctx.actor.id, 'VAULT');
      if (s && s.status !== 'RUNNING') return { scan: s, items: (s.items ?? []) as unknown as VaultItem[] };
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('varredura não terminou');
  };

  it('sem forçar, cofre saudável não tem ação; forçando, entra no plano marcado como forçado (e continua OK)', async () => {
    const w = await okWorld();
    expect(byEnv((await scan(w.ctx)).items, 'hml').action).toBeNull();
    const it = byEnv((await forcedScan(w.ctx)).items, 'hml');
    expect(it).toMatchObject({ state: 'OK', action: 'ROTATE', forced: true });
    expect(it.plan?.revokeTokenId).toBe(w.old.id);
    expect(fake.requests.filter((r) => r.method !== 'GET')).toEqual([]); // ainda é dry-run
  });

  it('aplica a renovação forçada: token novo gravado, antigo revogado e auditoria marca forced', async () => {
    const w = await okWorld();
    const { scan: s, items } = await forcedScan(w.ctx);
    const r = await executeVault(w.ctx, { scanId: s.id, keys: [byEnv(items, 'hml').key], reason: why });
    expect(r).toMatchObject({ done: 1, failed: 0 });
    expect(w.old.revoked).toBe(true);
    const novo = [...fake.tokens.values()].find((t) => (t as { projectId?: number }).projectId === w.vaultHml.id && !t.revoked)!;
    expect(fake.variables.get(`${w.appGroup.id}:DEVOPS_HML`)!.value).toBe(novo.token);
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: 'VAULT_TOKEN_ROTATED', result: 'SUCCESS' } });
    expect((a.metadata as { forced: boolean }).forced).toBe(true);
  });

  it('cofre com mais de um token ativo não é forçado', async () => {
    const w = await okWorld();
    fake.addProjectToken(w.vaultHml.id, { expires_at: inDays(300) });
    expect(byEnv((await forcedScan(w.ctx)).items, 'hml')).toMatchObject({ state: 'MULTIPLE_TOKENS', action: null });
  });
});

describe('configuração', () => {
  it('padrão, salvar, auditar e rejeitar valores inválidos', async () => {
    const w = await world();
    expect(await getVaultConfig()).toMatchObject({ rootGroup: 'seguranca-corporativa', warnDays: 30, lifetimeDays: 180, accessLevel: 40 });
    await updateVaultConfig(w.ctx, {
      rootGroup: 'cofres',
      warnDays: 15,
      lifetimeDays: 90,
      scopes: ['read_api', 'read_repository'],
      accessLevel: 30,
    });
    expect(await getVaultConfig()).toMatchObject({ rootGroup: 'cofres', warnDays: 15, lifetimeDays: 90, accessLevel: 30 });
    expect(await prisma.auditLog.count({ where: { action: 'SETTINGS_CHANGED' } })).toBe(1);
    expect(await code(updateVaultConfig(w.ctx, { ...(await getVaultConfig()), lifetimeDays: 999 }))).toBe('INVALID_SETTING');
    expect(await code(updateVaultConfig(w.ctx, { ...(await getVaultConfig()), scopes: [] }))).toBe('INVALID_SETTING');
    // valor corrompido no banco → volta ao padrão em vez de quebrar
    await prisma.appSetting.update({ where: { key: 'vault.config' }, data: { value: { warnDays: -5 } } });
    expect((await getVaultConfig()).warnDays).toBe(30);
  });
});
