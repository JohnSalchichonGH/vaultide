import { randomUUID } from 'node:crypto';
import { findAuthUserById, type Database } from '@vaultide/db';
import { AuthRequiredError } from '../errors';
import { buildRequestContext } from '../context';
import type { SessionContext, UserSettings } from '../settings/types';
import { findSettings } from '../settings/service';
import { ensureProvisioned } from '../users/provisioning';
import { SESSION_FRESH_AGE, type Auth } from './config';

/**
 * Session to authorization (blueprint 17.2).
 *
 * 1. `proxy.ts` may redirect an unauthenticated request. It is a convenience,
 *    never the authority.
 * 2. Every server component under `(app)` and every server action calls
 *    `requireSession()`, which fails closed.
 * 3. The context it returns carries the user id from the **session**. No caller
 *    supplies one, no action accepts one, and `withUser` will only ever put
 *    this value into the RLS GUC (17.4).
 */

export interface SessionDependencies {
  readonly auth: Auth;
  readonly db: Database;
  readonly env?: NodeJS.ProcessEnv;
}

export interface SessionReadOptions {
  /**
   * Bypass the signed cookie cache and read the session store itself.
   *
   * 17.1 enables `cookieCache: { maxAge: 300 }`, so an ordinary read can be
   * answered from the cookie for up to five minutes after the session row was
   * deleted. That is a deliberate trade for ordinary reads and is documented in
   * ADR 0002 decision 14 — but it means an ordinary read is **not** an
   * authority on whether the session still exists.
   *
   * With this set, Better Auth queries the store, so a revoked session resolves
   * to `null` immediately. Better Auth's own contract says the same: the flag
   * exists so "a revoked-but-cached session cannot authorize a sensitive
   * action".
   */
  readonly authoritative?: boolean;
}

/** What Better Auth hands back for an authenticated request. */
interface RawSession {
  readonly session: { readonly id: string; readonly createdAt: Date | string };
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly name: string;
    readonly emailVerified: boolean;
    readonly twoFactorEnabled?: boolean | null;
  };
}

function isFresh(createdAt: Date | string): boolean {
  const created = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
  return Date.now() - created < SESSION_FRESH_AGE * 1000;
}

/**
 * The context of the current request, or `undefined` when nobody is signed in.
 *
 * Also the point where an un-provisioned account repairs itself: sign-in is
 * verification-gated, so this runs before the user can reach anything, and
 * `ensureProvisioned` is a single indexed read in the normal case.
 */
export async function getSessionContext(
  deps: SessionDependencies,
  headers: Headers,
  options: SessionReadOptions = {},
): Promise<SessionContext | undefined> {
  const raw = (await deps.auth.api.getSession({
    headers,
    ...(options.authoritative === true ? { query: { disableCookieCache: true } } : {}),
  })) as RawSession | null;
  if (raw === null) return undefined;

  await ensureProvisioned(deps.db, raw.user.id);

  const settings = await findSettings(deps.db, raw.user.id);
  /* v8 ignore next -- ensureProvisioned has just guaranteed the row exists. */
  if (settings === undefined) return undefined;

  /**
   * Read the account's own flags from the database rather than from the session
   * payload.
   *
   * 17.1 enables a five-minute signed cookie cache, so `raw.user` can be up to
   * five minutes old — which is fine for a name, and wrong for
   * `twoFactorEnabled`: somebody who has just turned two-factor on would be
   * told for the next five minutes that it is off. This request already reads
   * the settings row, so it is one more indexed primary-key read.
   */
  const account = await findAuthUserById(deps.db, raw.user.id);

  return buildSessionContext(raw, settings, account, headers, deps.env);
}

function buildSessionContext(
  raw: RawSession,
  settings: UserSettings,
  account: { email: string; name: string; emailVerified: boolean; twoFactorEnabled: boolean } | undefined,
  headers: Headers,
  env: NodeJS.ProcessEnv | undefined,
): SessionContext {
  const base = buildRequestContext({
    requestId: headers.get('x-request-id') ?? randomUUID(),
    userId: raw.user.id,
    sessionId: raw.session.id,
    timezone: settings.timezone,
    locale: settings.locale,
    reportingCurrency: settings.reportingCurrency,
    headers,
    ...(env === undefined ? {} : { env }),
  });

  return {
    ...base,
    settings,
    email: account?.email ?? raw.user.email,
    name: account?.name ?? raw.user.name,
    emailVerified: account?.emailVerified ?? raw.user.emailVerified,
    twoFactorEnabled: account?.twoFactorEnabled ?? raw.user.twoFactorEnabled === true,
    sessionFresh: isFresh(raw.session.createdAt),
  };
}

/** Fails closed: no session, no context (17.2). */
export async function requireSession(
  deps: SessionDependencies,
  headers: Headers,
  options: SessionReadOptions = {},
): Promise<SessionContext> {
  const context = await getSessionContext(deps, headers, options);
  if (context === undefined) throw new AuthRequiredError();
  return context;
}

/**
 * The session, validated against the **store** rather than the cookie cache.
 *
 * ## The invariant this exists to hold
 *
 * **No state-changing financial action may be authorized from the five-minute
 * cookie cache.** A revoked session must stop being able to move money-shaped
 * data the moment the row is gone, not up to five minutes later.
 *
 * Phase 1 has nothing financial to write, and its ordinary mutations
 * (preferences, categories, tags) legitimately use `requireSession`: they are
 * cheap, reversible, and visible to the account holder. Production verification
 * of Phase 1 observed exactly that boundary — a revoked session completed one
 * ordinary settings write inside the window, then was refused on the next.
 *
 * From Phase 2 onward, valuations, flows, balances and every other financial
 * mutation go through this instead. It costs one session lookup per write,
 * which is the right price for a write that changes what somebody's net worth
 * says.
 *
 * This is deliberately **not** `requireFreshSession`: that asks "did they
 * authenticate recently?" (`session.createdAt` within `freshAge`) and would
 * happily accept a revoked session created two minutes ago. The two answer
 * different questions and a financial write needs this one.
 */
export async function requireAuthoritativeSession(
  deps: SessionDependencies,
  headers: Headers,
): Promise<SessionContext> {
  return requireSession(deps, headers, { authoritative: true });
}

/**
 * Gate a sensitive screen on session freshness (17.1 `freshAge`).
 *
 * The endpoints themselves are guarded by Better Auth, so this exists to fail
 * *early and legibly* — "confirm your password to continue" rather than a
 * rejected submission — not to be the control.
 */
export function requireFreshSession(context: SessionContext): SessionContext {
  if (context.sessionFresh) return context;
  throw new AuthRequiredError('Confirm your password to continue.');
}
