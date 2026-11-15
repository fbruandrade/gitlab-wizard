// Client-safe. Passo a passo do reset de MFA de ADMINISTRADOR GitLab, que a API não permite (só o console Rails).
// Fonte: https://docs.gitlab.com/security/two_factor_authentication/ (TwoFactor::DestroyService).

// Usernames do GitLab: letras, números, ponto, hífen e sublinhado. O comando é colado num console de produção,
// então qualquer valor fora disso NÃO é interpolado (evita injeção de código Ruby via um username forjado).
const SAFE = /^[A-Za-z0-9._-]{1,255}$/;
const safe = (v: string, placeholder: string) => (SAFE.test(v) ? v : placeholder);

export function buildMfaConsoleCommand(operatorUsername: string, targetUsername: string): string {
  const op = safe(operatorUsername, 'SEU_USERNAME');
  const target = safe(targetUsername, 'USERNAME_DO_ALVO');
  return [
    `admin = User.find_by_username('${op}')      # você, o admin que executa`,
    `alvo  = User.find_by_username('${target}')  # o admin que perdeu o 2FA`,
    '',
    'TwoFactor::DestroyService.new(admin, user: alvo).execute',
  ].join('\n');
}
