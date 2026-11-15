'use client';
import { useRouter } from 'next/navigation';
import { createContext, useContext, useState } from 'react';
import { SecretDialog } from '@/components/common/secret-dialog';

interface Secret {
  token: string;
  partial: boolean;
}
const Ctx = createContext<(s: Secret) => void>(() => undefined);

/** Para um formulário pedir "mostre este token UMA vez" sem depender de si mesmo continuar montado. */
export const useShowTokenSecret = () => useContext(Ctx);

/**
 * Dono do diálogo do token exibido uma única vez (novo token da rotação, ou o token que o GitLab rotacionou mas a
 * ferramenta não conseguiu gravar). Fica FORA dos cards: a rotação troca a linha do token, o card é recriado e o
 * estado de dentro dele se perderia — no caso PARTIAL, junto com o único exemplar do token.
 */
export function TokenSecretHost({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [secret, setSecret] = useState<Secret | null>(null);
  return (
    <Ctx.Provider value={setSecret}>
      {children}
      <SecretDialog
        open={secret !== null}
        title={secret?.partial ? 'Token rotacionado, mas não foi salvo' : 'Novo token'}
        description={
          secret?.partial
            ? 'O GitLab rotacionou o token, porém a ferramenta não conseguiu gravá-lo. Copie agora e cadastre-o em "Adicionar outro token". Ele não será exibido de novo.'
            : 'Este token não será exibido novamente.'
        }
        secret={secret?.token ?? ''}
        onClose={() => {
          setSecret(null);
          router.refresh();
        }}
      />
    </Ctx.Provider>
  );
}
