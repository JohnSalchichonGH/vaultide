import { getServices } from '@vaultide/application';
import { toNextJsHandler } from 'better-auth/next-js';

/**
 * The Better Auth route handler (blueprint 4.2, 17.1).
 *
 * Everything under `/api/auth/*` — sign-up, verification, sign-in, reset,
 * two-factor, sign-out and account deletion — is served here. The instance is
 * built by `@vaultide/application`, which is the only package that may see the
 * database (section 19); this file is the thin wrapper the framework needs.
 *
 * The services are resolved per request rather than at module scope. Building
 * them requires `BETTER_AUTH_SECRET` and a database URL, and a build step that
 * merely imports this module has neither — failing there would say "the build
 * is broken" when the truth is "this deployment has no secret configured".
 */

// Auth is per-request by definition: it reads cookies and writes sessions.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request): Promise<Response> {
  return toNextJsHandler(getServices().auth.handler).GET(request);
}

export function POST(request: Request): Promise<Response> {
  return toNextJsHandler(getServices().auth.handler).POST(request);
}
