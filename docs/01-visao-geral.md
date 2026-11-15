# 01 — Visão geral e requisitos

## 1. Objetivo

Oferecer uma interface web simples e auditável para operações administrativas recorrentes no GitLab que hoje exigem acesso à Admin Area ou chamadas manuais à API. O acesso à ferramenta é controlado por **conta própria (usuário + senha + 2FA)**. As operações no GitLab são feitas **em nome do operador, com o PAT dele**: a ferramenta não tem credencial privilegiada própria no GitLab.

## 2. Personas

| Persona | Descrição | O que faz na ferramenta |
|---------|-----------|-------------------------|
| **Admin da ferramenta** | `role = admin` no better-auth | Cria e gerencia contas da ferramenta, consulta toda a auditoria. Pode também ser operador |
| **Operador** | Conta da ferramenta cujo PAT é de um admin GitLab | Desbloqueia usuários GitLab, reseta MFA GitLab, rotaciona o próprio PAT |
| **Usuário comum** | Conta da ferramenta com PAT sem privilégio de admin GitLab | Vincula e rotaciona o próprio PAT (telas de admin GitLab ficam ocultas) |

## 3. Premissas

- P1. Há **uma instância GitLab** alvo (self-managed ou Dedicated), definida em `GITLAB_BASE_URL`. O modelo de dados já comporta mais de uma no futuro.
- P2. A versão mínima do GitLab é **17.9+**, por causa do scope `self_rotate`. O endpoint `POST /personal_access_tokens/self/rotate` existe desde a 16.10. A versão real da instância precisa ser validada.
- P3. Os operadores têm PAT com scope `api` (e `admin_mode`, se o Admin Mode estiver habilitado na instância).
- P4. A ferramenta roda em rede interna, com acesso HTTPS à instância GitLab (certificado público, de CA interna ou **auto-assinado** — ver [04 §5](04-integracao-gitlab-api.md#5-tls-e-certificado-auto-assinado)).
- P5. Cada conta da ferramenta pode ter **vários PATs ativos** (ex.: um de admin e um só de leitura), todos do **mesmo usuário GitLab**; um deles é o **padrão** e o usuário escolhe qual está **em uso**. Cada usuário GitLab só pode estar vinculado a **uma** conta da ferramenta.
- P6. O cadastro público fica **desabilitado**: só o admin da ferramenta cria contas. O primeiro admin é criado por script de seed.
- P7. O MVP não tem servidor de e-mail. A redefinição de senha é feita pelo admin da ferramenta (ver questão Q3 em [11](11-questoes-em-aberto.md)).

## 4. Escopo

### Dentro do MVP
- Login com usuário + senha; 2FA (TOTP) da ferramenta com códigos de backup.
- Troca de senha obrigatória no primeiro acesso.
- Gestão de contas da ferramenta pelo admin: criar, redefinir senha, banir e desbanir, alterar papel, revogar sessões.
- Minha conta: trocar senha, configurar 2FA, ver e encerrar sessões ativas.
- Vincular o PAT: validação, detecção do que ele permite e armazenamento cifrado.
- Busca de usuários GitLab e visualização de status (estado, MFA, último login).
- Desbloqueio de usuário GitLab.
- Reset (desabilitar) do MFA de usuário GitLab.
- Rotação do próprio PAT com persistência automática do novo token.
- Substituição manual do PAT, para quando a rotação foi feita fora da ferramenta.
- Auditoria de todas as ações, com histórico pessoal e global (admin).
- Alerta de expiração do PAT.

### Fora do MVP (backlog)
- Envio de e-mail (recuperação de senha self-service, notificações).
- SSO corporativo (OIDC/SAML via plugins `genericOAuth`/`sso` do better-auth) ou login via OAuth do GitLab.
- Banir/desbanir e ativar/desativar usuários GitLab (bloquear/desbloquear já estão no escopo).
- Revogar tokens de terceiros; gerenciar membros de grupos e projetos.
- Múltiplas instâncias GitLab.
- Rotação agendada ou automática do PAT.
- Aprovação dupla (4-eyes) para reset de MFA GitLab.

## 5. Requisitos funcionais

### Acesso à ferramenta

| ID | Requisito | Prioridade |
|----|-----------|------------|
| RF01 | Usuário faz login com username e senha | Must |
| RF02 | Se a conta tem 2FA da ferramenta habilitado, o login exige o código TOTP ou um código de backup | Must |
| RF03 | 2FA da ferramenta obrigatório para todas as contas (configurável por `REQUIRE_APP_2FA`) | Should (Must em produção) |
| RF04 | No primeiro acesso, ou após redefinição pelo admin, a troca de senha é obrigatória antes de qualquer outra tela | Must |
| RF05 | Admin da ferramenta cria contas (username, nome, e-mail, papel, senha temporária) | Must |
| RF06 | Admin da ferramenta redefine senha, bane e desbane, altera papel e revoga sessões de contas | Must |
| RF07 | Usuário troca a própria senha, configura e desativa o próprio 2FA e encerra as próprias sessões | Must |
| RF08 | Bloqueio temporário após tentativas de login inválidas (rate limit) | Must |

### PAT e GitLab

| ID | Requisito | Prioridade |
|----|-----------|------------|
| RF10 | Usuário vincula o PAT; a ferramenta valida o token no GitLab e identifica usuário GitLab, scopes, expiração e se é admin | Must |
| RF11 | Um usuário GitLab não pode estar vinculado a duas contas da ferramenta ao mesmo tempo | Must |
| RF12 | A UI só exibe as ações que o PAT permite | Must |
| RF13 | Operador busca usuários GitLab por username, nome ou e-mail | Must |
| RF14 | Operador vê os detalhes do usuário GitLab: estado (`active`, `blocked`, `ldap_blocked`, `deactivated`, `banned`), MFA habilitado, último login | Must |
| RF15 | Operador desbloqueia usuário GitLab com estado `blocked`, informando motivo ou chamado (obrigatório) | Must |
| RF15b | Operador bloqueia usuário GitLab `active` (motivo obrigatório, confirmação por username), exceto a própria conta | Must |
| RF16 | Operador desabilita o MFA de usuário GitLab que tem MFA ativo, informando motivo ou chamado (obrigatório) | Must |
| RF17 | Usuário rotaciona o próprio PAT escolhendo a nova data de expiração | Must |
| RF18 | Após a rotação, o novo PAT é salvo cifrado e o antigo é marcado como rotacionado | Must |
| RF19 | Usuário substitui manualmente um PAT salvo (o novo precisa ser do mesmo usuário GitLab; mantém a condição de padrão) | Must |
| RF27 | Usuário **cadastra vários PATs**, vê os **escopos** e o que cada um permite, e define qual é o **padrão** | Must |
| RF28 | Usuário escolhe qual PAT está **em uso** (por navegador); as ações usam o PAT em uso, e a permissão é a dele | Must |
| RF29 | Remover um PAT da plataforma não o revoga no GitLab; remover o padrão promove outro | Must |
| RF20 | Banner de alerta quando o PAT expira em 7 dias ou menos | Should |
| RF21 | Opção de exibir o novo PAT uma única vez após a rotação | Could |
| RF22 | Funcionar com GitLab de **certificado auto-assinado**, por configuração do deploy (confiar na CA ou ignorar a verificação só para o GitLab) | Must |

### Auditoria

| ID | Requisito | Prioridade |
|----|-----------|------------|
| RF23 | Admin da ferramenta faz uma **varredura (dry-run)** de tokens (PAT) e chaves SSH de usuários **bloqueados** e/ou **sem uso há mais de N dias**, revisa a lista e revoga os itens escolhidos (motivo + confirmação digitada, auditoria item a item) | Must |
| RF24 | O número de dias "sem uso" é **configurável na interface** (padrão salvo, 90 de fábrica) | Must |
| RF25 | A limpeza nunca toca na própria conta do operador, em tokens em uso por contas da ferramenta nem em bots (tokens de projeto/grupo) | Must |
| RF26 | Admin da ferramenta configura o **prazo máximo de validade do PAT** na ferramenta (limita a rotação aqui) e, opcionalmente, no GitLab (instância inteira), este só após uma **simulação** do efeito | Must |
| RF30 | Toda ação (login, falha de login, gestão de contas, ações GitLab, PAT) gera registro de auditoria com resultado | Must |
| RF31 | Usuário vê o próprio histórico | Should |
| RF32 | Admin da ferramenta vê a auditoria global com filtros e exporta CSV | Should |

## 6. Requisitos não funcionais

| ID | Requisito |
|----|-----------|
| RNF01 | **Segurança**: PAT cifrado em repouso (AES-256-GCM), nunca logado e nunca enviado ao browser depois do cadastro. Senhas com hash scrypt (padrão do better-auth) |
| RNF02 | **Auditoria**: registros append-only, retenção mínima de 5 anos (ajustar à política interna) |
| RNF03 | **Disponibilidade**: se o GitLab estiver indisponível, mostrar mensagem clara; nenhuma ação parcial silenciosa. O login continua funcionando sem o GitLab |
| RNF04 | **Desempenho**: busca de usuários em menos de 2 s (p95), dependendo da latência do GitLab |
| RNF05 | **Observabilidade**: logs JSON estruturados com `requestId` e sem dados sensíveis; health check em `/api/health` |
| RNF06 | **Acessibilidade**: WCAG 2.1 AA |
| RNF07 | **LGPD**: dados pessoais mínimos. Da conta: username, nome, e-mail. Do usuário GitLab alvo: apenas id e username na auditoria |
| RNF08 | **Deploy**: imagem Docker, configuração 100% por variáveis de ambiente, Node.js 26 LTS |
| RNF10 | **TLS**: verificação do certificado do GitLab ligada por padrão; ignorá-la é opt-in explícito (`GITLAB_TLS_INSECURE`), restrito às chamadas ao GitLab e sinalizado na UI |
| RNF09 | **Versões**: dependências fixadas na versão exata, lockfile versionado, atualização contínua via Renovate (ver [10](10-dependencias-e-versoes.md)) |
