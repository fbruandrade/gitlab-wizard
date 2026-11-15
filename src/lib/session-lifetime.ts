/** O better-auth só expira por inatividade; este é o teto absoluto desde a criação da sessão. */
export const isOverAbsoluteLifetime = (createdAt: Date, maxHours: number, now = Date.now()) =>
  now - createdAt.getTime() > maxHours * 3_600_000;
