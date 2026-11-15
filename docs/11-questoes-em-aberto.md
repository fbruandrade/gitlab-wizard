# 11 — Questões em aberto e riscos

## 1. Questões em aberto

| # | Questão | Impacto | Default adotado até a decisão |
|---|---------|---------|------------------------------|
| Q1 | Qual a versão da instância GitLab? | `self_rotate` exige 17.9+; o rotate de PAT próprio exige 16.10+ | Assumir 17.9+ |
| Q2 | O Admin Mode está habilitado? | Define se o PAT precisa do scope `admin_mode` | `GITLAB_ADMIN_MODE_ENABLED`; `403` com orientação |
| Q3 | Haverá servidor de e-mail (SMTP)? | Permite recuperação de senha self-service (`sendResetPassword`) e notificações de login | Sem e-mail: o admin redefine a senha |
| Q4 | O login deveria usar SSO corporativo (AD/Entra ID via OIDC) em vez de usuário e senha locais? | Muda a gestão de contas; o better-auth suporta via `genericOAuth`/`sso` | Usuário e senha locais (pedido explícito), mas seria bom criar a integração com o entraID |
| Q5 | 2FA da ferramenta obrigatório para todos? | Atrito vs. segurança | Obrigatório em produção (`REQUIRE_APP_2FA=true`) |
| Q6 | O bloqueio temporário do GitLab (`locked`) precisa de ação? | Exige endpoint ou versão específicos | Somente bloqueado, o admin poder desbloquear o usuário, gitlab 18.11+ |
| Q7 | Os bloqueios vêm majoritariamente do LDAP/AD (`ldap_blocked`)? | Se sim, a tela de desbloqueio resolve pouco | Exibir como não suportado |
| Q8 | O motivo precisa seguir um padrão de chamado (ex.: `^(INC\|REQ)\d+`)? Integração com ITSM? | Validação do campo | Texto livre com 10 caracteres ou mais |
| Q9 | Onde fica a chave de cifragem do PAT e o `BETTER_AUTH_SECRET` (Vault, KMS, HSM)? | Deploy e runbook | Env injetada pelo orquestrador |
| Q10 | O `GET /personal_access_tokens/self` com um PAT já rotacionado dispara a detecção de reuso? | Pode revogar o novo PAT | Validar na Fase 0; se disparar, remover a verificação |
| Q11 | Política de senha: argon2id obrigatório? Checagem de senhas vazadas (HIBP, consulta externa)? | Hash customizado / plugin | scrypt; sem HIBP |
| Q12 | Retenção exigida para a auditoria? | Particionamento | 5 anos |
| Q13 | Rotação automática do PAT antes de expirar? | Job em background | Fora do MVP |
| Q14 | Há proxy reverso na frente da ferramenta? Qual header traz o IP real do cliente? | Rate limit de login/2FA por IP; checagem de origem das Server Actions (`X-Forwarded-Host`) | Sem `CLIENT_IP_HEADER`: um balde global (3 verificações de 2FA / 10 s para todos) e aviso no boot |
| Q15 | O certificado do GitLab é de CA interna (exportável) ou auto-assinado sem CA? | `NODE_EXTRA_CA_CERTS` (seguro) vs `GITLAB_TLS_INSECURE` (sem garantia de identidade do servidor) | TLS verificado por padrão; opção explícita implementada ([04 §5](04-integracao-gitlab-api.md#5-tls-e-certificado-auto-assinado)) |
| Q16 | A integração com o Entra ID (Q4) entra em qual fase? | Troca/soma o login por senha; o better-auth suporta OIDC (`genericOAuth`/`sso`) e a conta da ferramenta passaria a ser provisionada pelo IdP | Fora desta entrega; o modelo (`user`/`account`) já comporta provedores sociais/OIDC |
| Q18 | A API do GitLab da sua versão devolve `last_used_at` nas chaves SSH (`GET /users/:id/keys`)? | Sem o campo, o critério "sem uso" não vale para chaves (a ferramenta avisa e só revoga as de usuários bloqueados) | Tratado como ausente = não revogar |
| Q19 | Como a sua versão identifica bots (`bot`, `user_type`) e `GET /users` inclui bloqueados? | Evita revogar tokens de projeto/grupo (pipelines) e esquecer bloqueados | Usa `bot`/`user_type`/padrão de username e mescla com `blocked=true` |
| Q20 | A instância é Ultimate? Qual a regra exata de corte do `max_personal_access_token_lifetime`? | Sem Ultimate o limite não existe; a simulação é estimativa | Simulação = ativos com expiração > hoje + N dias; aplica só se o GitLab confirmar o valor |
| Q21 | Todos os tokens de uma conta da ferramenta devem ser do **mesmo usuário GitLab**? (ex.: alguém que tenha uma conta pessoal e uma conta de serviço/admin separadas) | Mantém a auditoria inequívoca (quem agiu = um usuário GitLab) e a regra "um usuário GitLab, uma conta". Permitir usuários GitLab diferentes na mesma conta exigiria repensar essas duas garantias | Sim, mesmo usuário (erro `GITLAB_USER_MISMATCH`) |
| Q17 | Onde ficam as imagens e quem roda o job de migrations a cada deploy? | O CI publica `app` e `migrate`; o orquestrador precisa executar `migrate` antes do `app` | `.gitlab-ci.yml` pronto e **não testado** em runner real |

## 2. Riscos

| Risco | Prob. | Impacto | Mitigação |
|-------|-------|---------|-----------|
| Credenciais de um operador comprometidas dão acesso ao PAT de admin GitLab | Média | Crítico | 2FA obrigatório, rate limit, sessão curta, sessão fresca para ações, auditoria |
| Vazamento do banco expõe os PATs | Baixa | Crítico | AES-GCM com chave fora do banco, AAD, retenção curta do ciphertext, runbook de revogação em massa |
| Admin da ferramenta abusa do papel (cria conta, redefine senha de outro e usa o PAT dele) | Baixa | Alto | Redefinir a senha revoga as sessões e exige troca + 2FA do dono; tudo auditado; impersonation desabilitada; alertas sobre `TOOL_USER_PASSWORD_RESET` (futuro) |
| Perda do novo PAT na rotação | Baixa | Alto | Lock, auditoria prévia, exibição do token em caso de falha, sem retry |
| A detecção de reuso revoga a cadeia de PATs | Média | Alto | Nunca usar o PAT antigo depois do `200`; teste automatizado garante |
| Breaking changes em majors (Next, better-auth, Prisma) | Média | Médio | Versões exatas, Renovate com revisão manual de major, **os 157 testes** (unit + integração + E2E) no CI. O E2E já pegou 2 pegadinhas do better-auth (origem desligada em teste; rate limit de 2FA global) |
| `GITLAB_TLS_INSECURE=true` em produção | Média | Alto | Preferir a CA; aviso permanente na UI e no log; escopo só no GitLab. Ver [06](06-seguranca.md) |
| Endpoints do GitLab diferem na versão real da instância | Média | Alto | **Fase 0 pendente**: validar na documentação/instância; o cliente valida respostas com zod e mapeia erros, e o GitLab falso segue a doc que conhecemos, não a sua instância |
| Releases muito recentes com bugs | Média | Médio | `minimumReleaseAge` de 3 dias; sem RC/beta |
| O operador usa o mesmo PAT em scripts/CI e rotaciona pela ferramenta | Alta | Médio | Aviso no modal; exibição única do novo PAT |
| Engenharia social para resetar o MFA GitLab | Média | Alto | Motivo obrigatório, checkbox de verificação de identidade, auditoria; 4-eyes no futuro |
