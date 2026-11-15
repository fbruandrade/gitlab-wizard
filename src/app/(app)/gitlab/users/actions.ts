'use server';
import { revalidatePath } from 'next/cache';
import { gitlabUserActionSchema } from '@/lib/schemas';
import { runAction } from '@/server/action-result';
import { gitlabCtx } from '@/server/action-context';
import { blockGitLabUser, disableGitLabUserTwoFactor, unblockGitLabUser } from '@/server/services/gitlab-user.service';

export async function blockGitLabUserAction(input: unknown) {
  return runAction(async () => {
    const ctx = await gitlabCtx();
    const data = gitlabUserActionSchema.parse(input);
    await blockGitLabUser(ctx, data);
    revalidatePath(`/gitlab/users/${data.gitlabUserId}`);
  });
}

export async function unblockGitLabUserAction(input: unknown) {
  return runAction(async () => {
    const ctx = await gitlabCtx();
    const data = gitlabUserActionSchema.parse(input);
    await unblockGitLabUser(ctx, data);
    revalidatePath(`/gitlab/users/${data.gitlabUserId}`);
  });
}

export async function disableGitLabUserTwoFactorAction(input: unknown) {
  return runAction(async () => {
    const ctx = await gitlabCtx();
    const data = gitlabUserActionSchema.parse(input);
    await disableGitLabUserTwoFactor(ctx, data);
    revalidatePath(`/gitlab/users/${data.gitlabUserId}`);
  });
}
