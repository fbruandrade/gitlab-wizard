import { z } from 'zod';
import { reasonSchema } from './schemas';
import { SETTING_BOUNDS } from './settings';
import { ACCESS_LEVELS, VAULT_BOUNDS, VAULT_SCOPES } from './vault-rules';

export const inactivityDaysSchema = z.object({
  days: z.number().int().min(SETTING_BOUNDS.cleanupInactivityDays.min).max(SETTING_BOUNDS.cleanupInactivityDays.max),
});
export const cleanupParamsSchema = z.object({
  blockedUsers: z.boolean(),
  unusedDays: z.number().int().min(1).max(3650).nullable(),
  includePat: z.boolean(),
  includeSsh: z.boolean(),
  sshNoExpiry: z.boolean().optional(),
});
/** Confirmação digitada: evita revogação em massa por clique distraído. */
export const CLEANUP_CONFIRM_WORD = 'REVOGAR';
export const executeCleanupSchema = z.object({
  scanId: z.uuid(),
  keys: z
    .array(z.string().regex(/^(PAT|SSH_KEY):\d+$/))
    .min(1)
    .max(500),
  reason: reasonSchema,
  confirm: z.literal(CLEANUP_CONFIRM_WORD),
});

export const patLifetimeSchema = z.object({
  days: z.number().int().min(SETTING_BOUNDS.patMaxLifetimeDays.min).max(SETTING_BOUNDS.patMaxLifetimeDays.max),
});
export const applyConfirmWord = (days: number) => `APLICAR ${days}`;
export const applyPatLifetimeSchema = z
  .object({ scanId: z.uuid(), days: patLifetimeSchema.shape.days, reason: reasonSchema, confirm: z.string() })
  .refine((v) => v.confirm === applyConfirmWord(v.days), { path: ['confirm'], message: 'Confirmação incorreta.' });

export const vaultConfigSchema = z.object({
  rootGroup: z.string().trim().min(1).max(255),
  warnDays: z.number().int().min(VAULT_BOUNDS.warnDays.min).max(VAULT_BOUNDS.warnDays.max),
  lifetimeDays: z.number().int().min(VAULT_BOUNDS.lifetimeDays.min).max(VAULT_BOUNDS.lifetimeDays.max),
  scopes: z.array(z.enum(VAULT_SCOPES)).min(1),
  accessLevel: z
    .number()
    .int()
    .refine((n) => n in ACCESS_LEVELS),
});
export const startVaultScanSchema = z.object({ force: z.boolean().default(false) });
export const VAULT_CONFIRM_WORD = 'APLICAR';
export const executeVaultSchema = z.object({
  scanId: z.uuid(),
  keys: z
    .array(z.string().regex(/^project:\d+$/))
    .min(1)
    .max(50),
  reason: reasonSchema,
  confirm: z.literal(VAULT_CONFIRM_WORD),
});
