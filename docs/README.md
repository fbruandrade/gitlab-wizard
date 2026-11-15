# GitLab Wizard — Documentação de Planejamento

Interface web (Next.js 16 + PostgreSQL) para executar operações na API do GitLab usando o **Personal Access Token (PAT)** do próprio usuário, respeitando exatamente o escopo e as permissões desse token. O acesso à ferramenta é feito com **usuário e senha** (better-auth); o PAT é vinculado à conta depois do login.

> **Revisão 3 — 13/11/2026 (implementado)**: a especificação foi **construída e testada** (39 unitários, 83 de integração, 35 E2E; imagem Docker de produção e `docker-compose`). Os documentos refletem o que existe, inclusive os desvios do plano (marcados com **Implementação**). Novidades: opção de **GitLab com certificado auto-assinado** (`GITLAB_TLS_INSECURE`/`NODE_EXTRA_CA_CERTS`), runbook ([12](12-runbook.md)), rotação da chave de cifragem. Código e comandos: [`../README.md`](../README.md).

## Escopo do MVP

1. **Acesso à ferramenta** — login com usuário e senha, 2FA (TOTP) da própria ferramenta e gestão de contas por um administrador.
2. **Vínculo do PAT** — cada usuário cadastra o seu PAT do GitLab, que fica cifrado no banco.
3. **Desbloqueio de usuário GitLab** — buscar um usuário e desbloqueá-lo (`blocked` → `active`).
4. **Reset de MFA de usuário GitLab** — desabilitar o 2FA do usuário no GitLab para que ele recadastre.
5. **Rotação do meu PAT** — rotacionar o PAT vinculado e salvar automaticamente o novo token.

## Glossário (evita confusão entre os dois "2FA")

| Termo | Significado |
|-------|-------------|
| **Conta da ferramenta** | Usuário do GitLab Wizard (tabela `user` do better-auth), autenticado por usuário + senha |
| **2FA da ferramenta** | TOTP exigido no login do GitLab Wizard (plugin `twoFactor` do better-auth) |
| **PAT** / **token GitLab** | Personal Access Token do GitLab vinculado à conta da ferramenta |
| **Usuário GitLab** | Conta na instância GitLab, alvo das ações de desbloqueio e reset de MFA |
| **MFA GitLab** | 2FA da conta no GitLab, que o operador pode resetar |
| **Admin da ferramenta** | Conta com `role = admin` no better-auth; gerencia contas da ferramenta e vê toda a auditoria |
| **Admin GitLab** | Usuário GitLab com `is_admin = true`; único que consegue desbloquear e resetar MFA via API |

## Índice

| # | Documento | Conteúdo |
|---|-----------|----------|
| 01 | [Visão geral e requisitos](01-visao-geral.md) | Objetivo, escopo, premissas, requisitos funcionais e não funcionais |
| 02 | [Arquitetura](02-arquitetura.md) | Stack, componentes, fluxos, estrutura de pastas, variáveis de ambiente |
| 03 | [Autenticação (better-auth)](03-autenticacao.md) | Configuração do better-auth, plugins, sessão, proteção de rotas, criação de contas |
| 04 | [Integração com a API do GitLab](04-integracao-gitlab-api.md) | Endpoints, scopes e permissões, tratamento de erros |
| 05 | [Modelo de dados](05-modelo-de-dados.md) | Tabelas do better-auth + tabelas da aplicação, retenção |
| 06 | [Segurança](06-seguranca.md) | Criptografia do PAT, auditoria, proteções web, ameaças |
| 07 | [Especificação de telas](07-especificacao-telas.md) | Telas, estados, validações, mensagens |
| 08 | [Plano de implementação](08-plano-de-implementacao.md) | Fases, tarefas, critérios de aceite, Definition of Done |
| 09 | [Estratégia de testes](09-estrategia-de-testes.md) | Testes unitários, de integração e E2E |
| 10 | [Dependências e versões](10-dependencias-e-versoes.md) | Versões fixadas, incompatibilidades conhecidas, política de atualização |
| 11 | [Questões em aberto e riscos](11-questoes-em-aberto.md) | Decisões pendentes e riscos |
| 12 | [Runbook de operação](12-runbook.md) | Deploy, checklist de produção, TLS, manutenção, rotação de chaves, incidentes |

## Decisões-chave

- **Next.js 16.4 (App Router, Turbopack) + React 19.3 + TypeScript 6.0**. Toda chamada ao GitLab é feita no servidor (Server Actions e Route Handlers). O PAT nunca volta para o browser depois de cadastrado.
- **better-auth 1.7** com `emailAndPassword` + plugins `username`, `twoFactor`, `admin` e `nextCookies`. **Cadastro público desabilitado**: contas são criadas pelo admin da ferramenta.
- **PostgreSQL 18 + Prisma 7.10** (driver adapter `@prisma/adapter-pg`). O PAT é armazenado **cifrado com AES-256-GCM**, com a chave fora do banco.
- **Autenticação e PAT são independentes**: a sessão vem do better-auth; o PAT é só a credencial para falar com o GitLab. Um PAT inválido não derruba a sessão, só bloqueia as ações até ser substituído.
- **As telas aparecem conforme o que o PAT permite** (admin GitLab + scope `api`, `self_rotate` etc.).
- **Toda ação, inclusive login, falha de login e ação administrativa, gera auditoria** append-only. Ações GitLab exigem motivo ou número de chamado.
- **GitLab auto-gerenciado com certificado auto-assinado**: a verificação TLS é ligada por padrão; quem faz o deploy escolhe confiar na CA (`NODE_EXTRA_CA_CERTS`, recomendado) ou ignorar a verificação só para o GitLab (`GITLAB_TLS_INSECURE=true`, com aviso permanente na UI). Não é uma opção por usuário na tela.
- **Rotação é tratada como operação crítica**: o novo token é persistido antes de qualquer outra chamada e o token antigo nunca é reutilizado.
