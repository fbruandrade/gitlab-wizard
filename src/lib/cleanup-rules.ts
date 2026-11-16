// Regras da limpeza de credenciais. PURO e client-safe: decide o que é candidato a revogação.
// Princípio: na dúvida, NÃO revoga. Falta de dado (ex.: chave SSH sem `last_used_at`) nunca vira "sem uso".

export type CleanupReason = 'USER_BLOCKED' | 'UNUSED' | 'NO_EXPIRY';
export type CredentialKind = 'PAT' | 'SSH_KEY';
export type ProtectedReason = 'SELF' | 'LINKED_IN_TOOL';

export interface CleanupParams {
  /** Credenciais de usuários bloqueados (`blocked`/`ldap_blocked`). */
  blockedUsers: boolean;
  /** Credenciais sem uso há MAIS de N dias. null = critério desligado. */
  unusedDays: number | null;
  includePat: boolean;
  includeSsh: boolean;
  /** Chaves SSH sem data de validade (qualquer uso). Útil quando o GitLab não informa o último uso. Ausente em varreduras antigas. */
  sshNoExpiry?: boolean;
}

export interface CleanupItem {
  key: string; // `${kind}:${credentialId}`
  kind: CredentialKind;
  gitlabUserId: number;
  username: string;
  userState: string;
  credentialId: number;
  name: string;
  createdAt: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  /** Escopos do token (só PAT). Varreduras antigas não têm o campo. */
  scopes?: string[];
  /** Tipo de uso da chave SSH: auth | signing | auth_and_signing (só SSH). */
  usageType?: string | null;
  reasons: CleanupReason[];
  /** Presente = aparece na lista, mas NÃO pode ser selecionado/revogado. */
  protectedReason?: ProtectedReason;
}

export interface RuleUser {
  id: number;
  username: string;
  state: string;
  bot?: boolean;
}
export interface RulePat {
  id: number;
  user_id: number;
  name: string;
  scopes?: string[];
  created_at?: string | null;
  last_used_at?: string | null;
  expires_at?: string | null;
  revoked?: boolean;
  active?: boolean;
}
export interface RuleKey {
  id: number;
  title?: string | null;
  usage_type?: string | null;
  created_at?: string | null;
  expires_at?: string | null;
  /** Se a chave NÃO tem esta propriedade, o GitLab não informou o último uso (≠ null = "nunca usada"). */
  last_used_at?: string | null;
}

export interface ClassifyInput {
  params: CleanupParams;
  now: Date;
  users: Map<number, RuleUser>;
  pats: RulePat[];
  keysByUser: Map<number, RuleKey[]>;
  selfGitlabUserId: number;
  linkedTokenIds: Set<number>;
}

export interface ClassifyResult {
  items: CleanupItem[];
  excluded: { bots: number; unknownOwner: number };
  /** true se alguma chave SSH veio sem `last_used_at`: o critério "sem uso" não pôde ser avaliado para elas. */
  sshLastUsedUnavailable: boolean;
}

const DAY = 86_400_000;
/**
 * Contas não humanas (tokens de projeto/grupo, contas de serviço). O GitLab expõe `bot` e/ou `user_type` conforme a
 * versão; usa os dois e, por garantia, o padrão de username dos bots de projeto/grupo.
 */
export function isBotUser(u: { username: string; bot?: boolean | null; user_type?: string | null }): boolean {
  if (u.bot === true) return true;
  if (u.user_type && u.user_type !== 'human') return true;
  return /^(project|group)_\d+_bot/.test(u.username);
}

export const isBlockedState = (state: string) => state === 'blocked' || state === 'ldap_blocked';

/** "Sem uso há mais de N dias": usa o último uso; se nunca usada, a data de criação. Sem nenhuma data → desconhecido (false). */
export function isUnused(lastUsedAt: string | null | undefined, createdAt: string | null | undefined, days: number, now: Date): boolean {
  const ref = lastUsedAt ?? createdAt;
  if (!ref) return false;
  const t = Date.parse(ref);
  if (Number.isNaN(t)) return false;
  return t < now.getTime() - days * DAY;
}

export function classify(i: ClassifyInput): ClassifyResult {
  const { params, now } = i;
  const items: CleanupItem[] = [];
  const excluded = { bots: 0, unknownOwner: 0 };
  let sshLastUsedUnavailable = false;

  const reasonsFor = (user: RuleUser, lastUsed: string | null | undefined, created: string | null | undefined, canJudgeUse: boolean) => {
    const reasons: CleanupReason[] = [];
    if (params.blockedUsers && isBlockedState(user.state)) reasons.push('USER_BLOCKED');
    if (params.unusedDays !== null && canJudgeUse && isUnused(lastUsed, created, params.unusedDays, now)) reasons.push('UNUSED');
    return reasons;
  };

  if (params.includePat) {
    for (const p of i.pats) {
      if (p.revoked || p.active === false) continue;
      const user = i.users.get(p.user_id);
      if (!user) {
        excluded.unknownOwner++;
        continue;
      }
      if (user.bot) {
        excluded.bots++;
        continue;
      } // tokens de projeto/grupo/serviço: revogar quebraria automações
      const reasons = reasonsFor(user, p.last_used_at, p.created_at, true);
      if (!reasons.length) continue;
      items.push({
        key: `PAT:${p.id}`,
        kind: 'PAT',
        gitlabUserId: user.id,
        username: user.username,
        userState: user.state,
        credentialId: p.id,
        name: p.name,
        createdAt: p.created_at ?? null,
        lastUsedAt: p.last_used_at ?? null,
        expiresAt: p.expires_at ?? null,
        scopes: p.scopes ?? [],
        reasons,
        ...protect(user.id, p.id, i),
      });
    }
  }

  if (params.includeSsh) {
    for (const [userId, keys] of i.keysByUser) {
      const user = i.users.get(userId);
      if (!user) {
        excluded.unknownOwner++;
        continue;
      }
      if (user.bot) {
        excluded.bots++;
        continue;
      }
      for (const k of keys) {
        const known = 'last_used_at' in k;
        if (!known) sshLastUsedUnavailable = true;
        const reasons = reasonsFor(user, k.last_used_at, k.created_at, known);
        if (params.sshNoExpiry && !k.expires_at) reasons.push('NO_EXPIRY');
        if (!reasons.length) continue;
        items.push({
          key: `SSH_KEY:${k.id}`,
          kind: 'SSH_KEY',
          gitlabUserId: user.id,
          username: user.username,
          userState: user.state,
          credentialId: k.id,
          name: k.title ?? `chave #${k.id}`,
          createdAt: k.created_at ?? null,
          lastUsedAt: k.last_used_at ?? null,
          expiresAt: k.expires_at ?? null,
          usageType: k.usage_type ?? null,
          reasons,
          ...protect(user.id, null, i),
        });
      }
    }
  }

  items.sort((a, b) => a.username.localeCompare(b.username) || a.kind.localeCompare(b.kind) || a.credentialId - b.credentialId);
  return { items, excluded, sshLastUsedUnavailable };
}

/** Itens protegidos aparecem na lista, mas não são revogáveis. */
function protect(userId: number, patId: number | null, i: ClassifyInput): { protectedReason?: ProtectedReason } {
  if (userId === i.selfGitlabUserId) return { protectedReason: 'SELF' }; // revogar as próprias credenciais tiraria o acesso do operador
  if (patId !== null && i.linkedTokenIds.has(patId)) return { protectedReason: 'LINKED_IN_TOOL' }; // PAT em uso por outra conta desta ferramenta
  return {};
}

export function validateCleanupParams(p: CleanupParams): string | null {
  if (!p.blockedUsers && p.unusedDays === null && !p.sshNoExpiry)
    return 'Selecione ao menos um critério (usuários bloqueados, sem uso e/ou chaves SSH sem validade).';
  if (p.sshNoExpiry && !p.blockedUsers && p.unusedDays === null && !p.includeSsh)
    return 'Chaves SSH sem validade exigem incluir chaves SSH.';
  if (!p.includePat && !p.includeSsh) return 'Selecione ao menos um tipo de credencial (tokens e/ou chaves SSH).';
  if (p.unusedDays !== null && (!Number.isInteger(p.unusedDays) || p.unusedDays < 1 || p.unusedDays > 3650))
    return 'Dias sem uso: informe um inteiro entre 1 e 3650.';
  return null;
}

/** Escopos que dão controle amplo: destacados na tela para priorizar a revisão. */
export const PRIVILEGED_SCOPES = ['api', 'sudo', 'admin_mode'] as const;
export const isPrivilegedScope = (s: string) => (PRIVILEGED_SCOPES as readonly string[]).includes(s);

const USAGE_LABEL: Record<string, string> = { auth: 'autenticação', signing: 'assinatura', auth_and_signing: 'autenticação + assinatura' };
export const usageTypeLabel = (u: string | null | undefined) => (u ? (USAGE_LABEL[u] ?? u) : null);
