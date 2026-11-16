'use client';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Nav, type NavItem } from './nav';

/** Abaixo de `md` a barra lateral some: este botão abre o mesmo menu (fecha ao navegar e com Esc). */
export function MobileNav({ items }: { items: NavItem[] }) {
  const path = usePathname();
  // Guarda em qual rota o menu foi aberto: ao navegar, a rota muda e o menu fecha sozinho (sem setState em efeito).
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === path;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpenAt(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="md:hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="menu-movel"
        onClick={() => setOpenAt(open ? null : path)}
        className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
        data-testid="menu-movel"
      >
        {open ? 'Fechar' : 'Menu'}
      </button>
      {open && (
        <div
          id="menu-movel"
          className="absolute inset-x-0 top-full z-20 max-h-[70vh] overflow-y-auto bg-sidebar text-sidebar-foreground shadow-lg"
        >
          <Nav items={items} />
        </div>
      )}
    </div>
  );
}
