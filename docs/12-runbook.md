# 12 — Runbook de operação

## 1. Primeiro deploy

```bash
cp .env.example .env     # preencha segredos (openssl rand -base64 32), GITLAB_BASE_URL, CLIENT_IP_HEADER, etc.
docker compose --profile app up -d --build           # db → migrate (uma vez) → app
docker compose --profile tools run --rm create-admin # imprime a senha temporária do 1º admin UMA vez
```
O admin entra, é **obrigado** a trocar a senha e a configurar o 2FA, e depois cria as demais contas em *Contas da ferramenta*.

Em produção real use as imagens publicadas pelo CI: `…/gitlab-wizard:<tag>` (app, `DATABASE_URL` = `app_runtime`) e `…/gitlab-wizard/migrate:<tag>` (job a cada deploy, `DATABASE_MIGRATION_URL` = `app_migrator`). O Postgres de produção deve ter os dois papéis criados como em `docker/postgres/01-roles.sh`.

## 2. Checklist de produção
- [ ] `BETTER_AUTH_URL` = URL pública **https**; proxy reverso encaminha `X-Forwarded-Host`/`Proto` (a checagem de origem das Server Actions do Next compara `Origin` com o host).
- [ ] **`CLIENT_IP_HEADER`** = header que **o seu proxy sobrescreve** (ex.: `x-forwarded-for`). Sem isso, o rate limit de login/2FA vira **um balde único para todos** (o app avisa no boot). Nunca aponte para um header que o cliente possa forjar.
- [ ] `REQUIRE_APP_2FA=true`. Segredos vindos de Vault/KMS, **distintos** entre si (`BETTER_AUTH_SECRET` ≠ chaves do PAT).
- [ ] GitLab com certificado de CA interna: monte a CA e defina `NODE_EXTRA_CA_CERTS` (**preferível**). Só se não houver CA: `GITLAB_TLS_INSECURE=true` (a UI mostra um aviso permanente).
- [ ] `MAINTENANCE_SECRET` definido + CronJob diário (abaixo). Backups do Postgres.
- [ ] Usuário de banco do app **sem DDL** e sem `UPDATE/DELETE` em `audit_log` (a migration já revoga do papel `app_runtime`).

## 3. GitLab com certificado auto-assinado
| Opção | Como | Segurança |
|-------|------|-----------|
| **Confiar na CA** (recomendado) | `NODE_EXTRA_CA_CERTS=/certs/ca.pem` + montar o arquivo | Verificação TLS completa |
| Ignorar a verificação | `GITLAB_TLS_INSECURE=true` | **Sem garantia de que o servidor é o GitLab**: o PAT trafega para quem responder naquele endereço. Vale **só** para chamadas ao GitLab (não para banco, nem para o resto do processo). Decisão do deploy, não do usuário |

Sem nenhuma das duas, o erro mostrado é `GITLAB_TLS_ERROR` com a orientação.

## 4. Manutenção (retenção)
```yaml
# CronJob (exemplo): diário
curl -fsS -X POST -H "Authorization: Bearer $MAINTENANCE_SECRET" https://wizard.empresa.com/api/internal/maintenance
```
Remove sessões vencidas há 7+ dias, rate limits e verificações antigos, **varreduras da limpeza/simulações com 30+ dias** e **zera o ciphertext** de PATs inativos há 30+ dias. Idempotente.

## 5. Rotação da chave de cifragem do PAT
1. Gere uma chave: `openssl rand -base64 32`.
2. Acrescente a versão nova **mantendo as antigas**: `TOKEN_ENCRYPTION_KEYS=v1:…,v2:…` e `TOKEN_ENCRYPTION_ACTIVE_KEY=v2`. Reinicie o app (novos PATs já usam a v2).
3. Recifre os existentes: `docker compose --profile tools run --rm create-admin npm run reencrypt-tokens` (sai com código 1 se algo ficar pendente).
4. Com `Pendentes: 0`, remova a v1 de `TOKEN_ENCRYPTION_KEYS`.

## 6. Rotação do `BETTER_AUTH_SECRET`
Invalida os cookies assinados: **todos os usuários precisam logar de novo**. Troque o segredo e reinicie. Não afeta os PATs (chave própria).

## 7. Incidentes
| Situação | Ação |
|----------|------|
| **Vazamento do banco** | Os PATs estão cifrados e a chave fica fora do banco. Mesmo assim: rotacione `TOKEN_ENCRYPTION_KEYS` e `BETTER_AUTH_SECRET`, **revogue os PATs no GitLab**, force troca de senha (`Redefinir senha`) |
| **Vazamento da chave de cifragem + banco** | Revogue **todos** os PATs no GitLab imediatamente; depois rotacione as chaves |
| Conta de operador comprometida | *Banir conta* (encerra sessões) → revogar o PAT dele no GitLab → investigar em *Auditoria* |
| Perdeu o autenticador (2FA) | Admin: *Resetar 2FA* (e, se preciso, *Redefinir senha*) |
| **Perdeu o único admin** (esqueceu a senha e o 2FA, ou ele foi banido) | Rode `create-admin` com **outro** username: ele só se recusa se existir um admin **ativo** (não banido). Depois, com o novo admin, resete/reative a conta antiga |
| Rotação do PAT com `REVOKED_UNKNOWN` | A rotação pode ter ocorrido e o token novo se perdeu: crie outro PAT no GitLab e cadastre-o em *Adicionar outro token* |

## 8. Comandos úteis
```bash
docker compose logs -f app                      # logs JSON (pino); tokens/senhas são redigidos
docker compose exec db psql -U postgres gitlab_wizard
npm run auth:generate                           # compara o schema do better-auth após atualizar a lib
```
