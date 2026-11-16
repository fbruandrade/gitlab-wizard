'use client';
import {
  ClipboardList,
  Eraser,
  Server,
  History,
  House,
  KeyRound,
  SlidersHorizontal,
  UserRound,
  Users,
  Vault,
  ShieldUser,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { href } from '@/lib/routes';

const ICONS = {
  home: House,
  users: Users,
  token: KeyRound,
  history: History,
  account: UserRound,
  toolUsers: ShieldUser,
  cleanup: Eraser,
  vault: Vault,
  policies: SlidersHorizontal,
  audit: ClipboardList,
  runners: Server,
} satisfies Record<string, LucideIcon>;
export type NavIcon = keyof typeof ICONS;

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  /** Itens com o mesmo grupo ficam juntos, sob um rótulo. */
  group?: string;
}

/** Colorida pela barra lateral (índigo profundo): o item ativo ganha o preenchimento e o ícone âmbar. */
export function Nav({ items }: { items: NavItem[] }) {
  const path = usePathname();
  return (
    <nav aria-label="Principal" className="flex flex-col gap-0.5 p-3">
      {items.map((i, idx) => {
        const active = i.href === '/' ? path === '/' : path.startsWith(i.href);
        const Icon = ICONS[i.icon];
        const heading = i.group && i.group !== items[idx - 1]?.group ? i.group : null;
        return (
          <div key={i.href} className="contents">
            {heading && <div className="mt-4 mb-1 px-3 text-xs font-medium text-sidebar-foreground/70">{heading}</div>}
            <Link
              href={href(i.href)}
              aria-current={active ? 'page' : undefined}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring ${
                active
                  ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                  : 'text-sidebar-foreground/85 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'
              }`}
            >
              <Icon className={`size-4 shrink-0 ${active ? 'text-sidebar-primary' : 'text-sidebar-foreground/70'}`} aria-hidden="true" />
              {i.label}
            </Link>
          </div>
        );
      })}
    </nav>
  );
}
