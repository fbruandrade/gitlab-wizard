'use server';
import { revalidatePath } from 'next/cache';
import { applyPatLifetimeSchema, patLifetimeSchema } from '@/lib/admin-schemas';
import { runAction } from '@/server/action-result';
import { adminCtx } from '@/server/action-context';
import { applyGitLabPatLifetime, startPatLifetimeSimulation } from '@/server/services/pat-policy.service';
import { updateSetting } from '@/server/services/settings.service';

/** Só a ferramenta: limita a data escolhida ao rotacionar o token aqui. Não toca no GitLab. */
export async function savePatLifetimeToolAction(input: unknown) {
  return runAction(async () => {
    const ctx = await adminCtx();
    const { days } = patLifetimeSchema.parse(input);
    await updateSetting(ctx, 'patMaxLifetimeDays', days);
    revalidatePath('/admin/policies');
    revalidatePath('/token');
    return { days };
  });
}

/** Dry-run do efeito no GitLab (não escreve nada lá). */
export async function simulatePatLifetimeAction(input: unknown) {
  return runAction(async () => {
    const ctx = await adminCtx();
    return startPatLifetimeSimulation(ctx, patLifetimeSchema.parse(input).days);
  });
}

/** Escreve no GitLab. Exige simulação concluída com o mesmo valor, motivo e confirmação digitada. */
export async function applyPatLifetimeGitLabAction(input: unknown) {
  return runAction(async () => {
    const ctx = await adminCtx();
    const data = applyPatLifetimeSchema.parse(input);
    const out = await applyGitLabPatLifetime(ctx, { scanId: data.scanId, days: data.days, reason: data.reason });
    revalidatePath('/admin/policies');
    return out;
  });
}
