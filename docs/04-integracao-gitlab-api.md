# 04 — Integração com a API do GitLab

Base: `${GITLAB_BASE_URL}/api/v4`. Autenticação: header `PRIVATE-TOKEN: <pat>`.

> ⚠️ Confirmar cada endpoint na documentação da **versão exata** da instância antes de implementar (Fase 0 do plano).

## 1. Endpoints utilizados

### 1.1 Identidade e capacidades

| Uso | Método e rota | Permissão | Campos usados |
|-----|---------------|-----------|---------------|
| Quem sou eu | `GET /user` | `read_user`/`api` | `id`, `username`, `name`, `is_admin` (só vem para admins), `avatar_url` |
| Dados do PAT atual | `GET /personal_access_tokens/self` | qualquer PAT válido | `id`, `name`, `scopes[]`, `expires_at`, `active`, `revoked`, `last_used_at` |
| Versão da instância | `GET /version` | `read_api`/`api` | `version` |

### 1.2 Usuários GitLab (admin)

| Uso | Método e rota | Permissão | Respostas relevantes |
|-----|---------------|-----------|----------------------|
| Buscar | `GET /users?search=<q>&per_page=20&page=n` | admin + `read_api`/`api` | Para admin: `state`, `two_factor_enabled`, `last_sign_in_at`, `locked` |
| Filtrar bloqueados | `GET /users?blocked=true` | admin | |
| Detalhe | `GET /users/:id` | admin | idem |
| **Bloquear** | `POST /users/:id/block` | admin + `api` (+ `admin_mode`) | `201` sucesso · `403` sem permissão ou usuário protegido pela instância · `404` |
| **Desbloquear** | `POST /users/:id/unblock` | admin + `api` (+ `admin_mode`) | `201` sucesso · `403` usuário `ldap_blocked` ou sem permissão · `404` |
| **Desabilitar MFA** | `PATCH /users/:id/disable_two_factor` | admin + `api` (+ `admin_mode`) | `204` sucesso · `400` usuário sem 2FA · `403` · `404`. **Regra do GitLab (confirmada na doc oficial): administradores não podem desabilitar o 2FA da própria conta nem de outros administradores pela API** (só pelo console Rails) |

Observações:
- **Bloquear** só é oferecido para `state = active` e **nunca para a própria conta GitLab do operador** (bloquear a si mesmo derrubaria o PAT em uso e o acesso à ferramenta; a trava vale na UI e no servidor). Ao bloquear um admin GitLab o diálogo traz um aviso extra. ⚠ O endpoint `block` e seus códigos de erro ainda precisam ser conferidos na versão real da instância (Fase 0).
- `ldap_blocked` **não** pode ser desbloqueado pela API: o bloqueio vem do LDAP/AD.
- `deactivated` (`POST /users/:id/activate`) e `banned` (`POST /users/:id/unban`) ficam fora do MVP. A UI exibe o estado e informa que a ação não é suportada.
- `locked` (bloqueio temporário por senha errada no GitLab) não é o mesmo que `blocked`: expira sozinho. Ver questão Q6.

### 1.2b Licença da instância (admin)

| Uso | Método e rota | Permissão | Campos usados |
|-----|---------------|-----------|---------------|
| Licença | `GET /license` | admin | `plan`, `expires_at`, `expired`, `user_limit`, `maximum_user_count`, `active_users`, `overage` |

A tela de usuários mostra, no topo, **Users in subscription** (`user_limit`), **Maximum Users** (`maximum_user_count`), **Billable users** (`active_users`) e **Users over License** (`overage`, em destaque quando > 0), mais plano e validade. ⚠ A doc oficial só define `overage` (= usuários cobráveis − licenciados); o **mapeamento dos outros rótulos para os campos é inferido** do exemplo da doc, e cada número traz um tooltip com o campo de origem para conferência com o painel do GitLab. Sem licença instalada (edição Community) o endpoint pode responder 404: a tela mostra um aviso e a busca segue funcionando.

### 1.2c Credenciais de outros usuários e configurações da instância (admin)

| Uso | Método e rota | Observações (fonte: docs.gitlab.com) |
|-----|---------------|---------------------------------------|
| Listar PATs da instância | `GET /personal_access_tokens?state=active&user_id=&per_page=100` | Admin vê todos. Campos: `id`, `user_id`, `name`, `created_at`, `last_used_at`, `expires_at`, `revoked`, `active`. A doc **não diz** se inclui tokens de projeto/grupo (bots) |
| Revogar PAT de qualquer usuário | `DELETE /personal_access_tokens/:id` | `204`; `400/401/403` |
| Listar chaves SSH de um usuário | `GET /users/:id/keys` | **Não há endpoint global**: só por usuário. A doc **não lista `last_used_at`** na resposta |
| Remover chave SSH de um usuário | `DELETE /users/:id/keys/:key_id` | Admin. Códigos de resposta não documentados |
| Ler/definir limite de validade do PAT | `GET`/`PUT /application/settings` (`max_personal_access_token_lifetime`) | **Só Ultimate (self-managed)**, **≤ 365 dias** (400 com feature flag). Ao definir/alterar, o GitLab **revoga** os tokens com expiração além do prazo |

Os `scopes` do PAT já vêm na listagem (sem chamada extra); da chave SSH usa-se `usage_type`.

**Como a limpeza decide** (`src/lib/cleanup-rules.ts`, função pura e testada): um PAT/chave é candidato se (a) o dono está `blocked`/`ldap_blocked` **e/ou** (b) o último uso (ou, se nunca usado, a criação) é **mais antigo** que N dias — "mais de N" é estrito (exatamente N dias não conta). Sem nenhuma data → desconhecido → **nunca** é candidato.

**Limitações que precisam ser conferidas na sua versão (Fase 0):**
- **Chave SSH sem `last_used_at`**: se o GitLab não devolver o campo, a chave **não** é considerada "sem uso" (aviso na tela); só entra pelo critério de usuário bloqueado. A *presença* do campo é checada (ausente ≠ `null`).
- **Bots**: tokens de projeto/grupo são excluídos pelo `bot`, `user_type ≠ human` ou padrão de username `(project|group)_N_bot…`. Se a sua versão não expuser nenhum desses sinais, a exclusão depende só do padrão do username.
- `GET /users` pode não incluir bloqueados por padrão: por isso a ferramenta faz **duas** listagens (todos + `blocked=true`) e mescla.
- **Regra de corte da simulação**: considera "PAT ativo com expiração depois de hoje + N dias". A doc diz apenas "tokens com expiração além do prazo máximo"; trate o número como estimativa.
- No Ultimate-less, o `PUT` pode responder 200 **ignorando** o campo: a ferramenta só considera aplicado se o valor devolvido for igual ao enviado (`GITLAB_SETTING_NOT_APPLIED`).

### 1.3 PAT próprio

| Uso | Método e rota | Permissão | Respostas |
|-----|---------------|-----------|-----------|
| **Rotacionar** | `POST /personal_access_tokens/self/rotate` com body `{ "expires_at": "YYYY-MM-DD" }` | scope `api` **ou** `self_rotate` | `200` `{ id, name, scopes, expires_at, token, ... }` · `400` data inválida · `401` · `403` scope insuficiente · `405` token já revogado/expirado |

Regras da rotação:
1. O PAT antigo é **revogado imediatamente** quando o GitLab responde com sucesso.
2. **Detecção de reuso**: se um PAT antigo da cadeia de rotação for usado de novo, o GitLab revoga também o mais recente. **Nunca fazer retry com o PAT antigo** depois de um `200`.
3. Sem `expires_at`, o GitLab aplica um padrão curto (uma semana, limitado pela política da instância). **A ferramenta sempre envia a data explicitamente.**
4. O novo PAT mantém o nome e os scopes do anterior.
5. Timeout ou erro de rede durante a rotação deixa o resultado **ambíguo** (seção 4).

## 2. Matriz de capacidades

Calculada ao vincular o PAT, recalculada a cada rotação ou substituição e persistida em `GitLabToken.capabilities`.

| Capability | Regra | Telas liberadas |
|-----------|-------|-----------------|
| `READ_USERS` | `is_admin` && scopes ∩ {`api`, `read_api`} ≠ ∅ | Busca e detalhe de usuários GitLab |
| `ADMIN_USERS` | `is_admin` && `api` ∈ scopes && (`!GITLAB_ADMIN_MODE_ENABLED` \|\| `admin_mode` ∈ scopes) | Desbloquear, resetar MFA |
| `SELF_ROTATE` | scopes ∩ {`api`, `self_rotate`} ≠ ∅ | Rotacionar meu PAT |

As capabilities **não dependem do papel na ferramenta**: um `admin` da ferramenta com PAT de usuário comum do GitLab não desbloqueia ninguém, e um `user` da ferramenta com PAT de admin GitLab desbloqueia.

## 3. GitLabClient — contrato

```ts
// src/server/gitlab/client.ts
import 'server-only';

export class GitLabClient {
  constructor(private readonly token: string, private readonly baseUrl = env.GITLAB_BASE_URL) {}

  getCurrentUser(): Promise<GitLabCurrentUser>;
  getCurrentToken(): Promise<GitLabTokenInfo>;
  getVersion(): Promise<{ version: string }>;

  searchUsers(params: { search?: string; blocked?: boolean; page?: number; perPage?: number })
    : Promise<Paginated<GitLabUser>>;   // headers X-Page, X-Total-Pages, X-Next-Page
  getUser(id: number): Promise<GitLabUser>;
  unblockUser(id: number): Promise<void>;
  disableTwoFactor(id: number): Promise<void>;

  rotateSelf(expiresAt: string): Promise<GitLabRotatedToken>;
}
```

Requisitos:
- `AbortSignal.timeout(env.GITLAB_TIMEOUT_MS)` em todas as chamadas.
- **Sem retry** em `unblockUser`, `disableTwoFactor` e `rotateSelf`. Nos `GET`, retry com backoff (no máximo 2 vezes) apenas para `429`/`5xx`, respeitando `Retry-After`.
- Respostas validadas com zod 4 (`z.looseObject`, para tolerar campos novos entre versões).
- Erros convertidos em `GitLabApiError { status, code, retryable }`. O corpo bruto nunca chega ao usuário e só vai para o log depois de sanitizado.
- O token nunca aparece em mensagens de erro, logs ou stack traces.

## 4. Mapeamento de erros

| Situação | `code` interno | Mensagem ao usuário | Efeito |
|----------|---------------|---------------------|--------|
| `401` | `GITLAB_TOKEN_INVALID` | "Seu token GitLab é inválido, expirou ou foi revogado. Vincule um novo token." | PAT → `REVOKED`. A **sessão da ferramenta continua**; redireciona para `/token` |
| `403` em ação admin | `GITLAB_FORBIDDEN` | "Seu token não tem permissão para esta ação. Requer admin GitLab + scope `api` (e `admin_mode`, se aplicável)." | Recalcula as capabilities |
| `403` em unblock de `ldap_blocked` | `GITLAB_LDAP_BLOCKED` | "Usuário bloqueado pelo LDAP/AD. O desbloqueio deve ser feito no diretório." | |
| `400` em disable 2FA | `GITLAB_2FA_NOT_ENABLED` | "Este usuário não tem MFA habilitado no GitLab." | Recarrega os dados |
| `404` | `GITLAB_NOT_FOUND` | "Usuário não encontrado no GitLab." | |
| `429` | `GITLAB_RATE_LIMITED` | "Limite de requisições do GitLab atingido. Tente em alguns segundos." | |
| `5xx`/rede | `GITLAB_UNAVAILABLE` | "GitLab indisponível no momento." | |
| Timeout na rotação | `GITLAB_ROTATION_UNKNOWN` | ver abaixo | |

### Rotação com resultado ambíguo

1. **Não** reenviar o rotate.
2. Fazer **uma única** chamada `GET /personal_access_tokens/self` com o PAT antigo:
   - `200` e `active: true` → a rotação não aconteceu; informar o erro e permitir nova tentativa.
   - `401` → a rotação provavelmente aconteceu e o novo PAT se perdeu. Marcar `REVOKED_UNKNOWN` e orientar o usuário a criar um novo PAT no GitLab e vinculá-lo.
   > Validar na Fase 0 se esse `GET` com PAT já rotacionado dispara a detecção de reuso (questão Q10). Se disparar, remover a verificação e ir direto à orientação.
3. Registrar `AuditLog(GITLAB_TOKEN_ROTATED, UNKNOWN)`.

## 5. TLS e certificado auto-assinado

Instâncias auto-gerenciadas costumam usar CA interna ou certificado auto-assinado. A verificação TLS fica **ligada por padrão**; o deploy escolhe uma destas saídas:

| Opção | Configuração | Quando |
|-------|--------------|--------|
| **Confiar na CA** (recomendado) | `NODE_EXTRA_CA_CERTS=/certs/ca.pem` (monte o arquivo no container) | Há uma CA interna ou o certificado pode ser exportado |
| **Ignorar a verificação** | `GITLAB_TLS_INSECURE=true` | Não há CA para confiar. O PAT passa a trafegar **sem garantia de que o servidor é o GitLab** |

**Implementação** (`src/server/gitlab/client.ts`):
- A opção cria um `undici.Agent({ connect: { rejectUnauthorized: false } })` usado **somente** pelo `GitLabClient`. Não se usa `NODE_TLS_REJECT_UNAUTHORIZED=0`, que desligaria a verificação para o processo inteiro (inclusive banco e better-auth). Há teste de que o `fetch` global **continua rejeitando** o certificado após uma chamada insegura.
- É decisão do **deploy**, não da tela: um operador com um PAT de admin não deve poder desligar a verificação.
- O app registra um `warn` no primeiro uso e a UI exibe o selo **"TLS do GitLab sem verificação"** em todas as telas.
- Sem nenhuma das duas opções, o erro é `GITLAB_TLS_ERROR` (cobre `SELF_SIGNED_CERT`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, cert expirado, nome inválido…), com a orientação acima, e **nenhuma requisição (nem o token) é enviada**.
- Avatares do GitLab não são carregados (iniciais no lugar): o browser os bloquearia com certificado auto-assinado, e isso mantém a CSP restrita (`img-src 'self' data:`).

## 6. Mensagens de erro do GitLab
O 403 do GitLab **não** significa necessariamente falta de scope. A ferramenta já sabe os scopes do PAT (guardados no vínculo) e checa a capacidade antes de chamar; um 403 depois disso vem de uma regra do próprio GitLab. Por isso:
- Para o reset de MFA, o alvo administrador (ou a própria conta) é barrado **antes** da chamada, com `GITLAB_ADMIN_2FA_UNSUPPORTED`. A tela não oferece o botão e mostra no lugar o **passo a passo pelo console Rails** (`TwoFactor::DestroyService.new(admin, user: alvo).execute`, fonte: docs.gitlab.com/security/two_factor_authentication), já preenchido com os usernames. Os usernames só são interpolados se casarem com `[A-Za-z0-9._-]`; senão vira placeholder (o comando é colado num console de produção). A ferramenta **não executa nem audita** essa ação, que acontece fora dela.
- As respostas 400/401/403/404 repassam ao usuário um trecho curto (≤ 200 caracteres) do `message` devolvido pelo GitLab, com o token redigido (`[token]`), para diagnóstico. O corpo bruto continua não sendo logado.
