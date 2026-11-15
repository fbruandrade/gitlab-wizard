# 06 — Segurança

A ferramenta guarda PATs que, no caso de admins GitLab, dão controle total da instância. Por isso o desenho parte de duas premissas: **o PAT é o ativo mais sensível** e **a conta da ferramenta é a porta de entrada para ele**. As duas camadas precisam ser fortes.

## 1. Camadas de proteção

```
Acesso à ferramenta     → username + senha (scrypt) + TOTP + rate limit + sessão curta
Ação sensível           → sessão "fresca" (login recente) + motivo obrigatório + confirmação
Uso do PAT              → decifrado só no servidor, durante a requisição
Permissão efetiva       → o GitLab decide (o PAT só faz o que o operador já poderia fazer)
Rastreabilidade         → auditoria append-only de tudo
```

## 2. Contas e senhas (better-auth)

- Hash **scrypt** (padrão do better-auth). Se a política interna exigir argon2id, sobrescrever `emailAndPassword.password.{hash,verify}`.
- Política: 12 a 128 caracteres, com pelo menos 3 de 4 classes (maiúscula, minúscula, número, símbolo), validada em zod no client e em hook `before` no servidor. Opcional: plugin `haveIBeenPwned` (consulta externa; avaliar com a Segurança).
- Senha temporária criada pelo admin: 20 caracteres aleatórios, exibida uma vez, `mustChangePassword = true`.
- Troca de senha: `changePassword` com `revokeOtherSessions: true`.
- Mensagem de login genérica ("Usuário ou senha inválidos"), sem revelar qual dos dois está errado.
- Rate limit: 5 tentativas/min por IP em `/sign-in/username` e nos endpoints de verificação 2FA, guardado no banco.
- **2FA da ferramenta** obrigatório em produção (`REQUIRE_APP_2FA=true`). Códigos de backup exibidos uma vez na ativação.

## 3. Sessão

- Gerenciada pelo better-auth: token aleatório no cookie `gw.session_token` (`HttpOnly`, `Secure`, `SameSite=Lax`), registro na tabela `session`.
- Expiração por inatividade de 30 min (`expiresIn` + `updateAge`) e limite absoluto de 8 h aplicado no guard.
- `cookieCache` de 60 s para leituras. Ações sensíveis consultam o banco (`disableCookieCache`).
- **Sessão fresca**: ações GitLab e de admin exigem login nos últimos 15 min. Fora disso, a UI pede reautenticação.
- O usuário vê e encerra as próprias sessões; o admin revoga todas as sessões de uma conta.
- Banir uma conta revoga as sessões dela (comportamento do plugin `admin`).

## 4. Armazenamento do PAT

- **AES-256-GCM**, IV de 12 bytes aleatório por cifragem e auth tag de 16 bytes.
- **AAD** = `${userId}:${gitlabTokenId}`: impede que um ciphertext copiado para a linha de outra conta seja decifrado.
- **Chaves versionadas** (`TOKEN_ENCRYPTION_KEYS` + `TOKEN_ENCRYPTION_ACTIVE_KEY`). A cifragem usa sempre a chave ativa; a decifragem usa a versão gravada em `keyVersion`. Há um script de recifragem para rotacionar a chave.
- Em produção, a chave mestra vem de Vault/KMS, injetada no runtime. Ela é **independente** do `BETTER_AUTH_SECRET`.
- O token em claro vive só em variáveis locais da requisição e nunca entra em estado React, cache do Next (`'use cache'`), logs ou respostas.

```ts
// src/server/crypto/token-cipher.ts (esboço)
import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function encryptToken(plain: string, aad: string) {
  const { version, key } = activeKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: version };
}

export function decryptToken(rec: EncryptedToken, aad: string): string {
  const decipher = createDecipheriv('aes-256-gcm', keyFor(rec.keyVersion), rec.iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(rec.authTag);
  return Buffer.concat([decipher.update(rec.ciphertext), decipher.final()]).toString('utf8');
}
```

## 5. Autorização

| Ação | Requisito |
|------|-----------|
| Telas autenticadas | Sessão válida, senha já trocada, 2FA configurado (se obrigatório) |
| Vincular, substituir ou rotacionar o PAT | Sessão fresca; para rotacionar, capability `SELF_ROTATE` |
| Desbloquear / resetar MFA GitLab | Sessão fresca + capability `ADMIN_USERS` + motivo + confirmação |
| Gerenciar contas da ferramenta | Sessão fresca + `role = admin` + motivo |
| Auditoria global | `role = admin` |

- Cada Server Action revalida tudo no servidor. **Nunca confiar** no fato de a UI ter escondido um botão.
- O GitLab é a fonte de verdade: um `403` dele prevalece sobre a capability local e força o recálculo.
- Server Actions retornam `{ ok: false, code }` e nunca vazam detalhes internos.

## 6. Proteções web

| Ameaça | Controle |
|--------|---------|
| CSRF | Server Actions validam `Origin` × `Host`/`X-Forwarded-Host` (o proxy **deve** encaminhar esses headers). O better-auth valida a origem com `trustedOrigins` — **checagem fixada ligada** (o default a desliga em `NODE_ENV=test`). Cookies `SameSite=Lax`. Testado: cookie válido + `Origin` forjado → 403 |
| XSS | React escapa por padrão; `react/no-danger` como erro de lint; **CSP com nonce por requisição** no `proxy.ts` (`script-src 'self' 'nonce-…' 'strict-dynamic'`, `frame-ancestors 'none'`, `object-src 'none'`, `img-src 'self' data:`). Todas as páginas são dinâmicas (necessário para o nonce). O E2E garante zero violação de CSP |
| Clickjacking | `frame-ancestors 'none'` |
| Vazamento em log | pino `redact` (`*.token`, `*.password`, `*.newPassword`, `*.currentPassword`, `*.secret`, `*.backupCodes`, `req.headers.cookie`, `req.headers["private-token"]`) |
| Força bruta | Rate limit do better-auth no login e na verificação 2FA |
| SSRF | `GITLAB_BASE_URL` fixo por env; o usuário nunca informa URL |
| PAT no browser | Campo `type="password"`, `autocomplete="off"`; o PAT nunca é devolvido depois do cadastro. A exibição pós-rotação é única e opcional |
| Cache indevido | Páginas autenticadas são dinâmicas (leem `headers()`/cookies); nada de PAT ou dados GitLab sensíveis dentro de `'use cache'` |
| Dependências | Renovate + `npm audit` no CI (produção: **0** vulnerabilidades hoje; bloqueia moderada+ em produção e alta+ em tudo); versões exatas; pacotes de build (`shadcn`) fora de `dependencies` |

## 7. Auditoria

- Eventos de autenticação vêm do hook `after` do better-auth. Eventos de negócio vêm do wrapper `withAudit` nas Server Actions:

```ts
return withAudit(
  { action: 'GITLAB_USER_UNBLOCKED', target: { type: 'gitlab_user', id, label }, reason },
  async () => {
    // ... chamada ao GitLab
    return { stateBefore, stateAfter };
  },
);
```

- Grava `SUCCESS` ou `FAILURE` (com `errorCode`); falhas também são auditadas.
- Na rotação, `GITLAB_TOKEN_ROTATION_STARTED` é gravado **antes** da chamada ao GitLab, o que permite reconciliar casos ambíguos.
- A auditoria local complementa os audit events do próprio GitLab (Premium/Ultimate) com **quem na ferramenta** fez a ação e **por quê**.

## 7b. Limpeza em massa de credenciais e política de validade

Revogar credenciais de outros usuários é a operação mais destrutiva da ferramenta. Controles:

| Controle | Detalhe |
|----------|---------|
| Dry-run obrigatório | A execução só age sobre itens de uma varredura concluída (≤ 6 h), do mesmo admin |
| **Reavaliação antes de revogar** | Imediatamente antes, cada item é reavaliado com dados frescos do GitLab: usado ou desbloqueado desde a varredura → **ignorado** |
| Protegidos | Conta do próprio operador (revogar tiraria o acesso dele) e PATs em uso por contas desta ferramenta aparecem na lista, mas **não são selecionáveis nem aceitos pelo servidor**; bots são excluídos |
| Dado ausente ≠ inativo | Chave SSH sem `last_used_at` nunca vira "sem uso" |
| Confirmação | Motivo (≥ 10 caracteres) + digitar `REVOGAR`; máx. 500 itens por execução; sessão fresca; só `role = admin` **e** PAT com capacidade `ADMIN_USERS` |
| Sem retry | Escritas (DELETE/PUT) não repetem; um 401 interrompe o lote e invalida o PAT do operador |
| Auditoria | Uma linha **por item** (com motivos, último uso, estado do dono) + resumo; falhas também |
| **Aplicar limite no GitLab** | Exige simulação concluída (≤ 30 min) **do mesmo valor**, motivo e digitar `APLICAR N`. A simulação avisa se o **seu token** ou os **vinculados à ferramenta** seriam revogados. Só vale se o GitLab devolver o valor aplicado |

## 7c. Vários tokens por conta e token em uso

| Controle | Detalhe |
|----------|---------|
| Cookie `gw.active_token` | Guarda só o **id** do token escolhido (`HttpOnly`, `SameSite=Lax`, `Secure` em https). **Não é credencial**: `resolveToken` só o aceita se o token for **desta conta e estiver ativo**; id de outra conta (cookie forjado/herdado no mesmo navegador), id inexistente ou lixo → cai no padrão. Testado (integração e E2E) |
| Toda ação por id confere a posse | Rotacionar, substituir, desvincular, definir padrão e escolher recebem um id e fazem `ownActive(userId, id)`: token de outra conta → `TOKEN_NOT_FOUND` |
| Mesma identidade | Todos os tokens de uma conta são do mesmo usuário GitLab (a auditoria continua dizendo quem agiu); outra conta não consegue ficar com esse usuário GitLab nem com o mesmo PAT (índices únicos parciais no banco) |
| Privilégio mínimo | Dá para manter um token só de **leitura** e usá-lo no dia a dia, trocando para o de admin só quando preciso. A permissão de cada ação é a do token **em uso** |
| Escolher o token em uso | Preferência de baixo risco: exige sessão válida e conta pronta, mas **não** login recente (só ações sensíveis exigem). Ações sensíveis continuam exigindo sessão fresca |
| Remover ≠ revogar | Desvincular tira o token da ferramenta e apaga a cópia cifrada na retenção (30 dias); **não** chama o GitLab |

## 8. Modelo de ameaças (STRIDE resumido)

| Ameaça | Cenário | Mitigação |
|--------|---------|-----------|
| Spoofing | Senha de operador vazada | 2FA obrigatório, rate limit, alertas de login (futuro) |
| Spoofing | Sequestro de sessão | Cookie seguro, sessão curta, sessão fresca para ações, revogação |
| Tampering | Alteração da auditoria | Permissões de banco append-only, backups |
| Repudiation | Operador nega uma ação | Auditoria com conta, IP, user agent, motivo e horário |
| Information disclosure | Dump do banco | PAT cifrado com chave fora do banco, AAD, senhas com hash |
| Elevation of privilege | Conta comum chama action de admin | Guards no servidor; o GitLab nega com `403` de qualquer forma |
| Information disclosure / Tampering | `GITLAB_TLS_INSECURE=true`: alguém na rede se passa pelo GitLab e captura o PAT | Só habilitar se não houver CA para confiar; preferir `NODE_EXTRA_CA_CERTS`. Escopo restrito às chamadas ao GitLab, aviso permanente na UI e log `warn`. Risco aceito conscientemente pelo deploy |
| Denial of service | Rate limit de login/2FA compartilhado por todos (sem `CLIENT_IP_HEADER`) | Configurar o header do proxy; o app avisa no boot |
| Elevation of privilege | Admin da ferramenta usa o PAT de outro usuário | Não é possível: as actions só usam o PAT **da própria sessão**; não há impersonation habilitada |

> O plugin `admin` do better-auth permite **impersonation**. **Implementação:** o handler HTTP aceita apenas uma *allowlist* de endpoints; `/admin/*` (inclusive `impersonate-user`) responde 404 para qualquer um, admin ou não (testado). Isso impede que um admin da ferramenta aja com o PAT de outro operador e também que contorne motivo/auditoria chamando o plugin direto.

## 9. Compliance

- LGPD: minimização. O e-mail do usuário GitLab alvo aparece na tela (vem do GitLab em tempo real), mas não é persistido.
- A validar com a Segurança da Informação: classificação do dado "PAT de admin", cofre de chaves, política de senha, pentest antes da produção.
