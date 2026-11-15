import { describe, expect, it } from 'vitest';
import { csvCell } from '@/lib/csv';

describe('csvCell', () => {
  it.each([
    ['simples', '"simples"'],
    ['com "aspas"', '"com ""aspas"""'],
    ['a,b\nc', '"a,b\nc"'],
    [null, '""'],
    [42, '"42"'],
  ])('%j → %s', (v, out) => expect(csvCell(v)).toBe(out));

  it.each(['=cmd|"/c calc"!A1', '+1+1', '-2+3', '@SUM(A1)', '\t=1'])('neutraliza fórmula: %j', (v) => {
    expect(csvCell(v).startsWith(`"'`)).toBe(true);
  });
});
