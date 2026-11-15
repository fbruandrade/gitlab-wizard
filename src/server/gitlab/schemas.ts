import { z } from 'zod';

// looseObject: campos novos entre versões do GitLab não quebram o parse.
export const currentUserSchema = z.looseObject({
  id: z.number().int(),
  username: z.string(),
  name: z.string(),
  // Só vem para quem é admin.
  is_admin: z.boolean().optional().default(false),
  avatar_url: z.string().nullish(),
});
export type GitLabCurrentUser = z.infer<typeof currentUserSchema>;

export const tokenInfoSchema = z.looseObject({
  id: z.number().int(),
  name: z.string(),
  scopes: z.array(z.string()),
  expires_at: z.string().nullish(),
  active: z.boolean().optional().default(true),
  revoked: z.boolean().optional().default(false),
  last_used_at: z.string().nullish(),
});
export type GitLabTokenInfo = z.infer<typeof tokenInfoSchema>;

export const rotatedTokenSchema = tokenInfoSchema.extend({ token: z.string().min(1) });
export type GitLabRotatedToken = z.infer<typeof rotatedTokenSchema>;

export const gitlabUserSchema = z.looseObject({
  id: z.number().int(),
  username: z.string(),
  name: z.string(),
  state: z.string(),
  email: z.string().nullish(),
  avatar_url: z.string().nullish(),
  created_at: z.string().nullish(),
  last_sign_in_at: z.string().nullish(),
  two_factor_enabled: z.boolean().optional().default(false),
  locked: z.boolean().optional(),
  is_admin: z.boolean().optional(),
  // Exposição varia por versão: `bot` e/ou `user_type` ('human' | 'project_bot' | 'service_account' …).
  bot: z.boolean().optional(),
  user_type: z.string().nullish(),
});
export type GitLabUser = z.infer<typeof gitlabUserSchema>;

export const versionSchema = z.looseObject({ version: z.string() });

/** Item de GET /personal_access_tokens (admin lista os de toda a instância). */
export const patListItemSchema = z.looseObject({
  id: z.number().int(),
  user_id: z.number().int(),
  name: z.string(),
  scopes: z.array(z.string()).optional().default([]),
  created_at: z.string().nullish(),
  last_used_at: z.string().nullish(),
  expires_at: z.string().nullish(),
  revoked: z.boolean().optional().default(false),
  active: z.boolean().optional().default(true),
});
export type GitLabPat = z.infer<typeof patListItemSchema>;

/** Chave SSH de um usuário. looseObject: a PRESENÇA de `last_used_at` importa (ausente ≠ null). */
export const sshKeySchema = z.looseObject({
  id: z.number().int(),
  title: z.string().nullish(),
  created_at: z.string().nullish(),
  expires_at: z.string().nullish(),
  last_used_at: z.string().nullish(),
  usage_type: z.string().nullish(),
});
export type GitLabSshKey = z.infer<typeof sshKeySchema>;

export const appSettingsSchema = z.looseObject({
  max_personal_access_token_lifetime: z.number().nullish(),
});

/** GET /license (só admin). Campos numéricos podem faltar conforme edição/versão. */
export const licenseSchema = z.looseObject({
  plan: z.string().nullish(),
  starts_at: z.string().nullish(),
  expires_at: z.string().nullish(),
  expired: z.boolean().optional(),
  user_limit: z.number().nullish(),
  maximum_user_count: z.number().nullish(),
  active_users: z.number().nullish(),
  overage: z.number().nullish(),
  historical_max: z.number().nullish(),
});
export type GitLabLicense = z.infer<typeof licenseSchema>;

export interface Paginated<T> {
  items: T[];
  page: number;
  nextPage: number | null;
  totalPages: number | null;
}
