import { describe, expect, it } from 'vitest';
import {
  addTokenSchema,
  createToolUserSchema,
  gitlabTokenSchema,
  gitlabUserActionSchema,
  loginSchema,
  newPasswordSchema,
  reasonSchema,
  replaceTokenSchema,
  rotateSchema,
  setRoleSchema,
  toolUserTargetSchema,
  tokenRefSchema,
} from '@/lib/schemas';

const uuid = '3f2b8c1e-5a4d-4e6f-8a9b-0c1d2e3f4a5b';
const strong = 'N0va!SenhaForte#42';
const ok = (r: { success: boolean }) => r.success;

describe('loginSchema', () => {
  it('aceita usuário/senha e apara o usuário', () => {
    const r = loginSchema.parse({ username: '  alice  ', password: 'x' });
    expect(r.username).toBe('alice');
  });
  it.each([
    [{ username: 'ab', password: 'x' }],
    [{ username: 'alice', password: '' }],
    [{ username: 'a'.repeat(33), password: 'x' }],
    [{ username: 'alice', password: 'x'.repeat(129) }],
  ])('rejeita %j', (v) => {
    expect(ok(loginSchema.safeParse(v))).toBe(false);
  });
});

describe('newPasswordSchema', () => {
  const base = { currentPassword: 'Atual!Senha#1', newPassword: strong, confirmPassword: strong };
  it('aceita senha forte confirmada e diferente da atual', () => expect(ok(newPasswordSchema.safeParse(base))).toBe(true));
  it('recusa senha que não atende à política', () => {
    expect(ok(newPasswordSchema.safeParse({ ...base, newPassword: 'curta', confirmPassword: 'curta' }))).toBe(false);
  });
  it('recusa confirmação diferente (erro no campo da confirmação)', () => {
    const r = newPasswordSchema.safeParse({ ...base, confirmPassword: strong + 'x' });
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path[0] === 'confirmPassword')).toBe(true);
  });
  it('recusa nova senha igual à atual', () => {
    const r = newPasswordSchema.safeParse({ currentPassword: strong, newPassword: strong, confirmPassword: strong });
    expect(r.error?.issues.some((i) => i.path[0] === 'newPassword' && /diferente/.test(i.message))).toBe(true);
  });
  it('exige a senha atual', () => expect(ok(newPasswordSchema.safeParse({ ...base, currentPassword: '' }))).toBe(false));
});

describe('reasonSchema (motivo / nº do chamado)', () => {
  it('apara e exige 10+ caracteres úteis', () => {
    expect(reasonSchema.parse('  INC0012345 - ok  ')).toBe('INC0012345 - ok');
    expect(ok(reasonSchema.safeParse('curto'))).toBe(false);
    expect(ok(reasonSchema.safeParse('          x          '))).toBe(false); // só espaços não conta
  });
  it('limita a 500 caracteres', () => {
    expect(ok(reasonSchema.safeParse('x'.repeat(500)))).toBe(true);
    expect(ok(reasonSchema.safeParse('x'.repeat(501)))).toBe(false);
  });
});

describe('schemas de token', () => {
  it('gitlabTokenSchema: 20–255 caracteres, aparado', () => {
    expect(gitlabTokenSchema.parse({ token: `  ${'a'.repeat(20)}  ` }).token).toHaveLength(20);
    expect(ok(gitlabTokenSchema.safeParse({ token: 'a'.repeat(19) }))).toBe(false);
    expect(ok(gitlabTokenSchema.safeParse({ token: 'a'.repeat(256) }))).toBe(false);
  });
  it('addTokenSchema: makeDefault assume false', () => {
    expect(addTokenSchema.parse({ token: 'a'.repeat(20) }).makeDefault).toBe(false);
    expect(addTokenSchema.parse({ token: 'a'.repeat(20), makeDefault: true }).makeDefault).toBe(true);
  });
  it('tokenRefSchema / replaceTokenSchema exigem um UUID (id forjado é recusado)', () => {
    expect(ok(tokenRefSchema.safeParse({ tokenId: uuid }))).toBe(true);
    expect(ok(tokenRefSchema.safeParse({ tokenId: "1' OR '1'='1" }))).toBe(false);
    expect(ok(tokenRefSchema.safeParse({}))).toBe(false);
    expect(ok(replaceTokenSchema.safeParse({ tokenId: uuid, token: 'a'.repeat(20) }))).toBe(true);
    expect(ok(replaceTokenSchema.safeParse({ tokenId: uuid, token: 'curto' }))).toBe(false);
  });
});

describe('rotateSchema', () => {
  it('data AAAA-MM-DD; tokenId opcional (UUID); reveal assume false', () => {
    expect(rotateSchema.parse({ expiresAt: '2027-02-11' })).toEqual({ expiresAt: '2027-02-11', reveal: false });
    expect(rotateSchema.parse({ expiresAt: '2027-02-11', tokenId: uuid, reveal: true }).tokenId).toBe(uuid);
  });
  it.each([['11/02/2027'], ['2027-2-1'], [''], ['amanhã']])('recusa a data %j', (d) =>
    expect(ok(rotateSchema.safeParse({ expiresAt: d }))).toBe(false),
  );
  it('recusa tokenId que não é UUID', () => expect(ok(rotateSchema.safeParse({ expiresAt: '2027-02-11', tokenId: 'x' }))).toBe(false));
});

describe('ações sobre usuários', () => {
  it('gitlabUserActionSchema: id inteiro positivo, motivo, username de confirmação', () => {
    const v = { gitlabUserId: 7, reason: 'INC0012345 - ok', confirmUsername: ' joao ' };
    expect(gitlabUserActionSchema.parse(v).confirmUsername).toBe('joao');
    expect(ok(gitlabUserActionSchema.safeParse({ ...v, gitlabUserId: 0 }))).toBe(false);
    expect(ok(gitlabUserActionSchema.safeParse({ ...v, gitlabUserId: 1.5 }))).toBe(false);
    expect(ok(gitlabUserActionSchema.safeParse({ ...v, confirmUsername: '  ' }))).toBe(false);
  });
  it('createToolUserSchema normaliza o username (minúsculas) e valida e-mail/papel', () => {
    const v = { username: ' Maria.Silva ', name: 'Maria', email: 'm@example.com', role: 'user', reason: 'REQ0001234 - novo' };
    expect(createToolUserSchema.parse(v).username).toBe('maria.silva');
    expect(ok(createToolUserSchema.safeParse({ ...v, username: 'a b' }))).toBe(false);
    expect(ok(createToolUserSchema.safeParse({ ...v, username: 'ab' }))).toBe(false);
    expect(ok(createToolUserSchema.safeParse({ ...v, email: 'nao-e-email' }))).toBe(false);
    expect(ok(createToolUserSchema.safeParse({ ...v, role: 'root' }))).toBe(false); // só user | admin
    expect(ok(createToolUserSchema.safeParse({ ...v, name: 'M' }))).toBe(false);
  });
  it('toolUserTargetSchema / setRoleSchema', () => {
    expect(ok(toolUserTargetSchema.safeParse({ userId: 'abc', reason: 'REQ0001234 - ok' }))).toBe(true);
    expect(ok(toolUserTargetSchema.safeParse({ userId: '', reason: 'REQ0001234 - ok' }))).toBe(false);
    expect(ok(setRoleSchema.safeParse({ userId: 'abc', reason: 'REQ0001234 - ok', role: 'admin' }))).toBe(true);
    expect(ok(setRoleSchema.safeParse({ userId: 'abc', reason: 'REQ0001234 - ok', role: 'dono' }))).toBe(false);
  });
});
