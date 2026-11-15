import { execFileSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

/**
 * Postgres 18 descartável que reproduz o modelo de permissões de produção
 * (migrations como `app_migrator`; aplicação como `app_runtime`, sem UPDATE/DELETE em audit_log).
 */
export async function startTestPostgres(dbName = 'gw_test') {
  const container = await new PostgreSqlContainer('postgres:18-alpine').withDatabase(dbName).start();
  const admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await admin.query(`
    CREATE ROLE app_migrator LOGIN CREATEDB PASSWORD 'mig';
    CREATE ROLE app_runtime LOGIN PASSWORD 'run';
    ALTER DATABASE ${dbName} OWNER TO app_migrator;
    ALTER SCHEMA public OWNER TO app_migrator;
    GRANT CONNECT ON DATABASE ${dbName} TO app_runtime;
    GRANT USAGE ON SCHEMA public TO app_runtime;
    ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
    ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;
  `);
  await admin.end();

  const host = container.getHost();
  const port = container.getPort();
  const migrationUrl = `postgresql://app_migrator:mig@${host}:${port}/${dbName}`;
  const databaseUrl = `postgresql://app_runtime:run@${host}:${port}/${dbName}`;
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_MIGRATION_URL: migrationUrl }, stdio: 'pipe' });
  return { databaseUrl, migrationUrl, stop: () => container.stop() };
}
