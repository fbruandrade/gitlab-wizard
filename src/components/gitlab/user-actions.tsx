'use client';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { blockGitLabUserAction, disableGitLabUserTwoFactorAction, unblockGitLabUserAction } from '@/app/(app)/gitlab/users/actions';
import { useSensitiveAction } from '@/components/auth/reauth-provider';
import { AdminMfaGuide } from './admin-mfa-guide';
import { ConfirmActionDialog } from './confirm-action-dialog';

interface Props {
  id: number;
  username: string;
  state: string;
  twoFactorEnabled: boolean;
  canAdmin: boolean;
  isSelf: boolean;
  isAdmin: boolean;
  operatorUsername: string;
}

export function UserActions({ id, username, state, twoFactorEnabled, canAdmin, isSelf, isAdmin, operatorUsername }: Props) {
  const router = useRouter();
  const run = useSensitiveAction();

  if (!canAdmin)
    return (
      <p className="text-sm text-muted-foreground">
        Seu token não permite ações neste usuário (requer admin GitLab + scope `api`, e `admin_mode` se aplicável).
      </p>
    );

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className="space-y-2 rounded-md border p-4">
        <h3 className="font-medium">Bloquear usuário</h3>
        {state !== 'active' ? (
          <p className="text-sm text-muted-foreground" data-testid="block-na">
            {state === 'blocked' || state === 'ldap_blocked' ? 'Usuário já está bloqueado.' : 'Estado não suportado nesta versão.'}
          </p>
        ) : isSelf ? (
          <p className="text-sm text-muted-foreground" data-testid="block-na">
            Você não pode bloquear a própria conta: perderia o acesso a esta ferramenta.
          </p>
        ) : (
          <ConfirmActionDialog
            testId="block"
            trigger="Bloquear"
            title={`Bloquear @${username}?`}
            confirmLabel="Bloquear"
            username={username}
            description="O usuário perderá o acesso ao GitLab até ser desbloqueado."
            warning={isAdmin ? 'Este usuário é ADMINISTRADOR do GitLab. Confirme que o bloqueio é intencional.' : undefined}
            onConfirm={async (v) => {
              const res = await run(() => blockGitLabUserAction({ gitlabUserId: id, ...v }));
              if (res.ok) {
                toast.success(`Usuário @${username} bloqueado.`);
                router.refresh();
              }
              return res;
            }}
          />
        )}
      </section>

      <section className="space-y-2 rounded-md border p-4">
        <h3 className="font-medium">Desbloquear usuário</h3>
        {state === 'blocked' ? (
          <ConfirmActionDialog
            testId="unblock"
            trigger="Desbloquear"
            title={`Desbloquear @${username}?`}
            confirmLabel="Desbloquear"
            username={username}
            description="O usuário poderá voltar a acessar o GitLab."
            onConfirm={async (v) => {
              const res = await run(() => unblockGitLabUserAction({ gitlabUserId: id, ...v }));
              if (res.ok) {
                toast.success(`Usuário @${username} desbloqueado.`);
                router.refresh();
              }
              return res;
            }}
          />
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="unblock-na">
            {state === 'ldap_blocked'
              ? 'Bloqueado via LDAP/AD — desbloquear no diretório.'
              : state === 'active'
                ? 'Usuário não está bloqueado.'
                : 'Estado não suportado nesta versão.'}
          </p>
        )}
      </section>

      <section className="space-y-2 rounded-md border p-4">
        <h3 className="font-medium">Resetar MFA no GitLab</h3>
        {isAdmin || isSelf ? (
          <AdminMfaGuide operatorUsername={operatorUsername} targetUsername={username} isSelf={isSelf} />
        ) : twoFactorEnabled ? (
          <ConfirmActionDialog
            testId="disable2fa"
            trigger="Resetar MFA"
            title={`Resetar o MFA de @${username}?`}
            confirmLabel="Resetar MFA"
            username={username}
            identityCheck
            description="O MFA do usuário será desabilitado no GitLab."
            warning="No próximo login ele terá de configurar o MFA novamente, se a política exigir. Confirme a identidade do solicitante antes de prosseguir."
            onConfirm={async (v) => {
              const res = await run(() => disableGitLabUserTwoFactorAction({ gitlabUserId: id, ...v }));
              if (res.ok) {
                toast.success(`MFA de @${username} resetado.`);
                router.refresh();
              }
              return res;
            }}
          />
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="disable2fa-na">
            Usuário não possui MFA habilitado no GitLab.
          </p>
        )}
      </section>
    </div>
  );
}
