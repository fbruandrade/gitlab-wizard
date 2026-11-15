import 'server-only';
import { prisma } from '@/server/db';

const DAY = 86_400_000;

/** Retenção (docs/05-modelo-de-dados.md §6). Idempotente; chamada por CronJob via /api/internal/maintenance. */
export async function runMaintenance(now = new Date()) {
  const ago = (days: number) => new Date(now.getTime() - days * DAY);

  const sessions = await prisma.session.deleteMany({ where: { expiresAt: { lt: ago(7) } } });
  // lastRequest é epoch em ms (BigInt).
  const rateLimits = await prisma.rateLimit.deleteMany({ where: { lastRequest: { lt: BigInt(ago(1).getTime()) } } });
  const verifications = await prisma.verification.deleteMany({ where: { expiresAt: { lt: ago(1) } } });
  // Tokens inativos há mais de 30 dias perdem o material cifrado; os metadados ficam.
  const tokens = await prisma.gitLabToken.updateMany({
    where: { status: { not: 'ACTIVE' }, inactivatedAt: { lt: ago(30) }, ciphertext: { not: null } },
    data: { ciphertext: null, iv: null, authTag: null },
  });

  // Varreduras da limpeza/simulações (contêm usernames e títulos de chaves, nunca segredos): 30 dias.
  const scans = await prisma.adminScan.deleteMany({ where: { createdAt: { lt: ago(30) } } });

  return {
    sessions: sessions.count,
    rateLimits: rateLimits.count,
    verifications: verifications.count,
    tokensScrubbed: tokens.count,
    scans: scans.count,
  };
}
