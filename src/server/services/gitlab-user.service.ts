import 'server-only';
import { ActionError } from '@/server/action-result';
import type { GitLabUser } from '@/server/gitlab/schemas';
import { withAudit } from './audit.service';
import { withGitLab, type Ctx } from './gitlab-token.service';

export const searchGitLabUsers = (ctx: Ctx, p: { search?: string; blocked?: boolean; page?: number }) =>
  withGitLab(ctx, 'READ_USERS', (c) => c.searchUsers({ ...p, perPage: 20 }));

export const getGitLabLicense = (ctx: Ctx) => withGitLab(ctx, 'READ_USERS', (c) => c.getLicense());

export const getGitLabUser = (ctx: Ctx, id: number) => withGitLab(ctx, 'READ_USERS', (c) => c.getUser(id));

const snapshot = (u: GitLabUser) => ({ state: u.state, twoFactorEnabled: u.two_factor_enabled });

/** Confere username digitado e estado atual no GitLab (não confia no que a tela mostrava). */
function assertTarget(u: GitLabUser, confirmUsername: string, stateOk: (u: GitLabUser) => boolean) {
  if (u.username.toLowerCase() !== confirmUsername.trim().toLowerCase()) throw new ActionError('USERNAME_MISMATCH');
  if (u.state === 'ldap_blocked') throw new ActionError('GITLAB_LDAP_BLOCKED'); // o bloqueio vem do diretório
  if (!stateOk(u)) throw new ActionError('STATE_CHANGED');
}

export function unblockGitLabUser(ctx: Ctx, i: { gitlabUserId: number; reason: string; confirmUsername: string }) {
  return withAudit(
    {
      action: 'GITLAB_USER_UNBLOCKED',
      actor: ctx.actor,
      meta: ctx.meta,
      reason: i.reason,
      target: { type: 'gitlab_user', id: i.gitlabUserId, label: i.confirmUsername },
    },
    () =>
      withGitLab(ctx, 'ADMIN_USERS', async (c) => {
        const before = await c.getUser(i.gitlabUserId);
        // ldap_blocked não pode ser desbloqueado pela API; só `blocked`.
        assertTarget(before, i.confirmUsername, (u) => u.state === 'blocked');
        await c.unblockUser(i.gitlabUserId);
        const after = await c.getUser(i.gitlabUserId).catch(() => null);
        return { value: undefined, metadata: { stateBefore: snapshot(before), stateAfter: after ? snapshot(after) : null } };
      }),
  );
}

export function blockGitLabUser(ctx: Ctx, i: { gitlabUserId: number; reason: string; confirmUsername: string }) {
  return withAudit(
    {
      action: 'GITLAB_USER_BLOCKED',
      actor: ctx.actor,
      meta: ctx.meta,
      reason: i.reason,
      target: { type: 'gitlab_user', id: i.gitlabUserId, label: i.confirmUsername },
    },
    () =>
      withGitLab(ctx, 'ADMIN_USERS', async (c, row) => {
        // Bloquear a própria conta GitLab derrubaria o PAT que está sendo usado: o operador perderia o acesso.
        if (row.gitlabUserId === i.gitlabUserId) throw new ActionError('SELF_ACTION');
        const before = await c.getUser(i.gitlabUserId);
        assertTarget(before, i.confirmUsername, (u) => u.state === 'active');
        await c.blockUser(i.gitlabUserId);
        const after = await c.getUser(i.gitlabUserId).catch(() => null);
        return {
          value: undefined,
          metadata: { stateBefore: snapshot(before), stateAfter: after ? snapshot(after) : null, targetIsAdmin: before.is_admin ?? null },
        };
      }),
  );
}

export function disableGitLabUserTwoFactor(ctx: Ctx, i: { gitlabUserId: number; reason: string; confirmUsername: string }) {
  return withAudit(
    {
      action: 'GITLAB_USER_2FA_DISABLED',
      actor: ctx.actor,
      meta: ctx.meta,
      reason: i.reason,
      target: { type: 'gitlab_user', id: i.gitlabUserId, label: i.confirmUsername },
    },
    () =>
      withGitLab(ctx, 'ADMIN_USERS', async (c, row) => {
        const before = await c.getUser(i.gitlabUserId);
        // Regra do GitLab: a API não reseta o 2FA de administradores nem da própria conta (devolveria 403).
        if (row.gitlabUserId === i.gitlabUserId || before.is_admin) throw new ActionError('GITLAB_ADMIN_2FA_UNSUPPORTED');
        assertTarget(before, i.confirmUsername, (u) => u.two_factor_enabled);
        await c.disableTwoFactor(i.gitlabUserId);
        const after = await c.getUser(i.gitlabUserId).catch(() => null);
        return { value: undefined, metadata: { stateBefore: snapshot(before), stateAfter: after ? snapshot(after) : null } };
      }),
  );
}
