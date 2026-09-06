import { NextResponse, type NextRequest } from 'next/server';

/**
 * Edge proxy (blueprint 17.2, 17.3).
 *
 * Two jobs, neither of which is an authorization decision:
 *
 *  1. security headers, including a strict CSP with a per-request nonce — no
 *     third-party scripts, no framing, no inline script without the nonce;
 *  2. from Phase 1, a convenience redirect for unauthenticated requests to
 *     `/(app)/*`. The authority is always `requireSession()` in the server
 *     component or action, never this file.
 */

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

function contentSecurityPolicy(nonce: string, isDevelopment: boolean): string {
  // Recharts injects inline styles, so style-src keeps 'unsafe-inline' (17.3);
  // scripts never do. Development additionally needs eval for fast refresh.
  const scriptSrc = isDevelopment
    ? `'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`
    : `'self' 'nonce-${nonce}' 'strict-dynamic'`;

  return [
    `default-src 'self'`,
    `script-src ${scriptSrc}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
    `connect-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `upgrade-insecure-requests`,
  ].join('; ');
}

export default function proxy(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDevelopment = process.env.NODE_ENV === 'development';

  const policy = contentSecurityPolicy(nonce, isDevelopment);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  // Next reads the policy from the *request* headers to stamp the same nonce on
  // its own script tags. Without this the framework's scripts carry no nonce,
  // `strict-dynamic` blocks them, and the page never hydrates.
  requestHeaders.set('Content-Security-Policy', policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  response.headers.set('Content-Security-Policy', policy);
  for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(header, value);
  }
  if (!isDevelopment) {
    response.headers.set(
      'Strict-Transport-Security',
      'max-age=63072000; includeSubDomains; preload',
    );
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except static assets and the image optimizer.
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
