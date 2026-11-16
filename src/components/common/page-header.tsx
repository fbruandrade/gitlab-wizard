import type { LucideIcon } from 'lucide-react';

export type Tone = 'violet' | 'blue' | 'amber' | 'rose' | 'teal' | 'slate';

/** Título de página com o ícone da área (cor = orientação: o mesmo matiz identifica a área em toda a ferramenta). */
export function PageHeader({
  icon: Icon,
  tone,
  title,
  children,
}: {
  icon: LucideIcon;
  tone: Tone;
  title: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <span
        aria-hidden="true"
        className={`tone-${tone} flex size-10 shrink-0 items-center justify-center rounded-xl bg-(--tone-bg) text-(--tone-fg)`}
      >
        <Icon className="size-5" />
      </span>
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {children && <p className="text-sm text-muted-foreground">{children}</p>}
      </div>
    </div>
  );
}
