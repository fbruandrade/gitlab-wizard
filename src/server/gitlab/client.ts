import 'server-only';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { z } from 'zod';
import { env } from '@/server/env';
import { logger } from '@/server/logger';
import { GitLabApiError } from './errors';
import {
  accessTokenSchema,
  createdRunnerSchema,
  runnerSchema,
  targetSchema,
  appSettingsSchema,
  createdAccessTokenSchema,
  groupSchema,
  projectSchema,
  variableSchema,
  currentUserSchema,
  licenseSchema,
  patListItemSchema,
  sshKeySchema,
  gitlabUserSchema,
  rotatedTokenSchema,
  tokenInfoSchema,
  versionSchema,
  type GitLabAccessToken,
  type GitLabCreatedRunner,
  type GitLabRunner,
  type GitLabTarget,
  type GitLabCreatedAccessToken,
  type GitLabCurrentUser,
  type GitLabGroup,
  type GitLabProject,
  type GitLabVariable,
  type GitLabPat,
  type GitLabSshKey,
  type GitLabLicense,
  type GitLabRotatedToken,
  type GitLabTokenInfo,
  type GitLabUser,
  type Paginated,
} from './schemas';

export interface GitLabClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /** Ignora a verificação TLS. Padrão: env.GITLAB_TLS_INSECURE. */
  insecureTls?: boolean;
}

let insecureAgent: Agent | undefined;
let warned = false;

/** Dispatcher só para o GitLab: o resto do processo (better-auth, Prisma) continua verificando TLS. */
function dispatcherFor(insecure: boolean): Dispatcher | undefined {
  if (!insecure) return undefined;
  if (!warned) {
    warned = true;
    logger.warn('GITLAB_TLS_INSECURE=true: o certificado TLS do GitLab NÃO está sendo verificado');
  }
  return (insecureAgent ??= new Agent({ connect: { rejectUnauthorized: false } }));
}

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function causeCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.cause?.code ?? e?.code;
}

export interface VariableWrite {
  key: string;
  value: string;
  masked: boolean;
  protected: boolean;
  environmentScope: string;
}
const variableBody = (v: VariableWrite, withKey: boolean) => ({
  ...(withKey && { key: v.key }),
  value: v.value,
  masked: v.masked,
  protected: v.protected,
  environment_scope: v.environmentScope,
});

export class GitLabClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly insecure: boolean;

  /** O token fica só em memória, durante a requisição. */
  constructor(
    private readonly token: string,
    opts: GitLabClientOptions = {},
  ) {
    this.baseUrl = (opts.baseUrl ?? env.GITLAB_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? env.GITLAB_TIMEOUT_MS;
    this.insecure = opts.insecureTls ?? env.GITLAB_TLS_INSECURE;
  }

  // ── identidade ─────────────────────────────────────────────────────────────
  getCurrentUser(): Promise<GitLabCurrentUser> {
    return this.get('/user', currentUserSchema);
  }
  getCurrentToken(): Promise<GitLabTokenInfo> {
    return this.get('/personal_access_tokens/self', tokenInfoSchema);
  }
  async getVersion(): Promise<string> {
    return (await this.get('/version', versionSchema)).version;
  }

  /** Licença da instância (admin). Sem licença/edição Community, o GitLab pode responder 404. */
  getLicense(): Promise<GitLabLicense> {
    return this.get('/license', licenseSchema);
  }

  // ── usuários ───────────────────────────────────────────────────────────────
  async searchUsers(p: { search?: string; blocked?: boolean; page?: number; perPage?: number }): Promise<Paginated<GitLabUser>> {
    const q = new URLSearchParams({ per_page: String(p.perPage ?? 20), page: String(p.page ?? 1) });
    if (p.search) q.set('search', p.search);
    if (p.blocked) q.set('blocked', 'true');
    const { json, headers } = await this.request('GET', `/users?${q}`, { retry: true });
    const items = this.parse(json, gitlabUserSchema.array());
    const num = (h: string) => (headers.get(h) ? Number(headers.get(h)) : null);
    return { items, page: p.page ?? 1, nextPage: num('x-next-page') || null, totalPages: num('x-total-pages') };
  }
  getUser(id: number): Promise<GitLabUser> {
    return this.get(`/users/${id}`, gitlabUserSchema);
  }
  /** Sem retry em escritas: a operação não é idempotente do ponto de vista da auditoria. */
  async blockUser(id: number): Promise<void> {
    await this.request('POST', `/users/${id}/block`);
  }
  async unblockUser(id: number): Promise<void> {
    await this.request('POST', `/users/${id}/unblock`);
  }
  async disableTwoFactor(id: number): Promise<void> {
    await this.request('PATCH', `/users/${id}/disable_two_factor`);
  }

  /** Todos os usuários (paginado). `blocked` filtra os bloqueados. Cuidado: pode ser grande em instâncias grandes. */
  listAllUsers(opts: { blocked?: boolean } = {}, onPage?: (total: number) => void): Promise<GitLabUser[]> {
    return this.listAll('/users', gitlabUserSchema, opts.blocked ? { blocked: 'true' } : {}, onPage);
  }

  // ── credenciais de outros usuários (admin) ──
  /** PATs ativos da instância (ou de um usuário). */
  listActivePersonalAccessTokens(userId?: number): Promise<GitLabPat[]> {
    return this.listAll('/personal_access_tokens', patListItemSchema, { state: 'active', ...(userId && { user_id: String(userId) }) });
  }
  /** Sem retry: revogar é uma escrita. */
  async revokePersonalAccessToken(id: number): Promise<void> {
    await this.request('DELETE', `/personal_access_tokens/${id}`);
  }
  listUserSshKeys(userId: number): Promise<GitLabSshKey[]> {
    return this.listAll(`/users/${userId}/keys`, sshKeySchema);
  }
  async deleteUserSshKey(userId: number, keyId: number): Promise<void> {
    await this.request('DELETE', `/users/${userId}/keys/${keyId}`);
  }

  // ── cofre de tokens de projeto ──
  /** Grupo por id ou caminho completo. 404 → null (para distinguir "não existe" de erro). */
  async findGroup(idOrPath: string | number): Promise<GitLabGroup | null> {
    try {
      return await this.get(`/groups/${encodeURIComponent(String(idOrPath))}`, groupSchema);
    } catch (e) {
      if (e instanceof GitLabApiError && e.code === 'GITLAB_NOT_FOUND') return null;
      throw e;
    }
  }
  listSubgroups(groupId: number): Promise<GitLabGroup[]> {
    return this.listAll(`/groups/${groupId}/subgroups`, groupSchema);
  }
  /** Só os projetos diretos do grupo (sem descer em subgrupos). */
  listGroupProjects(groupId: number): Promise<GitLabProject[]> {
    return this.listAll(`/groups/${groupId}/projects`, projectSchema, { include_subgroups: 'false', archived: 'false' });
  }
  listProjectAccessTokens(projectId: number): Promise<GitLabAccessToken[]> {
    return this.listAll(`/projects/${projectId}/access_tokens`, accessTokenSchema, { state: 'active' });
  }
  /** Sem retry: criar é uma escrita, e o valor do token só é devolvido nesta resposta. */
  async createProjectAccessToken(
    projectId: number,
    b: { name: string; scopes: string[]; accessLevel: number; expiresAt: string },
  ): Promise<GitLabCreatedAccessToken> {
    const { json } = await this.request('POST', `/projects/${projectId}/access_tokens`, {
      body: { name: b.name, scopes: b.scopes, access_level: b.accessLevel, expires_at: b.expiresAt },
    });
    return this.parse(json, createdAccessTokenSchema);
  }
  async revokeProjectAccessToken(projectId: number, tokenId: number): Promise<void> {
    await this.request('DELETE', `/projects/${projectId}/access_tokens/${tokenId}`);
  }
  /** Variável de grupo; 404 → null. */
  async getGroupVariable(groupId: number, key: string): Promise<GitLabVariable | null> {
    try {
      return await this.get(`/groups/${groupId}/variables/${encodeURIComponent(key)}`, variableSchema);
    } catch (e) {
      if (e instanceof GitLabApiError && e.code === 'GITLAB_NOT_FOUND') return null;
      throw e;
    }
  }
  async createGroupVariable(groupId: number, v: VariableWrite): Promise<void> {
    await this.request('POST', `/groups/${groupId}/variables`, { body: variableBody(v, true) });
  }
  async updateGroupVariable(groupId: number, v: VariableWrite): Promise<void> {
    await this.request('PUT', `/groups/${groupId}/variables/${encodeURIComponent(v.key)}`, { body: variableBody(v, false) });
  }

  // ── runners ──
  /** Grupos/projetos em que o usuário é Owner (única role que cria runner de grupo/projeto). */
  async searchRunnerTargets(kind: 'group' | 'project', q: string): Promise<GitLabTarget[]> {
    const params = new URLSearchParams({ per_page: '20', min_access_level: '50', ...(q && { search: q }) });
    if (kind === 'project') params.set('membership', 'true');
    const { json } = await this.request('GET', `/${kind === 'group' ? 'groups' : 'projects'}?${params}`, { retry: true });
    return this.parse(json, targetSchema.array());
  }
  /** Runners de um escopo. Instância exige admin. */
  listRunners(
    scope: { type: 'instance_type' } | { type: 'group_type'; id: number } | { type: 'project_type'; id: number },
  ): Promise<GitLabRunner[]> {
    const path =
      scope.type === 'instance_type'
        ? '/runners/all'
        : scope.type === 'group_type'
          ? `/groups/${scope.id}/runners`
          : `/projects/${scope.id}/runners`;
    return this.listAll(path, runnerSchema, { type: scope.type });
  }
  /** Sem retry: criar é escrita e o token só volta nesta resposta. Timeout = o runner pode ter sido criado (confira a lista). */
  async createRunner(b: {
    type: 'instance_type' | 'group_type' | 'project_type';
    targetId?: number;
    description?: string;
    tags: string[];
    runUntagged: boolean;
    locked: boolean;
    protectedRefs: boolean;
    paused: boolean;
    maximumTimeout: number | null;
  }): Promise<GitLabCreatedRunner> {
    const { json } = await this.request('POST', '/user/runners', {
      body: {
        runner_type: b.type,
        ...(b.type === 'group_type' && { group_id: b.targetId }),
        ...(b.type === 'project_type' && { project_id: b.targetId }),
        ...(b.description && { description: b.description }),
        tag_list: b.tags.join(','),
        run_untagged: b.runUntagged,
        locked: b.locked,
        access_level: b.protectedRefs ? 'ref_protected' : 'not_protected',
        paused: b.paused,
        ...(b.maximumTimeout && { maximum_timeout: b.maximumTimeout }),
      },
    });
    return this.parse(json, createdRunnerSchema);
  }
  async setRunnerPaused(id: number, paused: boolean): Promise<void> {
    await this.request('PUT', `/runners/${id}`, { body: { paused } });
  }
  async deleteRunner(id: number): Promise<void> {
    await this.request('DELETE', `/runners/${id}`);
  }

  // ── configurações da instância (admin) ──
  async getMaxPatLifetime(): Promise<number | null> {
    return (await this.get('/application/settings', appSettingsSchema)).max_personal_access_token_lifetime ?? null;
  }
  /** Sem retry. ATENÇÃO: no GitLab isto REVOGA os tokens existentes que passarem do prazo (e é só Ultimate). */
  async setMaxPatLifetime(days: number): Promise<number | null> {
    const { json } = await this.request('PUT', '/application/settings', { body: { max_personal_access_token_lifetime: days } });
    return this.parse(json, appSettingsSchema).max_personal_access_token_lifetime ?? null;
  }

  // ── token próprio ──────────────────────────────────────────────────────────
  /**
   * Rotaciona o PAT em uso. NUNCA fazer retry: a resposta 200 revoga o token antigo, e reutilizá-lo
   * aciona a detecção de reuso do GitLab (revoga também o novo). Timeout aqui = resultado ambíguo.
   */
  async rotateSelf(expiresAt: string): Promise<GitLabRotatedToken> {
    const { json } = await this.request('POST', '/personal_access_tokens/self/rotate', {
      body: { expires_at: expiresAt },
      ambiguousOnTimeout: true,
    });
    return this.parse(json, rotatedTokenSchema);
  }

  // ── infraestrutura ─────────────────────────────────────────────────────────
  private async get<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
    const { json } = await this.request('GET', path, { retry: true });
    return this.parse(json, schema);
  }

  /** Percorre todas as páginas (x-next-page). `maxPages` evita laço infinito contra um GitLab com paginação estranha. */
  private async listAll<T>(
    path: string,
    item: z.ZodType<T>,
    query: Record<string, string> = {},
    onPage?: (total: number) => void,
    maxPages = 1000,
  ): Promise<T[]> {
    const out: T[] = [];
    let page = 1;
    for (let n = 0; n < maxPages; n++) {
      const q = new URLSearchParams({ per_page: '100', page: String(page), ...query });
      const { json, headers } = await this.request('GET', `${path}?${q}`, { retry: true });
      out.push(...this.parse(json, z.array(item)));
      onPage?.(out.length);
      const next = headers.get('x-next-page');
      if (!next) break;
      page = Number(next);
    }
    return out;
  }

  private parse<S extends z.ZodType>(json: unknown, schema: S): z.infer<S> {
    const r = schema.safeParse(json);
    if (!r.success) {
      throw new GitLabApiError('GITLAB_UNEXPECTED_RESPONSE', null, 'Resposta inesperada do GitLab. Verifique a versão da instância.');
    }
    return r.data;
  }

  private async request(
    method: string,
    path: string,
    o: { body?: unknown; retry?: boolean; ambiguousOnTimeout?: boolean } = {},
  ): Promise<{ json: unknown; headers: Headers }> {
    const attempts = o.retry ? 3 : 1;
    let lastError: GitLabApiError | undefined;

    for (let i = 0; i < attempts; i++) {
      try {
        const res = await undiciFetch(`${this.baseUrl}/api/v4${path}`, {
          method,
          headers: {
            'PRIVATE-TOKEN': this.token,
            Accept: 'application/json',
            ...(o.body !== undefined && { 'Content-Type': 'application/json' }),
          },
          body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
          dispatcher: dispatcherFor(this.insecure),
          redirect: 'manual', // nunca seguir redirect levando o token
        });
        if (res.ok) {
          const text = res.status === 204 ? '' : await res.text();
          return { json: text ? JSON.parse(text) : null, headers: res.headers as unknown as Headers };
        }
        const err = await this.fromResponse(res.status, res.headers.get('retry-after'), res);
        if (!err.retryable || i === attempts - 1) throw err;
        lastError = err;
        await sleep(Math.min(Number(res.headers.get('retry-after')) * 1000 || 300 * 2 ** i, 3000));
      } catch (e) {
        // Um GitLabApiError aqui já é DEFINITIVO (não retentável ou última tentativa): só repassa.
        if (e instanceof GitLabApiError) throw e;
        const err = this.fromNetwork(e, o.ambiguousOnTimeout);
        if (!err.retryable || i === attempts - 1) throw err;
        lastError = err;
      }
    }
    throw lastError!;
  }

  private async fromResponse(status: number, retryAfter: string | null, res: { text(): Promise<string> }): Promise<GitLabApiError> {
    const body = await res.text().catch(() => '');
    const lower = body.toLowerCase();
    const detail = this.detailFrom(body);
    void retryAfter;
    switch (status) {
      case 401:
        return new GitLabApiError('GITLAB_TOKEN_INVALID', 401, 'Token GitLab inválido, expirado ou revogado.', false, detail);
      case 403:
        if (lower.includes('ldap')) return new GitLabApiError('GITLAB_LDAP_BLOCKED', 403, 'Usuário bloqueado via LDAP.');
        return new GitLabApiError('GITLAB_FORBIDDEN', 403, 'O GitLab recusou a ação (403).', false, detail);
      case 404:
        return new GitLabApiError('GITLAB_NOT_FOUND', 404, 'Recurso não encontrado no GitLab.', false, detail);
      case 400:
        if (lower.includes('two-factor') || lower.includes('two factor') || lower.includes('2fa')) {
          return new GitLabApiError('GITLAB_2FA_NOT_ENABLED', 400, 'O usuário não tem MFA habilitado.');
        }
        return new GitLabApiError('GITLAB_BAD_REQUEST', 400, 'Requisição recusada pelo GitLab.', false, detail);
      case 405:
        return new GitLabApiError('GITLAB_TOKEN_INVALID', 405, 'Token GitLab já revogado ou expirado.');
      case 429:
        return new GitLabApiError('GITLAB_RATE_LIMITED', 429, 'Limite de requisições do GitLab atingido.', true);
      default:
        if (status >= 500) return new GitLabApiError('GITLAB_UNAVAILABLE', status, 'GitLab indisponível.', true);
        return new GitLabApiError('GITLAB_BAD_REQUEST', status, 'Requisição recusada pelo GitLab.');
    }
  }

  /** Extrai `message`/`error` do corpo JSON do GitLab: curto, sem quebras e com o token redigido. */
  private detailFrom(body: string): string | undefined {
    try {
      const j = JSON.parse(body) as { message?: unknown; error?: unknown; error_description?: unknown };
      const raw = [j.message, j.error_description, j.error].find((v) => typeof v === 'string') as string | undefined;
      if (!raw) return undefined;
      return raw.replaceAll(this.token, '[token]').replace(/\s+/g, ' ').trim().slice(0, 200) || undefined;
    } catch {
      return undefined;
    }
  }

  private fromNetwork(e: unknown, ambiguousOnTimeout?: boolean): GitLabApiError {
    const code = causeCode(e);
    if (code && TLS_CODES.has(code)) {
      return new GitLabApiError(
        'GITLAB_TLS_ERROR',
        null,
        'Certificado TLS do GitLab não confiável. Configure NODE_EXTRA_CA_CERTS ou, se for auto-assinado, GITLAB_TLS_INSECURE=true.',
      );
    }
    const timedOut = (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError';
    if (timedOut && ambiguousOnTimeout) {
      return new GitLabApiError('GITLAB_ROTATION_UNKNOWN', null, 'A rotação não confirmou: o resultado é incerto.');
    }
    if (ambiguousOnTimeout) {
      // Falha de conexão depois do envio também é ambígua; antes do envio (ECONNREFUSED/ENOTFOUND) não é.
      if (code && ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
        return new GitLabApiError('GITLAB_UNAVAILABLE', null, 'GitLab indisponível.');
      }
      return new GitLabApiError('GITLAB_ROTATION_UNKNOWN', null, 'A rotação não confirmou: o resultado é incerto.');
    }
    return new GitLabApiError('GITLAB_UNAVAILABLE', null, 'GitLab indisponível.', true);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
