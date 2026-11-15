import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERROR_MESSAGES } from '@/lib/messages';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

describe('mensagens de erro', () => {
  it('todo código lançado (ActionError / GitLabApiError) tem mensagem para o usuário', () => {
    const codes = new Set<string>();
    for (const f of files('src')) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/new (?:ActionError|GitLabApiError)\(\s*'([A-Z0-9_]+)'/g)) codes.add(m[1]!);
    }
    expect(codes.size).toBeGreaterThan(15);
    const missing = [...codes].filter((c) => !ERROR_MESSAGES[c]);
    expect(missing).toEqual([]);
  });
});
