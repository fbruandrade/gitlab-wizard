// Recifra os PATs com a chave ativa. Ver src/server/services/key-rotation.service.ts.
//   npm run reencrypt-tokens        |   docker compose --profile tools run --rm create-admin npm run reencrypt-tokens
import { prisma } from '@/server/db';
import { reencryptTokens } from '@/server/services/key-rotation.service';

const r = await reencryptTokens();
console.log(`Recifrados: ${r.reencrypted}. Pendentes: ${r.remaining}${r.failed.length ? ` (ids: ${r.failed.join(', ')})` : ''}.`);
await prisma.$disconnect();
process.exit(r.remaining ? 1 : 0);
