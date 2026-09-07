import { Decimal } from '../decimal';
import {
  addDays,
  addMonths,
  compareDates,
  daysBetween,
  endOfMonthKey,
  monthKey,
  startOfMonthKey,
  type MonthKey,
  type PlainDate,
} from '../dates/plain-date';
import { currencyCode, type CurrencyCode } from '../money/types';
import { unavailable, type Unavailable } from '../unavailable';
import {
  MAX_LOOKBACK_DAYS,
  MIN_CURRENT_MONTH_SAMPLES,
  PIVOT_CURRENCY,
  type FxRateRecord,
  type FxTable,
  type RateLookup,
} from './types';

/**
 * `createFxTable` (blueprint 10.1, 10.2) — the in-memory view of `fx_rates`
 * for one request.
 *
 * Pure: rows in, lookups out. It never fabricates a rate. Every question it
 * cannot answer from stored data comes back as `Unavailable('fx_missing')`,
 * which the aggregation layer turns into a partial total rather than a zero
 * (7.6, 10.5).
 */

export interface FxTableOptions {
  /**
   * Today in the user's timezone. Only used to decide whether a month is the
   * current one, which changes how thin a monthly average may be (10.2).
   * Engines never read a clock themselves (7.7).
   */
  readonly today: PlainDate;
  /**
   * Source preference, most preferred first. When two publishers carry the same
   * date, the first match wins; an unlisted source ranks last (10.4).
   */
  readonly sourcePreference?: readonly string[];
}

/** `1 EUR = 1 EUR`, on any date, exactly. */
function pivotIdentity(date: PlainDate): RateLookup {
  return { rate: new Decimal(1), rateDate: date, source: 'identity', exact: true };
}

const missing = (detail: string): Unavailable => unavailable('fx_missing', detail);

export function createFxTable(rows: readonly FxRateRecord[], options: FxTableOptions): FxTable {
  const preference = options.sourcePreference ?? [];
  const rank = (source: string): number => {
    const index = preference.indexOf(source);
    return index === -1 ? preference.length : index;
  };

  // quote -> date-ascending rows, one per date (the preferred source wins).
  const byQuote = new Map<CurrencyCode, FxRateRecord[]>();
  const bestPerDate = new Map<string, FxRateRecord>();

  for (const row of rows) {
    const key = `${row.quote} ${row.rateDate}`;
    const held = bestPerDate.get(key);
    if (held === undefined || rank(row.source) < rank(held.source)) bestPerDate.set(key, row);
  }
  for (const row of bestPerDate.values()) {
    const list = byQuote.get(row.quote);
    if (list === undefined) byQuote.set(row.quote, [row]);
    else list.push(row);
  }
  for (const list of byQuote.values()) list.sort((a, b) => compareDates(a.rateDate, b.rateDate));

  /** The latest row with `rateDate` on or before `date`, by binary search. */
  function latestOnOrBefore(
    list: readonly FxRateRecord[],
    date: PlainDate,
  ): FxRateRecord | undefined {
    let low = 0;
    let high = list.length - 1;
    let found: FxRateRecord | undefined;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const row = list[mid] as FxRateRecord;
      if (row.rateDate <= date) {
        found = row;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  }

  function rateOn(quote: CurrencyCode | string, date: PlainDate): RateLookup | Unavailable {
    const code = currencyCode(quote);
    if (code === PIVOT_CURRENCY) return pivotIdentity(date);

    const list = byQuote.get(code);
    if (list === undefined || list.length === 0) return missing(`no stored rates for ${code}`);

    const row = latestOnOrBefore(list, date);
    if (row === undefined) return missing(`no rate for ${code} on or before ${date}`);

    // The ten-day rule is a hard cutoff: past it the rate is no longer evidence
    // about the requested date (10.2, 10.5).
    if (daysBetween(row.rateDate, date) > MAX_LOOKBACK_DAYS) {
      return missing(
        `nearest rate for ${code} is ${row.rateDate}, more than ${String(MAX_LOOKBACK_DAYS)} days before ${date}`,
      );
    }

    return {
      rate: row.rate,
      rateDate: row.rateDate,
      source: row.source,
      exact: row.rateDate === date,
    };
  }

  function samplesIn(code: CurrencyCode, month: MonthKey): FxRateRecord[] {
    const list = byQuote.get(code);
    if (list === undefined) return [];
    const from = startOfMonthKey(month);
    const to = endOfMonthKey(month);
    return list.filter((row) => row.rateDate >= from && row.rateDate <= to);
  }

  function monthlyAverage(quote: CurrencyCode | string, month: MonthKey): RateLookup | Unavailable {
    const code = currencyCode(quote);
    const monthEnd = endOfMonthKey(month);
    if (code === PIVOT_CURRENCY) return pivotIdentity(monthEnd);

    const samples = samplesIn(code, month);
    const isCurrentMonth = monthKey(options.today) === month;
    const enough =
      samples.length > 0 && (!isCurrentMonth || samples.length >= MIN_CURRENT_MONTH_SAMPLES);

    if (!enough) {
      // Too thin to be an average. Fall back to the dated rate and say so,
      // rather than averaging three days and calling it a month.
      const fallbackDate = isCurrentMonth ? options.today : monthEnd;
      const dated = rateOn(code, fallbackDate);
      if ('kind' in dated) return dated;
      return { ...dated, approximate: true, sampleCount: samples.length };
    }

    let total = new Decimal(0);
    for (const row of samples) total = total.plus(row.rate);

    const sources = [...new Set(samples.map((row) => row.source))].sort();
    return {
      rate: total.dividedBy(samples.length),
      // An average belongs to the month, not to a day; the month's last day is
      // how it is dated everywhere it is displayed or combined.
      rateDate: monthEnd,
      source: sources.join('+'),
      exact: false,
      approximate: false,
      sampleCount: samples.length,
    };
  }

  /**
   * A span's rate is the day-weighted mean of its months' averages (10.2), so a
   * 31-day month counts for more than a 28-day one. A month with no usable
   * average makes the whole span unavailable: an average over a hole is not an
   * average of the span.
   */
  function spanAverage(
    quote: CurrencyCode | string,
    fromMonth: MonthKey,
    toMonth: MonthKey,
  ): RateLookup | Unavailable {
    const code = currencyCode(quote);
    if (fromMonth > toMonth) return missing('span ends before it starts');
    if (code === PIVOT_CURRENCY) return pivotIdentity(endOfMonthKey(toMonth));

    let weighted = new Decimal(0);
    let days = 0;
    const sources = new Set<string>();
    let samples = 0;
    let anyApproximate = false;

    for (
      let month = fromMonth;
      month <= toMonth;
      month = monthKey(addMonths(startOfMonthKey(month), 1))
    ) {
      const average = monthlyAverage(code, month);
      if ('kind' in average) return average;

      const monthDays = daysBetween(startOfMonthKey(month), addDays(endOfMonthKey(month), 1));
      weighted = weighted.plus(average.rate.times(monthDays));
      days += monthDays;
      samples += average.sampleCount ?? 0;
      anyApproximate ||= average.approximate === true;
      for (const source of average.source.split('+')) sources.add(source);
    }

    return {
      rate: weighted.dividedBy(days),
      rateDate: endOfMonthKey(toMonth),
      source: [...sources].sort().join('+'),
      exact: false,
      approximate: anyApproximate,
      sampleCount: samples,
    };
  }

  return { rateOn, monthlyAverage, spanAverage };
}

/** An empty table: every lookup is unavailable. Used before any refresh has run. */
export function emptyFxTable(today: PlainDate): FxTable {
  return createFxTable([], { today });
}
