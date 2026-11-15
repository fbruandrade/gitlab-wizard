import { createCipheriv, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as cipher from '@/server/crypto/token-cipher';
import { prisma } from '@/server/db';
import { env } from '@/server/env';
import { reencryptTokens } from '@/server/services/key-rotation.service';
import { resetDb, seedUser } from '../support/app';

beforeEach(resetDb);

/** Cria uma linha cifrada com uma chave "antiga" (v0), como se fosse anterior à rotação. */
async function legacyRow(userId: string, token: string, keyBytes: Buffer, version: string, gitlabUserId: number) {
  const id = crypto.randomUUID();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyBytes, iv);
  c.setAAD(Buffer.from(cipher.tokenAad(userId, id)));
  const ciphertext = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  await prisma.gitLabToken.create({
    data: {
      id,
      userId,
      gitlabBaseUrl: 'g',
      gitlabUserId,
      gitlabUsername: 'x',
      gitlabIsAdmin: false,
      gitlabTokenId: gitlabUserId,
      name: 'n',
      scopes: [],
      capabilities: [],
      keyVersion: version,
      fingerprint: 'f',
      ciphertext: Uint8Array.from(ciphertext),
      iv: Uint8Array.from(iv),
      authTag: Uint8Array.from(c.getAuthTag()),
    },
  });
  return id;
}

describe('rotação da chave de cifragem', () => {
  it('recifra com a chave ativa preservando o token e é idempotente', async () => {
    const u = await seedUser('alice');
    const oldKey = Buffer.alloc(32, 9);
    // simula que a chave antiga ainda está configurada ao lado da nova
    env.TOKEN_ENCRYPTION_KEYS.set('v0', oldKey);
    const oldId = await legacyRow(u.id, 'glpat-antigo', oldKey, 'v0', 1);

    const first = await reencryptTokens();
    expect(first).toEqual({ reencrypted: 1, failed: [], remaining: 0 });

    const row = await prisma.gitLabToken.findUniqueOrThrow({ where: { id: oldId } });
    expect(row.keyVersion).toBe(env.TOKEN_ENCRYPTION_ACTIVE_KEY);
    const plain = cipher.decryptToken(
      {
        ciphertext: Buffer.from(row.ciphertext!),
        iv: Buffer.from(row.iv!),
        authTag: Buffer.from(row.authTag!),
        keyVersion: row.keyVersion,
      },
      cipher.tokenAad(u.id, oldId),
    );
    expect(plain).toBe('glpat-antigo');

    expect(await reencryptTokens()).toEqual({ reencrypted: 0, failed: [], remaining: 0 });
    env.TOKEN_ENCRYPTION_KEYS.delete('v0');
  });

  it('chave antiga já removida: reporta o id pendente, não perde o dado e não vaza o conteúdo', async () => {
    const u = await seedUser('alice');
    const lost = Buffer.alloc(32, 5);
    const id = await legacyRow(u.id, 'glpat-segredo-perdido', lost, 'v-removida', 7);
    const spy = vi.spyOn(console, 'log');
    const r = await reencryptTokens();
    expect(r).toEqual({ reencrypted: 0, failed: [id], remaining: 1 });
    expect(JSON.stringify(r)).not.toContain('segredo');
    expect(spy).not.toHaveBeenCalled();
    expect((await prisma.gitLabToken.findUniqueOrThrow({ where: { id } })).keyVersion).toBe('v-removida'); // intacto
  });
});
