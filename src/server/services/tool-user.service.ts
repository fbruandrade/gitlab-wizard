import 'server-only';
import type { Prisma } from '@/generated/prisma/client';
import { ActionError } from '@/server/action-result';
import { auth } from '@/server/auth/auth';
import { generateTempPassword } from '@/server/auth/temp-password';
import { prisma } from '@/server/db';
import { recordAudit, type RequestMeta } from './audit.service';

export interface AdminCtx {
  actor: { id: string; username?: string | null };
  headers: Headers; // sessão do admin: o plugin `admin` do better-auth autoriza por ela
  meta?: RequestMeta;
  /** Token GitLab escolhido (cookie); usado pelas actions que também falam com o GitLab. */
  tokenId?: string;
}

export const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

const audit = (
  ctx: AdminCtx,
  action: string,
  target: { id: string; label: string | null },
  reason: string,
  metadata?: Prisma.InputJsonObject,
) =>
  recordAudit({ action, result: 'SUCCESS', actor: ctx.actor, meta: ctx.meta, reason, target: { type: 'tool_user', ...target }, metadata });

async function getTarget(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId } });
  if (!u) throw new ActionError('NOT_FOUND');
  return u;
}

const activeAdmins = () => prisma.user.count({ where: { role: 'admin', banned: { not: true } } });

async function assertNotLastAdmin(target: { role: string | null; banned: boolean | null }) {
  if (target.role === 'admin' && !target.banned && (await activeAdmins()) <= 1) throw new ActionError('LAST_ADMIN');
}

export async function createToolUser(
  ctx: AdminCtx,
  i: { username: string; name: string; email: string; role: 'user' | 'admin'; reason: string },
) {
  const username = i.username.trim().toLowerCase();
  const email = i.email.trim().toLowerCase();
  if (!USERNAME_RE.test(username))
    throw new ActionError('VALIDATION', 'Username: 3–32 caracteres entre a-z, 0-9, ponto, hífen e sublinhado.');
  if (await prisma.user.findFirst({ where: { OR: [{ username }, { email }] } })) throw new ActionError('USERNAME_TAKEN');

  const tempPassword = generateTempPassword();
  const created = await auth.api.createUser({
    body: { email, password: tempPassword, name: i.name.trim(), role: i.role, data: { username, displayUsername: username } },
    headers: ctx.headers,
  });
  await audit(ctx, 'TOOL_USER_CREATED', { id: created.user.id, label: username }, i.reason, { role: i.role });
  return { userId: created.user.id, username, tempPassword };
}

export async function resetToolUserPassword(ctx: AdminCtx, i: { userId: string; reason: string }) {
  const t = await getTarget(i.userId);
  const tempPassword = generateTempPassword();
  await auth.api.setUserPassword({ body: { userId: t.id, newPassword: tempPassword }, headers: ctx.headers });
  await auth.api.revokeUserSessions({ body: { userId: t.id }, headers: ctx.headers });
  await prisma.user.update({ where: { id: t.id }, data: { mustChangePassword: true } });
  await audit(ctx, 'TOOL_USER_PASSWORD_RESET', { id: t.id, label: t.username }, i.reason);
  return { tempPassword };
}

/** Para quem perdeu o autenticador: remove o 2FA; no próximo login o gate exige configurar de novo. */
export async function resetToolUserTwoFactor(ctx: AdminCtx, i: { userId: string; reason: string }) {
  const t = await getTarget(i.userId);
  await prisma.$transaction([
    prisma.twoFactor.deleteMany({ where: { userId: t.id } }),
    prisma.user.update({ where: { id: t.id }, data: { twoFactorEnabled: false } }),
    prisma.session.deleteMany({ where: { userId: t.id } }),
  ]);
  await audit(ctx, 'TOOL_USER_2FA_RESET', { id: t.id, label: t.username }, i.reason);
}

export async function setToolUserRole(ctx: AdminCtx, i: { userId: string; role: 'user' | 'admin'; reason: string }) {
  const t = await getTarget(i.userId);
  if (t.role === i.role) return;
  if (i.role === 'user') await assertNotLastAdmin(t);
  await auth.api.setRole({ body: { userId: t.id, role: i.role }, headers: ctx.headers });
  await audit(ctx, 'TOOL_USER_ROLE_CHANGED', { id: t.id, label: t.username }, i.reason, { from: t.role, to: i.role });
}

export async function banToolUser(ctx: AdminCtx, i: { userId: string; reason: string }) {
  if (i.userId === ctx.actor.id) throw new ActionError('SELF_ACTION');
  const t = await getTarget(i.userId);
  await assertNotLastAdmin(t);
  await auth.api.banUser({ body: { userId: t.id, banReason: i.reason }, headers: ctx.headers });
  await audit(ctx, 'TOOL_USER_BANNED', { id: t.id, label: t.username }, i.reason);
}

export async function unbanToolUser(ctx: AdminCtx, i: { userId: string; reason: string }) {
  const t = await getTarget(i.userId);
  await auth.api.unbanUser({ body: { userId: t.id }, headers: ctx.headers });
  await audit(ctx, 'TOOL_USER_UNBANNED', { id: t.id, label: t.username }, i.reason);
}

export async function revokeToolUserSessions(ctx: AdminCtx, i: { userId: string; reason: string }) {
  const t = await getTarget(i.userId);
  await auth.api.revokeUserSessions({ body: { userId: t.id }, headers: ctx.headers });
  await audit(ctx, 'TOOL_USER_SESSIONS_REVOKED', { id: t.id, label: t.username }, i.reason);
}

export async function listToolUsers(q: string | undefined, page = 1, pageSize = 20) {
  const where: Prisma.UserWhereInput = q
    ? {
        OR: [
          { username: { contains: q, mode: 'insensitive' } },
          { name: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
        ],
      }
    : {};
  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        username: true,
        name: true,
        email: true,
        role: true,
        banned: true,
        twoFactorEnabled: true,
        gitlabTokens: { where: { status: 'ACTIVE' }, select: { gitlabUsername: true }, take: 1 },
      },
    }),
    prisma.user.count({ where }),
  ]);
  return { items, total, pages: Math.max(1, Math.ceil(total / pageSize)) };
}
