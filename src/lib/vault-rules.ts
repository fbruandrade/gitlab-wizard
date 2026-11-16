// Regras do cofre de tokens de projeto (docs/13). PURO e client-safe: caminho → ambiente/aplicação, estado e ação sugerida.
// Princípio: na dúvida, NÃO age. Mais de um token ativo, grupo de destino incerto ou variável ilegível nunca viram ação automática.

export interface VaultConfig {
  /** Caminho do grupo raiz dos cofres, ex.: `seguranca-corporativa`. */
  rootGroup: string;
  /** Avisar (estado EXPIRING) quando faltar até N dias para vencer. */
  warnDays: number;
  /** Validade dos tokens criados/rotacionados. */
  lifetimeDays: number;
  /** Escopos do token do cofre. */
  scopes: string[];
  /** 10 Guest, 20 Reporter, 30 Developer, 40 Maintainer, 50 Owner. */
  accessLevel: number;
}

export const VAULT_DEFAULTS: VaultConfig = {
  rootGroup: 'seguranca-corporativa',
  warnDays: 30,
  lifetimeDays: 180,
  scopes: ['read_api'],
  accessLevel: 40,
};

export const VAULT_BOUNDS = {
  warnDays: { min: 1, max: 365 },
  // 365 é o teto do GitLab para a vida de um token de acesso.
  lifetimeDays: { min: 1, max: 365 },
} as const;

export const VAULT_SCOPES = ['api', 'read_api', 'read_repository', 'write_repository', 'read_registry', 'write_registry'] as const;
export const ACCESS_LEVELS = { 10: 'Guest', 20: 'Reporter', 30: 'Developer', 40: 'Maintainer', 50: 'Owner' } as const;

export const VAULT_PID_PREFIX = 'PID_';
export const VAULT_TOKEN_PREFIX = 'DEVOPS_';

export type VaultState =
  'OK' | 'NO_TOKEN' | 'EXPIRED' | 'EXPIRING' | 'NO_TARGET_GROUP' | 'VARS_MISSING' | 'OUT_OF_SYNC' | 'UNVERIFIED' | 'MULTIPLE_TOKENS';

export type VaultAction = 'CREATE' | 'ROTATE' | 'WRITE_VARS';
export type VarCheck = 'OK' | 'MISSING' | 'MISMATCH' | 'UNVERIFIED';

export interface VaultToken {
  id: number;
  name: string;
  scopes: string[];
  accessLevel: number | null;
  createdAt: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export interface VaultPlanVar {
  key: string;
  op: 'CREATE' | 'UPDATE';
}

export interface VaultItem {
  key: string; // `project:${id}`
  projectId: number;
  projectPath: string;
  env: string;
  app: string;
  state: VaultState;
  tokens: VaultToken[];
  targetGroup: { id: number; fullPath: string } | null;
  checks: { pid: VarCheck; devops: VarCheck };
  action: VaultAction | null;
  /** Detalhe do que seria feito (dry-run). Nunca contém valores de token. */
  plan: null | {
    tokenName: string;
    scopes: string[];
    accessLevel: number;
    expiresAt: string;
    revokeTokenId: number | null;
    vars: VaultPlanVar[];
  };
  /** A ação existe só porque a renovação foi forçada (o cofre estaria sem ação). */
  forced?: boolean;
  /** Presente = a ação não pode ser aplicada. */
  blockedReason?: 'VAR_SCOPE' | 'VAR_HIDDEN';
}

/** `seguranca-corporativa/hml/areacorp-jks` → { env: 'hml', app: 'areacorp-jks' }. Qualquer outro formato → null. */
export function parseVaultPath(fullPath: string, rootGroup: string): { env: string; app: string } | null {
  const root = rootGroup.replace(/^\/+|\/+$/g, '').toLowerCase();
  const parts = fullPath.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 3 || parts[0]!.toLowerCase() !== root || !parts[1] || !parts[2]) return null;
  return { env: parts[1], app: parts[2] };
}

export const pidVarName = (env: string) => `${VAULT_PID_PREFIX}${env.toUpperCase().replaceAll('-', '_')}`;
export const tokenVarName = (env: string) => `${VAULT_TOKEN_PREFIX}${env.toUpperCase().replaceAll('-', '_')}`;

const DAY = 86_400_000;
export const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** Dias inteiros até a data (UTC). Negativo = já venceu. null = sem validade. */
export function daysUntil(expiresAt: string | null | undefined, now: Date): number | null {
  if (!expiresAt) return null;
  const end = Date.parse(`${expiresAt.slice(0, 10)}T23:59:59Z`);
  if (Number.isNaN(end)) return null;
  return Math.floor((end - now.getTime()) / DAY);
}

export const isExpired = (t: Pick<VaultToken, 'expiresAt'>, now: Date) => {
  const d = daysUntil(t.expiresAt, now);
  return d !== null && d < 0;
};

export const newExpiry = (now: Date, lifetimeDays: number) => isoDate(new Date(now.getTime() + lifetimeDays * DAY));

/** Mantém o nome-base do token atual (sem o sufixo de data anterior) e acrescenta a data de hoje. */
export function nextTokenName(current: string | null, env: string, app: string, now: Date): string {
  const base = current ? current.replace(/-\d{8}$/, '') : `cofre-${env}-${app}`;
  return `${base}-${isoDate(now).replaceAll('-', '')}`.slice(0, 255);
}

export interface ClassifyInput {
  now: Date;
  config: VaultConfig;
  projectId: number;
  projectPath: string;
  env: string;
  app: string;
  /** Tokens ATIVOS devolvidos pelo GitLab. */
  tokens: VaultToken[];
  targetGroup: { id: number; fullPath: string } | null;
  checks: { pid: VarCheck; devops: VarCheck };
  /** Renovação forçada: rotaciona mesmo o cofre que está OK (ex.: suspeita de vazamento). */
  force?: boolean;
  /** Atributos da variável existente que impedem a escrita automática. */
  blockedReason?: VaultItem['blockedReason'];
}

export function classifyVault(i: ClassifyInput): VaultItem {
  const live = i.tokens.filter((t) => !isExpired(t, i.now));
  const all = i.tokens;
  const days = live.length === 1 ? daysUntil(live[0]!.expiresAt, i.now) : null;

  let state: VaultState;
  if (live.length > 1) state = 'MULTIPLE_TOKENS';
  else if (!i.targetGroup) state = 'NO_TARGET_GROUP';
  else if (live.length === 0) state = all.length > 0 ? 'EXPIRED' : 'NO_TOKEN';
  else if (days !== null && days <= i.config.warnDays) state = 'EXPIRING';
  else if (i.checks.pid === 'MISSING' || i.checks.devops === 'MISSING') state = 'VARS_MISSING';
  else if (i.checks.pid === 'MISMATCH' || i.checks.devops === 'MISMATCH') state = 'OUT_OF_SYNC';
  else if (i.checks.devops === 'UNVERIFIED' || i.checks.pid === 'UNVERIFIED') state = 'UNVERIFIED';
  else state = 'OK';

  let action: VaultAction | null = null;
  if (i.targetGroup && live.length <= 1 && !['OK', 'UNVERIFIED'].includes(state)) {
    const needsNewToken = live.length === 0 || state === 'EXPIRING' || i.checks.devops === 'MISSING' || i.checks.devops === 'MISMATCH';
    action = needsNewToken ? (live.length === 1 ? 'ROTATE' : 'CREATE') : 'WRITE_VARS';
  }

  // Forçar: um único token ativo e grupo de destino conhecido. Vários tokens continuam sem ação automática.
  const forced = action === null && Boolean(i.force) && i.targetGroup !== null && live.length === 1;
  if (forced) action = 'ROTATE';

  let plan: VaultItem['plan'] = null;
  if (action) {
    const cur = live[0] ?? null;
    const vars: VaultPlanVar[] = [];
    if (action !== 'WRITE_VARS') vars.push({ key: tokenVarName(i.env), op: i.checks.devops === 'MISSING' ? 'CREATE' : 'UPDATE' });
    if (i.checks.pid !== 'OK') vars.push({ key: pidVarName(i.env), op: i.checks.pid === 'MISSING' ? 'CREATE' : 'UPDATE' });
    plan = {
      tokenName: nextTokenName(cur?.name ?? all[0]?.name ?? null, i.env, i.app, i.now),
      // Rotação preserva o perfil do token atual (escopos/papel); criação usa o padrão configurado.
      scopes: cur ? cur.scopes : i.config.scopes,
      accessLevel: cur?.accessLevel ?? i.config.accessLevel,
      expiresAt: newExpiry(i.now, i.config.lifetimeDays),
      revokeTokenId: action === 'ROTATE' ? cur!.id : null,
      vars,
    };
  }

  return {
    key: `project:${i.projectId}`,
    projectId: i.projectId,
    projectPath: i.projectPath,
    env: i.env,
    app: i.app,
    state,
    tokens: i.tokens,
    targetGroup: i.targetGroup,
    checks: i.checks,
    action: i.blockedReason ? null : action,
    ...(forced && !i.blockedReason && { forced: true }),
    plan: i.blockedReason ? null : plan,
    ...(i.blockedReason && { blockedReason: i.blockedReason }),
  };
}

export const STATE_LABEL: Record<VaultState, string> = {
  OK: 'OK',
  NO_TOKEN: 'Sem token',
  EXPIRED: 'Token vencido',
  EXPIRING: 'Vence em breve',
  NO_TARGET_GROUP: 'Grupo de destino não encontrado',
  VARS_MISSING: 'Variáveis ausentes',
  OUT_OF_SYNC: 'Variáveis fora de sincronia',
  UNVERIFIED: 'Não verificável',
  MULTIPLE_TOKENS: 'Mais de um token ativo',
};
export const ACTION_LABEL: Record<VaultAction, string> = {
  CREATE: 'Criar token e variáveis',
  ROTATE: 'Rotacionar token e atualizar variável',
  WRITE_VARS: 'Gravar variáveis',
};
export const BLOCKED_LABEL = {
  VAR_SCOPE: 'A variável existente tem escopo de ambiente diferente de `*`; ajuste manualmente.',
  VAR_HIDDEN: 'A variável existente é oculta e não pode ser conferida.',
} as const;

export function validateVaultConfig(c: VaultConfig): string | null {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(c.rootGroup)) return 'Grupo raiz inválido (um único nível, ex.: seguranca-corporativa).';
  if (!Number.isInteger(c.warnDays) || c.warnDays < VAULT_BOUNDS.warnDays.min || c.warnDays > VAULT_BOUNDS.warnDays.max)
    return `Dias de alerta: informe de ${VAULT_BOUNDS.warnDays.min} a ${VAULT_BOUNDS.warnDays.max}.`;
  if (!Number.isInteger(c.lifetimeDays) || c.lifetimeDays < VAULT_BOUNDS.lifetimeDays.min || c.lifetimeDays > VAULT_BOUNDS.lifetimeDays.max)
    return `Validade: informe de ${VAULT_BOUNDS.lifetimeDays.min} a ${VAULT_BOUNDS.lifetimeDays.max} dias.`;
  if (c.scopes.length === 0 || c.scopes.some((s) => !(VAULT_SCOPES as readonly string[]).includes(s))) return 'Escopos inválidos.';
  if (!(c.accessLevel in ACCESS_LEVELS)) return 'Papel inválido.';
  return null;
}
