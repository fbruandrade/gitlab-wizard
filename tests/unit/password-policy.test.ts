import { describe, expect, it } from 'vitest';
import { passwordPolicyIssues } from '@/lib/password-policy';
import { generateTempPassword } from '@/server/auth/temp-password';

describe('política de senha', () => {
  it.each([
    ['curta', false],
    ['Abcdefgh1!', false],
    ['somenteminusculasxxxx', false],
    ['SOMENTEMAIUSCULASXXXX', false],
    ['minusculas e MAIUSCULAS', true],
    ['Minúsculas123456', true],
    ['abcdefghij12!@', true],
    ['x'.repeat(129) + 'A1', false],
  ])('%s → %s', (pw, ok) => expect(passwordPolicyIssues(pw).length === 0).toBe(ok));
});

describe('senha temporária', () => {
  it('sempre atende a política, tem 20 caracteres e não se repete', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const pw = generateTempPassword();
      expect(pw).toHaveLength(20);
      expect(passwordPolicyIssues(pw)).toEqual([]);
      seen.add(pw);
    }
    expect(seen.size).toBe(200);
  });
});
