import { FxProviderError, type FxProvider, type ProviderRateRow } from './provider';

/**
 * The Frankfurter provider (blueprint 10.1, D11).
 *
 * Frankfurter republishes the ECB's daily euro reference rates — the series
 * that has run since 1999 — plus the official rates of a few other central
 * banks, with no API key and a time-series endpoint that returns a whole range
 * in one request. That last property is what makes the first-use history
 * backfill a single call rather than thousands (10.4).
 *
 * The service is addressed as `api.frankfurter.dev`, whose current API is
 * mounted under `/v1`. The host is the version boundary; the path prefix is
 * configurable so a future move does not need a code change.
 *
 * **Rates are read as text, never as numbers.** `JSON.parse` would hand back a
 * float64, and `fx_rates.rate` is `NUMERIC(24,12)`; the reviver below keeps the
 * publisher's own digits so what is stored is what was published (7.1, R31).
 */

export interface FrankfurterOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Recorded in `fx_rates.source`; readers apply a source preference (10.4). */
  readonly source?: string;
  /**
   * Called once per row the provider published but this adapter refused
   * (10.5). The reason names the currency and date and never carries a rate,
   * so it is safe to log.
   */
  readonly onRejected?: (reason: string) => void;
}

export const FRANKFURTER_BASE_URL = 'https://api.frankfurter.dev/v1';

/** The first day of the ECB reference series (10.4). */
export const ECB_SERIES_START = '1999-01-04';

/**
 * A rate outside this range is a provider defect, not a currency (10.5:
 * "Provider returns a rate <= 0 or > 10^6 — row rejected, logged").
 */
export const MAX_PLAUSIBLE_RATE = 1_000_000;

const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/u;

/**
 * Parse a JSON body keeping every number as its literal source text.
 *
 * Node 22 exposes the raw token to the reviver. Where it is not available the
 * fallback is `String(value)`, which is exact for the short decimals a
 * reference rate actually carries — but the literal is preferred, because
 * "exact for the values we have seen" is not the same as exact.
 */
function parseKeepingLiterals(text: string): unknown {
  return JSON.parse(text, function reviver(this: unknown, _key: string, value: unknown, context?: { source?: string }) {
    if (typeof value !== 'number') return value;
    return context?.source ?? String(value);
  }) as unknown;
}

interface RatesResponse {
  readonly base?: string;
  readonly date?: string;
  readonly rates?: Record<string, unknown>;
}

interface TimeSeriesResponse {
  readonly rates?: Record<string, Record<string, unknown>>;
}

export function createFrankfurterProvider(options: FrankfurterOptions = {}): FxProvider {
  const baseUrl = (options.baseUrl ?? FRANKFURTER_BASE_URL).replace(/\/+$/u, '');
  const doFetch = options.fetchImpl ?? fetch;
  const source = options.source ?? 'ecb';
  const timeoutMs = options.timeoutMs ?? 15_000;
  const reject = options.onRejected ?? ((): void => undefined);

  async function get(path: string): Promise<unknown> {
    const url = `${baseUrl}${path}`;
    let response: Response;
    try {
      response = await doFetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new FxProviderError('frankfurter', undefined, 'request failed');
    }
    if (!response.ok) throw new FxProviderError('frankfurter', response.status);
    return parseKeepingLiterals(await response.text());
  }

  /**
   * Turn one `{ CODE: rate }` map into rows, dropping anything that is not a
   * plausible rate. A rejected row is reported to the caller rather than
   * silently skipped, so a refresh can log what it refused (10.5).
   */
  function toRows(rates: Record<string, unknown> | undefined, rateDate: string): ProviderRateRow[] {
    if (rates === undefined) return [];
    const rows: ProviderRateRow[] = [];

    for (const [quote, raw] of Object.entries(rates)) {
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (!DECIMAL_PATTERN.test(text)) {
        reject(`${quote} ${rateDate}: not a decimal`);
        continue;
      }
      // Compared as text against bounds rather than parsed: a rate is only
      // implausible at a magnitude a comparison on digits settles just as well.
      if (text === '0' || /^0(?:\.0+)?$/u.test(text)) {
        reject(`${quote} ${rateDate}: not positive`);
        continue;
      }
      const integerDigits = (text.split('.')[0] ?? '').replace(/^0+/u, '').length;
      if (integerDigits > String(MAX_PLAUSIBLE_RATE).length - 1) {
        reject(`${quote} ${rateDate}: above ${String(MAX_PLAUSIBLE_RATE)}`);
        continue;
      }
      rows.push({ quote: quote.toUpperCase(), rateDate, rate: text, source });
    }

    return rows;
  }

  return {
    id: 'frankfurter',

    async supportedCurrencies(): Promise<string[]> {
      const body = (await get('/currencies')) as Record<string, unknown>;
      return Object.keys(body)
        .map((code) => code.toUpperCase())
        .sort();
    },

    async fetchLatest(base, quotes): Promise<ProviderRateRow[]> {
      if (quotes.length === 0) return [];
      const symbols = encodeURIComponent([...quotes].sort().join(','));
      const body = (await get(`/latest?base=${base}&symbols=${symbols}`)) as RatesResponse;
      if (body.date === undefined) throw new FxProviderError('frankfurter', undefined, 'no date');

      return toRows(body.rates, body.date);
    },

    async fetchTimeSeries(base, quotes, from, to): Promise<ProviderRateRow[]> {
      if (quotes.length === 0) return [];
      const symbols = encodeURIComponent([...quotes].sort().join(','));
      const body = (await get(`/${from}..${to}?base=${base}&symbols=${symbols}`)) as TimeSeriesResponse;

      const rows: ProviderRateRow[] = [];
      for (const [rateDate, rates] of Object.entries(body.rates ?? {})) {
        rows.push(...toRows(rates, rateDate));
      }
      return rows;
    },
  };
}
