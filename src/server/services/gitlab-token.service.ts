import 'server-only';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@/generated/prisma/client';
import type { GitLabToken } from '@/generated/prisma/client';
import { ActionError } from '@/server/action-result';
import { computeCapabilities, type Capability } from '@/server/auth/capabilities';
import { decryptToken, encryptToken, fingerprint, tokenAad } from '@/server/crypto/token-cipher';
import { prisma } from '@/server/db';
import { env } from '@/server/env';
import { GitLabClient } from '@/server/gitlab/client';
import { GitLabApiError } from '@/server/gitlab/errors';
import { logger } from '@/server/logger';
import { recordAudit, recordAuditSafe, type RequestMeta } from './audit.service';
import { getSettings } from './settings.service';

export interface Ctx {
  actor: { id: string; username?: string | null };
  meta?: RequestMeta;
  /** Token ESCOLHIDO para esta requisição (cookie); ausente/inválido → o padrão da conta. */
  tokenId?: string;
}

const day = 86_400_000;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** Valida a nova data de expiração da rotação: YYYY-MM-DD, depois de hoje e dentro do limite. */
export function validateExpiry(expiresAt: string, maxDays: number = env.TOKEN_MAX_LIFETIME_DAYS, now = new Date()): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) throw new ActionError('INVALID_EXPIRY');
  const d = new Date(`${expiresAt}T00:00:00Z`);
  const today = new Date(`${isoDate(now)}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || isoDate(d) !== expiresAt) throw new ActionError('INVALID_EXPIRY');
  if (d <= today) throw new ActionError('INVALID_EXPIRY', 'A data de expiração deve ser futura.');
  if (d.getTime() - today.getTime() > maxDays * day) {
    throw new ActionError('INVALID_EXPIRY', `A expiração máxima é de ${maxDays} dias.`);
  }
  return expiresAt;
}

/** Tokens ATIVOS da conta: o padrão primeiro; depois do mais novo para o mais antigo. */
export const listTokens = (userId: string) =>
  prisma.gitLabToken.findMany({ where: { userId, status: 'ACTIVE' }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }] });

/** Token padrão da conta (por segurança, se nenhum estiver marcado, o mais novo). */
export const getActiveToken = async (userId: string) => (await listTokens(userId))[0] ?? null;

/**
 * Qual token usar: o escolhido (`tokenId`) SE for desta conta e estiver ativo; senão o padrão.
 * Um `tokenId` de outra conta (cookie forjado/antigo) é simplesmente ignorado.
 */
export async function resolveToken(userId: string, tokenId?: string | null) {
  const all = await listTokens(userId);
  return (tokenId ? all.find((t) => t.id === tokenId) : undefined) ?? all[0] ?? null;
}

/** Token ATIVO que pertence à conta (alvo de rotacionar/substituir/remover/definir padrão/escolher). */
export async function ownActive(userId: string, tokenRowId: string) {
  const row = await prisma.gitLabToken.findFirst({ where: { id: tokenRowId, userId, status: 'ACTIVE' } });
  if (!row) throw new ActionError('TOKEN_NOT_FOUND');
  return row;
}

type Db = Prisma.TransactionClient;

/** Invariante: conta com tokens ativos SEMPRE tem um padrão. Se o padrão saiu, promove o mais novo. */
async function ensureDefault(db: Db, userId: string): Promise<string | null> {
  const active = await db.gitLabToken.findMany({ where: { userId, status: 'ACTIVE' }, orderBy: { createdAt: 'desc' } });
  if (active.length === 0 || active.some((t) => t.isDefault)) return null;
  try {
    await db.gitLabToken.update({ where: { id: active[0]!.id }, data: { isDefault: true } });
    return active[0]!.name;
  } catch (e) {
    if (isUniqueViolation(e)) return null; // outra conta assumiu este usuário GitLab: `resolveToken` ainda cai no mais novo
    throw e;
  }
}

function decryptRow(row: GitLabToken): string {
  if (!row.ciphertext || !row.iv || !row.authTag) throw new ActionError('NO_GITLAB_TOKEN');
  return decryptToken(
    { ciphertext: Buffer.from(row.ciphertext), iv: Buffer.from(row.iv), authTag: Buffer.from(row.authTag), keyVersion: row.keyVersion },
    tokenAad(row.userId, row.id),
  );
}

async function markRevoked(row: GitLabToken, status: 'REVOKED' | 'REVOKED_UNKNOWN', ctx: Ctx, why: string) {
  await prisma.$transaction(async (tx) => {
    const r = await tx.gitLabToken.updateMany({
      where: { id: row.id, status: 'ACTIVE' },
      data: { status, inactivatedAt: new Date(), isDefault: false },
    });
    if (r.count) await ensureDefault(tx, row.userId); // o padrão caiu: outro token ativo assume
  });
  await recordAuditSafe({
    action: 'GITLAB_TOKEN_INVALIDATED',
    result: 'SUCCESS',
    actor: ctx.actor,
    meta: ctx.meta,
    target: { type: 'gitlab_token', id: row.gitlabTokenId, label: row.name },
    metadata: { reason: why },
  });
}

/**
 * Executa `fn` com o PAT decifrado do token em uso (`ctx.tokenId`, senão o padrão). Exige a capability (quando
 * informada) e trata 401/403: 401 marca ESSE token como REVOKED (a sessão e os outros tokens seguem); 403 recalcula
 * as capabilities dele.
 */
export async function withGitLab<T>(
  ctx: Ctx,
  required: Capability | null,
  fn: (client: GitLabClient, row: GitLabToken) => Promise<T>,
): Promise<T> {
  const row = await resolveToken(ctx.actor.id, ctx.tokenId);
  if (!row) throw new ActionError('NO_GITLAB_TOKEN');
  if (required && !row.capabilities.includes(required)) {
    // Ajuda prática: se OUTRO token da conta permite a ação, diz qual.
    const other = (await listTokens(ctx.actor.id)).find((t) => t.id !== row.id && t.capabilities.includes(required));
    throw new ActionError(
      'MISSING_CAPABILITY',
      other
        ? `O token em uso ("${row.name}") não permite esta ação, mas o token "${other.name}" permite. Troque o token em uso no cabeçalho.`
        : undefined,
    );
  }
  const client = new GitLabClient(decryptRow(row));
  try {
    return await fn(client, row);
  } catch (e) {
    if (e instanceof GitLabApiError) {
      if (e.code === 'GITLAB_TOKEN_INVALID') await markRevoked(row, 'REVOKED', ctx, 'gitlab_401');
      if (e.code === 'GITLAB_FORBIDDEN') await refreshCapabilities(row, client).catch(() => undefined);
    }
    throw e;
  }
}

async function refreshCapabilities(row: GitLabToken, client: GitLabClient) {
  const [u, info] = await Promise.all([client.getCurrentUser(), client.getCurrentToken()]);
  await prisma.gitLabToken.update({
    where: { id: row.id },
    data: {
      scopes: info.scopes,
      gitlabIsAdmin: u.is_admin,
      capabilities: computeCapabilities({ isAdmin: u.is_admin, scopes: info.scopes }),
    },
  });
}

/** Valida um PAT no GitLab e devolve o que a ferramenta precisa saber sobre ele. */
async function inspect(token: string) {
  const client = new GitLabClient(token);
  const [user, info] = await Promise.all([client.getCurrentUser(), client.getCurrentToken()]);
  if (info.revoked || !info.active) throw new GitLabApiError('GITLAB_TOKEN_INVALID', 401, 'Token GitLab revogado ou inativo.');
  return { user, info, capabilities: computeCapabilities({ isAdmin: user.is_admin, scopes: info.scopes }) };
}

const toDate = (s?: string | null) => (s ? new Date(`${s.slice(0, 10)}T00:00:00Z`) : null);

function newRow(
  userId: string,
  token: string,
  d: Awaited<ReturnType<typeof inspect>>,
  extra: Partial<Prisma.GitLabTokenUncheckedCreateInput> = {},
) {
  const id = randomUUID();
  const enc = encryptToken(token, tokenAad(userId, id));
  return {
    id,
    userId,
    gitlabBaseUrl: env.GITLAB_BASE_URL,
    gitlabUserId: d.user.id,
    gitlabUsername: d.user.username,
    gitlabIsAdmin: d.user.is_admin,
    gitlabTokenId: d.info.id,
    name: d.info.name,
    scopes: d.info.scopes,
    capabilities: d.capabilities,
    expiresAt: toDate(d.info.expires_at),
    status: 'ACTIVE' as const,
    // Prisma 7 tipa Bytes como Uint8Array<ArrayBuffer> (Buffer pode apontar para SharedArrayBuffer).
    ciphertext: Uint8Array.from(enc.ciphertext),
    iv: Uint8Array.from(enc.iv),
    authTag: Uint8Array.from(enc.authTag),
    keyVersion: enc.keyVersion,
    fingerprint: fingerprint(token),
    ...extra,
  } satisfies Prisma.GitLabTokenUncheckedCreateInput;
}

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

const auditToken = (
  ctx: Ctx,
  action: string,
  result: 'SUCCESS' | 'FAILURE',
  row: { gitlabTokenId: number; name: string },
  extra: { errorCode?: string; metadata?: Prisma.InputJsonObject } = {},
) =>
  recordAudit({
    action,
    result,
    actor: ctx.actor,
    meta: ctx.meta,
    target: { type: 'gitlab_token', id: row.gitlabTokenId, label: row.name },
    ...extra,
  });

/**
 * Adiciona um PAT à conta (a conta pode ter VÁRIOS). O primeiro vira o padrão; os seguintes só se `makeDefault`.
 * Todos os tokens de uma conta precisam ser do MESMO usuário GitLab (a identidade na auditoria fica inequívoca).
 */
export async function addToken(ctx: Ctx, token: string, opts: { makeDefault?: boolean } = {}) {
  const d = await inspect(token);
  const info = { gitlabTokenId: d.info.id, name: d.info.name };
  const fail = async (code: string): Promise<never> => {
    await auditToken(ctx, 'GITLAB_TOKEN_LINKED', 'FAILURE', info, { errorCode: code }).catch(() => undefined);
    throw new ActionError(code);
  };

  const existing = await listTokens(ctx.actor.id);
  if (existing.length && existing[0]!.gitlabUserId !== d.user.id) return fail('GITLAB_USER_MISMATCH');
  if (existing.some((t) => t.gitlabTokenId === d.info.id)) return fail('TOKEN_ALREADY_ADDED');
  const isDefault = existing.length === 0 || Boolean(opts.makeDefault);

  const data = newRow(ctx.actor.id, token, d, { isDefault });
  try {
    await prisma.$transaction(async (tx) => {
      // Ordem importa: solta o padrão atual ANTES de criar o novo (índice único parcial).
      if (isDefault && existing.length)
        await tx.gitLabToken.updateMany({ where: { userId: ctx.actor.id, status: 'ACTIVE', isDefault: true }, data: { isDefault: false } });
      await tx.gitLabToken.create({ data });
    });
  } catch (e) {
    // Índices únicos parciais: o mesmo usuário GitLab (ou o mesmo PAT) já está ativo em outra conta.
    if (isUniqueViolation(e)) return fail('GITLAB_USER_ALREADY_LINKED');
    throw e;
  }
  await auditToken(ctx, 'GITLAB_TOKEN_LINKED', 'SUCCESS', info, {
    metadata: {
      gitlabUserId: d.user.id,
      gitlabUsername: d.user.username,
      scopes: d.info.scopes,
      capabilities: d.capabilities,
      expiresAt: d.info.expires_at ?? null,
      isDefault,
      tokensInAccount: existing.length + 1,
    },
  });
  return {
    tokenId: data.id,
    gitlabUsername: d.user.username,
    capabilities: d.capabilities,
    expiresAt: d.info.expires_at ?? null,
    isDefault,
  };
}

/** Troca o PAT de UM token já cadastrado (ex.: rotacionado fora da ferramenta). Mantém o "padrão". */
export async function replaceToken(ctx: Ctx, tokenRowId: string, token: string) {
  const row = await ownActive(ctx.actor.id, tokenRowId);
  const d = await inspect(token);
  const fail = async (code: string): Promise<never> => {
    await auditToken(ctx, 'GITLAB_TOKEN_REPLACED', 'FAILURE', { gitlabTokenId: d.info.id, name: d.info.name }, { errorCode: code }).catch(
      () => undefined,
    );
    throw new ActionError(code);
  };
  if (d.user.id !== row.gitlabUserId) return fail('GITLAB_USER_MISMATCH');
  if ((await listTokens(ctx.actor.id)).some((t) => t.id !== row.id && t.gitlabTokenId === d.info.id)) return fail('TOKEN_ALREADY_ADDED');

  const data = newRow(ctx.actor.id, token, d, { isDefault: row.isDefault });
  try {
    await prisma.$transaction(async (tx) => {
      await tx.gitLabToken.update({ where: { id: row.id }, data: { status: 'REPLACED', inactivatedAt: new Date(), isDefault: false } });
      await tx.gitLabToken.create({ data });
    });
  } catch (e) {
    if (isUniqueViolation(e)) return fail('GITLAB_USER_ALREADY_LINKED');
    throw e;
  }
  await auditToken(
    ctx,
    'GITLAB_TOKEN_REPLACED',
    'SUCCESS',
    { gitlabTokenId: d.info.id, name: d.info.name },
    {
      metadata: {
        replaced: row.gitlabTokenId,
        gitlabUsername: d.user.username,
        scopes: d.info.scopes,
        capabilities: d.capabilities,
        expiresAt: d.info.expires_at ?? null,
        isDefault: row.isDefault,
      },
    },
  );
  return { tokenId: data.id, gitlabUsername: d.user.username, capabilities: d.capabilities, expiresAt: d.info.expires_at ?? null };
}

/** Remove o token da PLATAFORMA (não o revoga no GitLab). Se era o padrão, o mais novo assume. */
export async function unlinkToken(ctx: Ctx, tokenRowId: string) {
  const row = await ownActive(ctx.actor.id, tokenRowId);
  const promoted = await prisma.$transaction(async (tx) => {
    await tx.gitLabToken.update({ where: { id: row.id }, data: { status: 'REPLACED', inactivatedAt: new Date(), isDefault: false } });
    return row.isDefault ? ensureDefault(tx, ctx.actor.id) : null;
  });
  await auditToken(ctx, 'GITLAB_TOKEN_UNLINKED', 'SUCCESS', row, { metadata: { wasDefault: row.isDefault, newDefault: promoted } });
  return { newDefault: promoted };
}

/** Define qual token é o padrão da conta (o usado quando nenhum outro foi escolhido). */
export async function setDefaultToken(ctx: Ctx, tokenRowId: string) {
  const row = await ownActive(ctx.actor.id, tokenRowId);
  if (row.isDefault) return { changed: false };
  const previous = (await listTokens(ctx.actor.id)).find((t) => t.isDefault);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.gitLabToken.updateMany({ where: { userId: ctx.actor.id, status: 'ACTIVE', isDefault: true }, data: { isDefault: false } });
      await tx.gitLabToken.update({ where: { id: row.id }, data: { isDefault: true } });
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new ActionError('GITLAB_USER_ALREADY_LINKED');
    throw e;
  }
  await auditToken(ctx, 'GITLAB_TOKEN_DEFAULT_CHANGED', 'SUCCESS', row, { metadata: { from: previous?.name ?? null, to: row.name } });
  return { changed: true };
}

export type RotationOutcome =
  | { status: 'ROTATED'; expiresAt: string; token?: string }
  /** O GitLab rotacionou mas não conseguimos gravar: o novo token é exibido uma vez para o usuário vincular. */
  | { status: 'PARTIAL'; expiresAt: string; token: string };

/**
 * Rotação do PAT (docs/02 §3.4). Regras críticas:
 *  - lock de advisory POR TOKEN: duas rotações simultâneas do mesmo token → uma vence, a outra ROTATION_IN_PROGRESS;
 *  - auditoria `ROTATION_STARTED` ANTES de chamar o GitLab (permite reconciliar casos ambíguos);
 *  - o GitLab é chamado UMA vez, sem retry; depois do 200 o token antigo nunca mais é usado;
 *  - se gravar o novo falhar, devolve o token (PARTIAL) em vez de perdê-lo.
 */
export async function rotateToken(ctx: Ctx, expiresAt: string, reveal: boolean, tokenRowId?: string): Promise<RotationOutcome> {
  // Limite editável na interface (Políticas); na ausência, TOKEN_MAX_LIFETIME_DAYS do .env.
  validateExpiry(expiresAt, (await getSettings()).patMaxLifetimeDays);
  // Rotaciona o token indicado (um dos da conta) ou, sem indicação, o que está em uso.
  const row = tokenRowId ? await ownActive(ctx.actor.id, tokenRowId) : await resolveToken(ctx.actor.id, ctx.tokenId);
  if (!row) throw new ActionError('NO_GITLAB_TOKEN');
  if (!row.capabilities.includes('SELF_ROTATE')) throw new ActionError('MISSING_CAPABILITY');
  const oldPlain = decryptRow(row);
  const target = { type: 'gitlab_token' as const, id: row.gitlabTokenId, label: row.name };

  await recordAudit({
    action: 'GITLAB_TOKEN_ROTATION_STARTED',
    result: 'SUCCESS',
    actor: ctx.actor,
    meta: ctx.meta,
    target,
    metadata: { expiresAt },
  });

  let rotated: Awaited<ReturnType<GitLabClient['rotateSelf']>> | undefined;
  const client = new GitLabClient(oldPlain);
  try {
    await prisma.$transaction(
      async (tx) => {
        const lock = await tx.$queryRaw<
          { locked: boolean }[]
        >`SELECT pg_try_advisory_xact_lock(hashtext(${'gw-rotate:' + row.id})) AS locked`;
        if (!lock[0]?.locked) throw new ActionError('ROTATION_IN_PROGRESS');
        const fresh = await tx.gitLabToken.findFirst({ where: { id: row.id, status: 'ACTIVE' } });
        if (!fresh) throw new ActionError('STATE_CHANGED');

        rotated = await client.rotateSelf(expiresAt); // ← o token antigo morre aqui

        await tx.gitLabToken.update({ where: { id: row.id }, data: { status: 'ROTATED', inactivatedAt: new Date(), isDefault: false } });
        const info = { id: rotated.id, name: rotated.name, scopes: rotated.scopes, expires_at: rotated.expires_at };
        await tx.gitLabToken.create({
          data: newRow(
            ctx.actor.id,
            rotated.token,
            {
              user: { id: row.gitlabUserId, username: row.gitlabUsername, name: row.gitlabUsername, is_admin: row.gitlabIsAdmin },
              info: { ...info, active: true, revoked: false },
              capabilities: computeCapabilities({ isAdmin: row.gitlabIsAdmin, scopes: rotated.scopes }),
            },
            { rotatedFromId: row.id, isDefault: row.isDefault }, // o novo token herda o "padrão"
          ),
        });
      },
      { timeout: env.GITLAB_TIMEOUT_MS + 10_000, maxWait: 5_000 },
    );
  } catch (e) {
    // Rotacionou no GitLab mas a gravação falhou: não perder o token.
    if (rotated) {
      logger.error({ userId: ctx.actor.id }, 'rotação concluída no GitLab, mas falhou ao gravar o novo token');
      // O token antigo já morreu no GitLab: não pode continuar ACTIVE aqui (a transação foi revertida).
      await markRevoked(row, 'REVOKED', ctx, 'rotated_but_not_persisted').catch(() => undefined);
      await recordAuditSafe({
        action: 'GITLAB_TOKEN_ROTATED',
        result: 'PARTIAL',
        actor: ctx.actor,
        meta: ctx.meta,
        target,
        errorCode: 'PERSIST_FAILED',
        metadata: { expiresAt: rotated.expires_at ?? expiresAt },
      });
      return { status: 'PARTIAL', expiresAt: rotated.expires_at ?? expiresAt, token: rotated.token };
    }
    if (e instanceof GitLabApiError) return handleRotationFailure(e, row, client, ctx, target);
    await recordAuditSafe({
      action: 'GITLAB_TOKEN_ROTATED',
      result: 'FAILURE',
      actor: ctx.actor,
      meta: ctx.meta,
      target,
      errorCode: (e as { code?: string }).code ?? 'INTERNAL',
    });
    throw e;
  }

  // Verificação com o NOVO token (nunca o antigo). Falha aqui não desfaz nada: só fica registrada.
  let verified = true;
  try {
    await new GitLabClient(rotated!.token).getCurrentToken();
  } catch {
    verified = false;
    logger.warn({ userId: ctx.actor.id }, 'verificação pós-rotação falhou');
  }
  await recordAudit({
    action: 'GITLAB_TOKEN_ROTATED',
    result: 'SUCCESS',
    actor: ctx.actor,
    meta: ctx.meta,
    target,
    metadata: { expiresAt: rotated!.expires_at ?? expiresAt, newGitlabTokenId: rotated!.id, verified },
  });
  return { status: 'ROTATED', expiresAt: rotated!.expires_at ?? expiresAt, ...(reveal && { token: rotated!.token }) };
}

async function handleRotationFailure(
  e: GitLabApiError,
  row: GitLabToken,
  oldClient: GitLabClient,
  ctx: Ctx,
  target: { type: 'gitlab_token'; id: number; label: string },
): Promise<never> {
  if (e.code === 'GITLAB_ROTATION_UNKNOWN') {
    // Resultado ambíguo: UMA consulta com o token antigo, sem retry do rotate (docs/04 §4).
    let stillActive = false;
    try {
      stillActive = (await oldClient.getCurrentToken()).active;
    } catch (probe) {
      if (!(probe instanceof GitLabApiError && probe.code === 'GITLAB_TOKEN_INVALID')) {
        await recordAuditSafe({
          action: 'GITLAB_TOKEN_ROTATED',
          result: 'UNKNOWN',
          actor: ctx.actor,
          meta: ctx.meta,
          target,
          errorCode: e.code,
        });
        throw e;
      }
    }
    if (stillActive) {
      await recordAuditSafe({
        action: 'GITLAB_TOKEN_ROTATED',
        result: 'FAILURE',
        actor: ctx.actor,
        meta: ctx.meta,
        target,
        errorCode: 'GITLAB_UNAVAILABLE',
      });
      throw new GitLabApiError('GITLAB_UNAVAILABLE', null, 'Rotação não ocorreu; tente novamente.');
    }
    await markRevoked(row, 'REVOKED_UNKNOWN', ctx, 'rotation_ambiguous');
    await recordAuditSafe({
      action: 'GITLAB_TOKEN_ROTATED',
      result: 'UNKNOWN',
      actor: ctx.actor,
      meta: ctx.meta,
      target,
      errorCode: e.code,
    });
    throw e;
  }
  if (e.code === 'GITLAB_TOKEN_INVALID') await markRevoked(row, 'REVOKED', ctx, 'gitlab_401');
  await recordAuditSafe({ action: 'GITLAB_TOKEN_ROTATED', result: 'FAILURE', actor: ctx.actor, meta: ctx.meta, target, errorCode: e.code });
  throw e;
}
