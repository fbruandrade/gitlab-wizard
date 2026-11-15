import { inject } from 'vitest';

// Precisa rodar antes de qualquer import de `@/server/*` (env é validada no primeiro acesso).
const key = Buffer.alloc(32, 7).toString('base64');
Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: inject('databaseUrl'),
  BETTER_AUTH_SECRET: 'integration-test-secret-integration-test-secret',
  BETTER_AUTH_URL: 'http://localhost:3000',
  CLIENT_IP_HEADER: 'x-test-ip',
  AUTH_RATE_LIMIT_SIGNIN_MAX: '5',
  REQUIRE_APP_2FA: 'true',
  FRESH_SESSION_MINUTES: '15',
  GITLAB_BASE_URL: 'http://127.0.0.1:18080', // porta fixa do GitLab falso (ver tests/support/app.ts)
  GITLAB_TIMEOUT_MS: '1500',
  GITLAB_ADMIN_MODE_ENABLED: 'false',
  TOKEN_ENCRYPTION_KEYS: `v1:${key}`,
  TOKEN_ENCRYPTION_ACTIVE_KEY: 'v1',
});
