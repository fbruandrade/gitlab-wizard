import { describe, expect, it } from 'vitest';
import { parseAuditFilters } from '@/server/audit-filters';

describe('parseAuditFilters', () => {
  it('sem parâmetros: nada filtrado, página 1', () => {
    const { filters, page } = parseAuditFilters({});
    expect(page).toBe(1);
    expect(filters).toEqual({ actionPrefix: undefined, result: undefined, from: undefined, to: undefined, q: undefined });
  });
  it('grupo, resultado válido e busca (aparada)', () => {
    const { filters } = parseAuditFilters({ group: 'AUTH_', result: 'FAILURE', q: '  maria  ' });
    expect(filters).toMatchObject({ actionPrefix: 'AUTH_', result: 'FAILURE', q: 'maria' });
  });
  it('resultado desconhecido é ignorado (não vai para a consulta)', () => {
    expect(parseAuditFilters({ result: 'QUALQUER' }).filters.result).toBeUndefined();
    expect(parseAuditFilters({ result: "SUCCESS'; DROP" }).filters.result).toBeUndefined();
  });
  it('datas são o dia INTEIRO em Brasília (UTC-3): início 00:00 e fim 23:59:59.999', () => {
    const { filters } = parseAuditFilters({ from: '2026-11-13', to: '2026-11-13' });
    expect(filters.from?.toISOString()).toBe('2026-11-13T03:00:00.000Z');
    expect(filters.to?.toISOString()).toBe('2026-11-14T02:59:59.999Z');
  });
  it.each([['13/11/2026'], ['2026-13-45x'], ['hoje'], ['']])('data inválida %j é ignorada', (d) => {
    const { filters } = parseAuditFilters({ from: d, to: d });
    expect(filters.from).toBeUndefined();
    expect(filters.to).toBeUndefined();
  });
  it('página: inteiro ≥ 1; lixo/negativo/zero → 1', () => {
    expect(parseAuditFilters({ page: '3' }).page).toBe(3);
    for (const p of ['0', '-2', 'abc', '', undefined]) expect(parseAuditFilters({ page: p }).page).toBe(1);
  });
});
