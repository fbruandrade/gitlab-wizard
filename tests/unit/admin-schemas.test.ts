import { describe, expect, it } from 'vitest';
import {
  applyConfirmWord,
  applyPatLifetimeSchema,
  CLEANUP_CONFIRM_WORD,
  cleanupParamsSchema,
  executeCleanupSchema,
  inactivityDaysSchema,
  patLifetimeSchema,
} from '@/lib/admin-schemas';

const uuid = '3f2b8c1e-5a4d-4e6f-8a9b-0c1d2e3f4a5b';
const reason = 'CHG0042 - higiene trimestral';
const ok = (r: { success: boolean }) => r.success;

describe('inactivityDaysSchema (dias sem uso)', () => {
  it.each([[1], [90], [3650]])('aceita %i', (days) => expect(ok(inactivityDaysSchema.safeParse({ days }))).toBe(true));
  it.each([[0], [3651], [-5], [1.5], ['90'], [null]])('recusa %j', (days) =>
    expect(ok(inactivityDaysSchema.safeParse({ days }))).toBe(false),
  );
});

describe('cleanupParamsSchema', () => {
  const base = { blockedUsers: true, unusedDays: 90, includePat: true, includeSsh: true };
  it('aceita critério de dias ou null (desligado)', () => {
    expect(ok(cleanupParamsSchema.safeParse(base))).toBe(true);
    expect(ok(cleanupParamsSchema.safeParse({ ...base, unusedDays: null }))).toBe(true);
    expect(ok(cleanupParamsSchema.safeParse({ ...base, sshNoExpiry: true }))).toBe(true);
    expect(ok(cleanupParamsSchema.safeParse({ ...base, sshNoExpiry: 'sim' }))).toBe(false);
  });
  it.each([[0], [3651], [1.5]])('recusa unusedDays=%j', (unusedDays) =>
    expect(ok(cleanupParamsSchema.safeParse({ ...base, unusedDays }))).toBe(false),
  );
  it('recusa tipos incorretos', () => expect(ok(cleanupParamsSchema.safeParse({ ...base, includePat: 'sim' }))).toBe(false));
});

describe('executeCleanupSchema (revogação em massa)', () => {
  const base = { scanId: uuid, keys: ['PAT:1', 'SSH_KEY:22'], reason, confirm: CLEANUP_CONFIRM_WORD };
  it('aceita o formato correto', () => expect(ok(executeCleanupSchema.safeParse(base))).toBe(true));
  it('exige a palavra de confirmação EXATA (maiúsculas)', () => {
    expect(CLEANUP_CONFIRM_WORD).toBe('REVOGAR');
    for (const c of ['revogar', 'Revogar', 'REVOGAR ', '']) expect(ok(executeCleanupSchema.safeParse({ ...base, confirm: c }))).toBe(false);
  });
  it('as chaves só podem ser PAT:<n> ou SSH_KEY:<n> (nada de ids livres/injeção)', () => {
    for (const k of ['PAT:abc', 'PAT:', 'TOKEN:1', 'PAT:1; DROP TABLE', 'ssh_key:1', '1'])
      expect(ok(executeCleanupSchema.safeParse({ ...base, keys: [k] }))).toBe(false);
  });
  it('entre 1 e 500 itens; scanId UUID; motivo obrigatório', () => {
    expect(ok(executeCleanupSchema.safeParse({ ...base, keys: [] }))).toBe(false);
    expect(ok(executeCleanupSchema.safeParse({ ...base, keys: Array.from({ length: 500 }, (_, i) => `PAT:${i}`) }))).toBe(true);
    expect(ok(executeCleanupSchema.safeParse({ ...base, keys: Array.from({ length: 501 }, (_, i) => `PAT:${i}`) }))).toBe(false);
    expect(ok(executeCleanupSchema.safeParse({ ...base, scanId: 'x' }))).toBe(false);
    expect(ok(executeCleanupSchema.safeParse({ ...base, reason: 'curto' }))).toBe(false);
  });
});

describe('política do PAT', () => {
  it('patLifetimeSchema: 1–365', () => {
    for (const days of [1, 365]) expect(ok(patLifetimeSchema.safeParse({ days }))).toBe(true);
    for (const days of [0, 366, 1.5]) expect(ok(patLifetimeSchema.safeParse({ days }))).toBe(false);
  });
  it('aplicar no GitLab exige digitar EXATAMENTE "APLICAR <dias>" do mesmo valor', () => {
    expect(applyConfirmWord(90)).toBe('APLICAR 90');
    const base = { scanId: uuid, days: 90, reason, confirm: 'APLICAR 90' };
    expect(ok(applyPatLifetimeSchema.safeParse(base))).toBe(true);
    for (const c of ['APLICAR 60', 'aplicar 90', 'APLICAR  90', '', 'APLICAR']) {
      const r = applyPatLifetimeSchema.safeParse({ ...base, confirm: c });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.path).toEqual(['confirm']);
    }
  });
});
