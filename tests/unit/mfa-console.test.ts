import { describe, expect, it } from 'vitest';
import { buildMfaConsoleCommand } from '@/lib/mfa-console';

describe('comando do console Rails (reset de MFA de admin)', () => {
  it('preenche os usernames e usa o DestroyService com o admin executor primeiro', () => {
    const c = buildMfaConsoleCommand('fandrade', 'brunelli');
    expect(c).toContain("admin = User.find_by_username('fandrade')");
    expect(c).toContain("alvo  = User.find_by_username('brunelli')");
    expect(c).toContain('TwoFactor::DestroyService.new(admin, user: alvo).execute');
  });

  it.each([
    ["x'); system('rm -rf /'); ('", 'aspas e código'],
    ['a b', 'espaço'],
    ['x\nputs 1', 'quebra de linha'],
    ['x#{1+1}', 'interpolação Ruby'],
    ['', 'vazio'],
  ])('username perigoso (%j, %s) NÃO é interpolado: vira placeholder', (bad) => {
    const c = buildMfaConsoleCommand(bad, bad);
    expect(c).toContain("'SEU_USERNAME'");
    expect(c).toContain("'USERNAME_DO_ALVO'");
    expect(c).not.toContain('system');
    expect(c).not.toContain('#{');
  });

  it('aceita username com ponto, hífen e sublinhado', () => {
    expect(buildMfaConsoleCommand('ana.silva', 'jo_ao-2')).toContain("'jo_ao-2'");
  });
});
