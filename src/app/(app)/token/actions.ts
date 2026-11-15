'use server';
import { revalidatePath } from 'next/cache';
import { addTokenSchema, replaceTokenSchema, rotateSchema, tokenRefSchema } from '@/lib/schemas';
import { runAction } from '@/server/action-result';
import { gitlabCtx } from '@/server/action-context';
import { requireActiveSession } from '@/server/auth/guards';
import { addToken, ownActive, replaceToken, rotateToken, setDefaultToken, unlinkToken } from '@/server/services/gitlab-token.service';
import { setSelectedTokenId } from '@/server/token-selection';

const refresh = () => revalidatePath('/', 'layout');

/** Adiciona um PAT (a conta pode ter vários). O primeiro vira o padrão. */
export async function addGitLabTokenAction(input: unknown) {
  return runAction(async () => {
    const ctx = await gitlabCtx();
    const { token, makeDefault } = addTokenSchema.parse(input);
    const out = await addToken(ctx, token, { makeDefault });
    refresh();
    return out;
  });
}

export async function replaceGitLabTokenAction(input: unknown) {
  return runAction(async () => {
    const ctx = await gitlabCtx();
    const { tokenId, token } = replaceTokenSchema.parse(input);
    const out = await replaceToken(ctx, tokenId, token);
    refresh();
    return out;
  });
}

export async function unlinkGitLabTokenAction(input: unknown) {
  return runAction(async () => {
    const ctx = await gitlabCtx();
    const out = await unlinkToken(ctx, tokenRefSchema.parse(input).tokenId);
    refresh();
    return out;
  });
}

export async function setDefaultGitLabTokenAction(input: unknown) {
  return runAction(async () => {
    const ctx = await gitlabCtx();
    const out = await setDefaultToken(ctx, tokenRefSchema.parse(input).tokenId);
    refresh();
    return out;
  });
}

/** Escolhe qual token usar NESTE navegador (preferência de sessão; não exige login recente). */
export async function selectGitLabTokenAction(input: unknown) {
  return runAction(async () => {
    const session = await requireActiveSession();
    const { tokenId } = tokenRefSchema.parse(input);
    const row = await ownActive(session.user.id, tokenId); // só tokens ativos DESTA conta
    await setSelectedTokenId(row.id);
    refresh();
    return { tokenId: row.id, name: row.name };
  });
}

export async function rotateGitLabTokenAction(input: unknown) {
  return runAction(async () => {
    const ctx = await gitlabCtx();
    const { tokenId, expiresAt, reveal } = rotateSchema.parse(input);
    const out = await rotateToken(ctx, expiresAt, reveal, tokenId);
    refresh();
    return out;
  });
}
