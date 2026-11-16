import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTION_GROUPS, ACTION_LABELS, labelFor } from '@/lib/audit-labels';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

describe('rótulos da auditoria', () => {
  it('labelFor devolve o rótulo, ou o próprio código se desconhecido', () => {
    expect(labelFor('AUTH_LOGIN_SUCCESS')).toBe('Login');
    expect(labelFor('ACAO_NOVA_SEM_ROTULO')).toBe('ACAO_NOVA_SEM_ROTULO');
  });

  it('TODA ação gravada pelo código tem rótulo legível (evita aparecer "GITLAB_XYZ" cru na tela)', () => {
    // Procura pelo CONTEXTO em que uma ação é gravada (não por prefixo: códigos de erro como GITLAB_USER_MISMATCH colidem com prefixos de ação).
    const used = new Set<string>();
    const CODE = "'([A-Z][A-Z0-9_]+)'";
    const patterns = [
      new RegExp(`\\baction:\\s*${CODE}`, 'g'), // { action: 'X' }
      new RegExp(`\\baction:\\s*[^,}]*?\\?\\s*${CODE}\\s*:\\s*${CODE}`, 'g'), // { action: cond ? 'A' : 'B' }
      new RegExp(`\\bauditToken\\(ctx,\\s*${CODE}`, 'g'),
      new RegExp(`\\baudit\\(ctx,\\s*${CODE}`, 'g'), // tool-user.service
      new RegExp(`\\bconst action = [^?]*\\?\\s*${CODE}\\s*:\\s*${CODE}`, 'g'), // audit-hooks (429 × falha)
    ];
    for (const f of files('src')) {
      const src = readFileSync(f, 'utf8');
      for (const re of patterns) for (const m of src.matchAll(re)) for (const g of m.slice(1)) if (g) used.add(g);
    }
    expect(used.size).toBeGreaterThan(25); // sanidade: o regex está mesmo achando as ações
    expect([...used].filter((a) => !ACTION_LABELS[a])).toEqual([]);
    expect(used.has('GITLAB_CLEANUP_PAT_REVOKED') && used.has('AUTH_RATE_LIMITED') && used.has('TOOL_USER_CREATED')).toBe(true);
  });

  it('cada rótulo pertence a algum grupo do filtro (ou é isolado de propósito)', () => {
    const standalone = new Set(['AUDIT_EXPORTED']);
    const orphan = Object.keys(ACTION_LABELS).filter((a) => !standalone.has(a) && !ACTION_GROUPS.some((g) => a.startsWith(g.value)));
    expect(orphan).toEqual([]);
  });

  it('prefixos de grupo não se sobrepõem de forma ambígua', () => {
    for (const a of Object.keys(ACTION_LABELS)) {
      const groups = ACTION_GROUPS.filter((g) => a.startsWith(g.value));
      expect(groups.length, a).toBeLessThanOrEqual(1);
    }
  });
});
