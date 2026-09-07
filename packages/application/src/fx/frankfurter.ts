import { FxProviderError, type FxProvider, type ProviderRateRow } from './provider';

/**
 * The Frankfurter **v2** provider (blueprint 10.1, D11).
 *
 * `https://api.frankfurter.dev` serves two versions: `/v1`, which the service
 * itself reports as `frozen` and keeps only for backward compatibility, and
 * `/v2`, reported as `current`. The blueprint specifies v2, and the difference
 * is not cosmetic — v1 exposes only the ECB's own reference set (30 currencies
 * today), while v2 models 84 central banks and 165 current currencies.
 *
 * ## Why this adapter asks for one provider at a time
 *
 * v2's `/rates` blends every provider that publishes a pair, filters outliers
 * by consensus, and overrides pegged currencies with the peg. That blended
 * number is a good default for a chart and the wrong thing to store here:
 * 10.1 requires that `source` record **which central bank published each
 * rate**, and a blend has no publisher. Storing it would leave every row
 * attributed to "Frankfurter", which is a redistributor, not a source.
 *
 * Asking for a single provider (`providers=ECB`) returns *that bank's own
 * published rate*, rebased to the requested base, with no blending and no peg
 * override — verified against the live API. So the adapter walks a short,
 * explicit chain of providers and makes one request per provider. Every stored
 * row therefore names a real central bank, and a currency two banks both
 * publish becomes two rows differing only in `source` — exactly the shape 10.4
 * describes ("an alternative rate is a new row with another `source`; readers
 * apply a source preference").
 *
 * ## The approved chain
 *
 * `ECB` first: the reference series 10.1 names, daily since 1999-01-04, and the
 * preferred source on read. `BDI` (Banca d'Italia) second: also EUR-pivoted,
 * also daily since 1999-01-04, and it publishes 151 currencies — a superset of
 * the ECB's — which is what carries the supported set beyond the euro area's
 * 30 without reaching for a bank whose own pivot is something else.
 *
 * These two are Vaultide's **policy** for Phase 1, not the extent of what v2
 * makes available. What this chain publishes is consequently narrower than
 * what Frankfurter publishes, and the difference is a choice about which
 * official sources this product converts money with — deliberately EUR-pivoted
 * and euro-system — rather than a gap in the API. Widening the chain is a
 * decision with a migration behind it, not an implementation detail.
 *
 * Two requests cover the whole approved set. Both are EUR-pivoted at the
 * source, so nothing is re-pivoted twice on the way in.
 *
 * They are issued **concurrently**, and the results are concatenated in chain
 * order. One bank per request means the chain would otherwise cost the sum of
 * its members' latencies, and `ensureHistory` runs inside a user's request:
 * a first-use backfill asks for a 27-year series, which on a cold upstream
 * cache is seconds rather than milliseconds. Concurrency bounds that by the
 * slowest bank instead of the sum. Order is preserved because it is the source
 * preference (10.2), not a race.
 *
 * ## Rates are read as text, never as numbers
 *
 * `JSON.parse` would hand back a float64, and `fx_rates.rate` is
 * `NUMERIC(24,12)`; the reviver below keeps the publisher's own digits so what
 * is stored is what was published (7.1, R31).
 */

/** The v2 base URL. `/v1` is frozen and is not used. */
export const FRANKFURTER_BASE_URL = 'https://api.frankfurter.dev/v2';

/**
 * Vaultide's **approved** provider chain for Phase 1, in preference order.
 * Also the order `fx_rates` readers apply, lower-cased (10.2, 10.4).
 *
 * "Approved" rather than "available": v2 carries 84 central banks, and this is
 * a deliberate two-bank policy, not the limit of what the API offers. What the
 * chain publishes is therefore narrower than what Frankfurter publishes, and
 * the two must not be conflated — see `supportedCurrencies()`.
 */
export const FRANKFURTER_PROVIDER_CHAIN = ['ECB', 'BDI'] as const;

/** The first day of the ECB reference series, and of Banca d'Italia's (10.4). */
export const ECB_SERIES_START = '1999-01-04';

/**
 * ISO 4217 codes that are not money.
 *
 * The precious metals and the IMF's Special Drawing Right have ISO codes and
 * v2 publishes rates for them, but nobody holds a bank account denominated in
 * gold or in SDR. Excluding them is the same judgement R28 and D35 make about
 * crypto: an asset class, priced in a currency, not a currency.
 */
export const NON_MONETARY_ISO_CODES: readonly string[] = ['XAU', 'XAG', 'XPT', 'XPD', 'XDR'];

/**
 * A rate outside this range is a provider defect, not a currency (10.5:
 * "Provider returns a rate <= 0 or > 10^6 — row rejected, logged").
 */
export const MAX_PLAUSIBLE_RATE = 1_000_000;

const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/u;

export interface FrankfurterOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /**
   * Providers to draw from, in preference order. Each is queried separately so
   * every row keeps its own attribution; a multi-provider request would return
   * a blend with no publisher.
   */
  readonly providers?: readonly string[];
  /**
   * Called once per row the provider published but this adapter refused
   * (10.5). The reason names the currency and date and never carries a rate,
   * so it is safe to log.
   */
  readonly onRejected?: (reason: string) => void;
}

/**
 * Parse a JSON body keeping every number as its literal source text.
 *
 * Node 22 exposes the raw token to the reviver. Where it is not available the
 * fallback is `String(value)`, which is exact for the short decimals a
 * reference rate actually carries — but the literal is preferred, because
 * "exact for the values we have seen" is not the same as exact.
 */
function parseKeepingLiterals(text: string): unknown {
  return JSON.parse(
    text,
    function reviver(this: unknown, _key: string, value: unknown, context?: { source?: string }) {
      if (typeof value !== 'number') return value;
      return context?.source ?? String(value);
    },
  ) as unknown;
}

/** One row of `GET /v2/rates`, with `rate` kept as its literal text. */
interface RateRow {
  readonly date?: string;
  readonly base?: string;
  readonly quote?: string;
  readonly rate?: unknown;
}

/** One entry of `GET /v2/currencies`. */
interface CurrencyRow {
  readonly iso_code?: string;
  /** Empty for a local issue with an unofficial abbreviation (GGP, CNH, …). */
  readonly iso_numeric?: string | null;
  readonly name?: string;
}

export function createFrankfurterProvider(options: FrankfurterOptions = {}): FxProvider {
  const baseUrl = (options.baseUrl ?? FRANKFURTER_BASE_URL).replace(/\/+$/u, '');
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const reject = options.onRejected ?? ((): void => undefined);
  const chain = options.providers ?? FRANKFURTER_PROVIDER_CHAIN;
  const notMoney = new Set(NON_MONETARY_ISO_CODES);

  async function get(path: string, keepLiterals: boolean): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new FxProviderError('frankfurter', undefined, 'request failed');
    }
    if (!response.ok) throw new FxProviderError('frankfurter', response.status);

    const text = await response.text();
    return keepLiterals ? parseKeepingLiterals(text) : (JSON.parse(text) as unknown);
  }

  /** `?quotes=` for a request, or `''` to take everything the provider has. */
  function quotesParam(quotes: readonly string[]): string {
    const wanted = [...new Set(quotes.map((code) => code.trim().toUpperCase()))]
      .filter((code) => code !== 'EUR')
      .sort();
    return wanted.length === 0 ? '' : `&quotes=${encodeURIComponent(wanted.join(','))}`;
  }

  /**
   * Turn one provider's rows into storable rows, refusing anything that is not
   * a plausible rate. A refusal is reported to the caller rather than silently
   * skipped, so a refresh can log what it would not store (10.5).
   */
  function toRows(rows: readonly RateRow[], providerKey: string): ProviderRateRow[] {
    const source = providerKey.toLowerCase();
    const out: ProviderRateRow[] = [];

    for (const row of rows) {
      const quote = row.quote?.toUpperCase();
      const rateDate = row.date;
      if (quote === undefined || rateDate === undefined) {
        reject(`${source}: row without a quote or a date`);
        continue;
      }
      // The pivot is 1 by definition and is never stored (10.1).
      if (quote === 'EUR') continue;

      const text = typeof row.rate === 'string' ? row.rate.trim() : '';
      if (!DECIMAL_PATTERN.test(text)) {
        reject(`${quote} ${rateDate} (${source}): not a decimal`);
        continue;
      }
      // Compared as text against the bounds rather than parsed: a rate is only
      // implausible at a magnitude a comparison on digits settles just as well.
      if (/^0(?:\.0+)?$/u.test(text)) {
        reject(`${quote} ${rateDate} (${source}): not positive`);
        continue;
      }
      const integerDigits = (text.split('.')[0] ?? '').replace(/^0+/u, '').length;
      if (integerDigits > String(MAX_PLAUSIBLE_RATE).length - 1) {
        reject(`${quote} ${rateDate} (${source}): above ${String(MAX_PLAUSIBLE_RATE)}`);
        continue;
      }

      out.push({ quote, rateDate, rate: text, source });
    }

    return out;
  }

  return {
    id: 'frankfurter-v2',

    /**
     * The currencies **this approved chain** can convert automatically: those
     * the chain publishes right now, restricted to money.
     *
     * This is deliberately *not* "every currency Frankfurter v2 offers". v2
     * aggregates 84 central banks, and for several codes some other bank does
     * publish a current rate — CBR for RUB and NBRB for BYN, among others —
     * while the ECB's and Banca d'Italia's own series for them have ended (RUB
     * and BYN in early 2022, ANG, IRR and KPW during 2025, MRO in 2017). Those
     * banks are outside Vaultide's Phase 1 policy, so their rates are not
     * fetched, not stored, and not offered: a currency this chain has no
     * current rate for cannot be a base or reporting currency, because there
     * would be nothing *we* could honestly convert it with (10.5).
     *
     * "Publishes right now" rather than "lists as covered" is the other half:
     * a provider's own metadata still lists series that have stopped.
     * `/rates` without a date range returns the latest row per quote, so this
     * is one request per approved provider and needs no clock.
     */
    async supportedCurrencies(): Promise<string[]> {
      const catalogue = (await get('/currencies', false)) as CurrencyRow[];

      // A non-empty ISO numeric code is what separates a currency from a local
      // issue with an unofficial three-letter abbreviation: Frankfurter lists
      // CNH, GGP, IMP and JEP, and none of them has one.
      const money = new Set(
        catalogue
          .filter(
            (row) =>
              row.iso_code !== undefined &&
              row.iso_numeric !== undefined &&
              row.iso_numeric !== null &&
              row.iso_numeric !== '' &&
              !notMoney.has(row.iso_code),
          )
          .map((row) => row.iso_code as string),
      );

      const perProvider = await Promise.all(
        chain.map(
          (providerKey) =>
            get(
              `/rates?base=EUR&providers=${encodeURIComponent(providerKey)}`,
              false,
            ) as Promise<RateRow[]>,
        ),
      );

      const published = new Set<string>();
      for (const rows of perProvider) {
        for (const row of rows) {
          const quote = row.quote?.toUpperCase();
          if (quote !== undefined && money.has(quote)) published.add(quote);
        }
      }

      // EUR is the pivot: always supported, never fetched.
      published.add('EUR');
      return [...published].sort();
    },

    async fetchLatest(base, quotes): Promise<ProviderRateRow[]> {
      const quotesQuery = quotesParam(quotes);

      const perProvider = await Promise.all(
        chain.map(async (providerKey) => {
          const body = (await get(
            `/rates?base=${base}&providers=${encodeURIComponent(providerKey)}${quotesQuery}`,
            true,
          )) as RateRow[];
          return toRows(body, providerKey);
        }),
      );

      return perProvider.flat();
    },

    async fetchTimeSeries(base, quotes, from, to): Promise<ProviderRateRow[]> {
      const quotesQuery = quotesParam(quotes);

      const perProvider = await Promise.all(
        chain.map(async (providerKey) => {
          const body = (await get(
            `/rates?base=${base}&from=${from}&to=${to}` +
              `&providers=${encodeURIComponent(providerKey)}${quotesQuery}`,
            true,
          )) as RateRow[];
          return toRows(body, providerKey);
        }),
      );

      return perProvider.flat();
    },
  };
}
