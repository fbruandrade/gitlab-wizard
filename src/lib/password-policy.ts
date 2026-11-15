// Client-safe: usado no formulário (feedback imediato) e no servidor (fonte de verdade).
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export const PASSWORD_RULES = [
  {
    id: 'length',
    label: `Entre ${PASSWORD_MIN} e ${PASSWORD_MAX} caracteres`,
    test: (p: string) => p.length >= PASSWORD_MIN && p.length <= PASSWORD_MAX,
  },
  {
    id: 'classes',
    label: 'Ao menos 3 de 4: maiúscula, minúscula, número, símbolo',
    test: (p: string) => [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length >= 3,
  },
] as const;

/** Regras não atendidas (lista vazia = senha válida). */
export function passwordPolicyIssues(password: string): string[] {
  return PASSWORD_RULES.filter((r) => !r.test(password)).map((r) => r.label);
}
