'use client';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { helmCommands, registrationCommand } from '@/lib/runner-rules';

function Block({ id, title, hint, text }: { id: string; title: string; hint?: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={async () => {
            await navigator.clipboard.writeText(text).catch(() => undefined);
            setCopied(true);
          }}
        >
          {copied ? <Check /> : <Copy />} {copied ? 'Copiado' : 'Copiar'}
        </Button>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <pre data-testid={id} className="rounded-md border bg-muted p-3 font-mono text-xs break-all whitespace-pre-wrap select-all">
        {text}
      </pre>
    </section>
  );
}

export interface CreatedRunner {
  runnerId: number;
  token: string;
  url: string;
  executor: 'docker' | 'shell';
}

/**
 * Mostra UMA vez: o token do runner (1º bloco) e os comandos para registrar numa máquina com gitlab-runner e para
 * instalar no Kubernetes via Helm. Só fecha pelo botão; o valor vive no estado do pai e é descartado ao fechar.
 */
export function RunnerCreatedDialog({ created, onClose }: { created: CreatedRunner | null; onClose: () => void }) {
  const helm = created ? helmCommands({ url: created.url, token: created.token }) : null;
  return (
    <Dialog open={created !== null} onOpenChange={() => undefined /* só fecha pelo botão */}>
      <DialogContent showCloseButton={false} className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" data-testid="runner-created">
        <DialogHeader>
          <DialogTitle>Runner #{created?.runnerId} criado</DialogTitle>
          <DialogDescription>
            O token abaixo não será exibido de novo. Copie agora e use um dos comandos para ativar o runner.
          </DialogDescription>
        </DialogHeader>
        {created && helm && (
          <div className="space-y-4">
            <Block id="runner-token" title="Token do runner" hint="Autentica o runner no GitLab. Trate como senha." text={created.token} />
            <Block
              id="runner-cmd-register"
              title={`Máquina com gitlab-runner (executor ${created.executor})`}
              hint="Rode na máquina onde o gitlab-runner está instalado."
              text={registrationCommand({ url: created.url, token: created.token, executor: created.executor })}
            />
            <div className="space-y-2">
              <Block id="runner-cmd-helm-repo" title="Kubernetes com Helm: 1. adicionar o repositório" text={helm.repo} />
              <Block
                id="runner-cmd-helm"
                title="Kubernetes com Helm: 2. instalar o runner"
                hint="Cria o namespace gitlab-runner. Ajuste namespace/release se precisar. Para um GitLab com certificado interno, aponte o chart para a CA (certsSecretName)."
                text={helm.install}
              />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button onClick={onClose} data-testid="runner-created-close">
            Já guardei, fechar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
