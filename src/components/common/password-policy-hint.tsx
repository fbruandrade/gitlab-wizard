import { Check, Circle } from 'lucide-react';
import { PASSWORD_RULES } from '@/lib/password-policy';

export function PasswordPolicyHint({ value }: { value: string }) {
  return (
    <ul className="space-y-1 text-xs" aria-label="Requisitos da senha">
      {PASSWORD_RULES.map((r) => {
        const ok = r.test(value);
        return (
          <li key={r.id} className={ok ? 'text-emerald-600' : 'text-muted-foreground'}>
            {ok ? <Check className="mr-1 inline size-3" /> : <Circle className="mr-1 inline size-3" />}
            {r.label}
          </li>
        );
      })}
    </ul>
  );
}
