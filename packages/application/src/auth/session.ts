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
): Promise<SessionContext | undefined> {
  const raw = (await deps.auth.api.getSession({ headers })) as RawSession | null;
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
): Promise<SessionContext> {
  const context = await getSessionContext(deps, headers);
  if (context === undefined) throw new AuthRequiredError();
  return context;
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
