import { beforeAll, describe, expect, it } from 'vitest';

let computeCapabilities: typeof import('@/server/auth/capabilities').computeCapabilities;
beforeAll(async () => {
  // capabilities só precisa de env para o default de Admin Mode; os casos abaixo passam o valor explicitamente.
  ({ computeCapabilities } = await import('@/server/auth/capabilities'));
});

describe('matriz de capacidades (docs/04 §2)', () => {
  const cases: [string, { isAdmin: boolean; scopes: string[]; adminModeEnabled: boolean }, string[]][] = [
    [
      'admin + api, Admin Mode desligado',
      { isAdmin: true, scopes: ['api'], adminModeEnabled: false },
      ['READ_USERS', 'ADMIN_USERS', 'SELF_ROTATE', 'VAULT_TOKENS', 'RUNNERS_MANAGE'],
    ],
    [
      'admin + api, Admin Mode LIGADO, sem admin_mode',
      { isAdmin: true, scopes: ['api'], adminModeEnabled: true },
      ['READ_USERS', 'SELF_ROTATE', 'VAULT_TOKENS', 'RUNNERS_MANAGE'],
    ],
    [
      'admin + api + admin_mode, Admin Mode ligado',
      { isAdmin: true, scopes: ['api', 'admin_mode'], adminModeEnabled: true },
      ['READ_USERS', 'ADMIN_USERS', 'SELF_ROTATE', 'VAULT_TOKENS', 'RUNNERS_MANAGE'],
    ],
    [
      'create_runner sozinho (api NÃO basta para criar)',
      { isAdmin: false, scopes: ['create_runner'], adminModeEnabled: false },
      ['RUNNERS_CREATE'],
    ],
    ['manage_runner sozinho', { isAdmin: false, scopes: ['manage_runner'], adminModeEnabled: false }, ['RUNNERS_MANAGE']],
    [
      'api + create_runner',
      { isAdmin: false, scopes: ['api', 'create_runner'], adminModeEnabled: false },
      ['SELF_ROTATE', 'VAULT_TOKENS', 'RUNNERS_CREATE', 'RUNNERS_MANAGE'],
    ],
    ['admin só com read_api', { isAdmin: true, scopes: ['read_api'], adminModeEnabled: false }, ['READ_USERS']],
    [
      'usuário comum com api',
      { isAdmin: false, scopes: ['api'], adminModeEnabled: false },
      ['SELF_ROTATE', 'VAULT_TOKENS', 'RUNNERS_MANAGE'],
    ],
    ['self_rotate sozinho', { isAdmin: false, scopes: ['self_rotate'], adminModeEnabled: false }, ['SELF_ROTATE']],
    ['admin só com self_rotate', { isAdmin: true, scopes: ['self_rotate'], adminModeEnabled: false }, ['SELF_ROTATE']],
    ['admin com read_user apenas', { isAdmin: true, scopes: ['read_user'], adminModeEnabled: false }, []],
    ['sem scopes', { isAdmin: false, scopes: [], adminModeEnabled: false }, []],
  ];
  it.each(cases)('%s', (_n, input, expected) => {
    expect(computeCapabilities(input)).toEqual(expected);
  });
});
