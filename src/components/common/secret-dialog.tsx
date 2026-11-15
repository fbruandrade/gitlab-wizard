'use client';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * Mostra um segredo UMA vez (senha temporária, token, códigos de backup). O valor vive só no estado
 * do componente pai e é descartado ao fechar; o fechamento exige confirmar que foi copiado.
 */
export function SecretDialog({
  open,
  title,
  description,
  secret,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  secret: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog open={open} onOpenChange={() => undefined /* só fecha pelo botão */}>
      <DialogContent showCloseButton={false} data-testid="secret-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <pre
          data-testid="secret-value"
          className="rounded-md border bg-muted p-3 font-mono text-sm break-all whitespace-pre-wrap select-all"
        >
          {secret}
        </pre>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={async () => {
              await navigator.clipboard.writeText(secret).catch(() => undefined);
              setCopied(true);
            }}
          >
            {copied ? <Check /> : <Copy />} {copied ? 'Copiado' : 'Copiar'}
          </Button>
          <Button
            onClick={() => {
              setCopied(false);
              onClose();
            }}
          >
            Já guardei, fechar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
