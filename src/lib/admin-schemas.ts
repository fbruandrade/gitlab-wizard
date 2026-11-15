import { z } from 'zod';
import { reasonSchema } from './schemas';
import { SETTING_BOUNDS } from './settings';

export const inactivityDaysSchema = z.object({
  days: z.number().int().min(SETTING_BOUNDS.cleanupInactivityDays.min).max(SETTING_BOUNDS.cleanupInactivityDays.max),
});
export const cleanupParamsSchema = z.object({
  blockedUsers: z.boolean(),
  unusedDays: z.number().int().min(1).max(3650).nullable(),
  includePat: z.boolean(),
  includeSsh: z.boolean(),
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
