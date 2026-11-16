import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

let mod: typeof import('@/server/action-result');
let GitLabApiError: typeof import('@/server/gitlab/errors').GitLabApiError;
beforeAll(async () => {
  process.env.LOG_LEVEL = 'silent'; // o erro inesperado é logado; não poluir a saída do teste
  mod = await import('@/server/action-result');
  ({ GitLabApiError } = await import('@/server/gitlab/errors'));
});

describe('runAction: nunca lança para o client', () => {
  it('sucesso → { ok: true, data }', async () => {
    expect(await mod.runAction(async () => 42)).toEqual({ ok: true, data: 42 });
  });

  it('ActionError → código estável e mensagem (padrão do código ou a própria)', async () => {
    expect(
      await mod.runAction(async () => {
        throw new mod.ActionError('FORBIDDEN');
      }),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN', message: expect.stringContaining('permissão') });
    expect(
      await mod.runAction(async () => {
        throw new mod.ActionError('INVALID_EXPIRY', 'Data inválida.');
      }),
    ).toMatchObject({ code: 'INVALID_EXPIRY', message: 'Data inválida.' });
  });

  it('GitLabApiError → mensagem do código + "Resposta do GitLab" quando há detalhe; sem detalhe, só a mensagem', async () => {
    const withDetail = await mod.runAction(async () => {
      throw new GitLabApiError('GITLAB_FORBIDDEN', 403, 'x', false, 'regra da instância');
    });
    expect(withDetail).toMatchObject({ ok: false, code: 'GITLAB_FORBIDDEN' });
    expect((withDetail as { message: string }).message).toContain('Resposta do GitLab: "regra da instância"');
    const without = await mod.runAction(async () => {
      throw new GitLabApiError('GITLAB_NOT_FOUND', 404, 'x');
    });
    expect((without as { message: string }).message).not.toContain('Resposta do GitLab');
  });

  it('ZodError → VALIDATION com os erros por campo', async () => {
    const r = await mod.runAction(async () => z.object({ idade: z.number().min(18), nome: z.string() }).parse({ idade: 3, nome: 1 }));
    expect(r).toMatchObject({ ok: false, code: 'VALIDATION' });
    expect(Object.keys((r as { fieldErrors: object }).fieldErrors).sort()).toEqual(['idade', 'nome']);
  });

  it('erro inesperado → INTERNAL genérico, SEM vazar a mensagem interna', async () => {
    const r = await mod.runAction(async () => {
      throw new Error('senha do banco: hunter2');
    });
    expect(r).toMatchObject({ ok: false, code: 'INTERNAL' });
    expect(JSON.stringify(r)).not.toContain('hunter2');
    expect(
      await mod.runAction(async () => {
        throw 'texto solto';
      }),
    ).toMatchObject({ code: 'INTERNAL' }); // até não-Error
  });

  it('exceções de controle do Next (redirect/notFound) PASSAM adiante em vez de virarem erro', async () => {
    const redirect = Object.assign(new Error('r'), { digest: 'NEXT_REDIRECT;replace;/login;307;' });
    await expect(
      mod.runAction(async () => {
        throw redirect;
      }),
    ).rejects.toBe(redirect);
    const nf = Object.assign(new Error('nf'), { digest: 'NEXT_NOT_FOUND' });
    await expect(
      mod.runAction(async () => {
        throw nf;
      }),
    ).rejects.toBe(nf);
    // um "digest" que NÃO começa com NEXT_ é erro comum
    expect(
      await mod.runAction(async () => {
        throw Object.assign(new Error('x'), { digest: 'OUTRO' });
      }),
    ).toMatchObject({ code: 'INTERNAL' });
  });
});
