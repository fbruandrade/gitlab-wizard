'use client';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { buildMfaConsoleCommand } from '@/lib/mfa-console';

/** O GitLab não deixa a API resetar o 2FA de administradores: mostra o caminho oficial (console Rails). */
export function AdminMfaGuide({
  operatorUsername,
  targetUsername,
  isSelf,
}: {
  operatorUsername: string;
  targetUsername: string;
  isSelf: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const command = buildMfaConsoleCommand(operatorUsername, targetUsername);

  return (
    <div className="space-y-3 text-sm" data-testid="disable2fa-na">
      <p>
        O GitLab não permite resetar o MFA de administradores (nem o da própria conta) pela API. Para{' '}
        {isSelf ? 'a sua conta' : <strong>@{targetUsername}</strong>}, o único caminho é o console Rails no servidor do GitLab.
      </p>
      <details className="rounded-md border p-3" data-testid="mfa-console-guide">
        <summary className="cursor-pointer font-medium">Passo a passo pelo console Rails</summary>
        <ol className="mt-3 list-decimal space-y-3 pl-5">
          <li>
            <strong>Confirme a identidade</strong> de quem pediu por um canal independente. A ação é <strong>permanente</strong>: a pessoa
            terá de cadastrar o 2FA de novo e será notificada.
          </li>
          <li>
            <strong>Abra o console</strong> no servidor do GitLab (exige acesso de administrador do servidor):
            <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
              <li>
                Pacote Linux: <code className="font-mono">sudo gitlab-rails console</code>
              </li>
              <li>
                Docker: <code className="font-mono">docker exec -it &lt;container&gt; gitlab-rails console</code>
              </li>
            </ul>
          </li>
          <li>
            <strong>Execute o comando</strong> (já preenchido com os usernames):
            <div className="mt-2 space-y-2">
              <pre
                data-testid="mfa-console-command"
                className="overflow-x-auto rounded-md border bg-muted p-3 font-mono text-xs select-all"
              >
                {command}
              </pre>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={async () => {
                  await navigator.clipboard.writeText(command).catch(() => undefined);
                  setCopied(true);
                }}
              >
                {copied ? <Check /> : <Copy />} {copied ? 'Copiado' : 'Copiar comando'}
              </Button>
            </div>
          </li>
          <li>
            Se a instância <strong>obriga o 2FA</strong> (enforcement), a pessoa será pedida para configurar no próximo login. Para deixá-la
            sem 2FA, desative também essa obrigatoriedade.
          </li>
          <li>
            Se ela ainda tiver um <strong>código de recuperação</strong>, pode entrar com ele e reconfigurar sozinha, sem o console.
          </li>
        </ol>
        <p className="mt-3 text-xs text-muted-foreground">
          Teste antes em homologação: o comportamento depende da versão do GitLab. Esta ferramenta não executa nem registra essa ação.
        </p>
      </details>
    </div>
  );
}
