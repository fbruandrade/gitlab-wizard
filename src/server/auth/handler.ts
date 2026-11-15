import 'server-only';
import { auth } from './auth';
import { clientIpFrom, recordAuditSafe } from '@/server/services/audit.service';

/**
 * Handler HTTP do better-auth. O rate limiter responde 429 antes dos hooks `after`, então a
 * auditoria desse evento acontece aqui, na borda.
 */
export async function authHandler(request: Request): Promise<Response> {
  const res = await auth.handler(request);
  if (res.status === 429) {
    await recordAuditSafe({
      action: 'AUTH_RATE_LIMITED',
      result: 'FAILURE',
      meta: { ip: clientIpFrom(request.headers), userAgent: request.headers.get('user-agent')?.slice(0, 300) ?? null },
      metadata: { path: new URL(request.url).pathname },
    });
  }
  return res;
}
