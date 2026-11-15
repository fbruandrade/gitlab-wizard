import 'server-only';
import { z } from 'zod';
import { messageFor } from '@/lib/messages';
import { GitLabApiError } from '@/server/gitlab/errors';
import { logger } from '@/server/logger';

export type ActionResult<T = undefined> =
  { ok: true; data: T } | { ok: false; code: string; message: string; fieldErrors?: Record<string, string[]> };

/** Erro de negócio com código estável; a UI decide o que mostrar a partir do `code`. */
export class ActionError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? messageFor(code));
    this.name = 'ActionError';
  }
}

/** Server Actions nunca lançam para o client: retornam `{ ok: false, code, message }`. */
export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    // redirect()/notFound() do Next são exceções de controle de fluxo: devem seguir adiante.
    if (typeof e === 'object' && e && 'digest' in e && String((e as { digest: unknown }).digest).startsWith('NEXT_')) throw e;
    if (e instanceof ActionError) return { ok: false, code: e.code, message: e.message };
    if (e instanceof GitLabApiError) {
      return { ok: false, code: e.code, message: messageFor(e.code) + (e.detail ? ` Resposta do GitLab: "${e.detail}"` : '') };
    }
    if (e instanceof z.ZodError) {
      return {
        ok: false,
        code: 'VALIDATION',
        message: messageFor('VALIDATION'),
        fieldErrors: z.flattenError(e).fieldErrors as Record<string, string[]>,
      };
    }
    logger.error({ err: e instanceof Error ? { name: e.name, message: e.message } : 'unknown' }, 'erro inesperado em server action');
    return { ok: false, code: 'INTERNAL', message: messageFor('INTERNAL') };
  }
}
