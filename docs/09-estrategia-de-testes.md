# 09 — Estratégia de testes

Tudo abaixo **existe e passa**: `npm test` (228), `npm run test:integration` (302), `npm run test:e2e` (63) e `npm run test:coverage` (unit + integração: 530 testes, com limites de cobertura). Total: **593 testes**. Os testes de integração e E2E precisam de Docker (Testcontainers).

## 1. Pirâmide

| Nível | Ferramenta | Alvo | Foco |
|-------|-----------|------|------|
| Unitário | Vitest 5 | Cifragem do PAT, matriz de capacidades, política/geração de senha, teto absoluto da sessão, CSV, validação de env, catálogo de mensagens | Lógica pura, sem I/O |
| Integração | Vitest 5 + **Postgres 18 real (Testcontainers)** + **GitLab falso** | Services, better-auth real (hooks, plugins, rate limit), retenção, permissões do banco | Backend completo sem browser |
| E2E | Playwright 1.65 + Chromium + axe-core | O app buildado (`standalone`, o mesmo artefato da imagem) falando HTTPS com o GitLab falso | Jornada do usuário, segurança, acessibilidade |

### Decisões que fogem do plano original
- **GitLab falso próprio (`tests/support/fake-gitlab.ts`) no lugar do MSW.** É um servidor HTTP/HTTPS de verdade com os endpoints usados, a **detecção de reuso de token rotacionado**, injeção de falhas/atrasos e (no E2E) uma porta de controle. Vantagem sobre o MSW: exercita o `undici`, o TLS auto-assinado e os timeouts de verdade.
- **Banco com papéis reais.** O Postgres de teste cria `app_migrator`/`app_runtime` como em produção; a aplicação roda como `app_runtime`. Por isso os testes provam que `audit_log` é append-only (`UPDATE`/`DELETE`/`TRUNCATE` → `permission denied`).

## 2. O que é coberto

### Autenticação (integração, better-auth real)
Login e hash scrypt; mensagem **idêntica** para senha errada e usuário inexistente; rate limit (6ª tentativa → 429, outro IP não é afetado) e sua auditoria; conta banida não loga e perde as sessões; **superfície HTTP**: `sign-up`, `admin/*` (inclusive para um admin logado), `impersonate`, `update-user`, `change-email`, `send-otp` → 404; senha fraca recusada, forte aceita, `mustChangePassword` limpo, outras sessões revogadas; `mustChangePassword` não forjável pelo client; **2FA** (TOTP, resposta `twoFactorRedirect` sem sessão, código errado, backup code uso único, auditoria correta de ativação vs. login); **CSRF** (cookie válido + `Origin` de outro site → 403, sessão e senha intactas); **reautenticação** por cima de sessão velha gera sessão nova e fresca.

### Cliente GitLab (integração)
**TLS auto-assinado**: rejeitado por padrão (erro acionável, token nem é enviado); aceito com `insecureTls`; a opção **não vaza** para o `fetch` global. Retry apenas em GET (503, 429); **nunca** em escrita (1 chamada); mapeamento 401/403/404; resposta fora do formato; erro/stack sem o token; GitLab fora do ar; paginação.

### PAT e rotação (integração)
Vincular guarda **cifrado** (nada em claro no banco nem na auditoria; AAD de outra conta falha); capacidades por scope; PAT inválido não grava; já vinculado / mesmo usuário GitLab em duas contas (inclui o índice parcial do banco); substituir exige o mesmo usuário; desvincular libera; 401 → `REVOKED` e a conta da ferramenta segue. **Rotação**: grava o novo, antigo `ROTATED`, `rotatedFromId`, **nenhuma chamada com o token antigo depois do 200**; reveal; **duas rotações simultâneas → o GitLab recebe uma só** (`ROTATION_IN_PROGRESS`); data inválida/sem capability sem chamar o GitLab; **falha ao gravar após rotacionar → `PARTIAL`** devolvendo o token; **timeout com rotação aplicada** → sem retry, `REVOKED_UNKNOWN`, auditoria `UNKNOWN`; timeout sem rotação → token continua `ACTIVE`; 401 na rotação.

### Usuários GitLab, contas, auditoria, retenção (integração)
Desbloqueio/reset de MFA com `stateBefore/stateAfter`; username errado, estado mudou, `ldap_blocked`, PAT sem admin, Admin Mode (403 prevalece) → **nenhuma escrita**; criação de conta (senha temporária nunca auditada), duplicados, não-admin barrado, redefinir senha/2FA, **último admin** e **auto-banimento** protegidos; auditoria append-only; filtros/paginação; retenção idempotente; **rotação da chave de cifragem** (preserva o token, idempotente, chave removida não perde dado).

### E2E (Playwright, 35 testes)
Primeiro acesso do admin (troca de senha com política + setup do 2FA com chave TOTP), login com 2FA, vincular PAT em **GitLab HTTPS auto-assinado**, capacidades, busca/paginação, desbloqueio (botão só habilita com motivo + username), `ldap_blocked`, reset de MFA (checkbox de identidade), **reautenticação após 20 min**, **rotação** (token exibido uma vez, antigo revogado no GitLab, app segue funcionando), substituição, criação de conta + fluxo do operador (gates, menus, URLs de admin, mesmo usuário GitLab em 2 contas), **banimento**, histórico, auditoria global com filtro, **CSV sem segredos**, export anônimo barrado, cookie `HttpOnly`/`SameSite`, health/manutenção, **axe WCAG 2.1 AA em 8 telas**, e **zero erro de console/CSP** em toda a jornada.

## 3. Como rodar

```bash
npm test                    # unitários (rápido, sem Docker)
npm run test:integration    # Postgres via Testcontainers (~25 s)
npm run test:e2e            # build + stack completa + Chromium (~1 min)
```

## 4. Armadilhas que os testes já pegaram (mantê-los!)
- `next build` sem `.env` quebrava ao importar rotas → criação **preguiçosa** de `env`, `prisma` e `auth`. **Só o `docker build` (ou `env -i npm run build`) pega isso.**
- O better-auth **desliga a checagem de origem em `NODE_ENV=test`** → fixamos `disableOriginCheck: false` para os testes validarem a produção.
- O rate limit embutido de `/two-factor/*` (3/10 s) é **global** sem `CLIENT_IP_HEADER` → aviso no boot e E2E com IP por contexto.
- Login com 2FA pendente não pode constar como sucesso na auditoria.

## 5. Limpeza de credenciais e políticas

- **Unitário** (`cleanup-rules`): fronteira "mais de N dias" (exatamente N não conta, N+1 ms conta), nunca usado vale a criação, sem data = desconhecido, `blocked`/`ldap_blocked` (não `banned`), "e/ou" acumulando motivos, bots e dono desconhecido excluídos, **protegidos** (própria conta, vinculado à ferramenta), chave sem `last_used_at` **nunca** vira "sem uso" (e avisa), validação dos parâmetros.
- **Integração** (GitLab falso com PATs/chaves/configurações): a varredura **não escreve nada** no GitLab; cada critério isolado e combinado; o número de dias muda o resultado; PAT sem permissão → varredura `FAILED`; privacidade da varredura; **execução**: revoga e audita item a item com motivo, **reavalia antes** (usado/desbloqueado → ignorado), recusa itens fora da varredura/protegidos/>500, varredura de outra conta/antiga/falha, falha de um item não derruba o lote (`PARTIAL`), 401 no meio aborta e invalida o PAT, sem retry. **Configurações**: padrões, persistência, auditoria antes/depois, limites, valor corrompido, e a validade configurada **limitando a rotação**. **Política**: a simulação não altera o GitLab, aplicar exige simulação do mesmo valor/recente/da mesma conta, edição sem o recurso → `GITLAB_SETTING_NOT_APPLIED`.
- **E2E**: padrão de dias salvo e auditado, critérios obrigatórios, varredura → revisão → revogação com `REVOGAR`, chave sem dado de uso intocada, token do operador **protegido**, validade na ferramenta limitando a rotação, simulação com alertas, aplicação com `APLICAR 365` que revoga só o previsto, acesso negado a não-admin, e axe nas duas telas.

## 6. Vários tokens por conta

- **Integração** (`multi-token.test.ts` + índices em `audit-maintenance.test.ts`): primeiro token vira padrão e os demais entram sem mudar; `makeDefault`; cada token guarda os **seus** escopos/capacidades; mesmo usuário GitLab obrigatório na conta; mesmo PAT recusado; **outra conta não ganha o usuário GitLab** (nem por PAT já cadastrado); o **banco** impede 2º padrão e PAT duplicado ativo; definir padrão (de/para auditado, idempotente, só da própria conta); remover (padrão promove o mais recente, último deixa a conta vazia, **não revoga no GitLab**, token alheio → `TOKEN_NOT_FOUND`); `resolveToken` ignora id de **outra conta**, inexistente, inválido ou removido; as chamadas usam o **PAT do token em uso**; capacidade é a do token em uso e o erro **indica qual outro token permite**; 401 no padrão promove outro (sempre há um padrão), 401 em não padrão não mexe no padrão; rotação **por token** (herda padrão/não padrão), sem `tokenId` rotaciona o em uso, token alheio/sem capacidade recusado, **lock por token** (dois tokens em paralelo ok, o mesmo só um); substituir mantém a condição de padrão.
- **E2E** (7 testes novos): adicionar tokens e ver escopos/capacidades de cada um, "padrão" ao adicionar, mesmo token duas vezes, **trocar o token em uso pelo cabeçalho** (com o de leitura somem as ações de escrita e a tela explica; a requisição sai com o PAT dele), cookie forjado/lixo ignorado, definir padrão persiste, rotacionar um token sem afetar os demais, remover o padrão promove outro e volta ao selo simples sem revogar nada.
- **Bugs que esta mudança expôs (mantê-los cobertos):** (1) a rotação recria o card, e o diálogo "novo token (exibido uma vez)" morava dentro dele e **sumia** (no caso `PARTIAL` seria perder o token) → `TokenSecretHost`; (2) `DropdownMenuLabel` do base-ui exige `DropdownMenuGroup`, senão o menu **quebra ao abrir** → só o E2E percebeu.

## 7. Cobertura de código

```bash
npm run test:coverage      # unitários + integração num só processo; falha se a cobertura cair abaixo dos limites
open coverage/index.html   # relatório navegável (linha a linha); também coverage/lcov.info e cobertura-coverage.xml
```

**Resultado atual (530 testes): 96,9% statements · 90,7% branches · 95,2% funções · 98,3% linhas.** Início da medição: 80,9 / 71,9 / 81,1 / 83,3.

**Por que combinado:** cada suíte cobre partes diferentes (os unitários só enxergam ~21% sozinhos; a lógica de servidor é exercida pela integração com Postgres real). Medir separado subestimaria as duas, então o `vitest.coverage.config.mts` usa os dois *projects* do Vitest e **mescla** a cobertura (provider `v8`, sem instrumentação de código).

**O que entra na conta:** `src/server`, `src/lib`, e a borda HTTP que dá para testar sem navegador — Server Actions (`actions.ts`) e route handlers (`route.ts`). **O que fica de fora, de propósito:** telas e componentes React (`page.tsx`, `layout.tsx`, `src/components`), exercitados pelo **E2E** (Playwright roda num navegador e não passa pelo instrumentador do Vitest — o E2E dá a garantia funcional, não um percentual); `src/lib/routes.ts` e `src/lib/auth-client.ts` (um cast de tipos e a fiação do client); `src/components/ui` (shadcn gerado), `src/generated` (Prisma) e os hooks `proxy.ts`/`instrumentation.ts`.

**Limites mínimos (a execução falha se cair):** global 95 / 88 / 94 / 97 (statements / branches / funções / linhas) e, **onde um furo de teste é um furo de segurança, 100%**: cifragem do PAT (`crypto/`), `capabilities`, `action-result` (não vazar erro interno), `cleanup-rules` (o que a limpeza revoga), `schemas`/`admin-schemas`/`password-policy` (validação de entrada) e `csv` (injeção de fórmula); `guards.ts` (sessão, gates, papel de admin) exige 100% de linhas e 94% de branches. Verificado: um limite impossível faz o comando falhar, e rodar só os unitários reprova `guards.ts` e `crypto` **pelo nome**. Não baixe um limite para "fazer passar": escreva o teste.

**O que ficou descoberto (conscientemente):** ramos defensivos de corrida que só disparam com concorrência real no banco (`P2002` em `replaceToken`/`setDefaultToken`/`ensureDefault`), `temp-password` (re-sorteio improvável) e alguns ramos de `logger`/`env` dependentes do ambiente. Linhas e ramos de interface não aparecem aqui — são do E2E.

### Como foi obtida (testes desta etapa, 285 → 473)
- **Unitários (74 → 179):** schemas de validação (UUID, limites, normalização, confirmações digitadas), formatação em `America/Sao_Paulo`, filtros de auditoria, `runAction` (não vaza erro interno; repassa `redirect`/`notFound` do Next), `isBotUser`, `env` (chaves malformadas, booleanos, limites, origens), as rotas `maintenance` (Bearer em tempo constante, 404 quando desligada) e `health` (503 sem expor o erro), e **dois testes que varrem o código** para impedir esquecimento: *toda mensagem de erro lançada tem texto* e *toda ação de auditoria gravada tem rótulo legível*.
- **Integração (156 → 239), com os módulos do Next simulados** (`tests/support/next-mocks.ts`: `headers`, `cookies`, `redirect`, `revalidatePath`) e o better-auth, o Postgres e a política de papéis **reais**: **guards** (sessão, teto absoluto, gates, login recente, papel de admin, revogação imediata sem cookie cache), contexto das ações, seleção de token (cookie forjado ignorado), `loadGitLab`, **todas as Server Actions** (incluindo a prova de que um usuário comum é barrado nas 13 ações administrativas *no servidor* e que o token de outra conta nunca é aceito), rotas de progresso da varredura e de **exportação CSV** (BOM, fórmulas neutralizadas, lotes de 500 sem repetir), trilha de auditoria de autenticação (logout, 2FA, revogação de sessões), paginação **de verdade** do cliente GitLab (250 usuários em 3 páginas), mapeamento de erros, rotação ambígua × não ambígua e varreduras com donos não listados.

### Bugs e dívidas que a cobertura expôs
1. `getSession` usava `React.cache` sem argumentos; agora memoiza **pelo objeto de headers da requisição** (mesma deduplicação no Next, sem estado global entre requisições).
2. Havia um **ramo morto** no retry do cliente GitLab (o `continue` nunca executava); removido.
3. A paginação multi-página do cliente **nunca tinha sido exercitada** — é o que a limpeza usa em instâncias grandes.
4. A porta 1 usada num teste não era "conexão recusada": o `fetch` a bloqueia como *bad port* sem conectar. Os testes agora usam uma porta efêmera realmente fechada.

## 8. Cofres de token de projeto (docs/13)

- **Unitários** (`vault-rules.test.ts`, 100% exigido no `test:coverage`): caminho → ambiente/aplicação, nomes das variáveis, validade (`daysUntil`, `isExpired`), nome do token novo, classificação de estado e ação (inclusive "só PID ausente → só grava variável", "DEVOPS divergente → rotaciona", "vários tokens/sem grupo → nenhuma ação") e esquemas.
- **Integração** (`vault.test.ts`, 32 testes, incluindo a renovação forçada; Postgres real + GitLab falso com grupos, projetos, tokens de projeto e variáveis): varredura **sem nenhuma escrita**; todos os estados; projeto sem permissão listado como inacessível; grupo raiz inexistente; grupo de destino por caminho exato (aninhado e id numérico não são adivinhados); rotação na **ordem certa** (criar → gravar → revogar) com `protected`/`masked` preservados; criação com as duas variáveis; falha ao criar/gravar (antigo intacto, token novo descartado); resposta perdida **mas escrita aplicada** (segue e conclui); releitura impossível (`NEEDS_ATTENTION`, nada revogado); falha ao revogar o antigo (parcial); validação do token novo falha (antigo mantido); reavaliação antes de aplicar; duas execuções simultâneas; PAT do operador revogado; e **varredura do código de que o valor do token nunca aparece em auditoria nem na varredura**.
- **Ações**: o usuário comum é barrado nas 3 ações do cofre no servidor; validação da palavra `APLICAR`.
- **E2E**: menu → varredura (dry-run com escopos, validade e plano; GitLab inalterado; axe com a tabela) → aplicar com motivo + `APLICAR` → variável nova, token antigo revogado, valor nunca exibido nem auditado → nova varredura `OK`.

- **Rotação automática** (`vault-auto.test.ts`, 12 testes): desabilitada não faz nada (nem chamadas ao GitLab); habilitar guarda quem e qual token (nunca o valor) e audita; exige capability; rotaciona **só** vencido/no alerta (OK, sem token, sem variáveis e vários tokens ficam intactos); respeita os dias de alerta; falha parcial → `PARTIAL`; quem habilitou banido ou sem papel de admin → não age e registra; token desvinculado → não cai para outro token da conta; varredura que falha vira problema registrado; duas execuções simultâneas (uma recebe `BUSY`, concessão no banco); agendador interno idempotente; sem vazamento do valor do token. Mais: gatilho HTTP (404/401/200) e um roteiro E2E (habilitar na tela → gatilho externo → última execução na tela).
- **Limpeza: chaves SSH sem validade** (`cleanup-rules`, `cleanup.test.ts` e E2E): lista todas as chaves sem `expires_at` (inclusive as sem dado de último uso), ignora as com validade, combina com os outros critérios, revoga auditando o motivo `NO_EXPIRY` e ignora a que ganhou validade depois da varredura.
- **Runners** (`runner.test.ts`, 10 testes + ações + `runner-rules.test.ts` + E2E): global só por admin (recusado antes de chamar o GitLab), de grupo e de projeto por Owner, `api` sem `create_runner` não cria, 403/404/500 do GitLab (escrita sem retry), busca de alvos, listagem por escopo, pausar/retomar, remover só dentro do escopo, auditoria **sem o token**; E2E: criar global e de grupo (comando de registro com o token), listar, pausar e remover, token ausente da tela e da auditoria, axe com a tabela.
- Correção encontrada pelo E2E: o seletor de token tinha nome acessível diferente do texto visível (axe `label-content-name-mismatch`).
- **Tags na listagem de runners:** o fake agora se comporta como o GitLab real (as listas não trazem `tag_list`, só o detalhe), o que expôs o defeito; testes: tags vindas do detalhe, detalhe com falha (runner sem tags conhecidas, os demais seguem) e 401 propagado; E2E confere as tags na tabela.
