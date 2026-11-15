import 'server-only';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '@/server/env';

export interface EncryptedToken {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: string;
}

const ALGORITHM = 'aes-256-gcm';

/** AAD amarra o ciphertext à linha e ao dono: copiar o valor para outra linha faz a decifragem falhar. */
export const tokenAad = (userId: string, tokenRowId: string) => `${userId}:${tokenRowId}`;

export function encryptToken(plain: string, aad: string): EncryptedToken {
  const keyVersion = env.TOKEN_ENCRYPTION_ACTIVE_KEY;
  const key = env.TOKEN_ENCRYPTION_KEYS.get(keyVersion)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion };
}

export function decryptToken(rec: EncryptedToken, aad: string): string {
  const key = env.TOKEN_ENCRYPTION_KEYS.get(rec.keyVersion);
  if (!key) throw new Error(`Chave de cifragem "${rec.keyVersion}" não configurada`);
  const decipher = createDecipheriv(ALGORITHM, key, rec.iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(rec.authTag);
  return Buffer.concat([decipher.update(rec.ciphertext), decipher.final()]).toString('utf8');
}

/** Identificador curto para suporte; não permite recuperar o token. */
export const fingerprint = (token: string) => createHash('sha256').update(token).digest('hex').slice(0, 8);
