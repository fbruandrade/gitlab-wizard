import { describe, expect, it } from 'vitest';
import { isOverAbsoluteLifetime } from '@/lib/session-lifetime';

describe('teto absoluto da sessão', () => {
  const created = new Date('2026-11-13T08:00:00Z');
  it('dentro do limite', () => expect(isOverAbsoluteLifetime(created, 8, created.getTime() + 7.9 * 3_600_000)).toBe(false));
  it('além do limite, mesmo que a sessão esteja ativa', () =>
    expect(isOverAbsoluteLifetime(created, 8, created.getTime() + 8.1 * 3_600_000)).toBe(true));
});
