'use server';
import { revalidatePath } from 'next/cache';
import { cleanupParamsSchema, executeCleanupSchema, inactivityDaysSchema } from '@/lib/admin-schemas';
import { runAction } from '@/server/action-result';
import { adminCtx } from '@/server/action-context';
import { executeCleanup, startCleanupScan } from '@/server/services/cleanup.service';
import { updateSetting } from '@/server/services/settings.service';

export async function saveInactivityDaysAction(input: unknown) {
  return runAction(async () => {
    const ctx = await adminCtx();
    const { days } = inactivityDaysSchema.parse(input);
    await updateSetting(ctx, 'cleanupInactivityDays', days);
    revalidatePath('/admin/cleanup');
    return { days };
  });
}

export async function startCleanupScanAction(input: unknown) {
  return runAction(async () => {
    const ctx = await adminCtx();
    return startCleanupScan(ctx, cleanupParamsSchema.parse(input));
  });
}

export async function executeCleanupAction(input: unknown) {
  return runAction(async () => {
    const ctx = await adminCtx();
    const data = executeCleanupSchema.parse(input);
    const out = await executeCleanup(ctx, { scanId: data.scanId, keys: data.keys, reason: data.reason });
    revalidatePath('/admin/cleanup');
    return out;
  });
}
