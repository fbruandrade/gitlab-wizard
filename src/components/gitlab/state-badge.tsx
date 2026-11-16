import { Badge } from '@/components/ui/badge';

const MAP: Record<
  string,
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' | 'info' }
> = {
  active: { label: 'active', variant: 'success' },
  blocked: { label: 'blocked', variant: 'destructive' },
  ldap_blocked: { label: 'ldap_blocked', variant: 'destructive' },
  deactivated: { label: 'deactivated', variant: 'outline' },
  banned: { label: 'banned', variant: 'default' },
  blocked_pending_approval: { label: 'pending approval', variant: 'warning' },
};

export function StateBadge({ state }: { state: string }) {
  const m = MAP[state] ?? { label: state, variant: 'outline' as const };
  return (
    <Badge variant={m.variant} data-testid="state-badge" data-state={state}>
      {m.label}
    </Badge>
  );
}
