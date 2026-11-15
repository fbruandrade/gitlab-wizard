#!/bin/sh
# Executado só na primeira inicialização do volume (docker-entrypoint-initdb.d).
# Cria dois papéis (docs/05-modelo-de-dados.md §5):
#   app_migrator — dono do schema, usado só por `prisma migrate` (CREATEDB p/ shadow DB em dev)
#   app_runtime  — DML apenas; a migration de auditoria revoga UPDATE/DELETE em audit_log
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v dbname="$POSTGRES_DB" \
  -v mig_pass="$APP_MIGRATOR_PASSWORD" \
  -v rt_pass="$APP_RUNTIME_PASSWORD" <<'SQL'
CREATE ROLE app_migrator LOGIN CREATEDB PASSWORD :'mig_pass';
CREATE ROLE app_runtime  LOGIN PASSWORD :'rt_pass';

ALTER DATABASE :"dbname" OWNER TO app_migrator;
ALTER SCHEMA public OWNER TO app_migrator;

GRANT CONNECT ON DATABASE :"dbname" TO app_runtime;
GRANT USAGE ON SCHEMA public TO app_runtime;

ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;
SQL
