import { NextResponse, type NextRequest } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';

const PUBLIC = [/^\/login(\/|$)/, /^\/api\/auth(\/|$)/, /^\/api\/health$/, /^\/api\/internal\//];

function csp(nonce: string) {
  const dev = process.env.NODE_ENV === 'development';
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:", // sem avatares do GitLab: com certificado auto-assinado o browser os bloquearia
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/**
 * 1) CSP com nonce por requisição; 2) checagem OTIMISTA do cookie de sessão.
 * Isto NÃO autoriza nada: a validação real fica nos guards de cada página/Server Action.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const policy = csp(nonce);

  if (!PUBLIC.some((re) => re.test(pathname)) && !getSessionCookie(request, { cookiePrefix: 'gw' })) {
    const res = NextResponse.redirect(new URL('/login', request.url));
    res.headers.set('Content-Security-Policy', policy);
    return res;
  }

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', policy);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('Content-Security-Policy', policy);
  return res;
}

export const config = {
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
