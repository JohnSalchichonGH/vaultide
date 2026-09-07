import type { Decimal } from '../decimal';
import type { MonthKey, PlainDate } from '../dates/plain-date';
import type { CurrencyCode, Money } from '../money/types';
import type { Unavailable } from '../unavailable';

/**
 * FX types (blueprint 10.1–10.3).
 *
 * Everything here is pure data. Rates arrive already loaded from `fx_rates`;
 * this package never performs IO, never calls a provider and never reads a
 * clock — "today" is supplied when the table is built.
 */

/**
 * The stored pivot. Every row in `fx_rates` is `EUR → quote`, so a cross rate
 * `A → B` is `rate(EUR→B) / rate(EUR→A)` and `EUR → EUR` is exactly 1 (10.1).
 */
export const PIVOT_CURRENCY = 'EUR' as CurrencyCode;

/**
 * How far back a lookup may reach for a rate (10.2). Ten calendar days covers
 * weekends and the longest ECB holiday runs; beyond that the conversion is
 * `Unavailable` rather than a stale guess (10.5).
 */
export const MAX_LOOKBACK_DAYS = 10;

/**
 * Fewer daily rates than this in the **current** month and a monthly average
 * would be an average of the first few days rather than of the month, so the
 * lookup falls back to the dated rate and says so (10.2).
 */
export const MIN_CURRENT_MONTH_SAMPLES = 5;

/** One stored reference rate: `1 EUR = rate <quote>` on `rateDate`. */
export interface FxRateRecord {
  readonly quote: CurrencyCode;
  readonly rateDate: PlainDate;
  readonly rate: Decimal;
  readonly source: string;
}

/**
 * The outcome of a rate lookup.
 *
 *  - `exact` is `false` whenever the rate is not from the requested date — a
 *    Saturday conversion carries Friday's rate with `exact: false` (Phase 1
 *    acceptance);
 *  - `approximate` marks a monthly average that had to fall back to a dated
 *    rate, so a caller can label the figure rather than present it as an
 *    average it is not.
 */
export interface RateLookup {
  readonly rate: Decimal;
  readonly rateDate: PlainDate;
  readonly source: string;
  readonly exact: boolean;
  readonly approximate?: boolean;
  /** Daily rates the average was computed from; absent for dated lookups. */
  readonly sampleCount?: number;
}

export type ConversionMode = 'dated' | 'monthly_average' | 'span_average';

/** A converted amount, carrying the evidence for the number it produced. */
export interface Converted {
  readonly amount: Money;
  readonly rate: Decimal;
  readonly rateDate: PlainDate;
  readonly source: string;
  readonly exact: boolean;
  readonly approximate: boolean;
  readonly mode: ConversionMode;
}

/**
 * The read interface the engines take (10.1). Implemented by `createFxTable`
 * over rows loaded for one request; tests implement it directly.
 */
export interface FxTable {
  rateOn(quote: CurrencyCode | string, date: PlainDate): RateLookup | Unavailable;
  monthlyAverage(quote: CurrencyCode | string, month: MonthKey): RateLookup | Unavailable;
  spanAverage(
    quote: CurrencyCode | string,
    fromMonth: MonthKey,
    toMonth: MonthKey,
  ): RateLookup | Unavailable;
}
