'use server';
import { revalidatePath } from 'next/cache';
import { createToolUserSchema, setRoleSchema, toolUserTargetSchema } from '@/lib/schemas';
import { runAction } from '@/server/action-result';
import { adminCtx } from '@/server/action-context';
import * as svc from '@/server/services/tool-user.service';

const refresh = () => revalidatePath('/admin/users');

export async function createToolUserAction(input: unknown) {
  return runAction(async () => {
    const ctx = await adminCtx();
    const out = await svc.createToolUser(ctx, createToolUserSchema.parse(input));
    refresh();
    return out; // contém a senha temporária: exibida UMA vez ao admin
  });
}
export async function resetToolUserPasswordAction(input: unknown) {
  return runAction(async () => {
    const ctx = await adminCtx();
    const out = await svc.resetToolUserPassword(ctx, toolUserTargetSchema.parse(input));
    refresh();
    return out;
  });
}
export async function resetToolUserTwoFactorAction(input: unknown) {
  return runAction(async () => {
    const ctx = await adminCtx();
    await svc.resetToolUserTwoFactor(ctx, toolUserTargetSchema.parse(input));
    refresh();
  });
}
export async function setToolUserRoleAction(input: unknown) {
  return runAction(async () => {
    const ctx = await adminCtx();
    await svc.setToolUserRole(ctx, setRoleSchema.parse(input));
    refresh();
  });
}
export async function banToolUserAction(input: unknown) {
  return runAction(async () => {
    const ctx = await adminCtx();
    await svc.banToolUser(ctx, toolUserTargetSchema.parse(input));
    refresh();
  });
}
export async function unbanToolUserAction(input: unknown) {
  return runAction(async () => {
    const ctx = await adminCtx();
    await svc.unbanToolUser(ctx, toolUserTargetSchema.parse(input));
    refresh();
  });
}
export async function revokeToolUserSessionsAction(input: unknown) {
  return runAction(async () => {
    const ctx = await adminCtx();
    await svc.revokeToolUserSessions(ctx, toolUserTargetSchema.parse(input));
    refresh();
  });
}
