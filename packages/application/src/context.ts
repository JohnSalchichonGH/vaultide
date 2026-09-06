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
 * The `TEST_CLOCK` override (blueprint 21).
 *
 * It exists so month boundaries can be exercised deterministically, and it is
 * honored **only** when `NODE_ENV === 'test'`. In development and production the
 * header is ignored entirely — reading it cannot move the clock, so a header a
 * user sends can never change which records the server accepts as "not in the
 * future".
 */
export function isTestClockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'test';
}

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
  if (!isTestClockEnabled(env)) return systemClock;

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
