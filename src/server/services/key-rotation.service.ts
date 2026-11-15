import 'server-only';
import { decryptToken, encryptToken, tokenAad } from '@/server/crypto/token-cipher';
import { prisma } from '@/server/db';
import { env } from '@/server/env';

/**
 * Recifra os PATs que ainda usam uma chave que não é a ativa (docs/06-seguranca.md §4).
 * Fluxo de rotação da chave: 1) adicione a versão nova a TOKEN_ENCRYPTION_KEYS (mantendo as antigas) e
 * ative-a em TOKEN_ENCRYPTION_ACTIVE_KEY; 2) rode este script; 3) quando `remaining` for 0, remova as antigas.
 * Idempotente e seguro de interromper: cada linha é atualizada de forma atômica.
 */
export async function reencryptTokens() {
  const active = env.TOKEN_ENCRYPTION_ACTIVE_KEY;
  const rows = await prisma.gitLabToken.findMany({
    where: { ciphertext: { not: null }, keyVersion: { not: active } },
    select: { id: true, userId: true, ciphertext: true, iv: true, authTag: true, keyVersion: true },
  });

  let reencrypted = 0;
  const failed: string[] = [];
  for (const r of rows) {
    try {
      const aad = tokenAad(r.userId, r.id);
      const plain = decryptToken(
        { ciphertext: Buffer.from(r.ciphertext!), iv: Buffer.from(r.iv!), authTag: Buffer.from(r.authTag!), keyVersion: r.keyVersion },
        aad,
      );
      const enc = encryptToken(plain, aad);
      await prisma.gitLabToken.update({
        where: { id: r.id },
        data: {
          ciphertext: Uint8Array.from(enc.ciphertext),
          iv: Uint8Array.from(enc.iv),
          authTag: Uint8Array.from(enc.authTag),
          keyVersion: enc.keyVersion,
        },
      });
      reencrypted++;
    } catch {
      failed.push(r.id); // chave antiga ausente ou dado corrompido: nunca loga o conteúdo
    }
  }
  return { reencrypted, failed, remaining: failed.length };
}
