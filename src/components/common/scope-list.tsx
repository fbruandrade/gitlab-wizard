import { Badge } from '@/components/ui/badge';
import { isPrivilegedScope } from '@/lib/cleanup-rules';

/** TODOS os escopos do PAT (tela de gerenciamento): privilegiados em vermelho e primeiro, o resto em ordem alfabética. */
export function ScopeList({ scopes }: { scopes: readonly string[] }) {
  if (scopes.length === 0) return <span className="text-sm text-muted-foreground">sem escopos</span>;
  const sorted = [...scopes].sort((a, b) => Number(isPrivilegedScope(b)) - Number(isPrivilegedScope(a)) || a.localeCompare(b));
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Escopos do token" data-testid="scope-list">
      {sorted.map((s) => (
        <li key={s}>
          <Badge variant={isPrivilegedScope(s) ? 'destructive' : 'secondary'}>{s}</Badge>
        </li>
      ))}
    </ul>
  );
}
