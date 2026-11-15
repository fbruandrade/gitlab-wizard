# 07 — Especificação de telas

Layout autenticado: header com nome da conta e badge do papel (`admin`), indicador do PAT vinculado (`@username-gitlab` ou "PAT não vinculado") e menu do usuário (Minha conta, Sair). O menu lateral tem Início, Usuários GitLab, Meu token GitLab, Histórico e, para admins, Administração (Contas, Auditoria).

Banner fixo de expiração do PAT: amarelo com 7 dias ou menos, vermelho com 1 dia ou menos.

Os itens de menu do GitLab aparecem conforme as capabilities do PAT ([04 §2](04-integracao-gitlab-api.md#2-matriz-de-capacidades)). Os de administração aparecem conforme `role`.

---

## T1 — Login (`/login`)

```
┌───────────────────────────────────────┐
│  GitLab Wizard                        │
│                                       │
│  Usuário                              │
│  [ fandrade                    ]      │
│  Senha                                │
│  [ ••••••••••••                ] 👁   │
│                                       │
│  [ Entrar ]                           │
│                                       │
│  Esqueceu a senha? Fale com o         │
│  administrador da ferramenta.         │
└───────────────────────────────────────┘
```

| Item | Especificação |
|------|---------------|
| Campos | `username` (3–32, `[a-z0-9._-]`, sem distinção de maiúsculas) e `password` (obrigatório) |
| Ação | `authClient.signIn.username({ username, password })` |
| 2FA habilitado | O better-auth retorna `twoFactorRedirect` → `/login/2fa` |
| Credenciais inválidas | "Usuário ou senha inválidos." (genérico) |
| Conta banida | "Conta desativada. Procure o administrador." |
| 429 | "Muitas tentativas. Aguarde 1 minuto." |
| `?expired=1` | Aviso "Sua sessão expirou. Entre novamente." |

## T1b — Verificação 2FA (`/login/2fa`)

- Campo de 6 dígitos (`inputmode="numeric"`, `autocomplete="one-time-code"`) → `authClient.twoFactor.verifyTotp({ code, trustDevice: false })`.
- Link "Usar código de backup" → campo alternativo → `verifyBackupCode`.
- `trustDevice` **desligado**: a ferramenta é sensível, então o código é pedido em todo login.

## T1c — Troca de senha obrigatória (`/account/change-password`)

Exibida quando `mustChangePassword = true`. Nenhuma outra rota autenticada fica acessível até a senha ser trocada.

- Campos: senha atual (temporária), nova senha, confirmação. Medidor de força e checklist da política.
- Ação: Server Action `changeInitialPassword` → `auth.api.changePassword({ body: { currentPassword, newPassword, revokeOtherSessions: true }, headers })` e depois `mustChangePassword = false`.
- Em seguida, se `REQUIRE_APP_2FA` e o 2FA ainda não está configurado → T7 com `?setup=1`.

---

## T2 — Início / Dashboard (`/`)

- **Sem PAT vinculado**: card de destaque "Vincule seu token GitLab para começar" → `/token`. Explica quais scopes pedir (`api` + `admin_mode` para operadores; `self_rotate` para apenas rotacionar).
- **Com PAT**: card do token (usuário GitLab, scopes, expiração "em N dias", último uso), card de capacidades (✔/✖ com explicação do que falta), atalhos ("Buscar usuário", "Ver bloqueados") e as últimas 5 ações da conta.

---

## T3 — Busca de usuários GitLab (`/gitlab/users`)

No topo da tela, o resumo da **licença da instância** (`GET /license`): Users in subscription, Maximum Users, Billable users e Users over License (vermelho se > 0), plano e validade. Busca e licença são consultadas em paralelo; se a licença falhar, a busca não é afetada.

Requer `READ_USERS`.

```
┌──────────────────────────────────────────────────────────────────┐
│ Usuários GitLab                                                   │
│ [ buscar por username, nome ou e-mail     ] [Buscar]              │
│ Filtro: (•) Todos  ( ) Somente bloqueados                         │
├──────────┬──────────────┬────────────┬──────┬────────────────────┤
│ Usuário  │ Nome         │ Estado     │ MFA  │ Último login       │
├──────────┼──────────────┼────────────┼──────┼────────────────────┤
│ jsilva   │ João Silva   │ 🔴 blocked │ ✔    │ 02/11/2026 14:10   │
│ mlima    │ Maria Lima   │ 🟢 active  │ ✔    │ 13/11/2026 09:02   │
└──────────┴──────────────┴────────────┴──────┴────────────────────┘
                                         ‹ Anterior  1/4  Próxima ›
```

| Item | Especificação |
|------|---------------|
| Busca | Mínimo de 2 caracteres; estado na URL (`?q=&blocked=&page=`), lido via `searchParams` (Promise no Next 16); renderizado no servidor com `<Suspense>` e skeleton |
| Paginação | 20 por página, usando os headers do GitLab |
| Badges de estado | `active` verde · `blocked` vermelho · `ldap_blocked` vermelho com ícone de diretório · `deactivated` cinza · `banned` preto · `blocked_pending_approval` laranja |
| Linha | Clicável → `/gitlab/users/[id]` |
| Vazio | "Nenhum usuário encontrado para '{q}'." |
| PAT inválido (401) | Redireciona para `/token` com o aviso |

---

## T4 — Detalhe do usuário GitLab (`/gitlab/users/[id]`)

Cabeçalho: avatar, nome, `@username`, e-mail, estado, MFA (habilitado/não), criado em, último login e `locked`, se houver.

### Ação 0 — Bloquear

| Regra | Comportamento |
|-------|---------------|
| Visível se | Capability `ADMIN_USERS` |
| Habilitado se | `state === 'active'` e o alvo **não** é a própria conta GitLab do operador |
| Já bloqueado | Texto "Usuário já está bloqueado" |
| Própria conta | Texto "Você não pode bloquear a própria conta" (sem botão) |
| Alvo é admin GitLab | O modal exibe um aviso extra |

Modal igual ao do desbloqueio (motivo + digitar o username). Server Action `blockGitLabUserAction` → `POST /users/:id/block`; auditoria `GITLAB_USER_BLOCKED` com `stateBefore/stateAfter` e `targetIsAdmin`.

### Ação A — Desbloquear

| Regra | Comportamento |
|-------|---------------|
| Visível se | Capability `ADMIN_USERS` |
| Habilitado se | `state === 'blocked'` |
| `ldap_blocked` | Desabilitado, com a dica "Bloqueado via LDAP/AD — desbloquear no diretório" |
| `deactivated` / `banned` | Desabilitado: "Estado não suportado nesta versão" |
| `active` | Oculto; mostra "Usuário não está bloqueado" |

Modal de confirmação:

```
┌──────────────────────────────────────────────┐
│ Desbloquear @jsilva?                          │
│ O usuário poderá voltar a acessar o GitLab.   │
│                                               │
│ Motivo / nº do chamado *                      │
│ [ INC0012345 - bloqueado por engano         ] │
│                                               │
│ Digite "jsilva" para confirmar *              │
│ [ jsilva ]                                    │
│                     [Cancelar] [Desbloquear]  │
└──────────────────────────────────────────────┘
```

Server Action `unblockGitLabUser({ gitlabUserId, reason, confirmUsername })`:
1. `requireFreshSession()` → se `REAUTH_REQUIRED`, a UI abre o modal de reautenticação e reenvia.
2. `requireCapability('ADMIN_USERS')` e validação zod.
3. `GET /users/:id`: `confirmUsername` precisa bater com o username atual e o estado precisa ser `blocked`; senão retorna `STATE_CHANGED`.
4. `POST /users/:id/unblock`.
5. Auditoria com `stateBefore`/`stateAfter`.
6. `revalidatePath`; toast "Usuário @jsilva desbloqueado".

O botão usa `useActionState`/`useFormStatus` para o estado pendente e não aceita duplo clique.

### Ação B — Resetar MFA GitLab

| Regra | Comportamento |
|-------|---------------|
| Visível se | Capability `ADMIN_USERS` |
| Habilitado se | `two_factor_enabled === true` |
| Caso contrário | "Usuário não possui MFA habilitado no GitLab" |

O modal tem a mesma estrutura, com aviso e checkbox obrigatório:

> ⚠ Isto remove o MFA do usuário no GitLab. No próximo login ele terá de configurá-lo novamente, se a política exigir.
> ☐ Confirmei a identidade do solicitante por um canal independente.

Server Action `disableGitLabUserTwoFactor(...)` segue o mesmo fluxo da Ação A, chamando `PATCH /users/:id/disable_two_factor`. Um `400` vira "Este usuário não tem MFA habilitado" e os dados são recarregados.

---

## T5 — Meus tokens GitLab (`/token`)

A conta pode ter **vários** tokens. Cada um é um card; o **padrão** é o usado quando nenhum outro foi escolhido e o **em uso** é o escolhido neste navegador.

```
┌──────────────────────────────────────────────────────────────┐
│ Meus tokens GitLab                                            │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ wizard-admin  [Padrão] [Em uso]                           │ │
│ │ @fandrade (admin GitLab) · ID 4821                        │ │
│ │ Escopos (17): [api] [sudo] [admin_mode] [read_user] …     │ │
│ │ ✔ Buscar usuários  ✔ Desbloquear e resetar MFA  ✔ Rotac. │ │
│ │ Expira em: 20/11/2026 (em 7 dias) · Último uso: hoje 09:40│ │
│ │ [Substituir] [Desvincular]                                │ │
│ │ Rotacionar este token: [ 11/02/2027 ] [ ] ver o novo ...  │ │
│ └──────────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ leitura                                                   │ │
│ │ Escopos (1): [read_api]   ✔ Buscar  ✖ Desbloquear  ✖ Rot.│ │
│ │ [Usar este token] [Definir como padrão] [Substituir] ...  │ │
│ └──────────────────────────────────────────────────────────┘ │
│ Adicionar outro token  [ glpat-… ]  [ ] Definir como padrão   │
│ Histórico de tokens                                           │
└──────────────────────────────────────────────────────────────┘
```

**No cabeçalho**, com 2+ tokens, o selo vira um **seletor** (`@usuário (admin) · nome ▾`): lista cada token com o nome, os escopos privilegiados e "padrão", e permite trocar o que está **em uso** sem sair da tela; "Gerenciar tokens…" leva a esta página. Com 1 token continua o selo simples.

| Tema | Especificação |
|------|---------------|
| Escopos | Todos os escopos do token (`ScopeList`), os privilegiados (`api`, `sudo`, `admin_mode`) em vermelho e primeiro. Abaixo, o que **este** token permite (✔/✖, com o motivo no tooltip) |
| Adicionar | Campo de token (20–255 caracteres) + "Definir este como o token padrão" (só aparece se já houver tokens). O 1º vira o padrão sozinho. Erros: `401` token inválido · já cadastrado (`TOKEN_ALREADY_ADDED`) · de **outro usuário GitLab** (`GITLAB_USER_MISMATCH`) · usuário GitLab já em outra conta (`GITLAB_USER_ALREADY_LINKED`) |
| **Usar este token** | Grava o cookie `gw.active_token` (`HttpOnly`, `SameSite=Lax`) com o id do token. **Vale por navegador**, não exige login recente. Um id de outra conta ou de token removido/inativo é **ignorado** (cai no padrão) |
| **Definir como padrão** | Preferência permanente da conta; transacional (solta o antigo antes de marcar o novo) e auditada (`GITLAB_TOKEN_DEFAULT_CHANGED`, de → para) |
| Substituir | Troca o PAT **daquele** token (rotacionado fora da ferramenta). Precisa ser do mesmo usuário GitLab; o novo herda a condição de padrão |
| Desvincular | Remove da **plataforma** (não revoga no GitLab). Pede confirmação; se era o padrão, o token mais recente dos restantes assume |
| Qual token as ações usam | O **em uso**. Se ele não tiver a permissão necessária mas outro token da conta tiver, o erro diz qual: *"O token em uso (“leitura”) não permite esta ação, mas o token “admin” permite. Troque o token em uso no cabeçalho."* |
| Token inválido (401) | Só **aquele** token vira `REVOKED`; os outros e a sessão seguem. Se era o padrão, outro assume |

### Ação C — Rotacionar (por token)

| Regra | Especificação |
|-------|---------------|
| Visível se | O token tem a capacidade `SELF_ROTATE`; senão, "Requer scope `api` ou `self_rotate`" |
| Data | Obrigatória; depois de hoje e até o limite de **Políticas** (padrão = `TOKEN_MAX_LIFETIME_DAYS`); sugestão: hoje + 90 dias |
| Confirmação | Modal: "O token atual será revogado imediatamente no GitLab. Scripts e integrações que o usam deixarão de funcionar." |
| Server Action | `rotateGitLabTokenAction({ tokenId, expiresAt, reveal })`, fluxo em [02 §3.4](02-arquitetura.md#34-rotação-do-pat). Rotaciona **exatamente** o token do card; os demais não são tocados. O novo herda "padrão" ou "não padrão" |
| Concorrência | Lock de advisory **por token**: o mesmo token não rotaciona 2× ao mesmo tempo (`ROTATION_IN_PROGRESS`), mas tokens diferentes rotacionam em paralelo |
| Sucesso + `reveal` / falha de persistência | Modal **único** com o novo token (copiar; "não será exibido novamente"). Fica num componente fora dos cards (`TokenSecretHost`), porque a rotação recria o card e o estado de dentro dele se perderia |
| Ambíguo | Ver [04 §4](04-integracao-gitlab-api.md#rotação-com-resultado-ambíguo) |

---

## T6 — Histórico (`/history`)

Tabela paginada no servidor com o `audit_log` da própria conta: data/hora, ação (rótulo legível), alvo, resultado (badge) e motivo. Filtros: período, grupo de ação e resultado.

---

## T7 — Minha conta / segurança (`/account/security`)

| Seção | Comportamento |
|-------|---------------|
| Dados | Nome, username, e-mail (somente leitura; alteração só pelo admin) |
| Trocar senha | Senha atual + nova + confirmação → `authClient.changePassword({ revokeOtherSessions: true })` |
| 2FA da ferramenta | **Ativar**: pede a senha → `authClient.twoFactor.enable({ password })` → QR code (`totpURI`) + campo de verificação → mostra os códigos de backup **uma vez**, com botões copiar e baixar. **Desativar**: só se `REQUIRE_APP_2FA=false`; pede a senha. **Regenerar códigos de backup**: pede a senha |
| Sessões ativas | Lista (`listSessions`): dispositivo/user agent, IP, criada em, última atividade e a marca "esta sessão". Botões "Encerrar" e "Encerrar todas as outras" |

Com `?setup=1` (2FA obrigatório e ainda não configurado), só a seção de 2FA é exibida, sem navegação.

---

## T8 — Administração: contas da ferramenta (`/admin/users`)

Requer `role = admin`.

```
┌──────────────────────────────────────────────────────────────────────┐
│ Contas da ferramenta                              [ + Nova conta ]    │
│ [ buscar ]                                                            │
├──────────┬──────────────┬───────┬──────┬───────────┬────────┬────────┤
│ Usuário  │ Nome         │ Papel │ 2FA  │ PAT GitLab│ Status │        │
├──────────┼──────────────┼───────┼──────┼───────────┼────────┼────────┤
│ fandrade │ F. Andrade   │ admin │ ✔    │ @fandrade │ Ativa  │ ⋯      │
│ jops     │ J. Ops       │ user  │ ✖    │ —         │ Banida │ ⋯      │
└──────────┴──────────────┴───────┴──────┴───────────┴────────┴────────┘
```

Lista paginada com `auth.api.listUsers` (busca por username/nome), mais o join com `gitlab_token` ACTIVE.

| Ação (menu ⋯) | Server Action → better-auth | Regras |
|---------------|-----------------------------|--------|
| Nova conta | `createToolUser` → `auth.api.createUser` | username único, e-mail, nome, papel; gera senha temporária e a mostra uma vez |
| Redefinir senha | `resetToolUserPassword` → `setUserPassword` + `revokeUserSessions` + `mustChangePassword = true` | Mostra a nova senha temporária uma vez |
| Resetar 2FA | `resetToolUserTwoFactor` (service) | Para quem perdeu o autenticador |
| Alterar papel | `setToolUserRole` → `setRole` | Não pode remover o último admin |
| Banir / desbanir | `banUser` / `unbanUser` | Motivo obrigatório; não pode banir a si mesmo |
| Encerrar sessões | `revokeUserSessions` | |

Toda ação exige motivo, sessão fresca e gera auditoria `TOOL_USER_*`.

## T9 — Administração: auditoria (`/admin/audit`)

Igual a T6, mas com todas as contas, filtro por conta e por alvo, e exportação CSV (gerada por streaming no Route Handler `/admin/audit/export`).

---

## T10 — Limpeza de credenciais (`/admin/cleanup`)

Só `role = admin` com PAT de admin GitLab. Três blocos:

1. **Nova varredura** — critérios (basta atender a um): ☑ credenciais de usuários **bloqueados**; ☑ credenciais **sem uso há mais de [N] dias** (campo editável + **Salvar como padrão**); tipos: ☑ tokens (PAT) ☑ chaves SSH. O botão desabilita sem critério/tipo.
2. **Resultado** (acompanhamento por polling enquanto roda): resumo (revogáveis, por tipo, por motivo, usuários lidos, protegidos, bots ignorados), aviso quando o GitLab não informou o último uso de chaves SSH, e a **tabela** (tipo, usuário + estado, credencial, **escopos**, último uso, criada, motivo) com checkboxes. **Escopos**: para tokens, os privilegiados (`api`, `sudo`, `admin_mode`) em vermelho e os demais compactados (2 + "+N"), com a lista completa no tooltip e para leitor de tela; para chaves SSH (que não têm escopos), o tipo de uso (autenticação / assinatura / ambos). O resumo mostra quantos tokens candidatos têm escopo privilegiado. Protegidos aparecem com o selo e checkbox desabilitado. *Selecionar todos* (máx. 500). **Revogar selecionados (N)** → modal com motivo + `REVOGAR`. Depois: resumo `revogadas / ignoradas / com falha` e os motivos de cada exceção.
3. **Varreduras recentes** (5 últimas).

## T11 — Políticas (`/admin/policies`)

- **Validade máxima do PAT** — mostra *ferramenta* × *GitLab* (e "valores diferentes"). Campo de 1–365 dias e **Salvar na ferramenta** (passa a limitar a data na tela de rotação, T5).
- **Aplicar no GitLab (instância inteira)** — *Simular efeito de N dias*: resumo (quantos tokens/usuários seriam revogados, sem expiração, bots), **alertas em vermelho** se o seu token ou tokens vinculados a contas da ferramenta seriam revogados, e a tabela (50 primeiros) com usuário, token, **escopos de cada PAT** (privilegiados em vermelho, como na limpeza), data de expiração, último uso e observações; o resumo conta quantos dos afetados têm escopo privilegiado. *Aplicar N dias no GitLab…* → modal com motivo + `APLICAR N`.

---

## Padrões gerais de UX

- Datas no fuso `America/Sao_Paulo`, formato `dd/MM/yyyy HH:mm` (`date-fns` 4 + `@date-fns/tz`).
- Server Actions retornam `{ ok: true, data } | { ok: false, code, message, fieldErrors? }`.
- Toasts (sonner) para sucesso; erros aparecem inline e o modal não fecha.
- Botões destrutivos em vermelho, com foco inicial em "Cancelar".
- Reautenticação (`REAUTH_REQUIRED`): um modal pede senha e TOTP e reenvia a ação automaticamente.
- Textos centralizados em `src/lib/messages.ts`.

---

## Implementação: diferenças em relação à especificação

| Tela | O que foi feito diferente / a mais |
|------|-----------------------------------|
| Todas | Selo **"TLS do GitLab sem verificação"** no cabeçalho quando `GITLAB_TLS_INSECURE=true`. Avatares do GitLab não são carregados (iniciais no lugar) |
| T1b / reautenticação | O campo de código é **limpo após erro** (evita misturar com o código errado); `429` é exibido como "muitas tentativas", não "código inválido" |
| T5 (setup do 2FA) | Além do QR code, a **chave TOTP é exibida em texto** ("não consegue escanear?"): acessibilidade e alternativa quando a câmera não funciona |
| T5 Meu token | "Último uso" vem de uma consulta ao GitLab (melhor esforço) feita ao abrir a página; ela também detecta token revogado (→ `REVOKED`) |
| T2 Dashboard | Não consulta o GitLab (usa o que está salvo): carrega rápido mesmo com o GitLab lento |
| T9 Auditoria | A exportação CSV registra o evento `AUDIT_EXPORTED`, usa BOM UTF-8 e neutraliza células que começam com `= + - @` (injeção de fórmula) |
| T4 Resetar MFA | Alvo **administrador GitLab** (ou a própria conta) não tem botão: o GitLab não permite resetar o 2FA de admins pela API. No lugar, um **guia recolhível com o passo a passo do console Rails** (como abrir o console no pacote Linux e no Docker, comando preenchido com copiar, avisos de ação permanente, enforcement e código de recuperação). Erros 400/403/404 do GitLab mostram também o motivo devolvido por ele (≤ 200 caracteres, token redigido) |
| Ações sensíveis | Toda Server Action GitLab/admin passa por `requireFreshSession`; a UI trata `REAUTH_REQUIRED` abrindo o modal e repetindo a ação uma vez |
