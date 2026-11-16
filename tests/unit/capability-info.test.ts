import { describe, expect, it } from 'vitest';
import { CAPABILITIES, missingReason } from '@/lib/capability-info';

describe('missingReason (por que falta cada capacidade)', () => {
  const admin = { isAdmin: true, scopes: ['read_user'], adminMode: false };
  it('READ_USERS: não-admin → pede admin; admin sem scope → pede api/read_api', () => {
    expect(missingReason('READ_USERS', { ...admin, isAdmin: false })).toMatch(/admin/);
    expect(missingReason('READ_USERS', admin)).toMatch(/api.*read_api/);
  });
  it('ADMIN_USERS: não-admin → admin; sem api → api; com api mas sem admin_mode → admin_mode', () => {
    expect(missingReason('ADMIN_USERS', { ...admin, isAdmin: false })).toMatch(/admin/);
    expect(missingReason('ADMIN_USERS', admin)).toMatch(/scope `api`/);
    expect(missingReason('ADMIN_USERS', { isAdmin: true, scopes: ['api'], adminMode: true })).toMatch(/admin_mode/);
  });
  it('SELF_ROTATE (e qualquer outra chave): pede api ou self_rotate', () => {
    expect(missingReason('SELF_ROTATE', admin)).toMatch(/api.*self_rotate/);
    expect(missingReason('QUALQUER', admin)).toMatch(/self_rotate/);
  });
  it('lista as 4 capacidades', () =>
    expect(CAPABILITIES.map((c) => c.key)).toEqual(['READ_USERS', 'ADMIN_USERS', 'SELF_ROTATE', 'VAULT_TOKENS']));
  it('VAULT_TOKENS: pede api e papel Maintainer', () => expect(missingReason('VAULT_TOKENS', admin)).toMatch(/api.*Maintainer/));
});
