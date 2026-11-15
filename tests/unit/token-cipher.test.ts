import { beforeAll, describe, expect, it } from 'vitest';

type Cipher = typeof import('@/server/crypto/token-cipher');
let c: Cipher;
const keyA = Buffer.alloc(32, 1).toString('base64');
const keyB = Buffer.alloc(32, 2).toString('base64');

beforeAll(async () => {
  Object.assign(process.env, {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    BETTER_AUTH_SECRET: 'x'.repeat(32),
    BETTER_AUTH_URL: 'http://localhost:3000',
    GITLAB_BASE_URL: 'https://gitlab.example.com',
    TOKEN_ENCRYPTION_KEYS: `v1:${keyA},v2:${keyB}`,
    TOKEN_ENCRYPTION_ACTIVE_KEY: 'v2',
  });
  c = await import('@/server/crypto/token-cipher');
});

describe('AES-256-GCM do PAT', () => {
  it('ida e volta; cifra com a chave ativa (v2) e IV novo a cada vez', () => {
    const a = c.encryptToken('glpat-segredo', 'u:1');
    const b = c.encryptToken('glpat-segredo', 'u:1');
    expect(a.keyVersion).toBe('v2');
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.ciphertext.toString('utf8')).not.toContain('glpat');
    expect(c.decryptToken(a, 'u:1')).toBe('glpat-segredo');
  });

  it('AAD diferente, ciphertext adulterado ou auth tag errada → falha', () => {
    const a = c.encryptToken('glpat-segredo', 'u:1');
    expect(() => c.decryptToken(a, 'u:2')).toThrow();
    const tampered = { ...a, ciphertext: Buffer.from(a.ciphertext.map((x, i) => (i === 0 ? x ^ 1 : x))) };
    expect(() => c.decryptToken(tampered, 'u:1')).toThrow();
    expect(() => c.decryptToken({ ...a, authTag: Buffer.alloc(16) }, 'u:1')).toThrow();
  });

  it('chave versionada: um registro cifrado com v1 continua decifrando depois que v2 virou a ativa', async () => {
    const { createCipheriv, randomBytes } = await import('node:crypto');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 1), iv);
    cipher.setAAD(Buffer.from('u:1'));
    const ciphertext = Buffer.concat([cipher.update('antigo', 'utf8'), cipher.final()]);
    expect(c.decryptToken({ ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: 'v1' }, 'u:1')).toBe('antigo');
    expect(() => c.decryptToken({ ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: 'v9' }, 'u:1')).toThrow(/não configurada/);
  });

  it('fingerprint tem 8 hex e não revela o token', () => {
    const f = c.fingerprint('glpat-segredo');
    expect(f).toMatch(/^[0-9a-f]{8}$/);
    expect('glpat-segredo').not.toContain(f);
  });
});
