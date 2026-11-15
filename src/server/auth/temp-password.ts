import 'server-only';
import { randomInt } from 'node:crypto';
import { passwordPolicyIssues } from '@/lib/password-policy';

const SETS = ['abcdefghjkmnpqrstuvwxyz', 'ABCDEFGHJKMNPQRSTUVWXYZ', '23456789', '!@#$%&*?-_'];

/** Senha temporária de 20 caracteres com as 4 classes, via CSPRNG. Exibida uma única vez ao admin. */
export function generateTempPassword(length = 20): string {
  const all = SETS.join('');
  const chars = SETS.map((s) => s[randomInt(s.length)]!); // garante ao menos 1 de cada classe
  while (chars.length < length) chars.push(all[randomInt(all.length)]!);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  const pw = chars.join('');
  if (passwordPolicyIssues(pw).length) return generateTempPassword(length);
  return pw;
}
