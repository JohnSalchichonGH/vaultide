import { timingSafeEqual } from 'node:crypto';
import { getServices, isDomainError } from '@vaultide/application';

/**
 * The daily FX refresh (blueprint 4.2, 10.4, R26, T11).
 *
 * Vercel calls this once a day, after the ECB fixing, with the bearer secret
 * from `vercel.json`. It maintains the **whole supported fiat set** from the
 * global `currencies` table and writes only to `fx_rates`.
 *
 * It runs with no user context at all: as `app_user` without
 * `app.current_user_id`, every RLS-protected table returns zero rows, so this
 * job provably cannot read across tenants — and never needs a role that could.
 * The integration suite asserts exactly that (fx.test.ts).
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// The refresh fetches a fortnight for about thirty currencies in one call.
export const maxDuration = 60;

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * Check in with the Sentry cron monitor (22.6: "Sentry ... cron monitors for FX
 * and backups"; alert after three consecutive failures, 10.5).
 *
 * The refresh runs on Vercel, not in a workflow, so the check-in has to come
 * from the route itself. Two rules, the same ones the backup job learned: a
 * monitoring problem must never fail a refresh that actually worked, and it
 * must never be silent either — a check-in that 404s on every run would report
 * a missed job while the job was fine.
 */
async function checkIn(status: 'in_progress' | 'ok' | 'error', logger: {
  warn: (fields: Record<string, unknown>, message: string) => void;
}): Promise<void> {
  const url = process.env['SENTRY_CRON_FX_URL'];
  if (url === undefined || url === '') return;

  try {
    // `body: ''` so the POST carries a Content-Length; Sentry answers 411
    // without one, which looks identical to an outage at a glance.
    const response = await fetch(`${url}?status=${status}`, {
      method: 'POST',
      body: '',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      logger.warn(
        { route: '/api/cron/fx-refresh', checkin_status: status, http_status: response.status },
        'cron_checkin_failed',
      );
    }
  } catch {
    logger.warn(
      { route: '/api/cron/fx-refresh', checkin_status: status },
      'cron_checkin_unreachable',
    );
  }
}

/**
 * Compare in constant time, so a wrong secret cannot be found byte by byte.
 * Lengths are compared first because `timingSafeEqual` throws on a mismatch;
 * the length of a secret is not itself a secret.
 */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorize(request: Request, expected: string | undefined): boolean {
  if (expected === undefined || expected === '') return false;

  const header = request.headers.get('authorization');
  if (header === null) return false;

  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return false;

  return secretMatches(rest.join(' ').trim(), expected);
}

export async function GET(request: Request): Promise<Response> {
  const services = getServices();
  const startedAt = Date.now();

  if (!authorize(request, process.env['CRON_SECRET'])) {
    // Nothing about why: an unauthorized caller learns only that it was refused.
    return new Response('Not found', { status: 404, headers: NO_STORE });
  }

  await checkIn('in_progress', services.logger);

  try {
    const result = await services.fx.refreshAll();

    services.logger.info(
      {
        route: '/api/cron/fx-refresh',
        duration_ms: Date.now() - startedAt,
        currencies: result.currencies,
        rows_inserted: result.rowsInserted,
      },
      'cron_completed',
    );
    await checkIn('ok', services.logger);

    return Response.json(
      {
        status: 'ok',
        currencies: result.currencies,
        rowsFetched: result.rowsFetched,
        rowsInserted: result.rowsInserted,
        from: result.from,
        to: result.to,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    // 10.5: a provider outage is logged and retried tomorrow. Nothing is
    // fabricated, nothing already stored is touched, and conversions simply
    // report `Unavailable` until rates arrive.
    services.logger.error(
      {
        route: '/api/cron/fx-refresh',
        duration_ms: Date.now() - startedAt,
        error_code: isDomainError(error) ? error.code : 'FX_PROVIDER_FAILURE',
      },
      'cron_failed',
    );
    await checkIn('error', services.logger);

    // A non-2xx as well, so the failure is visible to whatever is watching the
    // endpoint even if the monitor itself is misconfigured (18.2, 22.6).
    return Response.json(
      { status: 'failed', error: 'FX_PROVIDER_FAILURE' },
      { status: 503, headers: NO_STORE },
    );
  }
}
