'use server';
import { revalidatePath } from 'next/cache';
import {
  createRunnerSchema,
  deleteRunnerSchema,
  searchTargetsSchema,
  setRunnerPausedSchema,
  updateRunnerTagsSchema,
} from '@/lib/runner-rules';
import { runAction } from '@/server/action-result';
import { gitlabCtx } from '@/server/action-context';
import { createRunner, deleteRunner, searchRunnerTargets, setRunnerPaused, updateRunnerTags } from '@/server/services/runner.service';

export async function searchRunnerTargetsAction(input: unknown) {
  return runAction(async () => {
    const ctx = await gitlabCtx();
    const { kind, q } = searchTargetsSchema.parse(input);
    return searchRunnerTargets(ctx, kind, q);
  });
}

/** Devolve o token do runner UMA vez; ele não é guardado em lugar nenhum. */
export async function createRunnerAction(input: unknown) {
  return runAction(async () => {
    const ctx = await gitlabCtx();
    const out = await createRunner(ctx, createRunnerSchema.parse(input));
    revalidatePath('/runners');
    return out;
  });
}

export async function setRunnerPausedAction(input: unknown) {
  return runAction(async () => {
    const ctx = await gitlabCtx();
    await setRunnerPaused(ctx, setRunnerPausedSchema.parse(input));
    revalidatePath('/runners');
  });
}

export async function deleteRunnerAction(input: unknown) {
  return runAction(async () => {
    const ctx = await gitlabCtx();
    await deleteRunner(ctx, deleteRunnerSchema.parse(input));
    revalidatePath('/runners');
  });
}

export async function updateRunnerTagsAction(input: unknown) {
  return runAction(async () => {
    const ctx = await gitlabCtx();
    const out = await updateRunnerTags(ctx, updateRunnerTagsSchema.parse(input));
    revalidatePath('/runners');
    return out;
  });
}
