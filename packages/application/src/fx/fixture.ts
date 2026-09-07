import { currencySeed } from '@vaultide/db';
import { FRANKFURTER_PROVIDER_CHAIN } from './frankfurter';
import type { FxProvider, ProviderRateRow } from './provider';

/**
 * A deterministic FX provider for the end-to-end environment (blueprint 21.5).
 *
 * ## Why this exists
 *
 * The browser matrix runs three projects in parallel, and every one of them
 * signs up an account and picks a reporting currency. Against the live
 * Frankfurter service that is several concurrent long-range requests to a free
 * public API, which stalls under exactly that pattern — measured: six
 * concurrent 27-year requests took nine seconds each or timed out, while the
 * same request alone takes tens of milliseconds. The suite then failed for a
 * reason that has nothing to do with Vaultide.
 *
 * So the ordinary matrix runs against this instead: no network, no clock
 * outside the dates it is asked for, and the same answer on every run. What
 * the suite asserts — onboarding, currency selection, persistence, conversion
 * semantics, unavailability — is unchanged; only the publisher is substituted,
 * at the same IO boundary the integration suite already substitutes it at
 * (10.1). Adapter compatibility with the real service is proven separately and
 * serially, by `pnpm test:live`.
 *
 * ## What it models
 *
 * The real chain's shape, so nothing downstream can tell the difference in
 * kind: one row per bank per currency-date, the ECB publishing the euro-area
 * reference set and Banca d'Italia everything, EUR never quoted against
 * itself, weekends absent, and rates as exact 12-decimal strings so the
 * `NUMERIC(24,12)` path and the "no float" rule are exercised for real.
 *
 * It is **not** a fake of the rates themselves: the numbers are synthetic and
 * are never presented as anybody's reference rates. Nothing outside a test
 * build can reach it — `createServices` only builds it where the test
 * capabilities are enabled, which is refused outright on a production
 * deployment (21.5, 22.1).
 */

/** The euro-area reference set, so two banks disagree exactly where they do. */
const ECB_SET: readonly string[] = [
  'AUD',
  'BRL',
  'CAD',
  'CHF',
  'CNY',
  'CZK',
  'DKK',
  'GBP',
  'HKD',
  'HUF',
  'IDR',
  'ILS',
  'INR',
  'ISK',
  'JPY',
  'KRW',
  'MXN',
  'MYR',
  'NOK',
  'NZD',
  'PHP',
  'PLN',
  'RON',
  'SEK',
  'SGD',
  'THB',
  'TRY',
  'USD',
  'ZAR',
];

const PIVOT = 'EUR';

/** The chain, lower-cased the way the adapter writes it into `fx_rates`. */
const CHAIN = FRANKFURTER_PROVIDER_CHAIN.map((key) => key.toLowerCase());

function isWeekend(iso: string): boolean {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

function* eachDay(from: string, to: string): Generator<string> {
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    yield cursor.toISOString().slice(0, 10);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

/**
 * A stable rate that varies a little by day and by bank.
 *
 * Twelve decimals on purpose: a float64 cannot carry them, so anything that
 * parsed this as a number instead of keeping the string would show up as a
 * changed value in the database rather than passing quietly (7.1, R31).
 */
function syntheticRate(quote: string, date: string, source: string): string {
  const seed = [...quote].reduce((total, character) => total + character.charCodeAt(0), 0);
  const bank = [...source].reduce((total, character) => total + character.charCodeAt(0), 0);
  const dayOfMonth = Number.parseInt(date.slice(8, 10), 10);
  const whole = 1 + (seed % 9);
  const fraction = String(100_000 + ((seed * 31 + dayOfMonth * 7 + bank) % 899_999)).padStart(6, '0');
  // Six generated digits plus six zeros: exact, reproducible, and wider than a
  // float can round-trip.
  return `${String(whole)}.${fraction}000000`;
}

function banksFor(quote: string): string[] {
  return CHAIN.filter((source) => source !== 'ecb' || ECB_SET.includes(quote));
}

export interface FixtureFxProviderOptions {
  /**
   * The currencies the fixture "publishes". Defaults to the committed seed's
   * FX-supported set, so the reconciliation means the same thing here as it
   * does against the real chain.
   */
  readonly supportedCurrencies?: readonly string[];
  /** Injected so a fixture run is reproducible (7.7: no engine reads a clock). */
  readonly now?: () => Date;
}

export function createFixtureFxProvider(options: FixtureFxProviderOptions = {}): FxProvider {
  const supported =
    options.supportedCurrencies ??
    currencySeed.filter((row) => row.isFxSupported).map((row) => row.code);
  const supportedSet = new Set(supported);
  const now = options.now ?? ((): Date => new Date());

  function rowsFor(quotes: readonly string[], from: string, to: string): ProviderRateRow[] {
    const wanted = [...new Set(quotes.map((code) => code.toUpperCase()))].filter(
      (code) => code !== PIVOT && supportedSet.has(code),
    );

    const rows: ProviderRateRow[] = [];
    for (const rateDate of eachDay(from, to)) {
      // A central bank publishes on business days; the gap is what makes the
      // latest-on-or-before rule real rather than decorative (10.2).
      if (isWeekend(rateDate)) continue;
      for (const quote of wanted) {
        for (const source of banksFor(quote)) {
          rows.push({ quote, rateDate, rate: syntheticRate(quote, rateDate, source), source });
        }
      }
    }
    return rows;
  }

  return {
    id: 'fixture',

    supportedCurrencies(): Promise<string[]> {
      return Promise.resolve([...supportedSet].sort());
    },

    fetchLatest(_base, quotes): Promise<ProviderRateRow[]> {
      const today = now().toISOString().slice(0, 10);
      return Promise.resolve(rowsFor(quotes, today, today));
    },

    fetchTimeSeries(_base, quotes, from, to): Promise<ProviderRateRow[]> {
      return Promise.resolve(rowsFor(quotes, from, to));
    },
  };
}
