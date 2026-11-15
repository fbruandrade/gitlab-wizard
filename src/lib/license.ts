// Client-safe. Traduz a resposta de GET /license nos 4 números da tela de usuários.
// Rótulos = os do painel do GitLab; `field` = de onde vem na API (mostrado como tooltip para conferência).
// O mapeamento rótulo→campo é INFERIDO do exemplo oficial (user_limit=100, active_users=300, overage=200);
// a doc só define `overage` (= usuários cobráveis − usuários licenciados).
export interface LicenseLike {
  user_limit?: number | null;
  maximum_user_count?: number | null;
  active_users?: number | null;
  overage?: number | null;
}

export const LICENSE_STATS = [
  { key: 'user_limit', label: 'Users in subscription', hint: 'Usuários licenciados (campo user_limit).' },
  { key: 'maximum_user_count', label: 'Maximum Users', hint: 'Máximo de usuários no período (campo maximum_user_count).' },
  { key: 'active_users', label: 'Billable users', hint: 'Usuários cobráveis hoje (campo active_users).' },
  { key: 'overage', label: 'Users over License', hint: 'Usuários cobráveis − usuários licenciados (campo overage).' },
] as const;

export type LicenseStat = { key: (typeof LICENSE_STATS)[number]['key']; label: string; hint: string; value: number | null; over: boolean };

export function licenseStats(l: LicenseLike): LicenseStat[] {
  return LICENSE_STATS.map((s) => {
    const value = typeof l[s.key] === 'number' ? (l[s.key] as number) : null;
    return { ...s, value, over: s.key === 'overage' && value !== null && value > 0 };
  });
}
