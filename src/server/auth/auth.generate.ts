// Config usada só pela CLI (`npm run auth:generate`): reflete os plugins e campos de auth.ts
// sem importar módulos `server-only`. Mantenha em sincronia com auth.ts.
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { admin, twoFactor, username } from 'better-auth/plugins';

export const auth = betterAuth({
  database: prismaAdapter({} as never, { provider: 'postgresql' }),
  emailAndPassword: { enabled: true },
  rateLimit: { enabled: true, storage: 'database' },
  user: { additionalFields: { mustChangePassword: { type: 'boolean', defaultValue: true, input: false } } },
  plugins: [username(), twoFactor(), admin()],
});
