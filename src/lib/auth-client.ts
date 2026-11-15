import { createAuthClient } from 'better-auth/react';
import { inferAdditionalFields, twoFactorClient, usernameClient } from 'better-auth/client/plugins';
import type { auth } from '@/server/auth/auth';

// Só o que a rota HTTP expõe (docs/03-autenticacao.md): login, 2FA, senha e sessões.
// Ações de admin da ferramenta NÃO passam por aqui — são Server Actions.
export const authClient = createAuthClient({
  plugins: [usernameClient(), twoFactorClient(), inferAdditionalFields<typeof auth>()],
});
