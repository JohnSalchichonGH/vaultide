import 'server-only';
import type { Route } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  getServices,
  getSessionContext,
  requireAuthoritativeSession as requireAuthoritativeSessionContext,
  requireSession as requireSessionContext,
  type SessionContext,
} from '@vaultide/application';

/**
 * The server-side entry point for every read and every mutation
 * (blueprint 17.2, 4.2).
 *
 * `proxy.ts` may redirect an unauthenticated request before it gets here, but
 * that is a convenience. This is the authority: every server component under
 * `(app)` and every server action calls one of these, and they fail closed.
 *
 * Note what is absent: no function here takes a user id. The identity comes
 * from the session cookie, is validated by Better Auth against a database row,
 * and is the only value that ever reaches `withUser` (17.4).
 */

function deps() {
  const services = getServices();
  return { auth: services.auth, db: services.db };
}

/** The context, or `undefined` when nobody is signed in. */
export async function currentSession(): Promise<SessionContext | undefined> {
  return getSessionContext(deps(), await headers());
}

/** The context, or an `AUTH_REQUIRED` error. Used by server actions. */
export async function requireSession(): Promise<SessionContext> {
  return requireSessionContext(deps(), await headers());
}

/**
 * The context, validated against the session store rather than the cookie
 * cache. **Every financial mutation from Phase 2 onward must use this** — see
 * `requireAuthoritativeSession` in `@vaultide/application` and ADR 0003.
 */
export async function requireAuthoritativeSession(): Promise<SessionContext> {
  return requireAuthoritativeSessionContext(deps(), await headers());
}

/**
 * The context, or a redirect to sign-in. Used by pages, where an error boundary
 * would show a message when what the person actually needs is the sign-in form.
 */
export async function requireSessionPage(returnTo?: string): Promise<SessionContext> {
  const session = await currentSession();
  if (session !== undefined) return session;

  // The query string makes this a computed route; the destination itself is a
  // literal, so the cast asserts only what the line above already guarantees.
  const target =
    returnTo === undefined
      ? ('/sign-in' as Route)
      : (`/sign-in?next=${encodeURIComponent(returnTo)}` as Route);
  redirect(target);
}
