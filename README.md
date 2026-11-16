# GitLab Wizard

Interface web para operações administrativas no GitLab com o **PAT do próprio usuário** (Next.js 16 + better-auth + PostgreSQL).
Funciona com GitLab **auto-gerenciado**, inclusive com **certificado auto-assinado**.

- **Entrar**: usuário + senha + 2FA (TOTP) da ferramenta; contas criadas pelo admin.
- **Bloquear e desbloquear** usuário GitLab e **resetar o MFA** dele (motivo obrigatório, tudo auditado).
- **Limpar credenciais**: varredura (dry-run) de tokens e chaves SSH de usuários bloqueados, sem uso há N dias (N configurável na tela) e/ou **chaves SSH sem prazo de validade**, revisão e revogação auditada.
- **Cofres de token** (`/admin/vault`): valida a expiração do token de cada projeto-cofre em `seguranca-corporativa/<ambiente>/<aplicação>`, e cria ou rotaciona o token gravando `PID_<AMB>`/`DEVOPS_<AMB>` no grupo da aplicação (dry-run, validação antes de revogar o antigo, auditoria), com **rotação automática** opcional quando o token vence ou entra no prazo de alerta. Ver [docs/13](docs/13-cofre-de-tokens-de-projeto.md).
- **Runners** (`/runners`): cria runners **globais**, **de grupo** e **de projeto** (token mostrado uma vez + comando de registro), lista, pausa e remove. Ver [docs/14](docs/14-runners.md).
- **Políticas**: prazo máximo de validade do PAT na ferramenta e (após simulação) no GitLab.
- **Vários tokens por conta**: cadastre quantos PATs quiser (do mesmo usuário GitLab), veja os escopos de cada um, defina o **padrão** e escolha qual está **em uso**.
- **Rotacionar o seu PAT** e salvá-lo cifrado (AES-256-GCM) automaticamente.

Planejamento, especificação e decisões: [`docs/`](docs/README.md). Operação: [`docs/12-runbook.md`](docs/12-runbook.md).

## Requisitos
Node 26, npm 11, Docker com Compose v2.

## Desenvolvimento (app no host, banco no Docker)
```bash
cp .env.example .env            # preencha os segredos (openssl rand -base64 32) e GITLAB_BASE_URL
docker compose up -d db         # Postgres 18 + papéis app_migrator / app_runtime
npm ci
npm run db:generate && npm run db:deploy
npm run create-admin            # 1º admin (SEED_ADMIN_* no .env); imprime a senha temporária UMA vez
npm run dev                     # http://localhost:3000
```

## Stack completa em containers (igual à produção)
```bash
docker compose --profile app up -d --build           # db → migrate (uma vez) → app
docker compose --profile tools run --rm create-admin # 1º admin
curl localhost:3000/api/health
```

## GitLab com certificado auto-assinado
Por padrão o certificado é **verificado**. Se o seu GitLab usa CA interna ou certificado auto-assinado, escolha uma:

| Opção | Como | Observação |
|-------|------|-----------|
| **Confiar na CA** (recomendado) | `NODE_EXTRA_CA_CERTS=/certs/ca.pem` + montar o arquivo (exemplo comentado no `docker-compose.yml`) | Verificação completa |
| **Ignorar a verificação** | `GITLAB_TLS_INSECURE=true` | Só para as chamadas ao GitLab. O PAT trafega sem garantia de que o servidor é o GitLab; a UI exibe um aviso permanente |

## Testes
```bash
npm run lint && npm run typecheck && npm test   # 228 unitários
npm run test:integration                        # 302 — Postgres real (Testcontainers) + GitLab falso
npm run test:coverage                           # unit + integração, cobertura mesclada com limites mínimos (coverage/index.html)
npm run test:e2e                                # 63 — build + Chromium + axe (WCAG 2.1 AA)
```

## Imagens de produção
```bash
docker build -t gitlab-wizard:1.0.0 .                          # runner: standalone, usuário não-root
docker build --target migrate -t gitlab-wizard-migrate:1.0.0 . # job de migrations
```
Rode `migrate` a cada deploy com `DATABASE_MIGRATION_URL` (`app_migrator`) e o app com `DATABASE_URL` (`app_runtime`, sem DDL). O app **recusa subir** com configuração inválida. Checklist de produção (proxy, `CLIENT_IP_HEADER`, segredos): [runbook §2](docs/12-runbook.md#2-checklist-de-produção).

## Notas
- Porta 5432 ocupada? Ajuste `DB_PORT` **e** a porta nas URLs do `.env` (padrão local: 5433).
- `docker/postgres/01-roles.sh` só roda na criação do volume. Recriar do zero: `docker compose down -v`.
- Sem `CLIENT_IP_HEADER` atrás de um proxy, o rate limit de login/2FA é **compartilhado por todos** (o app avisa no boot).
