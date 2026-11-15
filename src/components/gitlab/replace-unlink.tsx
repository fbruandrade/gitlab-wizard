'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { setDefaultGitLabTokenAction, selectGitLabTokenAction, unlinkGitLabTokenAction } from '@/app/(app)/token/actions';
import { useSensitiveAction } from '@/components/auth/reauth-provider';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { ReplaceTokenForm } from './link-token-form';

export function ReplaceTokenDialog({ tokenId, name }: { tokenId: string; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" data-testid="open-replace" />}>Substituir</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Substituir o token “{name}”</DialogTitle>
          <DialogDescription>
            Use quando ele foi rotacionado fora da ferramenta. O novo token precisa ser do mesmo usuário GitLab.
          </DialogDescription>
        </DialogHeader>
        <ReplaceTokenForm tokenId={tokenId} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

/** Remove da plataforma (NÃO revoga no GitLab). Pede confirmação: pode ser o token padrão. */
export function UnlinkButton({ tokenId, name, isDefault, others }: { tokenId: string; name: string; isDefault: boolean; others: number }) {
  const router = useRouter();
  const run = useSensitiveAction();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    setError(null);
    const res = await run(() => unlinkGitLabTokenAction({ tokenId }));
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setOpen(false);
    toast.success(res.data.newDefault ? `Token removido. “${res.data.newDefault}” é o novo padrão.` : 'Token removido da plataforma.');
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setError(null);
      }}
    >
      <DialogTrigger render={<Button variant="ghost" size="sm" data-testid="unlink-open" />}>Desvincular</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Desvincular “{name}”?</DialogTitle>
          <DialogDescription>
            O token deixa de ser usado por esta ferramenta. Ele <strong>não é revogado no GitLab</strong>
            {isDefault && others > 0 ? '; como é o padrão, o mais recente dos outros assumirá o lugar' : ''}.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" autoFocus onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void confirm()} data-testid="unlink-confirm">
            Confirmar remoção
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Usar este token": escolhe o token em uso NESTE navegador (cookie). */
export function UseTokenButton({ tokenId }: { tokenId: string }) {
  const router = useRouter();
  const run = useSensitiveAction();
  return (
    <Button
      variant="outline"
      size="sm"
      data-testid="use-token"
      onClick={async () => {
        const res = await run(() => selectGitLabTokenAction({ tokenId }));
        if (!res.ok) return toast.error(res.message);
        toast.success(`Usando o token “${res.data.name}”.`);
        router.refresh();
      }}
    >
      Usar este token
    </Button>
  );
}

/** "Definir como padrão": preferência permanente da conta (vale quando nenhum outro foi escolhido). */
export function SetDefaultButton({ tokenId }: { tokenId: string }) {
  const router = useRouter();
  const run = useSensitiveAction();
  return (
    <Button
      variant="outline"
      size="sm"
      data-testid="set-default"
      onClick={async () => {
        const res = await run(() => setDefaultGitLabTokenAction({ tokenId }));
        if (!res.ok) return toast.error(res.message);
        toast.success('Token padrão alterado.');
        router.refresh();
      }}
    >
      Definir como padrão
    </Button>
  );
}
