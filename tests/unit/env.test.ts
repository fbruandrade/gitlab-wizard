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

  it.each([
    ['sem dois pontos', 'v1'],
    ['versão vazia', `:${key}`],
    ['base64 vazio', 'v1:'],
    ['lista vazia', ''],
    ['uma chave boa e uma ruim', `v1:${key},v2:${Buffer.alloc(8).toString('base64')}`],
  ])('TOKEN_ENCRYPTION_KEYS inválida (%s) derruba a configuração', (_n, keys) => {
    expect(() => loadEnv({ ...valid, TOKEN_ENCRYPTION_KEYS: keys, TOKEN_ENCRYPTION_ACTIVE_KEY: 'v1' })).toThrow(/Configuração inválida/);
  });

  it('várias chaves versionadas: lê todas, a ativa precisa existir', () => {
    const env = loadEnv({
      ...valid,
      TOKEN_ENCRYPTION_KEYS: `v1:${key}, v2:${Buffer.alloc(32, 2).toString('base64')}`,
      TOKEN_ENCRYPTION_ACTIVE_KEY: 'v2',
    });
    expect([...env.TOKEN_ENCRYPTION_KEYS.keys()]).toEqual(['v1', 'v2']);
  });

  it('booleanos aceitam só "true"/"false" (nada de "yes"/"1")', () => {
    expect(loadEnv({ ...valid, REQUIRE_APP_2FA: 'false', GITLAB_TLS_INSECURE: 'true' } as never)).toMatchObject({
      REQUIRE_APP_2FA: false,
      GITLAB_TLS_INSECURE: true,
    });
    for (const bad of ['yes', '1', 'TRUE', ''])
      expect(() => loadEnv({ ...valid, REQUIRE_APP_2FA: bad } as never)).toThrow(/REQUIRE_APP_2FA/);
  });

  it('inteiros respeitam os limites e viram número', () => {
    expect(loadEnv({ ...valid, SESSION_IDLE_MINUTES: '45' } as never).SESSION_IDLE_MINUTES).toBe(45);
    for (const bad of ['0', '4', '99999', 'abc'])
      expect(() => loadEnv({ ...valid, SESSION_IDLE_MINUTES: bad } as never)).toThrow(/SESSION_IDLE_MINUTES/);
  });

  it('origens confiáveis: lista separada por vírgula, sem vazios; padrão = nenhuma', () => {
    expect(loadEnv(valid).BETTER_AUTH_TRUSTED_ORIGINS).toEqual([]);
    expect(
      loadEnv({ ...valid, BETTER_AUTH_TRUSTED_ORIGINS: ' https://a.com , ,https://b.com ' } as never).BETTER_AUTH_TRUSTED_ORIGINS,
    ).toEqual(['https://a.com', 'https://b.com']);
  });

  it('MAINTENANCE_SECRET curto demais é recusado; ausente é permitido (endpoint desligado)', () => {
    expect(loadEnv(valid).MAINTENANCE_SECRET).toBeUndefined();
    expect(() => loadEnv({ ...valid, MAINTENANCE_SECRET: 'curto' } as never)).toThrow(/MAINTENANCE_SECRET/);
  });

  it('VAULT_AUTO_INTERVAL_MINUTES: padrão 60; 0 desliga; fora de 0–1440 é recusado', () => {
    expect(loadEnv(valid).VAULT_AUTO_INTERVAL_MINUTES).toBe(60);
    expect(loadEnv({ ...valid, VAULT_AUTO_INTERVAL_MINUTES: '0' } as never).VAULT_AUTO_INTERVAL_MINUTES).toBe(0);
    expect(() => loadEnv({ ...valid, VAULT_AUTO_INTERVAL_MINUTES: '1441' } as never)).toThrow(/VAULT_AUTO_INTERVAL_MINUTES/);
    expect(() => loadEnv({ ...valid, VAULT_AUTO_INTERVAL_MINUTES: '-1' } as never)).toThrow(/VAULT_AUTO_INTERVAL_MINUTES/);
  });

  it('o acesso preguiçoso (`env`) valida só no primeiro uso e memoriza', async () => {
    const { env } = await import('@/server/env');
    Object.assign(process.env, valid, { NODE_ENV: 'test' });
    expect(env.GITLAB_BASE_URL).toBe('https://gitlab.example.com');
    expect(env.SESSION_MAX_AGE_HOURS).toBe(8);
  });
});
