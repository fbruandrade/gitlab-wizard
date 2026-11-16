// Falha rápido no boot se a configuração estiver inválida (docs/02-arquitetura.md §5).
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { loadEnv } = await import('./server/env');
    const env = loadEnv();
    if (env.NODE_ENV === 'production' && !env.CLIENT_IP_HEADER) {
      // Sem IP confiável o rate limit do better-auth usa UM balde para todos: 3 verificações de 2FA / 10 s no sistema inteiro.
      const { logger } = await import('./server/logger');
      logger.warn(
        'CLIENT_IP_HEADER não definido: o rate limit de login/2FA é compartilhado por todos os usuários. Configure o header do seu proxy reverso (ex.: x-forwarded-for).',
      );
    }
    if (env.VAULT_AUTO_INTERVAL_MINUTES > 0) {
      // Rotação automática dos cofres: só age se um admin a habilitou na tela (/admin/vault).
      const { startVaultAutoScheduler } = await import('./server/services/vault-auto.service');
      startVaultAutoScheduler(env.VAULT_AUTO_INTERVAL_MINUTES);
    }
  }
}
