import { describe, expect, it } from 'vitest';
import { licenseStats } from '@/lib/license';

describe('licenseStats', () => {
  it('mapeia os 4 rótulos do painel para os campos da API (exemplo oficial da doc)', () => {
    const s = Object.fromEntries(
      licenseStats({ user_limit: 100, maximum_user_count: 300, active_users: 300, overage: 200 }).map((x) => [x.label, x]),
    );
    expect(s['Users in subscription']).toMatchObject({ value: 100, over: false });
    expect(s['Maximum Users']).toMatchObject({ value: 300, over: false });
    expect(s['Billable users']).toMatchObject({ value: 300, over: false });
    expect(s['Users over License']).toMatchObject({ value: 200, over: true });
  });
  it('overage 0 não é destaque; campos ausentes viram null (não 0)', () => {
    const s = licenseStats({ overage: 0 });
    expect(s.find((x) => x.key === 'overage')).toMatchObject({ value: 0, over: false });
    expect(s.find((x) => x.key === 'user_limit')?.value).toBeNull();
  });
  it('cada rótulo indica o campo da API de origem (para conferência)', () => {
    for (const s of licenseStats({})) expect(s.hint).toContain(s.key);
  });
});
