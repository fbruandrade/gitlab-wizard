// Sobe tudo que o E2E precisa e fica vivo até receber SIGTERM do Playwright:
//   Postgres descartável → migrations → GitLab falso (HTTPS auto-assinado) → admin via script → app (next start)
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, writeFileSync } from 'node:fs';
import { startFakeGitLab } from '../support/fake-gitlab';
import { startTestPostgres } from '../support/pg-container';
import { selfSignedCert } from '../support/self-signed';

const APP_PORT = 3100;
const GITLAB_PORT = 18443;
const CONTROL_PORT = 18444;
const ADMIN_SCOPES = ['api', 'admin_mode'];

const db = await startTestPostgres('gw_e2e');
const gitlab = await startFakeGitLab({ tls: selfSignedCert(), port: GITLAB_PORT, controlPort: CONTROL_PORT, adminMode: true });

// ── dados do GitLab falso ────────────────────────────────────────────────────
const root = gitlab.addUser({ username: 'root', name: 'Root GitLab', is_admin: true });
const dev = gitlab.addUser({ username: 'devuser', name: 'Dev User' });
// licença do GitLab (Premium, 20 usuários acima do contratado)
gitlab.setLicense({
  plan: 'premium',
  starts_at: '2026-01-01',
  expires_at: '2027-06-30',
  expired: false,
  user_limit: 100,
  maximum_user_count: 130,
  active_users: 120,
  overage: 20,
  historical_max: 130,
});
const adminPat = gitlab.addToken(root.id, {
  scopes: ADMIN_SCOPES,
  name: 'wizard-admin',
  expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10),
});
const rotateOnlyPat = gitlab.addToken(dev.id, { scopes: ['self_rotate'], name: 'wizard-dev' });
gitlab.addUser({ username: 'joao', name: 'João Silva', state: 'blocked', two_factor_enabled: true });
gitlab.addUser({ username: 'pedro', name: 'Pedro LDAP', state: 'ldap_blocked' });
gitlab.addUser({ username: 'maria', name: 'Maria Lima', two_factor_enabled: true });
for (let i = 1; i <= 25; i++) gitlab.addUser({ username: `extra${String(i).padStart(2, '0')}`, name: `Extra ${i}` });

const appUrl = `http://127.0.0.1:${APP_PORT}`;
const env = {
  ...process.env,
  NODE_ENV: 'production',
  LOG_LEVEL: 'warn',
  DATABASE_URL: db.databaseUrl,
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
  BETTER_AUTH_URL: appUrl,
  REQUIRE_APP_2FA: 'true',
  AUTH_RATE_LIMIT_SIGNIN_MAX: '1000',
  CLIENT_IP_HEADER: 'x-forwarded-for', // como atrás de um proxy: cada contexto do teste tem o seu IP (e o seu balde de rate limit)
  FRESH_SESSION_MINUTES: '15',
  GITLAB_BASE_URL: `https://127.0.0.1:${GITLAB_PORT}`,
  GITLAB_TLS_INSECURE: 'true', // o GitLab falso é auto-assinado: o E2E valida a opção de ponta a ponta
  GITLAB_ADMIN_MODE_ENABLED: 'true',
  GITLAB_TIMEOUT_MS: '5000',
  TOKEN_ENCRYPTION_KEYS: `v1:${randomBytes(32).toString('base64')}`,
  TOKEN_ENCRYPTION_ACTIVE_KEY: 'v1',
  MAINTENANCE_SECRET: randomBytes(24).toString('hex'),
  VAULT_AUTO_INTERVAL_MINUTES: '0', // o teste dispara a passada pelo gatilho externo
  PORT: String(APP_PORT),
};

// ── primeiro admin, pelo MESMO script usado em produção ──────────────────────
const out = execFileSync('npx', ['tsx', '--conditions=react-server', 'scripts/create-admin.mts'], {
  env: { ...env, SEED_ADMIN_USERNAME: 'admin', SEED_ADMIN_NAME: 'Administrador E2E', SEED_ADMIN_EMAIL: 'admin@example.com' },
  encoding: 'utf8',
});
const adminPassword = out.match(/^\s{2}(\S+)$/m)?.[1];
if (!adminPassword) throw new Error(`create-admin não retornou a senha:\n${out}`);

writeFileSync(
  'tests/e2e/.state.json',
  JSON.stringify({
    appUrl,
    adminPassword,
    adminPat: adminPat.token,
    rotateOnlyPat: rotateOnlyPat.token,
    controlUrl: `http://127.0.0.1:${CONTROL_PORT}/__control`,
    migrationUrl: db.migrationUrl,
    maintenanceSecret: env.MAINTENANCE_SECRET,
    gitlabUrl: env.GITLAB_BASE_URL,
  }),
);

// Roda o artefato `standalone`, o mesmo que vai para a imagem Docker (com os assets copiados ao lado).
cpSync('.next/static', '.next/standalone/.next/static', { recursive: true });
cpSync('public', '.next/standalone/public', { recursive: true });
const app = spawn('node', ['server.js'], { cwd: '.next/standalone', env: { ...env, HOSTNAME: '127.0.0.1' }, stdio: 'inherit' });
app.on('exit', (code) => {
  if (code) console.error(`next saiu com código ${code}`);
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  app.kill('SIGTERM');
  await gitlab.close().catch(() => undefined);
  await db.stop().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
