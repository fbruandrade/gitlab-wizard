'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { disableVaultAutoAction, enableVaultAutoAction } from '@/app/(app)/admin/vault/actions';
import { useSensitiveAction } from '@/components/auth/reauth-provider';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
import { messageFor } from '@/lib/messages';

export interface AutoView {
  settings: { actorUsername: string | null; tokenName: string; enabledAt: string } | null;
  status: { at: string; candidates: number; done: number; partial: number; skipped: number; failed: number; problem: string | null } | null;
  warnDays: number;
  intervalMinutes: number;
}

export function VaultAutoCard({ view, currentTokenName }: { view: AutoView; currentTokenName: string | null }) {
  const router = useRouter();
  const run = useSensitiveAction();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = view.settings !== null;

  async function toggle() {
    setBusy(true);
    setError(null);
    const res = await run(() => (on ? disableVaultAutoAction() : enableVaultAutoAction()));
    setBusy(false);
    if (!res.ok) return setError(res.message);
    toast.success(on ? 'Rotação automática desabilitada.' : 'Rotação automática habilitada.');
    router.refresh();
  }

  return (
    <div className="space-y-3" data-testid="vault-auto">
      <p className="text-sm">
        Quando um cofre estiver <strong>vencido</strong> ou a <strong>{view.warnDays} dias ou menos</strong> de vencer, a própria plataforma
        cria o token novo, grava <code>DEVOPS_&lt;AMB&gt;</code>, valida e só então revoga o antigo (o mesmo fluxo da tela).{' '}
        {view.intervalMinutes > 0
          ? `Verifica a cada ${view.intervalMinutes} min.`
          : 'O agendador interno está desligado: a verificação só roda pelo gatilho externo (POST /api/internal/vault-auto).'}{' '}
        Não cria token em cofre sem token nem corrige variáveis sozinha.
      </p>
      <p className="text-sm">
        Estado:{' '}
        <Badge variant={on ? 'success' : 'outline'} data-testid="vault-auto-state">
          {on ? 'habilitada' : 'desabilitada'}
        </Badge>
        {view.settings && (
          <span className="ml-2 text-muted-foreground">
            usa o token <strong>{view.settings.tokenName}</strong> de {view.settings.actorUsername ?? 'admin'} desde{' '}
            {formatDateTime(view.settings.enabledAt)}
          </span>
        )}
      </p>
      {!on && (
        <Alert>
          <AlertDescription>
            Ao habilitar, a plataforma passa a agir <strong>sem você presente</strong>, com o seu token em uso agora
            {currentTokenName ? ` (“${currentTokenName}”)` : ''}. Se você for banido, deixar de ser admin ou esse token for revogado, a
            automação para e avisa aqui.
          </AlertDescription>
        </Alert>
      )}
      {view.status && (
        <p className="text-sm text-muted-foreground" data-testid="vault-auto-status">
          Última execução: {formatDateTime(view.status.at)} — {view.status.candidates} candidato(s): {view.status.done} concluído(s),{' '}
          {view.status.partial} parcial(is), {view.status.failed} com falha, {view.status.skipped} ignorado(s).
        </p>
      )}
      {view.status?.problem && (
        <Alert variant="destructive" role="alert" data-testid="vault-auto-problem">
          <AlertDescription>A última execução não agiu: {messageFor(view.status.problem)}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button variant={on ? 'outline' : 'default'} disabled={busy} onClick={() => void toggle()} data-testid="vault-auto-toggle">
        {on ? 'Desabilitar rotação automática' : 'Habilitar rotação automática'}
      </Button>
    </div>
  );
}
