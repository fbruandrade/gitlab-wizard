/**
 * Marca do GitLab Wizard: um buraco de fechadura (o cofre) com uma centelha (o "mago"). Desenhada à mão, em duas cores
 * do sistema: âmbar (a chave) sobre índigo (o cofre).
 */
export function BrandMark({ className = 'size-8' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} role="img" aria-label="GitLab Wizard">
      <rect width="32" height="32" rx="9" fill="oklch(0.46 0.19 280)" />
      <circle cx="16" cy="13.2" r="4.6" fill="oklch(0.82 0.16 80)" />
      <path d="M13.9 16.6h4.2l1.5 8.2h-7.2z" fill="oklch(0.82 0.16 80)" />
      <path d="M25.2 5.2l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" fill="oklch(0.97 0.02 285)" />
    </svg>
  );
}
