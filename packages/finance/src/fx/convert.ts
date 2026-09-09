import { Decimal } from '../decimal';
import { minDate, monthKey, type MonthKey, type PlainDate } from '../dates/plain-date';
import { money } from '../money/money';
import { currencyCode, type CurrencyCode, type Money } from '../money/types';
import { isUnavailable, type Unavailable } from '../unavailable';
import { PIVOT_CURRENCY, type Converted, type ConversionMode, type FxTable, type RateLookup } from './types';

/**
 * Conversion (blueprint 10.1, 10.3).
 *
 * Everything here derives from stored `EUR -> quote` rates. A rate that is not
 * stored is never invented: the result is `Unavailable`, which aggregations
 * turn into a partial total marked for the user (7.6, 10.5). There is no
 * "assume 1.0", no "carry the last value forever" and no zero.
 */

/** Both legs of a cross rate must be known; the result is only as fresh as the stalest. */
function combine(from: RateLookup, to: RateLookup): RateLookup {
  // `identity` is the EUR leg of a pivot conversion, not a publisher: reporting
  // "ecb/identity" would suggest two sources disagreed about something. Both
  // legs can never be the identity here — that means `from === to === EUR`,
  // which `crossRate` answers before it gets this far.
  const sources = [...new Set([from.source, to.source])]
    .filter((source) => source !== 'identity')
    .sort()
    .join('/');
  return {
    // A -> B = (EUR -> B) / (EUR -> A).
    rate: to.rate.dividedBy(from.rate),
    rateDate: minDate(from.rateDate, to.rateDate),
    source: sources,
    exact: from.exact && to.exact,
    ...(from.approximate === true || to.approximate === true ? { approximate: true } : {}),
  };
}

function lookup(
  table: FxTable,
  quote: CurrencyCode,
  on: PlainDate,
  mode: ConversionMode,
  span: { from: MonthKey; to: MonthKey } | undefined,
  through: PlainDate | undefined,
): RateLookup | Unavailable {
  switch (mode) {
    case 'dated':
      return table.rateOn(quote, on);
    case 'monthly_average':
      return through === undefined
        ? table.monthlyAverage(quote, monthKey(on))
        : table.monthlyAverage(quote, monthKey(on), through);
    case 'span_average':
      return table.spanAverage(
        quote,
        span?.from ?? monthKey(on),
        span?.to ?? monthKey(on),
      );
  }
}

/**
 * The rate that takes one unit of `from` to `to`, derived through the EUR pivot.
 *
 * `EUR -> EUR` is exactly 1 and `X -> X` is exactly 1 with no lookup at all, so
 * a single-currency user never depends on the FX cache being warm.
 */
export function crossRate(
  table: FxTable,
  from: CurrencyCode | string,
  to: CurrencyCode | string,
  on: PlainDate,
  options: {
    mode?: ConversionMode;
    span?: { from: MonthKey; to: MonthKey };
    through?: PlainDate;
  } = {},
): RateLookup | Unavailable {
  const source = currencyCode(from);
  const target = currencyCode(to);
  const mode = options.mode ?? 'dated';

  if (source === target) {
    return { rate: new Decimal(1), rateDate: on, source: 'identity', exact: true };
  }

  const fromLeg =
    source === PIVOT_CURRENCY
      ? ({ rate: new Decimal(1), rateDate: on, source: 'identity', exact: true } as RateLookup)
      : lookup(table, source, on, mode, options.span, options.through);
  if (isUnavailable(fromLeg)) return fromLeg;

  const toLeg =
    target === PIVOT_CURRENCY
      ? ({ rate: new Decimal(1), rateDate: on, source: 'identity', exact: true } as RateLookup)
      : lookup(table, target, on, mode, options.span, options.through);
  if (isUnavailable(toLeg)) return toLeg;

  return combine(fromLeg, toLeg);
}

export interface ConvertOptions {
  /** `dated` (10.3 default), `monthly_average` (undated residuals) or `span_average`. */
  readonly mode?: ConversionMode;
  /** The months a `span_average` covers; ignored in the other modes. */
  readonly span?: { from: MonthKey; to: MonthKey };
  /**
   * The last day a `monthly_average` may draw on — `D` for a month-to-date
   * figure (10.2, 30.16). Ignored in the other modes.
   */
  readonly through?: PlainDate;
}

/**
 * Convert `amount` into `to`, valued on `on`.
 *
 * The multiplication happens at full engine precision (40 significant digits);
 * rounding is a boundary concern and happens only at persistence or display
 * (7.3). The returned `Converted` carries the rate, its date, its publisher and
 * whether it was the rate of the requested day, so the UI can show
 * "Friday's rate" instead of silently pretending the weekend had one.
 */
export function convert(
  amount: Money,
  to: CurrencyCode | string,
  on: PlainDate,
  table: FxTable,
  options: ConvertOptions = {},
): Converted | Unavailable {
  const target = currencyCode(to);
  const mode = options.mode ?? 'dated';

  const rate = crossRate(table, amount.currency, target, on, {
    mode,
    ...(options.span === undefined ? {} : { span: options.span }),
    ...(options.through === undefined ? {} : { through: options.through }),
  });
  if (isUnavailable(rate)) return rate;

  return {
    amount: money(amount.amount.times(rate.rate), target),
    rate: rate.rate,
    rateDate: rate.rateDate,
    source: rate.source,
    exact: rate.exact,
    approximate: rate.approximate ?? false,
    mode,
  };
}
