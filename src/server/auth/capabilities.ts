import 'server-only';
import { env } from '@/server/env';

export type Capability = 'READ_USERS' | 'ADMIN_USERS' | 'SELF_ROTATE' | 'VAULT_TOKENS' | 'RUNNERS_CREATE' | 'RUNNERS_MANAGE';

export interface CapabilityInput {
  isAdmin: boolean;
  scopes: readonly string[];
  adminModeEnabled?: boolean;
}

/** Matriz de docs/04-integracao-gitlab-api.md §2. Independe do papel na ferramenta. */
export function computeCapabilities({ isAdmin, scopes, adminModeEnabled }: CapabilityInput): Capability[] {
  const has = (...s: string[]) => s.some((x) => scopes.includes(x));
  const adminMode = adminModeEnabled ?? env.GITLAB_ADMIN_MODE_ENABLED;
  const caps: Capability[] = [];
  if (isAdmin && has('api', 'read_api')) caps.push('READ_USERS');
  if (isAdmin && scopes.includes('api') && (!adminMode || scopes.includes('admin_mode'))) caps.push('ADMIN_USERS');
  if (has('api', 'self_rotate')) caps.push('SELF_ROTATE');
  // Cofre de tokens de projeto: não exige admin; o GitLab valida o papel (Maintainer+) em cada chamada.
  if (scopes.includes('api')) caps.push('VAULT_TOKENS');
  // Runners: criar exige o scope `create_runner` (o `api` NÃO basta, segundo a doc); listar/pausar/remover aceita `manage_runner` ou `api`.
  if (scopes.includes('create_runner')) caps.push('RUNNERS_CREATE');
  if (has('api', 'manage_runner')) caps.push('RUNNERS_MANAGE');
  return caps;
}
