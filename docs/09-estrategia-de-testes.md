# 09 — Estratégia de testes

Tudo abaixo **existe e passa**: `npm test` (74), `npm run test:integration` (156), `npm run test:e2e` (55). Os testes de integração e E2E precisam de Docker (Testcontainers).

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
