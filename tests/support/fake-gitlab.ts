import { createServer as createHttp, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export interface FakeUser {
  id: number;
  username: string;
  name: string;
  email: string;
  state: 'active' | 'blocked' | 'ldap_blocked' | 'deactivated';
  two_factor_enabled: boolean;
  is_admin: boolean;
  bot?: boolean;
  /** Não aparece na listagem GET /users (mas GET /users/:id funciona): simula dono não listado. */
  hidden?: boolean;
  last_sign_in_at?: string;
}
export interface FakeToken {
  id: number;
  token: string;
  userId: number;
  name: string;
  scopes: string[];
  expires_at: string | null;
  revoked: boolean;
  rotated: boolean;
  rotatedTo?: string;
  created_at?: string;
  last_used_at?: string | null;
}
export interface FakeKey {
  id: number;
  userId: number;
  title: string;
  created_at: string;
  /** `undefined` = o campo NÃO vem na resposta (como se o GitLab não informasse); null = nunca usada. */
  last_used_at?: string | null;
  /** Data de validade da chave; ausente/null = sem prazo. */
  expires_at?: string | null;
  usage_type?: string;
}
export interface FakeGroup {
  id: number;
  name: string;
  path: string;
  full_path: string;
  parent_id: number | null;
}
export interface FakeProject {
  id: number;
  name: string;
  path: string;
  path_with_namespace: string;
  groupId: number;
}
export interface FakeVariable {
  groupId: number;
  key: string;
  value: string;
  masked: boolean;
  protected: boolean;
  hidden: boolean;
  environment_scope: string;
}
export interface FakeOptions {
  tls?: { key: string; cert: string };
  adminMode?: boolean;
  port?: number;
  /** Porta HTTP (sem TLS) com /__control/* para os testes E2E manipularem o estado de fora do processo. */
  controlPort?: number;
}

/** Imita a API v4 do GitLab usada pela ferramenta, inclusive a detecção de reuso de token rotacionado. */
export async function startFakeGitLab(opts: FakeOptions = {}) {
  const users = new Map<number, FakeUser>();
  const tokens = new Map<string, FakeToken>();
  const requests: { method: string; path: string; token: string | null }[] = [];
  let nextUserId = 100;
  let nextTokenId = 5000;
  let nextKeyId = 9000;
  const keys = new Map<number, FakeKey>();
  // Configuração da instância. `ultimate:false` = edição sem o recurso: o PUT responde 200 mas IGNORA o campo.
  const instance = { maxPatLifetime: null as number | null, ultimate: true };
  // Injeção de falhas/atrasos para o próximo request que casar com `match`.
  const faults: {
    match: RegExp;
    status?: number;
    delayMs?: number;
    applyThenDelay?: boolean;
    slowMs?: number;
    body?: unknown;
    rawBody?: string;
    reset?: boolean;
    /** Aplica a escrita de variável e derruba a conexão: o cliente não sabe se valeu. */
    applyThenReset?: boolean;
    /** Deixa passar as N primeiras requisições que casarem antes de disparar. */
    skip?: number;
  }[] = [];
  const groups = new Map<number, FakeGroup>();
  const projects = new Map<number, FakeProject>();
  const variables = new Map<string, FakeVariable>();
  /** Projetos em que o operador não tem papel (403 ao listar/criar tokens). */
  const denyProjects = new Set<number>();
  let nextGroupId = 700;
  let nextProjectId = 800;

  let license: Record<string, unknown> | null = null; // null = sem licença → 404

  const api = {
    users,
    tokens,
    requests,
    keys,
    instance,
    addKey(userId: number, k: Partial<FakeKey> = {}): FakeKey {
      const key: FakeKey = {
        id: nextKeyId++,
        userId,
        title: `key-${nextKeyId}`,
        created_at: new Date(Date.now() - 400 * 86_400_000).toISOString(),
        usage_type: 'auth',
        ...k,
      };
      keys.set(key.id, key);
      return key;
    },
    groups,
    projects,
    variables,
    denyProjects,
    addGroup(path: string, parentId: number | null = null): FakeGroup {
      const parent = parentId ? groups.get(parentId)! : null;
      const g: FakeGroup = {
        id: nextGroupId++,
        name: path,
        path,
        full_path: parent ? `${parent.full_path}/${path}` : path,
        parent_id: parentId,
      };
      groups.set(g.id, g);
      return g;
    },
    addProject(groupId: number, path: string): FakeProject {
      const g = groups.get(groupId)!;
      const p: FakeProject = { id: nextProjectId++, name: path, path, path_with_namespace: `${g.full_path}/${path}`, groupId };
      projects.set(p.id, p);
      return p;
    },
    /** Token de acesso do projeto: vira um token autenticável de um usuário-bot (como no GitLab). */
    addProjectToken(
      projectId: number,
      t: Partial<FakeToken> & { accessLevel?: number } = {},
    ): FakeToken & { projectId: number; accessLevel: number } {
      const bot = api.addUser({ username: `project_${projectId}_bot_${nextTokenId}`, bot: true });
      const { accessLevel, ...rest } = t;
      const tok = api.addToken(bot.id, { name: 'cofre', scopes: ['read_api'], expires_at: '2027-06-01', ...rest });
      Object.assign(tok, { projectId, accessLevel: accessLevel ?? 40 });
      return tok as FakeToken & { projectId: number; accessLevel: number };
    },
    setVariable(groupId: number, key: string, value: string, o: Partial<FakeVariable> = {}) {
      const v: FakeVariable = { groupId, key, value, masked: true, protected: false, hidden: false, environment_scope: '*', ...o };
      variables.set(`${groupId}:${key}`, v);
      return v;
    },
    setLicense: (l: Record<string, unknown> | null) => void (license = l),
    addUser(u: Partial<FakeUser> & { username: string }): FakeUser {
      const user: FakeUser = {
        id: nextUserId++,
        name: u.username,
        email: `${u.username}@example.com`,
        state: 'active',
        two_factor_enabled: false,
        is_admin: false,
        ...u,
      };
      users.set(user.id, user);
      return user;
    },
    addToken(userId: number, t: Partial<FakeToken> = {}): FakeToken {
      const tok: FakeToken = {
        id: nextTokenId++,
        token: `glpat-${randomBytes(12).toString('hex')}`,
        userId,
        name: 'wizard',
        scopes: ['api'],
        expires_at: '2027-01-01',
        revoked: false,
        rotated: false,
        created_at: new Date(Date.now() - 400 * 86_400_000).toISOString(),
        last_used_at: new Date().toISOString(),
        ...t,
      };
      tokens.set(tok.token, tok);
      return tok;
    },
    fault: (f: (typeof faults)[number]) => void faults.push(f),
    callsWith: (token: string) => requests.filter((r) => r.token === token),
  };

  const json = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((r) => {
      let d = '';
      req.on('data', (c) => (d += c));
      req.on('end', () => r(d));
    });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname.replace(/^\/api\/v4/, '');
    const secret = (req.headers['private-token'] as string | undefined) ?? null;
    requests.push({ method: req.method ?? 'GET', path, token: secret });

    // A primeira falha que casar manda: com `skip`, esta requisição passa e as falhas seguintes continuam na fila.
    let fi = faults.findIndex((f) => f.match.test(`${req.method} ${path}`));
    if (fi >= 0 && faults[fi]!.skip) {
      faults[fi]!.skip!--;
      fi = -1;
    }
    const fault = fi >= 0 ? faults.splice(fi, 1)[0] : undefined;
    if (fault?.reset) return void req.socket.destroy(); // conexão derrubada no meio da requisição
    if (fault?.rawBody !== undefined) {
      res.writeHead(fault.status ?? 502, { 'content-type': 'text/html' }); // corpo que NÃO é JSON (ex.: página de erro de um proxy)
      return void res.end(fault.rawBody);
    }
    if (fault?.status)
      return json(res, fault.status, fault.body ?? { message: 'injected' }, fault.status === 429 ? { 'retry-after': '0' } : {});

    // ── autenticação ──────────────────────────────────────────────────────────
    const tok = secret ? tokens.get(secret) : undefined;
    if (!tok || tok.revoked) {
      // Detecção de reuso: usar um token já rotacionado revoga o mais recente da cadeia.
      if (tok?.rotated) {
        let cur: FakeToken | undefined = tok;
        while (cur?.rotatedTo) cur = tokens.get(cur.rotatedTo);
        if (cur) cur.revoked = true;
      }
      return json(res, 401, { message: '401 Unauthorized' });
    }
    const owner = users.get(tok.userId)!;
    const has = (...s: string[]) => s.some((x) => tok.scopes.includes(x));
    const adminOk = owner.is_admin && tok.scopes.includes('api') && (!opts.adminMode || tok.scopes.includes('admin_mode'));
    const view = (u: FakeUser) => ({
      ...u,
      is_admin: undefined,
      user_type: u.bot ? 'project_bot' : 'human',
      ...(owner.is_admin && { is_admin: u.is_admin }),
    });
    const page = <T>(list: T[]) => {
      const per = Number(url.searchParams.get('per_page') ?? 20);
      const pg = Number(url.searchParams.get('page') ?? 1);
      const total = Math.max(1, Math.ceil(list.length / per));
      return {
        slice: list.slice((pg - 1) * per, pg * per),
        headers: { 'x-total-pages': String(total), 'x-page': String(pg), 'x-next-page': pg < total ? String(pg + 1) : '' },
      };
    };

    // ── administração de credenciais e configurações (admin) ──────────────────────────────────────────────
    if (path === '/application/settings') {
      if (!owner.is_admin) return json(res, 403, { message: '403 Forbidden' });
      if (req.method === 'GET') return json(res, 200, { max_personal_access_token_lifetime: instance.maxPatLifetime });
      if (req.method === 'PUT') {
        if (!adminOk) return json(res, 403, { message: '403 Forbidden' });
        const body = JSON.parse((await readBody(req)) || '{}') as { max_personal_access_token_lifetime?: number };
        const days = body.max_personal_access_token_lifetime;
        if (instance.ultimate && typeof days === 'number') {
          instance.maxPatLifetime = days;
          // Comportamento documentado: ao definir/alterar, REVOGA os tokens com expiração além do prazo.
          const cutoff = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
          for (const t of tokens.values()) if (!t.revoked && t.expires_at && t.expires_at > cutoff) t.revoked = true;
        }
        return json(res, 200, { max_personal_access_token_lifetime: instance.maxPatLifetime });
      }
    }
    if (path.startsWith('/personal_access_tokens') && path !== '/personal_access_tokens/self' && !path.endsWith('/rotate')) {
      if (!owner.is_admin) return json(res, 403, { message: '403 Forbidden' });
      const item = (t: FakeToken) => ({
        id: t.id,
        user_id: t.userId,
        name: t.name,
        scopes: t.scopes,
        created_at: t.created_at,
        last_used_at: t.last_used_at ?? null,
        expires_at: t.expires_at,
        revoked: t.revoked,
        active: !t.revoked,
      });
      if (req.method === 'GET' && path === '/personal_access_tokens') {
        let list = [...tokens.values()];
        if (url.searchParams.get('state') === 'active') list = list.filter((t) => !t.revoked);
        const uid = url.searchParams.get('user_id');
        if (uid) list = list.filter((t) => t.userId === Number(uid));
        const p = page(list.map(item));
        return json(res, 200, p.slice, p.headers);
      }
      const m = path.match(/^\/personal_access_tokens\/(\d+)$/);
      const target = m ? [...tokens.values()].find((t) => t.id === Number(m[1])) : undefined;
      if (m && !target) return json(res, 404, { message: '404 Not Found' });
      if (m && req.method === 'GET') return json(res, 200, item(target!));
      if (m && req.method === 'DELETE') {
        if (!adminOk) return json(res, 403, { message: '403 Forbidden' });
        target!.revoked = true;
        res.writeHead(204);
        return void res.end();
      }
    }
    if (req.method === 'GET' && path === '/license') {
      if (!owner.is_admin) return json(res, 403, { message: '403 Forbidden' });
      return license ? json(res, 200, { id: 1, ...license }) : json(res, 404, { message: '404 Not Found' });
    }
    if (req.method === 'GET' && path === '/version') return json(res, 200, { version: '18.11.0', revision: 'fake' });
    if (req.method === 'GET' && path === '/user') {
      return json(res, 200, { id: owner.id, username: owner.username, name: owner.name, ...(owner.is_admin && { is_admin: true }) });
    }
    if (req.method === 'GET' && path === '/personal_access_tokens/self') {
      return json(res, 200, {
        id: tok.id,
        name: tok.name,
        scopes: tok.scopes,
        expires_at: tok.expires_at,
        active: true,
        revoked: false,
        last_used_at: new Date().toISOString(),
      });
    }
    if (req.method === 'POST' && path === '/personal_access_tokens/self/rotate') {
      if (!has('api', 'self_rotate')) return json(res, 403, { message: '403 Forbidden' });
      const body = JSON.parse((await readBody(req)) || '{}') as { expires_at?: string };
      // delayMs sem applyThenDelay = a requisição se perde antes de ser aplicada; com ele, é aplicada e a resposta se perde.
      if (fault?.delayMs && !fault.applyThenDelay) {
        await new Promise((r) => setTimeout(r, fault.delayMs));
        return;
      }
      const next = api.addToken(owner.id, { name: tok.name, scopes: tok.scopes, expires_at: body.expires_at ?? null });
      tok.revoked = true;
      tok.rotated = true;
      tok.rotatedTo = next.token;
      if (fault?.delayMs) {
        await new Promise((r) => setTimeout(r, fault.delayMs));
        return;
      }
      if (fault?.slowMs) await new Promise((r) => setTimeout(r, fault.slowMs)); // responde, mas devagar (sem estourar o timeout)
      return json(res, 200, { id: next.id, name: next.name, scopes: next.scopes, expires_at: next.expires_at, token: next.token });
    }
    if (fault?.delayMs) {
      await new Promise((r) => setTimeout(r, fault.delayMs));
      if (!fault.applyThenDelay) return;
    }

    // ── cofre de tokens de projeto: grupos, projetos, tokens de projeto e variáveis de grupo ─────────────────
    if (path.startsWith('/groups') || path.startsWith('/projects')) {
      if (!has('api', 'read_api')) return json(res, 403, { message: '403 Forbidden' });
      const groupView = ({ id, name, path: gp, full_path, parent_id }: FakeGroup) => ({ id, name, path: gp, full_path, parent_id });
      const projView = ({ id, name, path: pp, path_with_namespace }: FakeProject) => ({ id, name, path: pp, path_with_namespace });
      const tokView = (t: FakeToken & { accessLevel?: number }) => ({
        id: t.id,
        name: t.name,
        scopes: t.scopes,
        created_at: t.created_at,
        last_used_at: t.last_used_at ?? null,
        expires_at: t.expires_at,
        active: !t.revoked,
        revoked: t.revoked,
        access_level: t.accessLevel ?? 40,
      });
      const varView = (v: FakeVariable) => ({
        key: v.key,
        value: v.hidden ? null : v.value,
        masked: v.masked,
        protected: v.protected,
        hidden: v.hidden,
        environment_scope: v.environment_scope,
        variable_type: 'env_var',
      });
      let m: RegExpMatchArray | null;

      if ((m = path.match(/^\/groups\/([^/]+)\/subgroups$/)) && req.method === 'GET') {
        const p = page([...groups.values()].filter((g) => g.parent_id === Number(m![1])).map(groupView));
        return json(res, 200, p.slice, p.headers);
      }
      if ((m = path.match(/^\/groups\/([^/]+)\/projects$/)) && req.method === 'GET') {
        const p = page([...projects.values()].filter((pr) => pr.groupId === Number(m![1])).map(projView));
        return json(res, 200, p.slice, p.headers);
      }
      if ((m = path.match(/^\/groups\/(\d+)\/variables(?:\/([^/]+))?$/))) {
        const gid = Number(m[1]);
        if (!groups.has(gid)) return json(res, 404, { message: '404 Group Not Found' });
        const key = m[2] ? decodeURIComponent(m[2]) : null;
        const cur = key ? variables.get(`${gid}:${key}`) : undefined;
        if (req.method === 'GET' && key) return cur ? json(res, 200, varView(cur)) : json(res, 404, { message: '404 Variable Not Found' });
        const body = JSON.parse((await readBody(req)) || '{}') as Partial<FakeVariable>;
        if (req.method === 'POST' && !key) {
          if (!body.key || variables.has(`${gid}:${body.key}`)) return json(res, 400, { message: { key: ['has already been taken'] } });
          if (body.masked && (body.value ?? '').length < 8) return json(res, 400, { message: { value: ['is invalid'] } });
          const v = api.setVariable(gid, body.key, body.value ?? '', {
            masked: body.masked ?? false,
            protected: body.protected ?? false,
            environment_scope: body.environment_scope ?? '*',
          });
          if (fault?.applyThenReset) return void req.socket.destroy();
          return json(res, 201, varView(v));
        }
        if (req.method === 'PUT' && key) {
          if (!cur) return json(res, 404, { message: '404 Variable Not Found' });
          if (body.value !== undefined) cur.value = body.value;
          if (body.masked !== undefined) cur.masked = body.masked;
          if (body.protected !== undefined) cur.protected = body.protected;
          if (fault?.applyThenReset) return void req.socket.destroy();
          return json(res, 200, varView(cur));
        }
      }
      if ((m = path.match(/^\/groups\/([^/]+)$/)) && req.method === 'GET') {
        const ref = decodeURIComponent(m[1]!);
        const g = /^\d+$/.test(ref) ? groups.get(Number(ref)) : [...groups.values()].find((x) => x.full_path === ref);
        return g ? json(res, 200, groupView(g)) : json(res, 404, { message: '404 Group Not Found' });
      }
      if ((m = path.match(/^\/projects\/(\d+)\/access_tokens(?:\/(\d+))?$/))) {
        const pid = Number(m[1]);
        if (!projects.has(pid)) return json(res, 404, { message: '404 Project Not Found' });
        if (denyProjects.has(pid)) return json(res, 403, { message: '403 Forbidden' });
        const mine = () => [...tokens.values()].filter((t) => (t as { projectId?: number }).projectId === pid);
        if (req.method === 'GET' && !m[2]) {
          let list = mine();
          if (url.searchParams.get('state') === 'active') list = list.filter((t) => !t.revoked);
          const p = page(list.map(tokView));
          return json(res, 200, p.slice, p.headers);
        }
        if (req.method === 'POST' && !m[2]) {
          const body = JSON.parse((await readBody(req)) || '{}') as {
            name: string;
            scopes: string[];
            access_level: number;
            expires_at: string;
          };
          const t = api.addProjectToken(pid, {
            name: body.name,
            scopes: body.scopes,
            expires_at: body.expires_at,
            accessLevel: body.access_level,
          });
          return json(res, 201, { ...tokView(t), token: t.token });
        }
        if (req.method === 'DELETE' && m[2]) {
          const t = mine().find((x) => x.id === Number(m![2]));
          if (!t) return json(res, 404, { message: '404 Not Found' });
          t.revoked = true;
          res.writeHead(204);
          return void res.end();
        }
      }
    }

    // ── usuários (somente admin) ─────────────────────────────────────────────
    if (path.startsWith('/users')) {
      if (!owner.is_admin || !has('api', 'read_api')) return json(res, 403, { message: '403 Forbidden' });
      if (req.method === 'GET' && path === '/users') {
        const q = (url.searchParams.get('search') ?? '').toLowerCase();
        let list = [...users.values()]
          .filter((u) => !u.hidden)
          .filter((u) => !q || [u.username, u.name, u.email].some((s) => s.toLowerCase().includes(q)));
        if (url.searchParams.get('blocked') === 'true') list = list.filter((u) => u.state === 'blocked' || u.state === 'ldap_blocked');
        const per = Number(url.searchParams.get('per_page') ?? 20),
          page = Number(url.searchParams.get('page') ?? 1);
        const total = Math.max(1, Math.ceil(list.length / per));
        return json(res, 200, list.slice((page - 1) * per, page * per).map(view), {
          'x-total-pages': String(total),
          'x-page': String(page),
          'x-next-page': page < total ? String(page + 1) : '',
        });
      }
      const km = path.match(/^\/users\/(\d+)\/keys(?:\/(\d+))?$/);
      if (km) {
        const uid = Number(km[1]);
        if (!users.has(uid)) return json(res, 404, { message: '404 User Not Found' });
        if (req.method === 'GET' && !km[2]) {
          const p = page([...keys.values()].filter((k) => k.userId === uid).map(({ userId, ...k }) => (void userId, k)));
          return json(res, 200, p.slice, p.headers);
        }
        if (req.method === 'DELETE' && km[2]) {
          if (!adminOk) return json(res, 403, { message: '403 Forbidden' });
          const k = keys.get(Number(km[2]));
          if (!k || k.userId !== uid) return json(res, 404, { message: '404 Key Not Found' });
          keys.delete(k.id);
          res.writeHead(204);
          return void res.end();
        }
      }
      const m = path.match(/^\/users\/(\d+)(?:\/(block|unblock|disable_two_factor))?$/);
      const target = m ? users.get(Number(m[1])) : undefined;
      if (!m || !target) return json(res, 404, { message: '404 User Not Found' });
      if (req.method === 'GET' && !m[2]) return json(res, 200, view(target));
      if (!adminOk) return json(res, 403, { message: '403 Forbidden' });
      if (req.method === 'POST' && m[2] === 'block') {
        if (target.id === owner.id) return json(res, 403, { message: '403 Forbidden' });
        if (target.state !== 'active') return json(res, 201, false);
        target.state = 'blocked';
        return json(res, 201, true);
      }
      if (req.method === 'POST' && m[2] === 'unblock') {
        if (target.state === 'ldap_blocked') return json(res, 403, { message: '403 Forbidden - LDAP blocked users cannot be unblocked' });
        if (target.state !== 'blocked') return json(res, 201, false);
        target.state = 'active';
        return json(res, 201, true);
      }
      if (req.method === 'PATCH' && m[2] === 'disable_two_factor') {
        // Regra real do GitLab: não vale para administradores nem para a própria conta.
        if (target.is_admin || target.id === owner.id)
          return json(res, 403, { message: '403 Forbidden - You are not allowed to disable two-factor authentication for this user' });
        if (!target.two_factor_enabled)
          return json(res, 400, { message: '400 Bad request - User does not have two-factor authentication enabled' });
        target.two_factor_enabled = false;
        res.writeHead(204);
        return void res.end();
      }
    }
    return json(res, 404, { message: '404 Not Found' });
  }

  const listener = (req: IncomingMessage, res: ServerResponse) =>
    void handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, {});
    });
  const server = opts.tls ? createHttps(opts.tls, listener) : createHttp(listener);
  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  // ── controle externo (E2E): o app roda em outro processo e fala com o falso só pela API v4 ─────────────────
  let controlServer: ReturnType<typeof createHttp> | undefined;
  if (opts.controlPort) {
    controlServer = createHttp((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://x');
        const send = (status: number, body?: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(body === undefined ? undefined : JSON.stringify(body));
        };
        const raw = await readBody(req);
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        const p = url.pathname.replace(/^\/__control/, '');
        let m: RegExpMatchArray | null;
        if (req.method === 'POST' && p === '/license') {
          api.setLicense(body.clear ? null : body);
          return send(200, { ok: true });
        }
        if (req.method === 'POST' && p === '/keys') {
          const { omitLastUsed, userId, ...rest } = body as { omitLastUsed?: boolean; userId: number } & Partial<FakeKey>;
          const key = api.addKey(Number(userId), rest);
          if (omitLastUsed) delete key.last_used_at; // simula o GitLab não informando o campo
          return send(200, key);
        }
        if (req.method === 'GET' && p === '/keys') return send(200, [...keys.values()]);
        if (req.method === 'GET' && p === '/instance') return send(200, instance);
        if (req.method === 'POST' && p === '/instance') return send(200, Object.assign(instance, body));
        if (req.method === 'POST' && p === '/users') return send(200, api.addUser(body as Partial<FakeUser> & { username: string }));
        if (req.method === 'GET' && p === '/users')
          return send(200, [...users.values()].find((u) => u.username === url.searchParams.get('username')) ?? null);
        if (req.method === 'GET' && (m = p.match(/^\/users\/(\d+)$/))) return send(200, users.get(Number(m[1])) ?? null);
        if (req.method === 'POST' && p === '/tokens') return send(200, api.addToken(Number(body.userId), body as Partial<FakeToken>));
        if (req.method === 'GET' && (m = p.match(/^\/tokens\/(.+)$/))) return send(200, tokens.get(decodeURIComponent(m[1]!)) ?? null);
        if (req.method === 'POST' && (m = p.match(/^\/tokens\/(.+)\/patch$/))) {
          const t = tokens.get(decodeURIComponent(m[1]!));
          if (t) Object.assign(t, body);
          return send(200, { ok: Boolean(t) });
        }
        if (req.method === 'POST' && (m = p.match(/^\/tokens\/(.+)\/revoke$/))) {
          const t = tokens.get(decodeURIComponent(m[1]!));
          if (t) t.revoked = true;
          return send(200, { ok: Boolean(t) });
        }
        if (req.method === 'POST' && p === '/groups')
          return send(200, api.addGroup(String(body.path), (body.parentId as number | null) ?? null));
        if (req.method === 'POST' && p === '/projects') return send(200, api.addProject(Number(body.groupId), String(body.path)));
        if (req.method === 'POST' && p === '/project-tokens') {
          const { projectId, ...rest } = body as { projectId: number } & Partial<FakeToken>;
          return send(200, api.addProjectToken(Number(projectId), rest));
        }
        if (req.method === 'POST' && p === '/variables') {
          const { groupId, key, value, ...rest } = body as { groupId: number; key: string; value: string } & Partial<FakeVariable>;
          return send(200, api.setVariable(Number(groupId), key, value, rest));
        }
        if (req.method === 'GET' && p === '/groups-list') return send(200, [...groups.values()]);
        if (req.method === 'GET' && p === '/variables') return send(200, [...variables.values()]);
        if (req.method === 'GET' && p === '/project-tokens')
          return send(
            200,
            [...tokens.values()].filter((t) => (t as { projectId?: number }).projectId !== undefined),
          );
        if (req.method === 'GET' && p === '/requests') return send(200, requests);
        send(404, { message: 'unknown control route' });
      })().catch(() => {
        res.writeHead(500);
        res.end();
      });
    });
    await new Promise<void>((r) => controlServer!.listen(opts.controlPort, '127.0.0.1', r));
  }
  return {
    ...api,
    url: `${opts.tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    close: async () => {
      controlServer?.closeAllConnections();
      controlServer?.close();
      await new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      });
    },
  };
}
export type FakeGitLab = Awaited<ReturnType<typeof startFakeGitLab>>;
