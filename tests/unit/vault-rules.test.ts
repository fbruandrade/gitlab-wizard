import { describe, expect, it } from 'vitest';
import { executeVaultSchema, startVaultScanSchema, vaultConfigSchema, VAULT_CONFIRM_WORD } from '@/lib/admin-schemas';
import {
  classifyVault,
  daysUntil,
  isExpired,
  newExpiry,
  nextTokenName,
  parseVaultPath,
  pidVarName,
  tokenVarName,
  validateVaultConfig,
  VAULT_DEFAULTS,
  type ClassifyInput,
  type VaultToken,
} from '@/lib/vault-rules';

const now = new Date('2026-11-16T12:00:00Z');
const day = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString().slice(0, 10);
const tok = (id: number, expiresInDays: number | null, o: Partial<VaultToken> = {}): VaultToken => ({
  id,
  name: 'cofre-hml-20260101',
  scopes: ['read_api'],
  accessLevel: 40,
  createdAt: null,
  expiresAt: expiresInDays === null ? null : day(expiresInDays),
  lastUsedAt: null,
  ...o,
});
const base = (o: Partial<ClassifyInput> = {}): ClassifyInput => ({
  now,
  config: VAULT_DEFAULTS,
  projectId: 10,
  projectPath: 'seguranca-corporativa/hml/areacorp-jks',
  env: 'hml',
  app: 'areacorp-jks',
  tokens: [tok(1, 200)],
  targetGroup: { id: 5, fullPath: 'areacorp-jks' },
  checks: { pid: 'OK', devops: 'OK' },
  ...o,
});

describe('parseVaultPath', () => {
  it('aceita exatamente grupo/ambiente/aplicação (sem diferenciar maiúsculas na raiz)', () => {
    expect(parseVaultPath('seguranca-corporativa/hml/areacorp-jks', 'seguranca-corporativa')).toEqual({ env: 'hml', app: 'areacorp-jks' });
    expect(parseVaultPath('/Seguranca-Corporativa/prd/x/', '/seguranca-corporativa/')).toEqual({ env: 'prd', app: 'x' });
  });
  it.each(['seguranca-corporativa/hml', 'seguranca-corporativa/hml/a/b', 'outro/hml/a', 'seguranca-corporativa//a', ''])(
    'rejeita %j',
    (p) => {
      expect(parseVaultPath(p, 'seguranca-corporativa')).toBeNull();
    },
  );
});

describe('nomes e datas', () => {
  it('variáveis em maiúsculas; hífen vira _', () => {
    expect(pidVarName('hml')).toBe('PID_HML');
    expect(tokenVarName('hml')).toBe('DEVOPS_HML');
    expect(tokenVarName('pre-prod')).toBe('DEVOPS_PRE_PROD');
  });
  it('daysUntil: vence ao fim do dia; sem data/lixo → null', () => {
    expect(daysUntil(day(0), now)).toBe(0);
    expect(daysUntil(day(10), now)).toBe(10);
    expect(daysUntil(day(-1), now)).toBe(-1);
    expect(daysUntil(null, now)).toBeNull();
    expect(daysUntil('lixo', now)).toBeNull();
    expect(isExpired({ expiresAt: day(-1) }, now)).toBe(true);
    expect(isExpired({ expiresAt: day(0) }, now)).toBe(false);
    expect(isExpired({ expiresAt: null }, now)).toBe(false);
  });
  it('newExpiry soma os dias', () => expect(newExpiry(now, 180)).toBe(day(180)));
  it('nextTokenName troca o sufixo de data e usa um padrão quando não há token', () => {
    expect(nextTokenName('cofre-hml-20260101', 'hml', 'x', now)).toBe('cofre-hml-20261116');
    expect(nextTokenName('meu-token', 'hml', 'x', now)).toBe('meu-token-20261116');
    expect(nextTokenName(null, 'hml', 'areacorp-jks', now)).toBe('cofre-hml-areacorp-jks-20261116');
  });
});

describe('classifyVault', () => {
  it('OK: sem ação nem plano', () => {
    const r = classifyVault(base());
    expect(r).toMatchObject({ state: 'OK', action: null, plan: null, key: 'project:10' });
  });
  it('sem token → CREATE com as duas variáveis e o perfil padrão', () => {
    const r = classifyVault(base({ tokens: [], checks: { pid: 'MISSING', devops: 'MISSING' } }));
    expect(r).toMatchObject({ state: 'NO_TOKEN', action: 'CREATE' });
    expect(r.plan).toMatchObject({ scopes: ['read_api'], accessLevel: 40, revokeTokenId: null, expiresAt: day(180) });
    expect(r.plan!.vars).toEqual([
      { key: 'DEVOPS_HML', op: 'CREATE' },
      { key: 'PID_HML', op: 'CREATE' },
    ]);
  });
  it('vencido (por data) é tratado como sem token ativo → CREATE', () => {
    const r = classifyVault(base({ tokens: [tok(1, -5)] }));
    expect(r).toMatchObject({ state: 'EXPIRED', action: 'CREATE' });
    expect(r.plan!.revokeTokenId).toBeNull();
  });
  it('vence dentro do alerta → ROTATE preservando escopos/papel e revogando o antigo', () => {
    const r = classifyVault(base({ tokens: [tok(7, 30, { scopes: ['read_api', 'read_repository'], accessLevel: 30 })] }));
    expect(r).toMatchObject({ state: 'EXPIRING', action: 'ROTATE' });
    expect(r.plan).toMatchObject({ scopes: ['read_api', 'read_repository'], accessLevel: 30, revokeTokenId: 7 });
    expect(r.plan!.vars).toEqual([{ key: 'DEVOPS_HML', op: 'UPDATE' }]);
    expect(classifyVault(base({ tokens: [tok(7, 31)] })).state).toBe('OK'); // 31 dias: fora do alerta
  });
  it('token sem validade nunca "vence"', () => expect(classifyVault(base({ tokens: [tok(1, null)] })).state).toBe('OK'));
  it('mais de um token ativo e grupo ausente nunca geram ação', () => {
    expect(classifyVault(base({ tokens: [tok(1, 100), tok(2, 100)] }))).toMatchObject({
      state: 'MULTIPLE_TOKENS',
      action: null,
      plan: null,
    });
    expect(classifyVault(base({ targetGroup: null, tokens: [] }))).toMatchObject({ state: 'NO_TARGET_GROUP', action: null });
  });
  it('só PID ausente/divergente → WRITE_VARS, sem criar nem revogar token', () => {
    const miss = classifyVault(base({ checks: { pid: 'MISSING', devops: 'OK' } }));
    expect(miss).toMatchObject({ state: 'VARS_MISSING', action: 'WRITE_VARS' });
    expect(miss.plan).toMatchObject({ revokeTokenId: null, vars: [{ key: 'PID_HML', op: 'CREATE' }] });
    const diff = classifyVault(base({ checks: { pid: 'MISMATCH', devops: 'OK' } }));
    expect(diff).toMatchObject({ state: 'OUT_OF_SYNC', action: 'WRITE_VARS' });
    expect(diff.plan!.vars).toEqual([{ key: 'PID_HML', op: 'UPDATE' }]);
  });
  it('DEVOPS ausente/divergente com token válido → ROTATE (o valor atual do token não é recuperável)', () => {
    const miss = classifyVault(base({ checks: { pid: 'OK', devops: 'MISSING' } }));
    expect(miss).toMatchObject({ state: 'VARS_MISSING', action: 'ROTATE' });
    expect(miss.plan!.vars).toEqual([{ key: 'DEVOPS_HML', op: 'CREATE' }]);
    const diff = classifyVault(base({ checks: { pid: 'MISMATCH', devops: 'MISMATCH' } }));
    expect(diff).toMatchObject({ state: 'OUT_OF_SYNC', action: 'ROTATE' });
    expect(diff.plan!.vars.map((v) => v.key)).toEqual(['DEVOPS_HML', 'PID_HML']);
  });
  it('variável ilegível → UNVERIFIED sem ação', () => {
    expect(classifyVault(base({ checks: { pid: 'OK', devops: 'UNVERIFIED' } }))).toMatchObject({ state: 'UNVERIFIED', action: null });
    expect(classifyVault(base({ checks: { pid: 'UNVERIFIED', devops: 'OK' } })).state).toBe('UNVERIFIED');
  });
  it('variável com escopo de ambiente bloqueia a ação', () => {
    const r = classifyVault(base({ tokens: [tok(1, 5)], blockedReason: 'VAR_SCOPE' }));
    expect(r).toMatchObject({ state: 'EXPIRING', action: null, plan: null, blockedReason: 'VAR_SCOPE' });
  });
});

describe('renovação forçada', () => {
  it('cofre OK passa a ter ROTATE (forced) só com force; sem force segue sem ação', () => {
    expect(classifyVault(base()).action).toBeNull();
    const r = classifyVault(base({ force: true, tokens: [tok(7, 200)] }));
    expect(r).toMatchObject({ state: 'OK', action: 'ROTATE', forced: true });
    expect(r.plan).toMatchObject({ revokeTokenId: 7, vars: [{ key: 'DEVOPS_HML', op: 'UPDATE' }] });
  });
  it('também vale para variável não verificável (oculta)', () => {
    expect(classifyVault(base({ force: true, checks: { pid: 'OK', devops: 'UNVERIFIED' } }))).toMatchObject({
      action: 'ROTATE',
      forced: true,
    });
  });
  it('ação que já existia não é marcada como forçada', () => {
    expect(classifyVault(base({ force: true, tokens: [tok(1, 5)] }))).toMatchObject({ action: 'ROTATE' });
    expect(classifyVault(base({ force: true, tokens: [tok(1, 5)] })).forced).toBeUndefined();
  });
  it('não força vários tokens, nem sem grupo de destino, nem sem token, nem variável bloqueada', () => {
    expect(classifyVault(base({ force: true, tokens: [tok(1, 100), tok(2, 100)] })).action).toBeNull();
    expect(classifyVault(base({ force: true, targetGroup: null })).action).toBeNull();
    expect(classifyVault(base({ force: true, tokens: [], checks: { pid: 'OK', devops: 'OK' } })).forced).toBeUndefined();
    expect(classifyVault(base({ force: true, blockedReason: 'VAR_SCOPE' }))).toMatchObject({ action: null, plan: null });
  });
});

describe('configuração e esquemas', () => {
  it('validateVaultConfig', () => {
    expect(validateVaultConfig(VAULT_DEFAULTS)).toBeNull();
    expect(validateVaultConfig({ ...VAULT_DEFAULTS, rootGroup: 'a b' })).toMatch(/raiz/);
    expect(validateVaultConfig({ ...VAULT_DEFAULTS, rootGroup: 'grupo/sub' })).toMatch(/raiz/);
    expect(validateVaultConfig({ ...VAULT_DEFAULTS, warnDays: 0 })).toMatch(/alerta/);
    expect(validateVaultConfig({ ...VAULT_DEFAULTS, lifetimeDays: 366 })).toMatch(/Validade/);
    expect(validateVaultConfig({ ...VAULT_DEFAULTS, scopes: [] })).toMatch(/Escopos/);
    expect(validateVaultConfig({ ...VAULT_DEFAULTS, scopes: ['sudo'] })).toMatch(/Escopos/);
    expect(validateVaultConfig({ ...VAULT_DEFAULTS, accessLevel: 45 })).toMatch(/Papel/);
  });
  it('startVaultScanSchema: force é opcional e booleano', () => {
    expect(startVaultScanSchema.parse({})).toEqual({ force: false });
    expect(startVaultScanSchema.safeParse({ force: 'sim' }).success).toBe(false);
  });
  it('vaultConfigSchema e executeVaultSchema', () => {
    expect(vaultConfigSchema.safeParse(VAULT_DEFAULTS).success).toBe(true);
    expect(vaultConfigSchema.safeParse({ ...VAULT_DEFAULTS, scopes: ['sudo'] }).success).toBe(false);
    expect(vaultConfigSchema.safeParse({ ...VAULT_DEFAULTS, accessLevel: 45 }).success).toBe(false);
    const id = '3f2b8c1e-5a4d-4e6f-8a9b-0c1d2e3f4a5b';
    const good = { scanId: id, keys: ['project:1'], reason: 'CHG0042 - rotação', confirm: VAULT_CONFIRM_WORD };
    expect(executeVaultSchema.safeParse(good).success).toBe(true);
    expect(executeVaultSchema.safeParse({ ...good, confirm: 'ok' }).success).toBe(false);
    expect(executeVaultSchema.safeParse({ ...good, keys: ['PAT:1'] }).success).toBe(false);
    expect(executeVaultSchema.safeParse({ ...good, keys: Array.from({ length: 51 }, (_, i) => `project:${i}`) }).success).toBe(false);
  });
});
