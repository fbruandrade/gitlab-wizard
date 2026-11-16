import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/server/env';
import { runVaultAuto } from '@/server/services/vault-auto.service';

export const dynamic = 'force-dynamic';

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Gatilho externo (CronJob) da rotação automática dos cofres. Mesmo segredo da manutenção; sem ele, 404. */
export async function POST(req: NextRequest) {
  const secret = env.MAINTENANCE_SECRET;
  if (!secret) return new NextResponse(null, { status: 404 });
  const given = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!safeEqual(given, secret)) return new NextResponse(null, { status: 401 });
  return NextResponse.json(await runVaultAuto());
}
