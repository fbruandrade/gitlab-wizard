# 08 — Plano de implementação

> **Status (13/11/2026): Fases 1–6 concluídas e a Fase 7 concluída na parte automatizável.** Legenda: `[x]` feito e testado · `[~]` parcial · `[ ]` depende de algo fora do repositório.
>
> **Pendente (não dá para fazer sem a sua infraestrutura):** toda a **Fase 0** (validar os endpoints na versão real do GitLab, Admin Mode, política de vida do PAT, instância de homologação, alinhamento com a Segurança) e, na Fase 7, **ASVS/pentest** e **métricas** (os logs estruturados existem; faltam métricas/dashboards). O pipeline `.gitlab-ci.yml` foi escrito mas **não foi executado em um runner real**.

Estimativas para **1 dev full-stack**. Com 2 devs, as fases 4 e 5 podem andar em paralelo depois da fase 3.

| Fase | Entrega | Estimativa |
|------|---------|-----------|
| 0 | Validações prévias | 1 d |
| 1 | Fundação do projeto (Next 16, Prisma 7, tooling) | 2 d |
| 2 | Autenticação (better-auth, 2FA, guards, seed) | 4 d |
| 3 | Núcleo GitLab: cliente, criptografia, vincular PAT | 3 d |
| 4 | Usuários GitLab: busca, desbloqueio, reset de MFA | 3 d |
| 5 | Meu token: rotação e substituição | 3 d |
| 6 | Administração da ferramenta, auditoria e histórico | 3 d |
| 7 | Hardening, E2E, deploy | 3 d |
| **Total** | | **~22 dias úteis** |

---

## Fase 0 — Validações prévias

- [ ] Versão do GitLab alvo (`GET /api/v4/version`) atende a P2.
- [ ] Na documentação dessa versão, confirmar `POST /users/:id/unblock`, `PATCH /users/:id/disable_two_factor` e `POST /personal_access_tokens/self/rotate` (parâmetros, códigos de resposta, detecção de reuso).
- [ ] Admin Mode habilitado? Qual a vida máxima de PAT na instância?
- [ ] Instância GitLab de homologação com um usuário admin de teste.
- [ ] Com a Segurança: cofre de chaves, política de senha, obrigatoriedade de 2FA, retenção da auditoria, formato do chamado.
- [x] Revalidar as versões de [10](10-dependencias-e-versoes.md) no dia do início (`npm view <pkg> version`). *Feito em 13/11/2026.*

**Aceite**: as questões de [11](11-questoes-em-aberto.md) estão respondidas ou têm decisão registrada.

## Fase 1 — Fundação


- [x] `npx create-next-app@16.4.6` (TypeScript, App Router, Tailwind 4, ESLint, `src/`, Turbopack). `output: 'standalone'` e `typedRoutes: true` no `next.config.ts`.
- [x] Fixar o TypeScript em **6.0.3** (ver [10](10-dependencias-e-versoes.md#3-incompatibilidades-e-decisões)).
- [x] `.nvmrc` / `engines`: Node 26; `packageManager` (pnpm 10 ou npm 11) com lockfile versionado; `save-exact=true` no `.npmrc`.
- [x] `npx shadcn@latest init` + componentes Button, Input, Dialog, Form, Table, Badge, Card, Sonner, Skeleton, DropdownMenu, InputOTP.
- [x] Prisma 7: `prisma.config.ts`, generator `prisma-client` com `output`, `@prisma/adapter-pg`, `db.ts`.
- [x] `docker-compose.yml` com `postgres:18`; `.env.example`.
- [x] `env.ts` (zod 4) validado em `instrumentation.ts`; `logger.ts` (pino 10 com redact).
- [x] ESLint 10 flat config (`eslint-config-next`, regra que proíbe `dangerouslySetInnerHTML`), Prettier.
- [x] Vitest 5 + Testcontainers + Playwright configurados. Pipeline de CI: lint, typecheck, test, build, `npm audit`.
- [x] Headers de segurança e CSP com nonce.
- [x] `renovate.json` (ver [10 §4](10-dependencias-e-versoes.md#4-política-de-atualização)).

**Aceite**: `docker compose up` sobe app e banco; `/api/health` retorna 200 com o check do banco; CI verde.

## Fase 2 — Autenticação

- [x] `auth.ts` conforme [03 §2](03-autenticacao.md#2-configuração-do-servidor); `npx auth@latest generate` → modelos no `schema.prisma` → migration.
- [x] Route handler `/api/auth/[...all]`, `auth-client.ts`, `proxy.ts`.
- [x] `guards.ts`: `requireSession`, `requireFreshSession`, `requireAdmin`, limite absoluto de sessão.
- [x] Telas T1, T1b, T1c e T7 (2FA com QR code, códigos de backup, sessões).
- [x] Redirecionamentos do layout `(app)`: troca de senha → setup de 2FA.
- [x] Modal de reautenticação genérico (`REAUTH_REQUIRED`).
- [x] Bloqueio dos endpoints de impersonation (hook `before`).
- [x] `scripts/create-admin.ts`.
- [x] Hook `after` → `AuditService` para os eventos `AUTH_*` (a tabela `audit_log` entra nesta fase).

**Aceite**:
- O admin criado pelo seed loga, é obrigado a trocar a senha e a configurar o 2FA, e cai no dashboard.
- Senha errada 6 vezes em 1 min → 429.
- Sessão inativa por 30 min → volta ao login. Sessão com mais de 8 h → volta ao login.
- Tentar `signUp` pela API → rejeitado.
- Login, falha de login e troca de senha aparecem no `audit_log`.

## Fase 3 — Núcleo GitLab e vínculo do PAT

- [x] `token-cipher.ts` (AES-256-GCM, AAD, chaves versionadas) + testes.
- [x] `GitLabClient` (`getCurrentUser`, `getCurrentToken`, `getVersion`), timeout, mapeamento de erros, schemas zod + testes com MSW.
- [x] `capabilities.ts` + testes da matriz.
- [x] Modelo `GitLabToken` + migration SQL manual (índices parciais, permissões de `audit_log`).
- [x] `GitLabTokenService.link()` + Server Action `linkGitLabToken` + T5 (estado sem PAT) + T2.
- [x] `withAudit`; tratamento global do `401` (PAT → `REVOKED`, redireciona para `/token`).

**Aceite**: vincular um PAT válido mostra as capacidades corretas; o banco só tem ciphertext; o mesmo usuário GitLab não vincula em duas contas; nenhum token aparece nos logs (teste captura a saída do logger).

## Fase 4 — Usuários GitLab

- [x] `GitLabClient`: `searchUsers`, `getUser`, `unblockUser`, `disableTwoFactor`.
- [x] `GitLabUserService` com checagem do estado atual antes de agir.
- [x] Telas T3 e T4 + modais (motivo, confirmação por username, checkbox de identidade).
- [x] Server Actions com `requireFreshSession` + `requireCapability`.
- [x] Tratamento de `ldap_blocked`, `STATE_CHANGED`, `GITLAB_2FA_NOT_ENABLED`, `403`.

**Aceite**:
- O operador desbloqueia um usuário `blocked` e o GitLab passa a mostrar `active`; a auditoria registra `SUCCESS` com o motivo.
- O operador reseta o MFA e o GitLab passa a mostrar `two_factor_enabled=false`.
- Conta com PAT sem admin GitLab não vê o menu; chamar a action diretamente → `FORBIDDEN`, auditado.
- Sessão com mais de 15 min → pede reautenticação antes de executar.

## Fase 5 — Meu token

- [x] `GitLabClient.rotateSelf(expiresAt)`, **sem retry**.
- [x] `GitLabTokenService.rotate()`: lock, auditoria de início, chamada, transação, verificação com o novo PAT, tratamento do caso ambíguo.
- [x] `replace()` exigindo o mesmo `gitlabUserId`; `unlink()`.
- [x] T5 completa (rotação, exibição única, substituição, histórico) e banner de expiração.

**Aceite**:
- A rotação gera um novo PAT, a ferramenta continua operando sem novo vínculo e o PAT antigo recebe `401` no GitLab.
- Duas rotações simultâneas → só uma executa.
- Falha simulada do banco depois da rotação → o usuário recebe o novo token na tela.
- Substituir por um PAT de outro usuário GitLab → rejeitado.

## Fase 6 — Administração e auditoria

- [x] T8 (contas): criar, redefinir senha, resetar 2FA, papel, banir/desbanir, encerrar sessões, com as regras de "último admin" e "não banir a si mesmo".
- [x] T6 (histórico pessoal) e T9 (auditoria global + CSV).
- [~] Endpoint de manutenção + CronJob (sessões, rate limit, ciphertext inativo). *Endpoint feito e testado; o CronJob é só um exemplo no [runbook](12-runbook.md#4-manutenção-retenção).*
- [x] Últimas ações no dashboard.

**Aceite**: todas as ações das fases 2 a 5 aparecem com o resultado correto; um `user` não acessa `/admin/*` (nem pela URL nem pela action).

## Fase 7 — Hardening e entrega

- [~] E2E com Playwright contra o GitLab de homologação ([09](09-estrategia-de-testes.md)). *Feito contra um GitLab **falso** (35 testes); falta rodar contra a instância real.*
- [~] Checklist OWASP ASVS nível 2, SAST/SCA e pentest, se exigido. *SCA feito (`npm audit` no CI, 0 em produção); ASVS, SAST e pentest não.*
- [~] Acessibilidade (axe + navegação por teclado). *axe WCAG 2.1 AA em 8 telas sem violações sérias; navegação por teclado não foi testada de forma sistemática.*
- [x] Dockerfile multi-stage em `node:26-alpine` (ou distroless), usuário não root, `prisma migrate deploy` num job separado com o usuário `app_migrator`.
- [x] Runbooks: deploy, rotação da chave de cifragem, rotação do `BETTER_AUTH_SECRET` (invalida as sessões), vazamento do banco (revogar todos os PATs), recuperação de acesso do admin.
- [~] Observabilidade: logs com `requestId`, métricas (latência do GitLab, taxa de erro por ação, falhas de login). *Existem logs JSON (pino) com redação de segredos e health check; **não** há `requestId` nem métricas.*

**Aceite**: Definition of Done cumprida em homologação.

---

## Definition of Done

- TypeScript strict, sem `any` injustificado; lint e typecheck verdes.
- Testes unitários dos services com cobertura de 80% ou mais em `src/server/`.
- Testes de integração (MSW + Postgres real) para o sucesso e para cada erro mapeado.
- Ação auditada no sucesso e na falha.
- Nenhum token, senha ou segredo em logs, respostas ou HTML (verificado por teste).
- Revisão de código aprovada.
- `docs/` atualizado se o comportamento divergir da especificação.
