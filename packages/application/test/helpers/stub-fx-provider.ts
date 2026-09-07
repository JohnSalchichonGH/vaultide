import type { FxProvider, ProviderRateRow } from '../../src/fx/provider';
import { FxProviderError } from '../../src/fx/provider';

/**
 * A stub rate publisher (blueprint 21.3: "FX `refreshAll`/`ensureHistory` with
 * a stubbed provider — gap filling, failure tolerance, immutability").
 *
 * It generates a deterministic weekday series so a test can assert exactly
 * which dates should exist, and it can be told to fail, to skip days, or to
 * publish a nonsense rate — the three provider behaviours 10.5 describes.
 */

export interface StubFxProvider extends FxProvider {
  /** Every call the service made, for asserting that a fetch was skipped. */
  readonly calls: { method: string; quotes: string[]; from?: string; to?: string }[];
  /** Make the next calls throw, as an outage would. */
  failWith(error: Error | null): void;
  /** Dates the publisher has no rate for, e.g. a holiday it skipped. */
  skipDates(dates: readonly string[]): void;
  /** Publish an implausible rate for a currency, to prove it is refused. */
  poison(quote: string, rate: string): void;
  /** Override the currency list `supportedCurrencies()` reports. */
  setSupportedCurrencies(codes: readonly string[]): void;
  reset(): void;
}

/** Weekdays only, like a central bank's reference series. */
function isWeekend(iso: string): boolean {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/**
 * A stable, currency-specific rate that varies a little by date, so a monthly
 * average is not trivially equal to every daily rate and a test can tell them
 * apart.
 */
function syntheticRate(quote: string, date: string): string {
  const seed = [...quote].reduce((total, character) => total + character.charCodeAt(0), 0);
  const dayOfMonth = Number.parseInt(date.slice(8, 10), 10);
  const whole = 1 + (seed % 7);
  const fraction = String(100000 + ((seed * 31 + dayOfMonth * 7) % 899999)).padStart(6, '0');
  return `${String(whole)}.${fraction}`;
}

const DEFAULT_SUPPORTED = [
  'EUR',
  'USD',
  'GBP',
  'JPY',
  'CHF',
  'SEK',
  'NOK',
  'AUD',
  'CAD',
  'PLN',
];

export function createStubFxProvider(): StubFxProvider {
  const calls: { method: string; quotes: string[]; from?: string; to?: string }[] = [];
  let failure: Error | null = null;
  let skipped = new Set<string>();
  const poisoned = new Map<string, string>();
  let supported = [...DEFAULT_SUPPORTED];

  function rowsFor(quotes: readonly string[], from: string, to: string): ProviderRateRow[] {
    const rows: ProviderRateRow[] = [];
    for (const date of eachDay(from, to)) {
      if (isWeekend(date) || skipped.has(date)) continue;
      for (const quote of quotes) {
        if (quote === 'EUR') continue;
        rows.push({
          quote,
          rateDate: date,
          rate: poisoned.get(quote) ?? syntheticRate(quote, date),
          source: 'ecb',
        });
      }
    }
    return rows;
  }

  function guard(): void {
    if (failure !== null) throw failure;
  }

  return {
    id: 'stub',
    calls,

    failWith(error) {
      failure = error;
    },
    skipDates(dates) {
      skipped = new Set(dates);
    },
    poison(quote, rate) {
      poisoned.set(quote, rate);
    },
    setSupportedCurrencies(codes) {
      supported = [...codes];
    },
    reset() {
      calls.length = 0;
      failure = null;
      skipped = new Set();
      poisoned.clear();
      supported = [...DEFAULT_SUPPORTED];
    },

    supportedCurrencies(): Promise<string[]> {
      calls.push({ method: 'supportedCurrencies', quotes: [] });
      guard();
      return Promise.resolve([...supported].sort());
    },

    fetchLatest(_base, quotes): Promise<ProviderRateRow[]> {
      calls.push({ method: 'fetchLatest', quotes: [...quotes] });
      guard();
      const today = new Date().toISOString().slice(0, 10);
      return Promise.resolve(rowsFor(quotes, today, today));
    },

    fetchTimeSeries(_base, quotes, from, to): Promise<ProviderRateRow[]> {
      calls.push({ method: 'fetchTimeSeries', quotes: [...quotes], from, to });
      guard();
      return Promise.resolve(rowsFor(quotes, from, to));
    },
  };
}

export const providerOutage = (): FxProviderError => new FxProviderError('stub', 503);
