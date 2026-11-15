import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma 7 não carrega .env sozinho. Em Docker/CI as variáveis já vêm do ambiente.
if (existsSync('.env')) process.loadEnvFile('.env');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // Migrations rodam com o usuário dono do schema (app_migrator); o app usa app_runtime.
    url:
      process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL ?? 'postgresql://placeholder:placeholder@localhost:5432/placeholder',
  },
});
