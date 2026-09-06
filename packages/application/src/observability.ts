/**
 * Sentry event scrubbing (blueprint 18.2).
 *
 * Sentry runs in the EU region with `sendDefaultPii: false`. This module holds
 * the `beforeSend` implementation so the rule is testable and identical on the
 * server and in the browser: request bodies, query strings, extra context and
 * network breadcrumbs never leave the process, and expected domain errors are
 * not reported at all.
 */

export interface SentryEventLike {
  request?: {
    data?: unknown;
    query_string?: unknown;
    cookies?: unknown;
    headers?: Record<string, unknown>;
    url?: string;
  };
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  breadcrumbs?: { category?: string }[];
  exception?: { values?: { type?: string; value?: string }[] };
  user?: { id?: string | number; email?: string; ip_address?: string; [key: string]: unknown };
}

/** Domain outcomes that are normal application behaviour, not incidents (20.2). */
export const IGNORED_ERROR_CODES = [
  'VALIDATION_ERROR',
  'AUTH_REQUIRED',
  'NOT_FOUND',
  'CONFLICT_VERSION',
  'CONFLICT_DUPLICATE',
  'IMPOSSIBLE_OPERATION',
  'INCOMPLETE_DATA',
  'SCENARIO_INVALID',
  'RATE_LIMITED',
] as const;

const DROPPED_BREADCRUMBS = new Set(['fetch', 'xhr', 'console']);
const SENSITIVE_HEADERS = new Set(['cookie', 'authorization', 'x-vaultide-test-clock']);

/** Query strings are dropped wholesale; a URL keeps only its path. */
function stripUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

/**
 * Scrub an event in place and return it, or `null` to drop it entirely.
 * Generic over the concrete Sentry event types (ErrorEvent, TransactionEvent),
 * which is why the structural view is applied internally.
 */
export function scrubEvent<T extends object>(input: T): T | null {
  const event = input as SentryEventLike;
  const type = event.exception?.values?.[0]?.type ?? '';
  const value = event.exception?.values?.[0]?.value ?? '';
  if (IGNORED_ERROR_CODES.some((code) => type.includes(code) || value.includes(code))) {
    return null;
  }

  if (event.request) {
    delete event.request.data;
    delete event.request.query_string;
    delete event.request.cookies;
    const url = stripUrl(event.request.url);
    if (url === undefined) delete event.request.url;
    else event.request.url = url;

    if (event.request.headers) {
      for (const header of Object.keys(event.request.headers)) {
        if (SENSITIVE_HEADERS.has(header.toLowerCase())) delete event.request.headers[header];
      }
    }
  }

  delete event.extra;

  if (event.contexts) delete event.contexts['state'];

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.filter(
      (crumb) => !DROPPED_BREADCRUMBS.has(crumb.category ?? ''),
    );
  }

  // Identify the tenant, never the person (sendDefaultPii: false).
  if (event.user) {
    const id = event.user.id;
    event.user = id === undefined ? {} : { id };
  }

  return input;
}
