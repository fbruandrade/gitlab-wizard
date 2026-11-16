'use server';
import { revalidatePath } from 'next/cache';
import { executeVaultSchema, startVaultScanSchema, vaultConfigSchema } from '@/lib/admin-schemas';
import { runAction } from '@/server/action-result';
import { adminCtx } from '@/server/action-context';
import { executeVault, startVaultScan, updateVaultConfig } from '@/server/services/vault.service';
import { disableVaultAuto, enableVaultAuto } from '@/server/services/vault-auto.service';

export async function saveVaultConfigAction(input: unknown) {
  return runAction(async () => {
    const ctx = await adminCtx();
    const out = await updateVaultConfig(ctx, vaultConfigSchema.parse(input));
    revalidatePath('/admin/vault');
    return out;
  });
}

export async function startVaultScanAction(input: unknown = {}) {
  return runAction(async () => {
    const ctx = await adminCtx();
    return startVaultScan(ctx, startVaultScanSchema.parse(input));
  });
}

export async function executeVaultAction(input: unknown) {
  return runAction(async () => {
    const ctx = await adminCtx();
    const data = executeVaultSchema.parse(input);
    const out = await executeVault(ctx, { scanId: data.scanId, keys: data.keys, reason: data.reason });
    revalidatePath('/admin/vault');
    return out;
  });
}

export async function enableVaultAutoAction() {
  return runAction(async () => {
    const out = await enableVaultAuto(await adminCtx());
    revalidatePath('/admin/vault');
    return { enabledAt: out.enabledAt };
  });
}

export async function disableVaultAutoAction() {
  return runAction(async () => {
    await disableVaultAuto(await adminCtx());
    revalidatePath('/admin/vault');
    return {};
  });
}
