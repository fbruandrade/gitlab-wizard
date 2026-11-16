import 'server-only';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const keyList = z.string().transform((raw, ctx) => {
  const keys = new Map<string, Buffer>();
  for (const part of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [version, b64] = part.split(':');
    const key = b64 ? Buffer.from(b64, 'base64') : undefined;
    if (!version || !key || key.length !== 32) {
      ctx.addIssue({ code: 'custom', message: `chave "${version ?? part}" deve ser base64 de 32 bytes` });
      return z.NEVER;
    }
    keys.set(version, key);
  }
  if (keys.size === 0) ctx.addIssue({ code: 'custom', message: 'informe ao menos uma chave' });
  return keys;
});

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    DATABASE_URL: z.url(),

    BETTER_AUTH_SECRET: z.string().min(32, 'mínimo de 32 caracteres'),
    BETTER_AUTH_URL: z.url(),
    BETTER_AUTH_TRUSTED_ORIGINS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    /** Header com o IP real do cliente, definido pelo proxy reverso (ex.: x-forwarded-for). Vazio = sem IP confiável. */
    CLIENT_IP_HEADER: z.string().default(''),
    AUTH_RATE_LIMIT_SIGNIN_MAX: int(1, 100000).default(5),
    REQUIRE_APP_2FA: bool.default(true),
    SESSION_MAX_AGE_HOURS: int(1, 72).default(8),
    SESSION_IDLE_MINUTES: int(5, 1440).default(30),
    FRESH_SESSION_MINUTES: int(1, 120).default(15),

    GITLAB_BASE_URL: z.url().transform((u) => u.replace(/\/+$/, '')),
    GITLAB_TIMEOUT_MS: int(1000, 60000).default(10000),
    /**
     * Ignora a verificação do certificado TLS do GitLab (auto-assinado). Vale só para as chamadas ao GitLab.
     * Prefira NODE_EXTRA_CA_CERTS com a CA da empresa; use isto apenas quando não houver CA para confiar.
     */
    GITLAB_TLS_INSECURE: bool.default(false),
    GITLAB_ADMIN_MODE_ENABLED: bool.default(true),
    TOKEN_MAX_LIFETIME_DAYS: int(1, 3650).default(365),

    TOKEN_ENCRYPTION_KEYS: keyList,
    TOKEN_ENCRYPTION_ACTIVE_KEY: z.string().min(1),

    /** Habilita POST /api/internal/maintenance (Bearer). Sem o segredo, o endpoint responde 404. */
    MAINTENANCE_SECRET: z.string().min(32).optional(),

    /** Intervalo (min) do agendador interno da rotação automática dos cofres (docs/13 §14). 0 = desligado; só age se habilitada na tela. */
    VAULT_AUTO_INTERVAL_MINUTES: int(0, 1440).default(60),
  })
  .refine((e) => e.TOKEN_ENCRYPTION_KEYS.has(e.TOKEN_ENCRYPTION_ACTIVE_KEY), {
    path: ['TOKEN_ENCRYPTION_ACTIVE_KEY'],
    message: 'versão ativa não existe em TOKEN_ENCRYPTION_KEYS',
  });

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Valida e memoriza. Lança com a lista de variáveis inválidas, sem ecoar valores. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached && source === process.env) return cached;
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Configuração inválida:\n${lines.join('\n')}`);
  }
  if (source === process.env) cached = parsed.data;
  return parsed.data;
}

/**
 * Acesso preguiçoso: `next build` importa módulos sem ter as variáveis de runtime,
 * então a validação só acontece no primeiro acesso (e no boot, via instrumentation.ts).
 */
export const env = new Proxy({} as Env, {
  get: (_t, prop: string) => loadEnv()[prop as keyof Env],
});
