// Client-safe: explica o que cada capability exige e por que falta (docs/07 T2).
export const CAPABILITIES = [
  { key: 'READ_USERS', label: 'Buscar usuários GitLab' },
  { key: 'ADMIN_USERS', label: 'Desbloquear usuário e resetar MFA' },
  { key: 'SELF_ROTATE', label: 'Rotacionar meu token' },
] as const;

export function missingReason(key: string, i: { isAdmin: boolean; scopes: string[]; adminMode: boolean }): string {
  const has = (...s: string[]) => s.some((x) => i.scopes.includes(x));
  switch (key) {
    case 'READ_USERS':
      return !i.isAdmin ? 'Requer conta admin no GitLab.' : 'Requer scope `api` ou `read_api`.';
    case 'ADMIN_USERS':
      if (!i.isAdmin) return 'Requer conta admin no GitLab.';
      if (!has('api')) return 'Requer scope `api`.';
      return 'Requer scope `admin_mode` (Admin Mode está ativo).';
    default:
      return 'Requer scope `api` ou `self_rotate`.';
  }
}
