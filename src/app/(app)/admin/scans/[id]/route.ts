import { NextResponse } from 'next/server';
import { auth } from '@/server/auth/auth';
import { getScan } from '@/server/services/cleanup.service';

export const dynamic = 'force-dynamic';

/** Progresso de uma varredura (polling da tela). Só o admin que a criou enxerga. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: req.headers, query: { disableCookieCache: true } });
  if (!session) return new NextResponse(null, { status: 401 });
  if (session.user.role !== 'admin') return new NextResponse(null, { status: 403 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new NextResponse(null, { status: 404 });
  const scan = await getScan(id, session.user.id);
  if (!scan) return new NextResponse(null, { status: 404 });
  return NextResponse.json(
    { status: scan.status, progress: scan.progress, error: scan.error },
    { headers: { 'cache-control': 'no-store' } },
  );
}
