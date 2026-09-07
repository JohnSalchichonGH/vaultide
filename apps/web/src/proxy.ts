import { NextResponse, type NextRequest } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';

/**
 * Edge proxy (blueprint 17.2, 17.3).
 *
 * Two jobs, neither of which is an authorization decision:
 *
 *  1. security headers, including a strict CSP with a per-request nonce — no
 *     third-party scripts, no framing, no inline script without the nonce;
 *  2. a convenience redirect for unauthenticated requests to the signed-in
 *     pages. The authority is always `requireSession()` in the server component
 *     or action, never this file.
 *
 * Point 2 deserves the emphasis 17.2 gives it. This runs on the edge and only
 * looks at whether a session **cookie** is present — it does not validate a
 * token, does not read the database, and is therefore not a security control.
 * Its whole job is to send somebody to the sign-in form instead of rendering a
 * page that would refuse them. Every page under `(app)` re-checks properly.
 */

/** Prefixes that require a session. Everything else is public. */
const PROTECTED_PREFIXES = ['/settings', '/onboarding', '/dashboard', '/monthly', '/accounts'];

function requiresSession(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

function contentSecurityPolicy(nonce: string, isDevelopment: boolean, isHttpsDeployment: boolean): string {
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
    // Only where the deployment is actually served over HTTPS. WebKit applies
    // this directive to loopback too, so leaving it on would break every local
    // and CI run over http without protecting anything.
    ...(isHttpsDeployment ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

export default function proxy(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDevelopment = process.env.NODE_ENV === 'development';
  // Taken from the request rather than from NODE_ENV, which Next inlines at
  // build time: the same artifact runs behind HTTPS in production and over
  // plain http on loopback in local and CI runs.
  const forwardedProtocol = request.headers.get('x-forwarded-proto');
  const isHttpsDeployment =
    (forwardedProtocol ?? request.nextUrl.protocol.replace(':', '')).split(',')[0]?.trim() ===
    'https';

  const policy = contentSecurityPolicy(nonce, isDevelopment, isHttpsDeployment);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  // Next reads the policy from the *request* headers to stamp the same nonce on
  // its own script tags. Without this the framework's scripts carry no nonce,
  // `strict-dynamic` blocks them, and the page never hydrates.
  requestHeaders.set('Content-Security-Policy', policy);

  // The convenience gate (17.2, step 1). A cookie's mere presence is enough to
  // let the request through to the page, which then checks it for real.
  const response =
    requiresSession(request.nextUrl.pathname) && getSessionCookie(request) === null
      ? NextResponse.redirect(signInUrl(request))
      : NextResponse.next({ request: { headers: requestHeaders } });

  response.headers.set('Content-Security-Policy', policy);
  for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(header, value);
  }
  if (isHttpsDeployment) {
    response.headers.set(
      'Strict-Transport-Security',
      'max-age=63072000; includeSubDomains; preload',
    );
  }

  return response;
}

/** Sign-in, remembering where the visitor was going. */
function signInUrl(request: NextRequest): URL {
  const url = new URL('/sign-in', request.nextUrl);
  url.searchParams.set('next', request.nextUrl.pathname + request.nextUrl.search);
  return url;
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
