import { describe, expect, it } from 'vitest';
import {
  classify,
  isBotUser,
  isPrivilegedScope,
  isUnused,
  type ClassifyInput,
  type CleanupParams,
  usageTypeLabel,
  validateCleanupParams,
} from '@/lib/cleanup-rules';

const NOW = new Date('2026-11-13T12:00:00Z');
const daysAgo = (n: number, extraMs = 0) => new Date(NOW.getTime() - n * 86_400_000 - extraMs).toISOString();

const users = new Map(
  [
    { id: 1, username: 'eu', state: 'active' },
    { id: 2, username: 'ativo', state: 'active' },
    { id: 3, username: 'bloqueado', state: 'blocked' },
    { id: 4, username: 'ldap', state: 'ldap_blocked' },
    { id: 5, username: 'banido', state: 'banned' },
    { id: 6, username: 'robo', state: 'active', bot: true },
  ].map((u) => [u.id, u]),
);
const base = ({ params, ...over }: Omit<Partial<ClassifyInput>, 'params'> & { params?: Partial<CleanupParams> } = {}): ClassifyInput => ({
  now: NOW,
  users,
  pats: [],
  keysByUser: new Map(),
  selfGitlabUserId: 1,
  linkedTokenIds: new Set(),
  ...over,
  params: { blockedUsers: true, unusedDays: 90, includePat: true, includeSsh: true, ...params },
});
const pat = (id: number, user_id: number, over: object = {}) => ({
  id,
  user_id,
  name: `pat${id}`,
  created_at: daysAgo(400),
  last_used_at: daysAgo(1),
  ...over,
});

describe('isUnused', () => {
  it('"mais de N dias": exatamente N dias NÃO conta; N dias + 1 ms conta', () => {
    expect(isUnused(daysAgo(90), null, 90, NOW)).toBe(false);
    expect(isUnused(daysAgo(90, 1), null, 90, NOW)).toBe(true);
    expect(isUnused(daysAgo(89), null, 90, NOW)).toBe(false);
  });
  it('nunca usada: vale a data de criação', () => {
    expect(isUnused(null, daysAgo(200), 90, NOW)).toBe(true);
    expect(isUnused(null, daysAgo(10), 90, NOW)).toBe(false);
    expect(isUnused(undefined, daysAgo(200), 90, NOW)).toBe(true);
  });
  it('sem nenhuma data ou data inválida: desconhecido → NÃO é "sem uso"', () => {
    expect(isUnused(null, null, 90, NOW)).toBe(false);
    expect(isUnused('lixo', null, 90, NOW)).toBe(false);
  });
});

describe('classify — tokens (PAT)', () => {
  it('critério "bloqueado": pega blocked e ldap_blocked, não pega active/banned', () => {
    const r = classify(base({ params: { unusedDays: null }, pats: [pat(1, 3), pat(2, 4), pat(3, 2), pat(4, 5)] }));
    expect(r.items.map((i) => i.credentialId)).toEqual([1, 2]);
    expect(r.items.every((i) => i.reasons.join() === 'USER_BLOCKED')).toBe(true);
  });
  it('critério "sem uso": ignora o estado do usuário', () => {
    const r = classify(
      base({
        params: { blockedUsers: false },
        pats: [pat(1, 2, { last_used_at: daysAgo(120) }), pat(2, 2, { last_used_at: daysAgo(10) })],
      }),
    );
    expect(r.items.map((i) => i.credentialId)).toEqual([1]);
    expect(r.items[0]!.reasons).toEqual(['UNUSED']);
  });
  it('"e/ou": com os dois critérios, qualquer um basta e os motivos se acumulam', () => {
    const r = classify(
      base({ pats: [pat(1, 3, { last_used_at: daysAgo(120) }), pat(2, 3), pat(3, 2, { last_used_at: daysAgo(120) }), pat(4, 2)] }),
    );
    expect(r.items.map((i) => [i.credentialId, i.reasons.join('+')])).toEqual([
      [3, 'UNUSED'], // ordenado por username: ativo < bloqueado
      [1, 'USER_BLOCKED+UNUSED'],
      [2, 'USER_BLOCKED'],
    ]);
  });
  it('PAT já revogado/inativo nunca é candidato', () => {
    const r = classify(base({ pats: [pat(1, 3, { revoked: true }), pat(2, 3, { active: false })] }));
    expect(r.items).toEqual([]);
  });
  it('bots (tokens de projeto/grupo) são excluídos e contados; dono desconhecido também', () => {
    const r = classify(base({ pats: [pat(1, 6, { last_used_at: daysAgo(500) }), pat(2, 999, { last_used_at: daysAgo(500) })] }));
    expect(r.items).toEqual([]);
    expect(r.excluded).toEqual({ bots: 1, unknownOwner: 1 });
  });
  it('a própria conta do operador e PATs vinculados à ferramenta aparecem PROTEGIDOS (não revogáveis)', () => {
    const r = classify(base({ pats: [pat(1, 1, { last_used_at: daysAgo(500) }), pat(2, 3), pat(3, 3)], linkedTokenIds: new Set([2]) }));
    const by = Object.fromEntries(r.items.map((i) => [i.credentialId, i.protectedReason]));
    expect(by).toEqual({ 1: 'SELF', 2: 'LINKED_IN_TOOL', 3: undefined });
  });
  it('includePat=false não avalia tokens', () => {
    expect(classify(base({ params: { includePat: false }, pats: [pat(1, 3)] })).items).toEqual([]);
  });
});

describe('classify — chaves SSH', () => {
  const keys = (u: number, ...k: object[]) =>
    new Map([[u, k.map((x, i) => ({ id: 100 + i, title: `k${i}`, created_at: daysAgo(400), ...x }))]]);
  it('usuário bloqueado: todas as chaves, mesmo sem informação de último uso', () => {
    const r = classify(base({ params: { unusedDays: null }, keysByUser: keys(3, {}, {}) }));
    expect(r.items.map((i) => i.kind)).toEqual(['SSH_KEY', 'SSH_KEY']);
  });
  it('"sem uso" com last_used_at informado: avalia; null = nunca usada (vale a criação)', () => {
    const r = classify(
      base({
        params: { blockedUsers: false },
        keysByUser: keys(
          2,
          { last_used_at: daysAgo(120) },
          { last_used_at: daysAgo(5) },
          { last_used_at: null, created_at: daysAgo(300) },
          { last_used_at: null, created_at: daysAgo(3) },
        ),
      }),
    );
    expect(r.items.map((i) => i.credentialId)).toEqual([100, 102]);
    expect(r.sshLastUsedUnavailable).toBe(false);
  });
  it('SEM o campo last_used_at (GitLab não informou): NUNCA vira "sem uso" — e avisa', () => {
    const r = classify(base({ params: { blockedUsers: false }, keysByUser: keys(2, { created_at: daysAgo(900) }) }));
    expect(r.items).toEqual([]);
    expect(r.sshLastUsedUnavailable).toBe(true);
  });
  it('sem o campo, mas usuário bloqueado: entra só pelo critério de bloqueio', () => {
    const r = classify(base({ keysByUser: keys(3, { created_at: daysAgo(900) }) }));
    expect(r.items[0]!.reasons).toEqual(['USER_BLOCKED']);
  });
  it('chaves da própria conta ficam protegidas; bots excluídos', () => {
    const r = classify(
      base({
        keysByUser: new Map([
          [1, [{ id: 1, last_used_at: daysAgo(500) }]],
          [6, [{ id: 2, last_used_at: daysAgo(500) }]],
        ]),
      }),
    );
    expect(r.items.map((i) => i.protectedReason)).toEqual(['SELF']);
    expect(r.excluded.bots).toBe(1);
  });
});

describe('classify — chaves SSH sem validade', () => {
  const keys = (u: number, ...k: object[]) =>
    new Map([[u, k.map((x, i) => ({ id: 100 + i, title: `k${i}`, created_at: daysAgo(10), ...x }))]]);
  const only = { blockedUsers: false, unusedDays: null, sshNoExpiry: true };

  it('lista TODAS as chaves sem expires_at, mesmo sem dado de último uso e mesmo em uso recente', () => {
    const r = classify(
      base({
        params: only,
        keysByUser: keys(
          2,
          {},
          { last_used_at: daysAgo(1) },
          { last_used_at: null },
          { expires_at: '2030-01-01' },
          { expires_at: '2020-01-01' },
        ),
      }),
    );
    expect(r.items.map((i) => i.credentialId)).toEqual([100, 101, 102]);
    expect(r.items.every((i) => i.reasons.join() === 'NO_EXPIRY')).toBe(true);
    expect(r.sshLastUsedUnavailable).toBe(true); // o aviso continua valendo para o critério "sem uso"
  });
  it('combina com os outros critérios (motivos somados) e não toca em tokens', () => {
    const r = classify(
      base({
        params: { blockedUsers: true, unusedDays: 90, sshNoExpiry: true },
        keysByUser: keys(3, { last_used_at: daysAgo(200) }),
        pats: [pat(1, 2)],
      }),
    );
    expect(r.items.filter((i) => i.kind === 'SSH_KEY')[0]!.reasons).toEqual(['USER_BLOCKED', 'UNUSED', 'NO_EXPIRY']);
    expect(r.items.filter((i) => i.kind === 'PAT')).toEqual([]); // PAT sem uso há muito? este é recente: nada
  });
  it('sem a opção, chave sem validade e em uso não entra; bots e a própria conta seguem as regras de sempre', () => {
    expect(classify(base({ params: { blockedUsers: false }, keysByUser: keys(2, { last_used_at: daysAgo(1) }) })).items).toEqual([]);
    expect(classify(base({ params: only, keysByUser: keys(6, {}) })).items).toEqual([]); // bot
    const self = classify(base({ params: only, keysByUser: keys(1, {}) })).items;
    expect(self).toHaveLength(1);
    expect(self[0]!.protectedReason).toBe('SELF');
  });
});

describe('validateCleanupParams', () => {
  const ok: CleanupParams = { blockedUsers: true, unusedDays: 90, includePat: true, includeSsh: true };
  it('aceita parâmetros válidos', () => expect(validateCleanupParams(ok)).toBeNull());
  it('só "SSH sem validade" já é um critério', () =>
    expect(validateCleanupParams({ ...ok, blockedUsers: false, unusedDays: null, sshNoExpiry: true })).toBeNull());
  it.each([
    [{ blockedUsers: false, unusedDays: null }, /critério/],
    [{ blockedUsers: false, unusedDays: null, sshNoExpiry: true, includeSsh: false }, /exigem incluir chaves SSH/],
    [{ includePat: false, includeSsh: false }, /tipo de credencial/],
    [{ unusedDays: 0 }, /entre 1 e 3650/],
    [{ unusedDays: 3651 }, /entre 1 e 3650/],
    [{ unusedDays: 1.5 }, /entre 1 e 3650/],
  ])('rejeita %j', (over, msg) => expect(validateCleanupParams({ ...ok, ...over })).toMatch(msg));
});

describe('escopos e tipo de uso nos candidatos', () => {
  const keys = (u: number, ...k: object[]) =>
    new Map([[u, k.map((x, i) => ({ id: 100 + i, created_at: daysAgo(400), last_used_at: daysAgo(1), ...x }))]]);

  it('PAT carrega os escopos da API (inclusive vazio quando não vierem)', () => {
    const r = classify(base({ pats: [pat(1, 3, { scopes: ['api', 'read_user', 'sudo'] }), pat(2, 3)] }));
    expect(r.items.find((i) => i.credentialId === 1)!.scopes).toEqual(['api', 'read_user', 'sudo']);
    expect(r.items.find((i) => i.credentialId === 2)!.scopes).toEqual([]);
  });
  it('chave SSH carrega o tipo de uso (não tem escopos)', () => {
    const r = classify(base({ params: { unusedDays: null }, keysByUser: keys(3, { usage_type: 'auth_and_signing' }, {}) }));
    expect(r.items.map((i) => i.usageType)).toEqual(['auth_and_signing', null]);
    expect(r.items.every((i) => i.scopes === undefined)).toBe(true);
  });
  it('escopos privilegiados: api, sudo e admin_mode (read_* e write_* não)', () => {
    for (const s of ['api', 'sudo', 'admin_mode']) expect(isPrivilegedScope(s)).toBe(true);
    for (const s of ['read_user', 'read_api', 'write_repository', 'self_rotate', 'API']) expect(isPrivilegedScope(s)).toBe(false);
  });
  it('rótulos do tipo de uso; valor desconhecido é exibido como veio', () => {
    expect(usageTypeLabel('auth')).toBe('autenticação');
    expect(usageTypeLabel('signing')).toBe('assinatura');
    expect(usageTypeLabel('auth_and_signing')).toBe('autenticação + assinatura');
    expect(usageTypeLabel('novo_tipo')).toBe('novo_tipo');
    expect(usageTypeLabel(null)).toBeNull();
  });
});

describe('isBotUser (não revogar o que roda pipelines)', () => {
  it.each([
    [{ username: 'x', bot: true }, true],
    [{ username: 'x', user_type: 'project_bot' }, true],
    [{ username: 'x', user_type: 'service_account' }, true],
    [{ username: 'x', user_type: 'human' }, false],
    [{ username: 'project_123_bot_abc' }, true],
    [{ username: 'group_9_bot_x' }, true],
    [{ username: 'projects_bot' }, false], // não é o padrão do GitLab
    [{ username: 'maria', bot: false, user_type: null }, false],
    [{ username: 'maria' }, false],
  ])('%j → %s', (u, expected) => expect(isBotUser(u)).toBe(expected));
});

describe('classify: dono desconhecido e campos ausentes', () => {
  it('chave de usuário que não está na lista é ignorada e CONTADA', () => {
    const r = classify(base({ keysByUser: new Map([[999, [{ id: 1, last_used_at: daysAgo(500) }]]]) }));
    expect(r.items).toEqual([]);
    expect(r.excluded.unknownOwner).toBe(1);
  });
  it('PAT sem created_at/last_used_at: nunca é "sem uso" (sem data = desconhecido); só entra se o dono está bloqueado', () => {
    const semDatas = { id: 7, user_id: 2, name: 'sem-datas' }; // usuário ativo
    expect(classify(base({ pats: [semDatas] })).items).toEqual([]);
    const bloqueado = classify(base({ pats: [{ id: 8, user_id: 3, name: 'b' }] })).items[0]!;
    expect(bloqueado).toMatchObject({ createdAt: null, lastUsedAt: null, expiresAt: null, reasons: ['USER_BLOCKED'] });
  });
});
