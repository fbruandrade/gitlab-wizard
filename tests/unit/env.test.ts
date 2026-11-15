import { describe, expect, it } from 'vitest';
import { loadEnv } from '@/server/env';

const key = Buffer.alloc(32, 1).toString('base64');
const valid = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3000',
  GITLAB_BASE_URL: 'https://gitlab.example.com/',
  TOKEN_ENCRYPTION_KEYS: `v1:${key}`,
  TOKEN_ENCRYPTION_ACTIVE_KEY: 'v1',
} as unknown as NodeJS.ProcessEnv;

describe('loadEnv', () => {
  it('aplica defaults e normaliza a URL do GitLab', () => {
    const env = loadEnv(valid);
    expect(env.GITLAB_BASE_URL).toBe('https://gitlab.example.com');
    expect(env.REQUIRE_APP_2FA).toBe(true);
    expect(env.SESSION_IDLE_MINUTES).toBe(30);
    expect(env.TOKEN_ENCRYPTION_KEYS.get('v1')).toHaveLength(32);
  });

  it('rejeita chave de cifragem que não tem 32 bytes', () => {
    const bad = { ...valid, TOKEN_ENCRYPTION_KEYS: `v1:${Buffer.alloc(16).toString('base64')}` };
    expect(() => loadEnv(bad)).toThrow(/32 bytes/);
  });

  it('rejeita versão ativa inexistente', () => {
    expect(() => loadEnv({ ...valid, TOKEN_ENCRYPTION_ACTIVE_KEY: 'v9' })).toThrow(/versão ativa/);
  });

  it('não ecoa valores de segredos na mensagem de erro', () => {
    const secret = 'segredo-curto';
    try {
      loadEnv({ ...valid, BETTER_AUTH_SECRET: secret });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).toContain('BETTER_AUTH_SECRET');
      expect(String(e)).not.toContain(secret);
    }
  });
});
