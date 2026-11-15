import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { logger } from '@/server/logger';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: 'ok' });
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'unknown' }, 'health check falhou');
    return NextResponse.json({ status: 'unavailable' }, { status: 503 });
  }
}
