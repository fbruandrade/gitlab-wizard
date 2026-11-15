'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { href } from '@/lib/routes';

export interface NavItem {
  href: string;
  label: string;
}

export function Nav({ items }: { items: NavItem[] }) {
  const path = usePathname();
  return (
    <nav aria-label="Principal" className="flex flex-col gap-1 p-3">
      {items.map((i) => {
        const active = i.href === '/' ? path === '/' : path.startsWith(i.href);
        return (
          <Link
            key={i.href}
            href={href(i.href)}
            aria-current={active ? 'page' : undefined}
            className={`rounded-md px-3 py-2 text-sm transition-colors ${active ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}
          >
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
