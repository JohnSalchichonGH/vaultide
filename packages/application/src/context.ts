import {
  fixedClock,
  isValidTimeZone,
  plainDate,
  systemClock,
  todayIn,
  type Clock,
  type PlainDate,
} from '@vaultide/finance';

/**
 * The request context (blueprint 4.2, 17.2, 21).
 *
 * Every read and every mutation receives one. It carries the authenticated user
 * (never a client-supplied id), the user's timezone and locale, the reporting
 * currency and — crucially — **today** in the user's timezone, computed once so
 * every engine in the request agrees on what "today" and "this month" mean.
 */
export interface RequestContext {
  readonly requestId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly timezone: string;
  readonly locale: string;
  readonly reportingCurrency: string;
  readonly today: PlainDate;
}

/** The context of a request that has no authenticated user yet. */
export type AnonymousContext = Omit<RequestContext, 'userId' | 'sessionId'>;

export const TEST_CLOCK_HEADER = 'x-vaultide-test-clock';

/**
 * Test-only capabilities: the `TEST_CLOCK` override (blueprint 21) and the
 * captured mailbox the end-to-end suite reads (21.5).
 *
 * Section 21 gates the clock override on `NODE_ENV === 'test'`, and that is
 * still the primary signal — it is what Vitest sets, and it is what makes the
 * override impossible under `next dev`. But 21.5 runs the suite against the
 * **production build**, and a Next.js standalone server assigns
 * `process.env.NODE_ENV = 'production'` in its own entry point, before any
 * application code runs. Gating on `NODE_ENV` alone would therefore make both
 * capabilities permanently unreachable in the one artifact the blueprint says
 * to test against.
 *
 * So there is a second door, deliberately narrow:
 *
 *  - it needs an explicit `VAULTIDE_TEST_ENDPOINTS=enabled`, which no
 *    deployment sets by accident, and
 *  - it is refused outright whenever the host says this is a production
 *    deployment (`VERCEL_ENV=production`), so setting the variable there
 *    cannot open it.
 *
 * The intent of section 21 is unchanged: a header a user sends can never move
 * the server's clock, and the mailbox — which would hand out single-use
 * verification tokens — cannot be reached in production.
 */
export function areTestEndpointsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['VERCEL_ENV'] === 'production') return false;
  if (env.NODE_ENV === 'test') return true;
  return env['VAULTIDE_TEST_ENDPOINTS'] === 'enabled';
}

/** The name section 21 uses for the same gate. */
export const isTestClockEnabled = areTestEndpointsEnabled;

export class InvalidTestClockError extends Error {
  readonly code = 'INVALID_TEST_CLOCK';
  constructor() {
    super('The test clock header is not a valid ISO instant.');
    this.name = 'InvalidTestClockError';
  }
}

/**
 * Resolve the clock for a request. Outside test builds this is always the
 * system clock, whatever headers arrive.
 */
export function resolveClock(
  headers: { get(name: string): string | null } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Clock {
  if (!areTestEndpointsEnabled(env)) return systemClock;

  const header = headers?.get(TEST_CLOCK_HEADER) ?? env.TEST_CLOCK ?? null;
  if (header === null || header === '') return systemClock;

  try {
    return fixedClock(header);
  } catch {
    throw new InvalidTestClockError();
  }
}

export interface AnonymousContextInput {
  readonly requestId?: string;
  readonly timezone: string;
  readonly locale: string;
  readonly reportingCurrency: string;
  readonly headers?: { get(name: string): string | null };
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * The context of a request with no authenticated user — the landing page and
 * the auth pages. It still computes `today` once, in the stated timezone, so
 * no component ever reads the browser or process clock itself.
 */
export function anonymousContext(input: AnonymousContextInput): AnonymousContext {
  const env = input.env ?? process.env;
  const timezone = isValidTimeZone(input.timezone) ? input.timezone : 'UTC';

  return {
    requestId: input.requestId ?? 'anonymous',
    timezone,
    locale: input.locale,
    reportingCurrency: input.reportingCurrency,
    today: todayIn(timezone, resolveClock(input.headers, env)),
  };
}

export interface BuildContextInput {
  readonly requestId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly timezone: string;
  readonly locale: string;
  readonly reportingCurrency: string;
  readonly headers?: { get(name: string): string | null };
  readonly env?: NodeJS.ProcessEnv;
}

export function buildRequestContext(input: BuildContextInput): RequestContext {
  const env = input.env ?? process.env;
  const timezone = isValidTimeZone(input.timezone) ? input.timezone : 'UTC';
  const clock = resolveClock(input.headers, env);

  return {
    requestId: input.requestId,
    userId: input.userId,
    sessionId: input.sessionId,
    timezone,
    locale: input.locale,
    reportingCurrency: input.reportingCurrency,
    today: todayIn(timezone, clock),
  };
}

/** A context for tests and fixtures, with an explicit `today`. */
export function testContext(overrides: Partial<RequestContext> & { today?: string } = {}) {
  const today = overrides.today ?? '2026-09-06';
  return {
    requestId: 'test-request',
    userId: '11111111-1111-4111-8111-111111111111',
    sessionId: 'test-session',
    timezone: 'Europe/Madrid',
    locale: 'en-GB',
    reportingCurrency: 'EUR',
    ...overrides,
    today: plainDate(today),
  } satisfies RequestContext;
}
