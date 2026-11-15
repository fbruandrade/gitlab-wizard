-- AlterTable
ALTER TABLE "gitlab_token" ADD COLUMN     "is_default" BOOLEAN NOT NULL DEFAULT false;

-- ─────────────────────────────────────────────────────────────────────────────
-- Vários tokens por conta, com UM padrão (docs/05-modelo-de-dados.md §5)
-- ─────────────────────────────────────────────────────────────────────────────

-- Contas existentes tinham no máximo um token ATIVO: ele passa a ser o padrão.
UPDATE "gitlab_token" SET "is_default" = true WHERE "status" = 'ACTIVE';

-- Antes: 1 token ativo por conta / por usuário GitLab. Agora isso vale só para o PADRÃO.
DROP INDEX "gitlab_token_one_active_per_user";
DROP INDEX "gitlab_token_one_active_per_gitlab_user";

-- Exatamente um padrão por conta da ferramenta.
CREATE UNIQUE INDEX "gitlab_token_one_default_per_user"
  ON "gitlab_token" ("user_id") WHERE "status" = 'ACTIVE' AND "is_default";

-- Um usuário GitLab é o padrão de, no máximo, uma conta da ferramenta. Como toda conta com tokens ativos tem um
-- padrão (invariante mantido em transação), isso garante: o mesmo usuário GitLab não fica em duas contas.
CREATE UNIQUE INDEX "gitlab_token_one_default_per_gitlab_user"
  ON "gitlab_token" ("gitlab_base_url", "gitlab_user_id") WHERE "status" = 'ACTIVE' AND "is_default";

-- O mesmo PAT (id no GitLab) não pode estar ativo duas vezes.
CREATE UNIQUE INDEX "gitlab_token_one_active_per_pat"
  ON "gitlab_token" ("gitlab_base_url", "gitlab_token_id") WHERE "status" = 'ACTIVE';
