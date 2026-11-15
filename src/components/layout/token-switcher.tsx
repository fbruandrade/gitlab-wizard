'use client';
import { Check, ChevronDown } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { selectGitLabTokenAction } from '@/app/(app)/token/actions';
import { useSensitiveAction } from '@/components/auth/reauth-provider';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { isPrivilegedScope } from '@/lib/cleanup-rules';

export interface SwitcherToken {
  id: string;
  gitlabTokenId: number;
  name: string;
  isDefault: boolean;
  scopes: string[];
}

/** Escolhe qual dos tokens da conta está em uso neste navegador. Só aparece com 2+ tokens. */
export function TokenSwitcher({
  username,
  isAdmin,
  tokens,
  currentId,
}: {
  username: string;
  isAdmin: boolean;
  tokens: SwitcherToken[];
  currentId: string;
}) {
  const router = useRouter();
  const run = useSensitiveAction();
  const current = tokens.find((t) => t.id === currentId) ?? tokens[0]!;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm" data-testid="token-switcher" aria-label={`Token em uso: ${current.name}. Trocar token`} />
        }
      >
        <span data-testid="gitlab-badge">
          @{username}
          {isAdmin ? ' (admin)' : ''} · {current.name}
        </span>
        <ChevronDown />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-64">
        <DropdownMenuGroup>
          {/* GroupLabel do base-ui exige estar dentro de um Group: fora dele o menu quebra ao abrir */}
          <DropdownMenuLabel>Token em uso neste navegador</DropdownMenuLabel>
          {tokens.map((t) => {
            const priv = t.scopes.filter(isPrivilegedScope);
            return (
              <DropdownMenuItem
                key={t.id}
                data-testid={`switch-${t.gitlabTokenId}`}
                onClick={async () => {
                  if (t.id === current.id) return;
                  const res = await run(() => selectGitLabTokenAction({ tokenId: t.id }));
                  if (!res.ok) return toast.error(res.message);
                  toast.success(`Usando o token “${res.data.name}”.`);
                  router.refresh();
                }}
              >
                <span className="flex w-full items-start gap-2">
                  <Check className={`mt-0.5 size-4 ${t.id === current.id ? '' : 'invisible'}`} aria-hidden />
                  <span className="flex flex-col">
                    <span>
                      {t.name}
                      {t.isDefault && <span className="text-muted-foreground"> · padrão</span>}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {priv.length ? `${priv.join(', ')} · ` : ''}
                      {t.scopes.length} escopo(s)
                    </span>
                  </span>
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push('/token')}>Gerenciar tokens…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
