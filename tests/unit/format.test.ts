import { describe, expect, it } from 'vitest';
import { daysUntil, formatDate, formatDateTime, initials } from '@/lib/format';

describe('formatação em America/Sao_Paulo', () => {
  it('converte UTC para o horário de Brasília (UTC-3)', () => {
    expect(formatDateTime('2026-11-13T02:30:00Z')).toBe('12/11/2026 23:30'); // vira o dia anterior
    expect(formatDateTime(new Date('2026-11-13T15:05:00Z'))).toBe('13/11/2026 12:05');
    expect(formatDate('2026-11-13T02:30:00Z')).toBe('12/11/2026');
  });
  it('vazio → "—"', () => {
    for (const v of [null, undefined, '']) {
      expect(formatDateTime(v)).toBe('—');
      expect(formatDate(v)).toBe('—');
    }
  });
});

describe('daysUntil (dias corridos até a data)', () => {
  const now = new Date('2026-11-13T12:00:00Z');
  it('hoje = 0, amanhã = 1, ontem = -1', () => {
    expect(daysUntil('2026-11-13', now)).toBe(0);
    expect(daysUntil('2026-11-14', now)).toBe(1);
    expect(daysUntil('2026-11-12', now)).toBe(-1);
    expect(daysUntil('2027-11-13', now)).toBe(365);
  });
  it('sem data → null', () => {
    expect(daysUntil(null, now)).toBeNull();
    expect(daysUntil(undefined, now)).toBeNull();
  });
});

describe('initials', () => {
  it('até 2 iniciais, maiúsculas; vazio vira "?"', () => {
    expect(initials('maria da silva')).toBe('MD');
    expect(initials('  João  ')).toBe('J');
    expect(initials('')).toBe('?');
  });
});
