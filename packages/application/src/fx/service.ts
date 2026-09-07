import {
  appendFxRates,
  earliestRateDate,
  latestRateDateByQuote,
  selectFxRates,
  type Database,
  type FxRateInput,
} from '@vaultide/db';
import {
  addDays,
  createFxTable,
  currencyCode,
  Decimal,
  plainDate,
  type FxRateRecord,
  type FxTable,
  type PlainDate,
} from '@vaultide/finance';
import { supportedFxCurrencyCodes } from '../currencies/service';
import type { Logger } from '../logging';
import { ECB_SERIES_START, FRANKFURTER_PROVIDER_CHAIN } from './frankfurter';
import { FxProviderError, type FxProvider, type ProviderRateRow } from './provider';

/**
 * `FxService` (blueprint 10.1, 10.4, R26, T11).
 *
 * Three responsibilities, all of them on **global** tables only:
 *
 *  - `refreshAll()` — the daily cron. It maintains the whole supported fiat set
 *    from `currencies`, never from anything a user owns. It does not know that
 *    users exist, has no user context, and could not read one if it tried: it
 *    runs as `app_user` with no `app.current_user_id`, so every RLS-protected
 *    table returns zero rows (17.4). That is the mechanical answer to T11 — "a
 *    job that discovers currencies by reading every user's positions needs a
 *    role that can see all tenants' data" — and the reason it never needs one.
 *  - `ensureHistory()` — the first time anybody uses a currency, fetch its
 *    history once. Rates are global, so every later user benefits.
 *  - `loadTable()` — read the rows one request needs into a pure `FxTable`.
 *
 * `fx_rates` rows are immutable (6.2). Every write is `ON CONFLICT DO NOTHING`
 * on `(base, quote, rate_date, source)`, so a repeated refresh is a no-op and a
 * later fetch can never silently rewrite history.
 */

/** The stored pivot: every row is `EUR -> quote` (10.1). */
export const PIVOT = 'EUR' as const;

/** 10.4: the cron also backfills any business day missed in the last fortnight. */
export const REFRESH_BACKFILL_DAYS = 14;

/** 10.4: history reaches a month before a user's earliest financial date. */
export const HISTORY_LEAD_DAYS = 31;

/**
 * What "first use" fetches when nothing dated has been asked for yet (10.4).
 *
 * Choosing a base, reporting or favourite currency makes it convertible
 * *now*; it does not, by itself, ask for any historical figure. So that path
 * fetches the same recent window the cron maintains and no more. The full
 * series is fetched the first time a dated conversion actually needs it —
 * see `ensureHistory`.
 */
export const CURRENT_WINDOW_DAYS = REFRESH_BACKFILL_DAYS;

/**
 * How long warming that window may take before the request gives up (10.5).
 *
 * This path runs inside a settings save. The user has picked a reporting
 * currency; they have not asked to convert anything, and they must not wait on
 * a free public service that has stalled — which it does, and which is why the
 * provider's own default is far longer. Measured against the live chain, the
 * whole fetch is around 300 ms cold, so three seconds is roughly ten times the
 * real cost and still bounded from a person's point of view.
 *
 * Giving up costs nothing that is not repaired: no row is written, no rate is
 * invented, conversions stay `Unavailable`, and the daily cron — or the next
 * request that needs the currency — fills the window in.
 *
 * The historical path keeps the provider's default: rates a user has actually
 * asked to convert are worth waiting for.
 */
export const CURRENT_WINDOW_TIMEOUT_MS = 3_000;

/**
 * The order readers prefer publishers in (10.2, 10.4).
 *
 * Lower-cased keys of Vaultide's approved provider chain, matching what the
 * adapter writes into `fx_rates.source`. The ECB comes first because 10.1
 * names its reference series; where two banks both published a pair on the
 * same day, both rows are stored and this decides which one a conversion uses.
 */
export const SOURCE_PREFERENCE: readonly string[] = FRANKFURTER_PROVIDER_CHAIN.map((key) =>
  key.toLowerCase(),
);

export interface FxServiceDependencies {
  readonly db: Database;
  readonly provider: FxProvider;
  readonly logger?: Logger;
  /** Injected so a refresh is reproducible in tests (7.7: no engine reads a clock). */
  readonly now?: () => Date;
}

export interface RefreshResult {
  /** How many currencies the supported set contains, EUR excluded. */
  readonly currencies: number;
  readonly rowsFetched: number;
  readonly rowsInserted: number;
  readonly from: string;
  readonly to: string;
}

export interface EnsureHistoryResult {
  readonly currency: string;
  readonly rowsInserted: number;
  /** `true` when nothing was fetched: covered already, or the provider failed. */
  readonly skipped: boolean;
  /** The first date the fetch asked for, or `undefined` when none was made. */
  readonly from?: string;
}

export interface SupportedCurrencyReconciliation {
  readonly provider: string[];
  readonly seeded: string[];
  /** Flagged FX-supported here, but the approved chain does not publish it. */
  readonly missingFromProvider: string[];
  /** Published by the approved chain, but not flagged FX-supported here. */
  readonly missingFromSeed: string[];
  readonly inSync: boolean;
}

export interface FxService {
  refreshAll(): Promise<RefreshResult>;
  /**
   * Make `currency` convertible for what is actually needed (10.4).
   *
   * `earliestNeededDate` is the earliest **financial date** a conversion has
   * to cover. Given one, the series is fetched from a month before it, which
   * is the lookback 10.4 requires. Omitted, there is no dated need yet — the
   * currency has just been chosen as a preference — and only the recent window
   * is fetched.
   */
  ensureHistory(currency: string, earliestNeededDate?: string): Promise<EnsureHistoryResult>;
  loadTable(
    quotes: readonly string[],
    from: string,
    to: string,
    today: PlainDate,
  ): Promise<FxTable>;
  reconcileSupportedCurrencies(): Promise<SupportedCurrencyReconciliation>;
  latestRateDates(): Promise<Record<string, string>>;
}

/**
 * The cron has no user and therefore no timezone. UTC is the only defensible
 * "today" for a job, and the ECB publishes on a UTC-anchored schedule anyway.
 */
function todayUtc(now: () => Date): PlainDate {
  return plainDate(now().toISOString().slice(0, 10));
}

/** ISO dates compare correctly as text, so the later one is the larger one. */
function latestOf(left: string, right: string): string {
  return left >= right ? left : right;
}

export function createFxService(deps: FxServiceDependencies): FxService {
  const { db, provider } = deps;
  const now = deps.now ?? ((): Date => new Date());

  /**
   * Backfills running in this process right now, by currency and range.
   *
   * Coalescing, not caching: an entry lives only while its fetch is in flight,
   * so nothing is ever answered from a stale result and the next call after it
   * settles reads the database as usual.
   */
  const inFlight = new Map<string, Promise<EnsureHistoryResult>>();

  /**
   * Provider rows to storable rows.
   *
   * A rate for a currency the catalogue does not carry would violate the
   * foreign key; dropping it here turns a provider surprise into a skipped row
   * rather than a failed transaction that loses the whole batch. `EUR -> EUR`
   * is dropped too: it is 1 by definition and is never stored (10.1).
   */
  function toInserts(
    rows: readonly ProviderRateRow[],
    supported: ReadonlySet<string>,
    fetchedAt: Date,
  ): FxRateInput[] {
    const inserts: FxRateInput[] = [];
    for (const row of rows) {
      const quote = row.quote.toUpperCase();
      if (quote === PIVOT || !supported.has(quote)) continue;
      inserts.push({
        base: PIVOT,
        quote,
        rateDate: row.rateDate,
        rate: row.rate,
        source: row.source,
        fetchedAt,
      });
    }
    return inserts;
  }

  return {
    /**
     * The daily cron (10.4). One time-series call covering the last fortnight
     * for the entire supported set: it delivers the latest fixing and fills any
     * business day a previous run missed, in the same request.
     */
    async refreshAll(): Promise<RefreshResult> {
      const supportedCodes = await supportedFxCurrencyCodes(db);
      const supported = new Set(supportedCodes);
      const quotes = supportedCodes.filter((code) => code !== PIVOT);

      const to = todayUtc(now);
      const from = addDays(to, -REFRESH_BACKFILL_DAYS);
      const fetchedAt = now();

      const rows = await provider.fetchTimeSeries(PIVOT, quotes, from, to);
      const rowsInserted = await appendFxRates(db, toInserts(rows, supported, fetchedAt));

      deps.logger?.info(
        {
          route: '/api/cron/fx-refresh',
          currencies: quotes.length,
          rows_fetched: rows.length,
          rows_inserted: rowsInserted,
        },
        'fx_refresh',
      );

      return { currencies: quotes.length, rowsFetched: rows.length, rowsInserted, from, to };
    },

    /**
     * Make a currency convertible for what is actually needed, once and
     * globally (10.4).
     *
     * ## How far back
     *
     * `earliestNeededDate` is the earliest financial date a conversion has to
     * cover. With one, the fetch starts a month earlier — 10.4's lookback —
     * and never before the first day of the reference series. Without one,
     * nothing dated has been asked for: the currency has merely been chosen as
     * a base, reporting or favourite currency, which needs it convertible
     * *now*, so only the recent window is fetched.
     *
     * 10.4 words the trigger as "on first use of a currency (a user creates a
     * position, sets a reporting currency or favorite in that currency)" and
     * gives `from` as "the user's earliest financial date - 31 days, or
     * 1999-01-04 when unknown". "Unknown" is the case where dated data exists
     * and its start cannot be determined — not the case where there is no
     * dated data at all, which is every currency preference in Phase 1. Read
     * the other way it would spend a 27-year request per bank on a settings
     * save with nothing to convert, and make the user wait for it; the first
     * dated conversion fetches exactly the same rows, at the point they are
     * first worth anything. See ADR 0002 decision 17.
     *
     * ## Failure
     *
     * Swallowed by design — this runs inside a user's request, and a rate
     * publisher being down must not stop somebody changing their reporting
     * currency. Conversions are simply `Unavailable` until the next cron fills
     * the gap (10.5). Nothing is fabricated and nothing already stored is
     * touched.
     */
    async ensureHistory(
      currency: string,
      earliestNeededDate?: string,
    ): Promise<EnsureHistoryResult> {
      const quote = currency.trim().toUpperCase();
      if (quote === PIVOT) return { currency: quote, rowsInserted: 0, skipped: true };

      const supported = new Set(await supportedFxCurrencyCodes(db));
      if (!supported.has(quote)) return { currency: quote, rowsInserted: 0, skipped: true };

      const to = todayUtc(now);
      const wantedFrom =
        earliestNeededDate === undefined
          ? addDays(to, -CURRENT_WINDOW_DAYS)
          : latestOf(addDays(plainDate(earliestNeededDate), -HISTORY_LEAD_DAYS), ECB_SERIES_START);

      // Already covered: the stored series starts at or before what was asked
      // for, and the daily cron keeps the recent end fresh. Nothing to do, and
      // no call to make on a free public provider.
      const earliest = await earliestRateDate(db, quote);
      if (earliest !== undefined && earliest <= wantedFrom) {
        return { currency: quote, rowsInserted: 0, skipped: true };
      }

      // One fetch per currency and range at a time. Three browsers finishing
      // onboarding together, or one page issuing two conversions, would
      // otherwise ask a free public provider the same question at the same
      // moment — a stampede upstream answers by stalling all of them.
      const key = `${quote}|${wantedFrom}|${to}`;
      const running = inFlight.get(key);
      if (running !== undefined) return running;

      const run = async (): Promise<EnsureHistoryResult> => {
        try {
          const rows = await provider.fetchTimeSeries(
            PIVOT,
            [quote],
            wantedFrom,
            to,
            // Only the preference path is bounded; a dated need keeps the
            // provider's own timeout.
            earliestNeededDate === undefined ? { timeoutMs: CURRENT_WINDOW_TIMEOUT_MS } : {},
          );
          const rowsInserted = await appendFxRates(db, toInserts(rows, supported, now()));
          deps.logger?.info(
            {
              action: 'fx.ensureHistory',
              currency: quote,
              from: wantedFrom,
              rows_inserted: rowsInserted,
            },
            'fx_history_backfilled',
          );
          return { currency: quote, rowsInserted, skipped: false, from: wantedFrom };
        } catch (error) {
          const status = error instanceof FxProviderError ? error.status : undefined;
          deps.logger?.warn(
            {
              action: 'fx.ensureHistory',
              currency: quote,
              from: wantedFrom,
              error_code: 'FX_PROVIDER_FAILURE',
              provider_status: status ?? 'unreachable',
            },
            'fx_history_backfill_failed',
          );
          return { currency: quote, rowsInserted: 0, skipped: true, from: wantedFrom };
        }
      };

      // `.finally` rather than a `finally` block inside: its callback always
      // runs in a later microtask, so the entry is registered before it can be
      // removed even when the provider settles without ever suspending — which
      // a stub does, and which would otherwise leave a finished result in the
      // map for every later caller to receive.
      const attempt = run().finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, attempt);
      return attempt;
    },

    /** Read the rows one request needs into the pure lookup table (10.1). */
    async loadTable(quotes, from, to, today): Promise<FxTable> {
      const wanted = [...new Set(quotes.map((code) => code.trim().toUpperCase()))].filter(
        (code) => code !== PIVOT,
      );
      if (wanted.length === 0) return createFxTable([], { today });

      const rows = await selectFxRates(db, wanted, from, to);

      const records: FxRateRecord[] = rows.map((row) => ({
        quote: currencyCode(row.quote),
        rateDate: plainDate(row.rateDate),
        // The column is NUMERIC, so the driver returns an exact decimal string
        // and no digit is lost on the way into the engine (7.1).
        rate: new Decimal(row.rate),
        source: row.source,
      }));

      return createFxTable(records, { today, sourcePreference: SOURCE_PREFERENCE });
    },

    /**
     * Compare the seeded `is_fx_supported` flags with what the **approved
     * chain** actually publishes (Phase 1: "reconcile the existing
     * `is_fx_supported` assumption against the provider-supported currency
     * set").
     *
     * `provider` here is the configured chain, so this measures the seed
     * against Vaultide's FX policy — not against every currency the upstream
     * aggregator can serve from banks the product does not draw from.
     *
     * It reports; it does not repair. A currency appearing in or leaving a
     * central bank's reference list is a decision about the product's
     * catalogue, with a migration behind it — not something a background job
     * should quietly do to the database.
     */
    async reconcileSupportedCurrencies(): Promise<SupportedCurrencyReconciliation> {
      const [providerCodes, seededCodes] = await Promise.all([
        provider.supportedCurrencies(),
        supportedFxCurrencyCodes(db),
      ]);

      const providerSet = new Set(providerCodes);
      const seededSet = new Set(seededCodes);
      const missingFromProvider = [...seededSet].filter((code) => !providerSet.has(code)).sort();
      const missingFromSeed = [...providerSet].filter((code) => !seededSet.has(code)).sort();

      return {
        provider: [...providerSet].sort(),
        seeded: [...seededSet].sort(),
        missingFromProvider,
        missingFromSeed,
        inSync: missingFromProvider.length === 0 && missingFromSeed.length === 0,
      };
    },

    async latestRateDates(): Promise<Record<string, string>> {
      return latestRateDateByQuote(db);
    },
  };
}
