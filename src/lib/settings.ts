// Client-safe: limites das configurações editáveis na interface.
export const SETTING_BOUNDS = {
  cleanupInactivityDays: { min: 1, max: 3650, default: 90, label: 'Dias sem uso (limpeza)' },
  // 365 é o teto do `max_personal_access_token_lifetime` do GitLab (400 só com feature flag), então a mesma faixa vale nos dois lados.
  patMaxLifetimeDays: { min: 1, max: 365, label: 'Validade máxima do PAT (dias)' },
} as const;
export type SettingName = keyof typeof SETTING_BOUNDS;
