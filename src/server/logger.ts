import 'server-only';
import pino from 'pino';

// Lê direto de process.env: o logger não pode depender da validação de env.ts (que o usa para reportar erros).
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { app: 'gitlab-wizard' },
  redact: {
    paths: [
      '*.token',
      '*.privateToken',
      '*.password',
      '*.newPassword',
      '*.currentPassword',
      '*.secret',
      '*.backupCodes',
      'req.headers.cookie',
      'req.headers["private-token"]',
      'req.headers.authorization',
    ],
    censor: '[REDACTED]',
  },
  ...(process.env.NODE_ENV === 'development' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});
