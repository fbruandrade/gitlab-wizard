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
      ['READ_USERS', 'ADMIN_USERS', 'SELF_ROTATE'],
    ],
    [
      'admin + api, Admin Mode LIGADO, sem admin_mode',
      { isAdmin: true, scopes: ['api'], adminModeEnabled: true },
      ['READ_USERS', 'SELF_ROTATE'],
    ],
    [
      'admin + api + admin_mode, Admin Mode ligado',
      { isAdmin: true, scopes: ['api', 'admin_mode'], adminModeEnabled: true },
      ['READ_USERS', 'ADMIN_USERS', 'SELF_ROTATE'],
    ],
    ['admin só com read_api', { isAdmin: true, scopes: ['read_api'], adminModeEnabled: false }, ['READ_USERS']],
    ['usuário comum com api', { isAdmin: false, scopes: ['api'], adminModeEnabled: false }, ['SELF_ROTATE']],
    ['self_rotate sozinho', { isAdmin: false, scopes: ['self_rotate'], adminModeEnabled: false }, ['SELF_ROTATE']],
    ['admin só com self_rotate', { isAdmin: true, scopes: ['self_rotate'], adminModeEnabled: false }, ['SELF_ROTATE']],
    ['admin com read_user apenas', { isAdmin: true, scopes: ['read_user'], adminModeEnabled: false }, []],
    ['sem scopes', { isAdmin: false, scopes: [], adminModeEnabled: false }, []],
  ];
  it.each(cases)('%s', (_n, input, expected) => {
    expect(computeCapabilities(input)).toEqual(expected);
  });
});
