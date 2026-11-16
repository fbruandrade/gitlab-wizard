# 13 — Cofre de tokens de projeto (Segurança Corporativa → grupos das esteiras)

> **Status (16/11/2026): implementado e testado** (tela `/admin/vault`, 29 testes de integração, 1 roteiro E2E; ver [09 §8](09-estrategia-de-testes.md#8-cofres-de-token-de-projeto-docs13)). Os endpoints do GitLab **ainda precisam ser validados na sua versão real** (fase V0): só foram exercitados contra o GitLab falso.
>
> **Decisões tomadas por falta de resposta às questões do §13 (todas configuráveis na tela, exceto onde dito):** grupo raiz `seguranca-corporativa`; token `read_api` + Maintainer; validade 180 dias; alerta 30 dias; criar → gravar → validar → revogar; variáveis em maiúsculas (`PID_<AMB>`, `DEVOPS_<AMB>`); nova `DEVOPS_` nasce **mascarada e sem `protected`** (a existente é preservada); qualquer admin da ferramenta com token `api` pode operar (o GitLab valida o papel Maintainer).
>
> **Diferenças em relação ao plano abaixo:**
> - **Sem `vault_operation`/`vault_pending_secret`/`vault_mapping`/`vault_item`:** a varredura reutiliza `admin_scan` (tipo `VAULT`) e a configuração fica em `app_setting` (`vault.config`). Não é preciso guardar o segredo: o token novo só é gravado na variável do GitLab, e o antigo só é revogado depois. Se a gravação falhar, o novo é descartado; se o resultado for incerto (nem dá para reler a variável), **nada é revogado** e o item vira `NEEDS_ATTENTION`.
> - **Sem exceção manual de grupo de destino:** quem não tem grupo raiz de mesmo nome aparece como `NO_TARGET_GROUP`, sem ação. Não há busca por aproximação.
> - **Grupo raiz de um único nível** (ex.: `seguranca-corporativa`).
> - **Trava por cofre só no processo** (instância única); a reavaliação imediatamente antes de aplicar cobre o resto. Execução **sequencial**, no máximo **50** cofres por vez.
> - **Rotação nativa do GitLab não foi implementada** (só criar → trocar → revogar).
> - Variável com `environment_scope` diferente de `*` bloqueia a ação (`VAR_SCOPE`); variável **oculta** impede a conferência (`UNVERIFIED`) mas não a rotação.
> - **Renovação forçada** (adicionada depois): opção "Forçar renovação" na varredura inclui no plano, como `ROTATE` marcado "renovação forçada", os cofres com **um único token ativo e grupo de destino conhecido** mesmo que estejam OK ou não verificáveis (ex.: suspeita de vazamento). Segue o mesmo fluxo seguro (dry-run, motivo, `APLICAR`, criar → gravar → validar → revogar) e a auditoria registra `forced: true`. Cofres com vários tokens ativos, sem grupo de destino ou com variável bloqueada continuam sem ação.
> - Capability nova `VAULT_TOKENS` (scope `api`); migração marca os tokens já vinculados.

## 1. O cenário

```
/seguranca-corporativa                 ← grupo raiz dos cofres
  ├── hml
  │     └── areacorp-jks               ← projeto = cofre de segredos do grupo /areacorp-jks
  │            └── Project Access Token  (usado pela esteira para ler as variáveis do cofre)
  └── prd
        └── areacorp-jks
/areacorp-jks                          ← grupo da aplicação (grupo raiz com o mesmo nome do projeto)
   variáveis de grupo: PID_HML    = id do projeto /seguranca-corporativa/hml/areacorp-jks
                       DEVOPS_HML = token de acesso desse projeto
                       PID_PRD / DEVOPS_PRD = idem para prd
```

Regra de mapeamento (derivada do caminho):

| Parte do caminho | Significado | Exemplo |
|---|---|---|
| `seguranca-corporativa` | grupo raiz dos cofres (configurável) | — |
| 2º nível (`hml`, `prd`) | **ambiente** → sufixo das variáveis (`PID_HML`) | `hml` |
| projeto (`areacorp-jks`) | **aplicação** → grupo raiz de destino `/areacorp-jks` | `areacorp-jks` |

## 2. O que a ferramenta vai fazer

1. **Inventário**: percorrer `seguranca-corporativa/*/*` e listar, por cofre: ambiente, aplicação, tokens do projeto (nome, escopos, papel, criação, **validade**, último uso), grupo de destino e situação das variáveis.
2. **Validade**: classificar cada cofre (§4) e destacar o que vence em N dias (N configurável na tela, como na limpeza).
3. **Rotacionar** o token e **gravar o novo valor** em `DEVOPS_<AMB>` do grupo da aplicação, sem janela em que a esteira fique quebrada.
4. **Criar** (quando não há token): criar o token no projeto-cofre, achar o grupo raiz de mesmo nome e **criar `PID_<AMB>` e `DEVOPS_<AMB>`**.
5. Sempre com **dry-run** antes de aplicar, **auditoria** e proteção contra falha no meio (§6).

## 3. Decisões de desenho

### 3.1 Rotacionar = "criar novo → gravar → validar → revogar o antigo"
O endpoint nativo `POST /projects/:id/access_tokens/:token_id/rotate` **revoga o token antigo na hora** e devolve o novo valor **uma única vez**. Se a gravação em `DEVOPS_<AMB>` falhar depois disso (rede, 403, grupo inexistente), o valor está perdido e **todas as esteiras do grupo quebram**.

Por isso o padrão é:

1. `POST /projects/:id/access_tokens` — cria o novo token com **mesmo nome (sufixo de data), escopos e papel** do atual e validade escolhida.
2. Guarda o valor **cifrado** (AES-256-GCM, mesma chave versionada do PAT) em `vault_pending_secret`.
3. `PUT /groups/:gid/variables/DEVOPS_<AMB>` com o novo valor.
4. **Valida a sincronia**: lê a variável de volta e chama `GET /personal_access_tokens/self` com ela; o `id` retornado deve ser o do token novo.
5. `DELETE /projects/:id/access_tokens/:old_id` — só agora revoga o antigo.
6. Apaga o segredo pendente.

Esteiras em execução durante o passo 3 continuam válidas (o antigo só morre no 5). Se algo falhar nos passos 3–4, **nada foi revogado**; o segredo pendente permite repetir. O `rotate` nativo fica como opção avançada (para quem quer manter o mesmo token id), com aviso do risco.

### 3.2 Chaves e escopos mínimos do token do cofre
A esteira só precisa **ler variáveis do projeto**: escopo `read_api` e papel **Maintainer** (a API de variáveis de projeto exige Maintainer; `read_repository` não serve). *Confirmar na Fase 0 se o que vocês usam hoje é exatamente isso e copiar o padrão atual em vez de inventar outro.*

### 3.3 Validade
O GitLab limita a vida de token (padrão 365 dias; configurável por admin em versões recentes). A ferramenta usa a **política já existente** (tela de Políticas) como teto e sugere o mesmo prazo padrão para cofres; `expires_at` é **sempre enviado explicitamente** (o `rotate` sem `expires_at` cria token de 1 semana em algumas versões — armadilha).

### 3.4 Variáveis de grupo
- `PID_<AMB>`: tipo variável, **não** mascarada (é só um número, útil para depuração).
- `DEVOPS_<AMB>`: **masked** (ou **masked and hidden**, GitLab ≥ 17.4) + **protected** quando as branches/tags de deploy são protegidas. Se o grupo já tem a variável, **atualiza preservando** `protected`, `masked`, `environment_scope`; nunca troca esses atributos em silêncio.
- Nome da variável: `PID_` + ambiente em **maiúsculas** (confirmar se existe algum caso em minúsculas hoje).
- Variável `hidden` não pode ser relida → a validação do passo 4 vira "melhor esforço" (valida só o que dá, e o resultado vai como `UNVERIFIED`).

### 3.5 Quem opera
A ferramenta usa o **PAT do próprio operador** (como o resto). Exige: `api`, e papel **Maintainer+ no projeto-cofre** (criar/revogar token) e **Maintainer+ no grupo da aplicação** (gravar variáveis). Nova capacidade `VAULT_TOKENS` em `capabilities.ts`, derivada do escopo `api` (sem exigir admin). Sem o papel necessário, a tela diz exatamente o que falta e em qual caminho.

## 4. Estados do cofre

| Estado | Condição | Ação sugerida |
|---|---|---|
| `NO_TOKEN` | projeto sem token ativo | **Criar** |
| `EXPIRED` | todos os tokens ativos vencidos | Criar/rotacionar (urgente) |
| `EXPIRING` | menor validade ≤ N dias | Rotacionar |
| `OK` | token válido e variáveis sincronizadas | — |
| `NO_TARGET_GROUP` | não existe `/<aplicação>` | Escolher o grupo manualmente (§5) |
| `VARS_MISSING` | token ok, mas falta `PID_`/`DEVOPS_` | Criar variáveis |
| `OUT_OF_SYNC` | `PID_` ≠ id do projeto, ou o valor de `DEVOPS_` não corresponde ao token ativo | Rotacionar/regravar |
| `UNVERIFIED` | variável oculta/sem permissão de leitura | Informativo |
| `MULTIPLE_TOKENS` | mais de um token ativo | Revisar (o plano não revoga o que não conhece) |

## 5. Descoberta do grupo de destino
1. Tentativa direta: `GET /groups/<aplicação>` (path de grupo **raiz** = nome do projeto).
2. Se 404: busca `GET /groups?search=<aplicação>&top_level_only=true` e exige **match exato de `path`**.
3. Se houver ambiguidade, ausência ou o caminho do projeto não seguir o padrão (`ambiente` ≠ subgrupo direto): **não adivinha** — mostra para escolha manual e grava a escolha em `vault_mapping` (exceções ficam registradas, e a próxima varredura já usa).
4. Nunca cria grupo automaticamente (fora de escopo; só variáveis).

## 6. Falhas e idempotência
Cada operação é uma **máquina de estados persistida** (`vault_operation`), com passos `CREATED_TOKEN → STORED_PENDING → VARIABLE_WRITTEN → VERIFIED → OLD_REVOKED → DONE`:

- Falha antes de `VARIABLE_WRITTEN`: nada a desfazer além de revogar o token novo órfão (oferecido na tela).
- Falha entre `VARIABLE_WRITTEN` e `OLD_REVOKED`: estado `NEEDS_ATTENTION`, com botão **"Retomar"** (revoga o antigo depois de verificar).
- Resposta ambígua (timeout) numa escrita: **nunca repete às cegas**; relê o estado no GitLab e decide (mesma regra de `PARTIAL/UNKNOWN` da rotação do PAT).
- Lock consultivo por cofre (advisory lock) — duas pessoas não rotacionam o mesmo cofre ao mesmo tempo.
- O valor do token **nunca** vai para log, auditoria, URL ou resposta de lista; só para a variável do GitLab e (cifrado, temporário) ao `vault_pending_secret`.

## 7. Modelo de dados (Prisma)

| Tabela | Campos principais |
|---|---|
| `vault_scan` | id, executado por, início/fim, status, parâmetros (N dias) |
| `vault_item` | scan_id, caminho do projeto, project_id, ambiente, aplicação, estado, token_id, nome, escopos, papel, `expires_at`, `last_used_at`, group_id destino, flags das variáveis |
| `vault_mapping` | caminho do projeto → group_id (exceções manuais), criado por |
| `vault_operation` | id, tipo (`CREATE`/`ROTATE`), projeto, passo atual, token novo/antigo (ids), erro, operador |
| `vault_pending_secret` | operation_id, valor cifrado (AES-GCM, AAD `operationId`), expira em 1 h |
| `app_setting` (existente) | `vault.rootGroup`, `vault.warnDays`, `vault.defaultLifetimeDays`, `vault.defaultScopes`, `vault.defaultAccessLevel` |

Todas as ações vão para o `audit_log` append-only existente (`VAULT_SCAN`, `VAULT_TOKEN_CREATED`, `VAULT_TOKEN_ROTATED`, `VAULT_VARIABLE_WRITTEN`, `VAULT_TOKEN_REVOKED`…), com ids e caminhos, **sem valores**.

## 8. Integração com a API do GitLab

| Objetivo | Endpoint |
|---|---|
| Listar subgrupos (ambientes) | `GET /groups/:id/subgroups` |
| Listar projetos de cada ambiente | `GET /groups/:id/projects` (paginação `x-next-page`, já suportada) |
| Listar tokens do projeto | `GET /projects/:id/access_tokens?state=active` |
| Criar token | `POST /projects/:id/access_tokens` (`name`, `scopes[]`, `access_level`, `expires_at`) |
| Revogar token | `DELETE /projects/:id/access_tokens/:token_id` |
| (Opcional) rotação nativa | `POST /projects/:id/access_tokens/:token_id/rotate` |
| Achar grupo de destino | `GET /groups/:path`, `GET /groups?search=` |
| Ler/gravar variáveis | `GET/POST/PUT /groups/:id/variables[/:key]` |
| Validar o valor gravado | `GET /personal_access_tokens/self` usando o valor lido |

Reaproveita o `GitLabClient` (retry só em GET, sem retry em escrita, redação de token, TLS opcional). Novo serviço `vault-token.service.ts`, regras puras em `src/lib/vault-rules.ts` (classificação de estado, nomes das variáveis, mapeamento do caminho — **100% de cobertura**, como `cleanup-rules.ts`).

## 9. Telas

1. **`/admin/vault` — Cofres de token** (tabela): aplicação, ambiente, estado (badge), validade (com dias restantes), escopos/papel, grupo destino, última verificação. Filtros por ambiente/estado, campo de dias de alerta, botão **Varrer** (em segundo plano com progresso, igual à limpeza).
2. **Dry-run**: ao escolher cofres e a ação (Criar/Rotacionar/Regravar variáveis), mostra **o que será feito, em ordem, por cofre**: token novo (nome, escopos, validade), variável alvo (`/areacorp-jks` → `DEVOPS_HML`, criar × atualizar, atributos mantidos) e o token antigo que será revogado. Nenhum valor aparece. Só habilita "Aplicar" para o que passou.
3. **Aplicação**: execução cofre a cofre (não em paralelo no mesmo grupo), com resultado por passo e botão **Retomar** nos `NEEDS_ATTENTION`.
4. **Configurações** (dentro da mesma tela): grupo raiz, dias de alerta, validade padrão, escopos/papel padrão.
5. Em lote: "rotacionar todos que vencem em N dias" com a mesma tela de dry-run; limite de itens por execução e confirmação digitando a contagem.

## 10. Segurança
- O token novo nunca é exibido (diferente do PAT pessoal); vai direto do GitLab para a variável. Opção "revelar uma vez" só para o caso de cofre sem grupo de destino, com confirmação e auditoria.
- `masked`/`protected` conforme §3.4; avisa se a variável existente **não** é masked.
- Papel mínimo no token (§3.2); aviso se o token atual tem escopo **maior** que o padrão (sugere reduzir na rotação).
- Rate limit e proteção contra clique duplo (idempotency key por operação).
- Revogação do antigo só **depois** de validar o novo.

## 11. Testes
- **Unitários**: `vault-rules` (classificação, mapeamento de caminho, nomes de variável, bordas de data).
- **Integração** (Postgres real + fake GitLab estendido com `access_tokens` de projeto, variáveis de grupo, `personal_access_tokens/self`): fluxo feliz de criar e rotacionar; falha no PUT da variável (nada revogado, segredo pendente, retomada); timeout ambíguo na escrita; variável existente com `protected`; grupo inexistente/ambíguo; 403 por papel insuficiente; concorrência (lock); o valor do token **nunca** aparece em audit/log/resposta (teste que varre).
- **E2E**: varrer → ver estados → dry-run → aplicar → ver `OK`.
- Cobertura entra no `test:coverage` com limite 100% em `vault-rules` e alto no serviço.

## 12. Fases
| Fase | Entrega | Estim. |
|---|---|---|
| V0 | Validar endpoints/papéis na sua versão; conferir como os tokens atuais foram criados (escopo, papel, validade); levantar exceções de nome | 0,5 d |
| V1 | `vault-rules` + capacidade + migração + fake GitLab | 1,5 d |
| V2 | Varredura e inventário (somente leitura) + tela de listagem | 2 d |
| V3 | Criar token + variáveis (dry-run + aplicar + auditoria) | 2,5 d |
| V4 | Rotacionar com máquina de estados e retomada | 2,5 d |
| V5 | Lote, configurações, E2E, docs/runbook | 1,5 d |
| **Total** | | **~10,5 dias** (V2 já entrega valor: enxergar vencimentos) |

## 13. Questões em aberto (preciso da sua decisão)
1. **Papel e escopo** do token do cofre hoje: `read_api` + Maintainer está correto? Há algum cofre com configuração diferente?
2. **Nomes das variáveis**: sempre `PID_<AMB>`/`DEVOPS_<AMB>` em maiúsculas? E o ambiente é sempre o **nome do subgrupo** (`hml` → `HML`)?
3. **Grupo de destino**: é sempre o grupo **raiz** com o mesmo nome do projeto? O que fazer quando o projeto tem sufixo/prefixo diferente do grupo?
4. As variáveis de `DEVOPS_` hoje são **masked/protected**? Posso padronizar (`masked and hidden`) ou devo apenas preservar o que existe?
5. **Validade padrão** do token do cofre (90/180/365 dias) e antecedência de alerta (ex.: 30 dias)?
6. Rotação preferida: **criar → trocar → revogar** (recomendada, sem janela de quebra) ou a **rotação nativa** do GitLab?
7. Quem pode operar: qualquer usuário com Maintainer nos dois caminhos, ou só um grupo restrito (ex.: Segurança)? A ferramenta pode exigir também papel interno `ADMIN`.
8. Versão do GitLab (para saber se há `hidden variables`, limite de vida do token e comportamento do `rotate`).


## 14. Rotação automática

**Implementada.** Na tela `/admin/vault` (cartão "Rotação automática") um admin habilita/desabilita. Quando habilitada, a plataforma varre os cofres periodicamente e, para os que estão **vencidos** ou a **N dias ou menos de vencer** (N = "avisar quando faltar"), aplica o mesmo fluxo seguro da tela (criar → gravar → validar → revogar o antigo).

- **Identidade:** age com o **token GitLab em uso por quem habilitou** (guardamos só o id da linha, nunca o valor) e em nome dessa pessoa na auditoria (`userAgent: vault-auto`, `auto: true`, motivo "Rotação automática…"). Se essa pessoa for banida, deixar de ser admin ou o token for desvinculado/revogado, a automação **para**, não cai para outro token e mostra o problema na tela (`ACTOR_UNAVAILABLE` / `TOKEN_UNAVAILABLE`). Habilitar exige sessão fresca.
- **Escopo:** só `EXPIRING` e `EXPIRED`. **Não** cria token em cofre que nunca teve token, **não** corrige variáveis ausentes/divergentes, **não** mexe em cofre com vários tokens ativos nem com variável bloqueada, e **não** usa "forçar renovação". Até 50 cofres por passada.
- **Gatilhos:** agendador interno (`VAULT_AUTO_INTERVAL_MINUTES`, padrão 60; `0` desliga; 1ª passada 2 min após o boot) e/ou `POST /api/internal/vault-auto` com `Authorization: Bearer $MAINTENANCE_SECRET` (CronJob). Uma **concessão no banco** (30 min) impede duas execuções simultâneas, mesmo com várias instâncias (a outra recebe `BUSY`).
- **Falhas:** o token novo é descartado se não for gravado; resultado incerto não revoga nada; o item falho é tentado de novo na próxima passada. A última execução (candidatos, concluídos, parciais, falhas, problema) aparece na tela e em `VAULT_AUTO_RUN`.
- **Ainda não há notificação ativa** (e-mail/chat) de falha: hoje é a tela e a auditoria. Se quiser, o próximo passo é um webhook.
