/** CSV seguro: aspas escapadas e células que começam com =,+,-,@ neutralizadas (injeção de fórmula no Excel). */
export const csvCell = (v: unknown): string => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
};
