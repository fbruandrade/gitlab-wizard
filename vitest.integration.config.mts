import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const p = (f: string) => fileURLToPath(new URL(f, import.meta.url));

export default defineConfig({
  resolve: { alias: { '@': p('./src') } },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    alias: { 'server-only': p('./tests/stubs/server-only.ts') },
    globalSetup: ['tests/integration/global-setup.ts'],
    setupFiles: ['tests/integration/setup.ts'],
    fileParallelism: false, // todos os arquivos compartilham o mesmo Postgres
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
