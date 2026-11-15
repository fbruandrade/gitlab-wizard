import 'server-only';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { env } from './env';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function getClient(): PrismaClient {
  globalForPrisma.prisma ??= new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  return globalForPrisma.prisma;
}

/**
 * Criação preguiçosa: `next build` carrega os módulos das rotas sem as variáveis de runtime
 * (a imagem Docker não tem .env), então o client só é instanciado no primeiro uso.
 * O singleton em globalThis também evita múltiplos pools em HMR e em produção.
 */
export const prisma = new Proxy({} as PrismaClient, {
  get: (_t, prop) => {
    const client = getClient();
    const value = Reflect.get(client, prop, client);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});
