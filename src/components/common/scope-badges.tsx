import { Badge } from '@/components/ui/badge';
import { isPrivilegedScope } from '@/lib/cleanup-rules';

/**
 * Escopos de um PAT: privilegiados (`api`, `sudo`, `admin_mode`) em vermelho e sempre à vista; os demais compactados
 * (2 + "+N"). A lista completa vai no tooltip e em texto para leitor de tela. `undefined` = dado não disponível
 * (ex.: varredura/simulação feita antes deste recurso).
 */
export function ScopeBadges({ scopes }: { scopes?: string[] }) {
  if (!scopes) return <span title="Dado não disponível (feito antes deste recurso)">—</span>;
  if (scopes.length === 0) return <span className="text-muted-foreground">sem escopos</span>;
  const privileged = scopes.filter(isPrivilegedScope);
  const rest = scopes.filter((s) => !isPrivilegedScope(s));
  const shown = rest.slice(0, 2);
  const hidden = rest.length - shown.length;
  return (
    <span className="flex max-w-56 flex-wrap gap-1" title={scopes.join(', ')} data-testid="scopes">
      {privileged.map((s) => (
        <Badge key={s} variant="destructive">
          {s}
        </Badge>
      ))}
      {shown.map((s) => (
        <Badge key={s} variant="secondary">
          {s}
        </Badge>
      ))}
      {hidden > 0 && <Badge variant="outline">+{hidden}</Badge>}
      <span className="sr-only">Todos os escopos: {scopes.join(', ')}</span>
    </span>
  );
}
