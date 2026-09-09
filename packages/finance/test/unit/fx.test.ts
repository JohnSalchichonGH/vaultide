import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/decimal';
import { monthKey, plainDate, type PlainDate } from '../../src/dates/plain-date';
import { money, serialize } from '../../src/money/money';
import { currencyCode } from '../../src/money/types';
import { isUnavailable } from '../../src/unavailable';
import {
  convert,
  createFxTable,
  crossRate,
  emptyFxTable,
  MAX_LOOKBACK_DAYS,
  type FxRateRecord,
} from '../../src/fx/index';

/**
 * FX lookup and conversion (blueprint 10.1–10.3, 21.1 "fx table").
 *
 * The rates below are real ECB reference rates for the first week of September
 * 2026, so the fixtures are checkable against the published series rather than
 * invented. 4 September 2026 was a Friday; the 5th and 6th are the weekend that
 * the on-or-before rule exists for.
 */

const rate = (quote: string, date: string, value: string, source = 'ecb'): FxRateRecord => ({
  quote: currencyCode(quote),
  rateDate: plainDate(date),
  rate: new Decimal(value),
  source,
});

/** EUR -> USD and EUR -> GBP, Mon 31 Aug 2026 through Fri 4 Sep 2026. */
const WEEK: FxRateRecord[] = [
  rate('USD', '2026-08-31', '1.1596'),
  rate('USD', '2026-09-01', '1.1590'),
  rate('USD', '2026-09-02', '1.1578'),
  rate('USD', '2026-09-03', '1.1615'),
  rate('USD', '2026-09-04', '1.1622'),
  rate('GBP', '2026-08-31', '0.85648'),
  rate('GBP', '2026-09-01', '0.85655'),
  rate('GBP', '2026-09-02', '0.85870'),
  rate('GBP', '2026-09-03', '0.86055'),
  rate('GBP', '2026-09-04', '0.85898'),
];

/** Read from October, so August and September are both completed months. */
const TODAY = plainDate('2026-10-05');
const table = createFxTable(WEEK, { today: TODAY });

const on = (value: string): PlainDate => plainDate(value);

describe('rateOn — exact date', () => {
  it('returns the stored rate for the requested day and reports it as exact', () => {
    const lookup = table.rateOn('USD', on('2026-09-03'));
    expect(isUnavailable(lookup)).toBe(false);
    if (isUnavailable(lookup)) return;

    expect(lookup.rate.toFixed()).toBe('1.1615');
    expect(lookup.rateDate).toBe('2026-09-03');
    expect(lookup.exact).toBe(true);
    expect(lookup.source).toBe('ecb');
  });
});

describe('rateOn — latest on or before (weekends and holidays)', () => {
  it("uses Friday's rate on Saturday and reports exact = false", () => {
    // Phase 1 acceptance: "a Saturday conversion uses Friday's rate with
    // exact = false".
    const saturday = table.rateOn('USD', on('2026-09-05'));
    if (isUnavailable(saturday)) throw new Error('expected a rate');

    expect(saturday.rate.toFixed()).toBe('1.1622');
    expect(saturday.rateDate).toBe('2026-09-04');
    expect(saturday.exact).toBe(false);
  });

  it('does the same on Sunday and on the following Monday before the fixing', () => {
    for (const day of ['2026-09-06', '2026-09-07']) {
      const lookup = table.rateOn('USD', on(day));
      if (isUnavailable(lookup)) throw new Error('expected a rate');
      expect(lookup.rateDate).toBe('2026-09-04');
      expect(lookup.exact).toBe(false);
    }
  });

  it('never reaches forward to a later rate', () => {
    const before = table.rateOn('USD', on('2026-08-30'));
    expect(isUnavailable(before)).toBe(true);
    if (!isUnavailable(before)) return;
    expect(before.reason).toBe('fx_missing');
  });
});

describe('rateOn — the ten-day cutoff', () => {
  const stale = createFxTable([rate('USD', '2026-09-04', '1.1622')], { today: TODAY });

  it('accepts a rate exactly ten calendar days old', () => {
    const lookup = stale.rateOn('USD', on('2026-09-14'));
    if (isUnavailable(lookup)) throw new Error('expected a rate');
    expect(lookup.rateDate).toBe('2026-09-04');
    expect(lookup.exact).toBe(false);
  });

  it('refuses the eleventh day rather than carrying a stale rate', () => {
    const lookup = stale.rateOn('USD', on('2026-09-15'));
    expect(isUnavailable(lookup)).toBe(true);
    if (!isUnavailable(lookup)) return;
    expect(lookup.reason).toBe('fx_missing');
    expect(lookup.detail).toContain(String(MAX_LOOKBACK_DAYS));
  });

  it('states the cutoff as ten calendar days, not business days', () => {
    expect(MAX_LOOKBACK_DAYS).toBe(10);
  });
});

describe('EUR identity', () => {
  it('is exactly 1 on every date, with no stored rate at all', () => {
    const empty = emptyFxTable(TODAY);
    const lookup = empty.rateOn('EUR', on('1999-01-04'));
    if (isUnavailable(lookup)) throw new Error('EUR must always be available');

    expect(lookup.rate.toFixed()).toBe('1');
    expect(lookup.exact).toBe(true);
  });

  it('converts EUR to EUR without touching the table', () => {
    const empty = emptyFxTable(TODAY);
    const result = convert(money('1234.56', 'EUR'), 'EUR', on('2026-09-05'), empty);
    if (isUnavailable(result)) throw new Error('expected a conversion');

    expect(serialize(result.amount)).toEqual({ amount: '1234.56', currency: 'EUR' });
    expect(result.rate.toFixed()).toBe('1');
    expect(result.exact).toBe(true);
  });

  it('leaves any same-currency conversion untouched, even without rates', () => {
    const empty = emptyFxTable(TODAY);
    const result = convert(money('999.99', 'JPY'), 'JPY', on('2026-09-05'), empty);
    if (isUnavailable(result)) throw new Error('expected a conversion');
    expect(serialize(result.amount)).toEqual({ amount: '999.99', currency: 'JPY' });
  });
});

describe('cross rates through the EUR pivot', () => {
  it('derives USD -> GBP as rate(EUR->GBP) / rate(EUR->USD)', () => {
    const lookup = crossRate(table, 'USD', 'GBP', on('2026-09-04'));
    if (isUnavailable(lookup)) throw new Error('expected a rate');

    const expected = new Decimal('0.85898').dividedBy(new Decimal('1.1622'));
    expect(lookup.rate.toFixed()).toBe(expected.toFixed());
    expect(lookup.exact).toBe(true);
  });

  it('round-trips: converting A -> B -> A returns the original amount', () => {
    const original = money('1000', 'USD');
    const toGbp = convert(original, 'GBP', on('2026-09-04'), table);
    if (isUnavailable(toGbp)) throw new Error('expected a conversion');
    const back = convert(toGbp.amount, 'USD', on('2026-09-04'), table);
    if (isUnavailable(back)) throw new Error('expected a conversion');

    // Exact at 40 significant digits: no intermediate rounding anywhere (7.3).
    expect(back.amount.amount.toFixed()).toBe('1000');
  });

  it('is only as fresh as its stalest leg', () => {
    const mixed = createFxTable(
      [rate('USD', '2026-09-04', '1.1622'), rate('GBP', '2026-09-02', '0.85870')],
      { today: TODAY },
    );
    const lookup = crossRate(mixed, 'USD', 'GBP', on('2026-09-04'));
    if (isUnavailable(lookup)) throw new Error('expected a rate');

    expect(lookup.exact).toBe(false);
    expect(lookup.rateDate).toBe('2026-09-02');
    expect(lookup.source).toBe('ecb');
  });

  it('is unavailable when either leg is missing', () => {
    expect(isUnavailable(crossRate(table, 'USD', 'JPY', on('2026-09-04')))).toBe(true);
    expect(isUnavailable(crossRate(table, 'JPY', 'USD', on('2026-09-04')))).toBe(true);
  });
});

describe('monthly average', () => {
  it('is the arithmetic mean of the stored daily rates of that month', () => {
    // September rates present: 1.1590, 1.1578, 1.1615, 1.1622.
    const average = table.monthlyAverage('USD', monthKey(on('2026-09-15')));
    if (isUnavailable(average)) throw new Error('expected an average');

    const expected = new Decimal('1.1590')
      .plus('1.1578')
      .plus('1.1615')
      .plus('1.1622')
      .dividedBy(4);
    expect(average.rate.toFixed()).toBe(expected.toFixed());
    expect(average.sampleCount).toBe(4);
    // An average is never the rate "of" a day.
    expect(average.exact).toBe(false);
    expect(average.approximate).toBe(false);
    expect(average.rateDate).toBe('2026-09-30');
  });

  it('ignores rates outside the month', () => {
    const august = table.monthlyAverage('USD', monthKey(on('2026-08-15')));
    if (isUnavailable(august)) throw new Error('expected an average');
    expect(august.sampleCount).toBe(1);
    expect(august.rate.toFixed()).toBe('1.1596');
  });

  it('is unavailable for a completed month with no stored rates', () => {
    // The ten-day window from a month's last day always falls inside that same
    // month, so a completed month with no samples has nothing within reach
    // either: there is no rate to fall back to, and none is invented (10.5).
    const july = table.monthlyAverage('USD', monthKey(on('2026-07-15')));
    expect(isUnavailable(july)).toBe(true);
    if (!isUnavailable(july)) return;
    expect(july.reason).toBe('fx_missing');
  });
});

describe('monthly average — the current month, through D (30.16)', () => {
  const currentMonthToday = plainDate('2026-09-04');

  it('has no answer without a cut-off, because 10.2 only defines it through D', () => {
    // A month that has not ended has no whole-month average to give, and
    // averaging the fortnight so far would be calling a fortnight September.
    const partial = createFxTable(WEEK, { today: currentMonthToday });
    const september = partial.monthlyAverage('USD', monthKey(on('2026-09-04')));
    expect(isUnavailable(september)).toBe(true);
  });

  it('FX-MTD-A — D is today, and four observations fall back to rateOn(D)', () => {
    // today = D = 6 Sep, rates on the 1st to the 4th.
    const table = createFxTable(WEEK, { today: plainDate('2026-09-06') });
    const september = table.monthlyAverage(
      'USD',
      monthKey(on('2026-09-06')),
      plainDate('2026-09-06'),
    );
    if (isUnavailable(september)) throw new Error('expected a lookup');

    expect(september.sampleCount).toBe(4);
    expect(september.approximate).toBe(true);
    // The 4 Sep rate is the latest within the lookback from D.
    expect(september.rate.toFixed()).toBe('1.1622');
    expect(september.rateDate).toBe('2026-09-04');
  });

  it('FX-MTD-B — rates after D are not evidence about a figure through D', () => {
    // today = 10 Sep, D = 6 Sep, and rates exist on the 8th and 9th as well.
    const table = createFxTable(
      [...WEEK, rate('USD', '2026-09-08', '9.9999'), rate('USD', '2026-09-09', '9.9999')],
      { today: plainDate('2026-09-10') },
    );
    const september = table.monthlyAverage(
      'USD',
      monthKey(on('2026-09-10')),
      plainDate('2026-09-06'),
    );
    if (isUnavailable(september)) throw new Error('expected a lookup');

    // Four eligible observations, so the fallback — and it is `rateOn(6 Sep)`,
    // never `rateOn(10 Sep)`, and never an average containing the 8th or 9th.
    expect(september.sampleCount).toBe(4);
    expect(september.approximate).toBe(true);
    expect(september.rateDate).toBe('2026-09-04');
    expect(september.rate.toFixed()).toBe('1.1622');
  });

  it('FX-MTD-C — five observations through D are their own mean', () => {
    const table = createFxTable(
      [
        ...WEEK,
        rate('USD', '2026-09-05', '1.1650'),
        rate('USD', '2026-09-08', '9.9999'),
        rate('USD', '2026-09-09', '9.9999'),
      ],
      { today: plainDate('2026-09-10') },
    );
    const september = table.monthlyAverage(
      'USD',
      monthKey(on('2026-09-10')),
      plainDate('2026-09-06'),
    );
    if (isUnavailable(september)) throw new Error('expected an average');

    expect(september.sampleCount).toBe(5);
    expect(september.approximate).toBe(false);
    const expected = new Decimal('1.1590')
      .plus('1.1578')
      .plus('1.1615')
      .plus('1.1622')
      .plus('1.1650')
      .dividedBy(5);
    expect(september.rate.toFixed()).toBe(expected.toFixed());
    // Dated at the cut-off, and the 9.9999 rates never entered it.
    expect(september.rateDate).toBe('2026-09-06');
  });

  it('FX-MTD-D — nothing within the lookback from D is unavailable, not a reach forward', () => {
    // The only rates are far before D and far after it. Neither is evidence.
    const table = createFxTable(
      [rate('USD', '2026-08-01', '1.1000'), rate('USD', '2026-09-25', '9.9999')],
      { today: plainDate('2026-09-30') },
    );
    const september = table.monthlyAverage(
      'USD',
      monthKey(on('2026-09-30')),
      plainDate('2026-09-20'),
    );
    expect(isUnavailable(september)).toBe(true);
  });

  it('applies the five-sample rule only to the current month', () => {
    // The same four September samples, read from October: September is a
    // completed month, so four days are the month's stored rates and average.
    const later = createFxTable(WEEK, { today: plainDate('2026-10-05') });
    const september = later.monthlyAverage('USD', monthKey(on('2026-09-15')));
    if (isUnavailable(september)) throw new Error('expected an average');
    expect(september.approximate).toBe(false);
    expect(september.sampleCount).toBe(4);
  });
});

describe('span average', () => {
  it('weights each month by its length, not by its sample count', () => {
    const span = table.spanAverage('USD', monthKey(on('2026-08-01')), monthKey(on('2026-09-01')));
    if (isUnavailable(span)) throw new Error('expected a span average');

    const august = new Decimal('1.1596');
    const september = new Decimal('1.1590')
      .plus('1.1578')
      .plus('1.1615')
      .plus('1.1622')
      .dividedBy(4);
    // August has 31 days and one sample; September has 30 days and four. The
    // weight is the calendar, so August cannot be diluted by having fewer rates.
    const expected = august.times(31).plus(september.times(30)).dividedBy(61);

    expect(span.rate.toFixed()).toBe(expected.toFixed());
    expect(span.rateDate).toBe('2026-09-30');
  });

  it('equals the monthly average when the span is one month', () => {
    const month = monthKey(on('2026-09-01'));
    const span = table.spanAverage('USD', month, month);
    const single = table.monthlyAverage('USD', month);
    if (isUnavailable(span) || isUnavailable(single)) throw new Error('expected averages');
    expect(span.rate.toFixed()).toBe(single.rate.toFixed());
  });

  it('is unavailable when any month inside it has no usable rate', () => {
    const gapped = createFxTable([rate('USD', '2026-08-31', '1.1596')], { today: TODAY });
    const span = gapped.spanAverage(
      'USD',
      monthKey(on('2026-08-01')),
      monthKey(on('2026-10-01')),
    );
    // An average over a hole is not an average of the span.
    expect(isUnavailable(span)).toBe(true);
  });

  it('refuses a span that ends before it starts', () => {
    const span = table.spanAverage('USD', monthKey(on('2026-09-01')), monthKey(on('2026-08-01')));
    expect(isUnavailable(span)).toBe(true);
  });

  it('is exactly 1 for EUR', () => {
    const span = table.spanAverage('EUR', monthKey(on('2026-08-01')), monthKey(on('2026-09-01')));
    if (isUnavailable(span)) throw new Error('EUR must always be available');
    expect(span.rate.toFixed()).toBe('1');
  });
});

describe('conversion', () => {
  it('multiplies at full precision and reports the rate it used', () => {
    const result = convert(money('16564.00', 'EUR'), 'USD', on('2026-09-04'), table);
    if (isUnavailable(result)) throw new Error('expected a conversion');

    expect(result.amount.amount.toFixed()).toBe(new Decimal('16564').times('1.1622').toFixed());
    expect(result.rateDate).toBe('2026-09-04');
    expect(result.exact).toBe(true);
    expect(result.mode).toBe('dated');
    expect(result.source).toBe('ecb');
  });

  it('carries exact = false through a weekend conversion', () => {
    const result = convert(money('100', 'USD'), 'EUR', on('2026-09-05'), table);
    if (isUnavailable(result)) throw new Error('expected a conversion');
    expect(result.exact).toBe(false);
    expect(result.rateDate).toBe('2026-09-04');
  });

  it('uses the monthly average when asked for one', () => {
    const result = convert(money('398', 'USD'), 'EUR', on('2026-09-15'), table, {
      mode: 'monthly_average',
    });
    if (isUnavailable(result)) throw new Error('expected a conversion');
    expect(result.mode).toBe('monthly_average');
    expect(result.exact).toBe(false);
  });

  it('uses a span average when given a span', () => {
    const result = convert(money('722', 'USD'), 'EUR', on('2026-09-30'), table, {
      mode: 'span_average',
      span: { from: monthKey(on('2026-08-01')), to: monthKey(on('2026-09-01')) },
    });
    if (isUnavailable(result)) throw new Error('expected a conversion');
    expect(result.mode).toBe('span_average');
  });

  it('is unavailable — never zero — when no rate exists', () => {
    const result = convert(money('100', 'JPY'), 'EUR', on('2026-09-04'), table);
    expect(isUnavailable(result)).toBe(true);
    if (!isUnavailable(result)) return;
    expect(result.reason).toBe('fx_missing');
  });
});

describe('source preference', () => {
  const twoSources = createFxTable(
    [
      rate('CHF', '2026-09-04', '0.9300', 'ecb'),
      rate('CHF', '2026-09-04', '0.9400', 'snb'),
    ],
    { today: TODAY, sourcePreference: ['ecb', 'snb'] },
  );

  it('picks the preferred publisher when two carry the same date', () => {
    const lookup = twoSources.rateOn('CHF', on('2026-09-04'));
    if (isUnavailable(lookup)) throw new Error('expected a rate');
    expect(lookup.source).toBe('ecb');
    expect(lookup.rate.toFixed()).toBe('0.93');
  });

  it('reverses when the preference reverses — the rows are unchanged', () => {
    const preferSnb = createFxTable(
      [
        rate('CHF', '2026-09-04', '0.9300', 'ecb'),
        rate('CHF', '2026-09-04', '0.9400', 'snb'),
      ],
      { today: TODAY, sourcePreference: ['snb', 'ecb'] },
    );
    const lookup = preferSnb.rateOn('CHF', on('2026-09-04'));
    if (isUnavailable(lookup)) throw new Error('expected a rate');
    expect(lookup.source).toBe('snb');
  });
});

describe('edges the engines depend on', () => {
  it('ranks an unlisted publisher behind every listed one', () => {
    const mixed = createFxTable(
      [
        rate('CHF', '2026-09-04', '0.9300', 'ecb'),
        rate('CHF', '2026-09-04', '0.9400', 'unknown-publisher'),
      ],
      { today: TODAY, sourcePreference: ['ecb'] },
    );
    const lookup = mixed.rateOn('CHF', on('2026-09-04'));
    if (isUnavailable(lookup)) throw new Error('expected a rate');
    expect(lookup.source).toBe('ecb');
  });

  it('has no monthly average for a currency it has never stored', () => {
    const average = table.monthlyAverage('JPY', monthKey(on('2026-09-15')));
    expect(isUnavailable(average)).toBe(true);
  });

  it('gives EUR a monthly average of exactly 1, dated the month end', () => {
    const average = emptyFxTable(TODAY).monthlyAverage('EUR', monthKey(on('2026-09-15')));
    if (isUnavailable(average)) throw new Error('EUR must always be available');
    expect(average.rate.toFixed()).toBe('1');
    expect(average.rateDate).toBe('2026-09-30');
    expect(average.exact).toBe(true);
  });

  it('carries "approximate" through a cross rate and through a span', () => {
    // Four September samples read through a 4 Sep cut-off: too thin to average,
    // so the monthly lookup falls back to the dated rate and says so (10.2).
    const inSeptember = createFxTable(WEEK, { today: plainDate('2026-09-04') });

    const cross = crossRate(inSeptember, 'USD', 'GBP', on('2026-09-04'), {
      mode: 'monthly_average',
      through: plainDate('2026-09-04'),
    });
    if (isUnavailable(cross)) throw new Error('expected a rate');
    expect(cross.approximate).toBe(true);

    // A span may not reach into it. 10.2 weights a span over its **completed**
    // months' averages, and a month that has not ended has no average to
    // contribute, so the span says so rather than borrowing a partial one.
    const reachingIntoSeptember = inSeptember.spanAverage(
      'USD',
      monthKey(on('2026-08-01')),
      monthKey(on('2026-09-01')),
    );
    expect(isUnavailable(reachingIntoSeptember)).toBe(true);
  });

  it('gives a completed span a real average, which is never approximate', () => {
    // Read from October, both months are complete. `approximate` is now
    // reachable only through the month-to-date path: a completed month falls
    // back only with no stored rate at all, and its ten-day lookback from
    // `end(M)` lies inside the month, so the fallback is unavailable rather
    // than approximate. A span therefore either averages or does not exist.
    const completed = createFxTable(
      [rate('USD', '2026-08-31', '1.1500'), ...WEEK],
      { today: plainDate('2026-10-05') },
    );
    const span = completed.spanAverage(
      'USD',
      monthKey(on('2026-08-01')),
      monthKey(on('2026-09-01')),
    );
    if (isUnavailable(span)) throw new Error('expected a span average');
    expect(span.approximate).toBe(false);
    expect(span.sampleCount).toBe(5);
  });

  it('treats a span_average with no span as the single month of the date', () => {
    const withSpan = convert(money('100', 'USD'), 'EUR', on('2026-09-15'), table, {
      mode: 'span_average',
      span: { from: monthKey(on('2026-09-01')), to: monthKey(on('2026-09-01')) },
    });
    const withoutSpan = convert(money('100', 'USD'), 'EUR', on('2026-09-15'), table, {
      mode: 'span_average',
    });
    if (isUnavailable(withSpan) || isUnavailable(withoutSpan)) {
      throw new Error('expected conversions');
    }
    expect(withoutSpan.amount.amount.toFixed()).toBe(withSpan.amount.amount.toFixed());
  });
});
