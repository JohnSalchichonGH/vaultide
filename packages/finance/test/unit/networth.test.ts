import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/decimal';
import { plainDate } from '../../src/dates/plain-date';
import { serialize, toMinorUnitString } from '../../src/money/money';
import { currencyCode } from '../../src/money/types';
import {
  aggregate,
  completedMonthEnds,
  netWorthAt,
  netWorthChange,
  netWorthSeries,
  seriesPointMonth,
  valueAt,
  type MoneyAggregate,
  type NetWorthResult,
} from '../../src/index';
import { isUnavailable, unavailable } from '../../src/unavailable';
import { entry, fxTable, monthEnd, position, valuation } from '../helpers/records';
import * as simpleUser from '../golden/simple-user/fixture';
import * as multiCurrency from '../golden/multi-currency/fixture';
import * as complexUser from '../golden/complex-user/fixture';

/**
 * The net-worth engine (blueprint 12.1, R18, 7.6, 10.3; 21.1 "net worth").
 *
 * The golden fixtures under `test/golden/` each carry a README with the
 * computation done by hand; the assertions here are those numbers.
 */

const on = (value: string) => plainDate(value);
const exact = (aggregate: MoneyAggregate): string => serialize(aggregate.value).amount;
const shown = (aggregate: MoneyAggregate): string =>
  toMinorUnitString(aggregate.value, 2);

function at(
  positions: Parameters<typeof netWorthAt>[0]['positions'],
  asOf: string,
  fx: Parameters<typeof netWorthAt>[0]['fx'],
  reportingCurrency = 'EUR',
): NetWorthResult {
  return netWorthAt({ positions, asOf: on(asOf), reportingCurrency, fx });
}

describe('golden: simple-user (two EUR accounts, six completed months)', () => {
  const totalsByMonthEnd: readonly [string, string][] = [
    ['2026-03-31', '15200'],
    ['2026-04-30', '15550'],
    ['2026-05-31', '15810'],
    ['2026-06-30', '16205'],
    ['2026-07-31', '16410'],
    ['2026-08-31', '16564'],
  ];

  it.each(totalsByMonthEnd)('totals %s to %s', (asOf, expected) => {
    const result = at(simpleUser.positions, asOf, simpleUser.fx);
    expect(exact(result.totalNetWorth)).toBe(expected);
    expect(result.totalNetWorth.availability).toBe('available');
    // No other assets exist, so the two metrics are the same figure.
    expect(exact(result.financialNetWorth)).toBe(expected);
    expect(result.metricsDiffer).toBe(false);
  });

  it('values the current month at today, from the 6 September snapshots', () => {
    const result = at(simpleUser.positions, '2026-09-06', simpleUser.fx);
    expect(exact(result.totalNetWorth)).toBe('16629');
    expect(result.positions.every((item) => item.value.state === 'exact')).toBe(true);
  });

  it('carries the August balances on 5 September, and says they are carried', () => {
    const result = at(simpleUser.positions, '2026-09-05', simpleUser.fx);
    expect(exact(result.totalNetWorth)).toBe('16564');
    expect(result.positions.map((item) => item.value.state)).toEqual(['carried', 'carried']);
    expect(result.positions.map((item) => item.value.ageDays)).toEqual([5, 5]);
  });

  it('is complete, not partial, before the accounts were tracked', () => {
    // Nothing is unknown in February: the accounts were not on the balance
    // sheet yet (12.3). "Nothing tracked" is zero and complete; "tracked but
    // unvalued" is the partial case asserted in complex-user below.
    const result = at(simpleUser.positions, '2026-02-28', simpleUser.fx);
    expect(exact(result.totalNetWorth)).toBe('0');
    expect(result.totalNetWorth.availability).toBe('available');
    expect(result.totalNetWorth.missing).toEqual([]);
    expect(result.totalNetWorth.contributingCount).toBe(0);
  });

  it('breaks the total down by component and by native currency', () => {
    const result = at(simpleUser.positions, '2026-08-31', simpleUser.fx);
    expect(exact(result.components.cash)).toBe('16564');
    expect(exact(result.components.otherAssetsIncluded)).toBe('0');
    expect(exact(result.components.otherAssetsExcluded)).toBe('0');
    expect(result.totalNetWorth.native.map(serialize)).toEqual([
      { amount: '16564', currency: 'EUR' },
    ]);
  });

  it('produces a series ending in a provisional point', () => {
    const series = netWorthSeries({
      positions: simpleUser.positions,
      reportingCurrency: simpleUser.REPORTING,
      fx: simpleUser.fx,
      today: simpleUser.TODAY,
      months: 12,
    });

    expect(series).toHaveLength(13);
    expect(series.at(-1)?.asOf).toBe('2026-09-06');
    expect(series.at(-1)?.provisional).toBe(true);
    expect(exact(series.at(-1)!.totalNetWorth)).toBe('16629');

    const august = series.find((point) => point.asOf === '2026-08-31');
    expect(august?.provisional).toBe(false);
    expect(exact(august!.totalNetWorth)).toBe('16564');
    expect(seriesPointMonth(august!)).toBe('2026-08');

    // The completed points stop at the previous month end: a month-end value
    // for September cannot exist on 6 September (R15).
    expect(series.filter((point) => !point.provisional).at(-1)?.asOf).toBe('2026-08-31');
  });

  it('lists the twelve completed month ends before today', () => {
    expect(completedMonthEnds(simpleUser.TODAY, 3)).toEqual([
      '2026-06-30',
      '2026-07-31',
      '2026-08-31',
    ]);
  });

  it('reports a change only between two complete figures', () => {
    const july = at(simpleUser.positions, '2026-07-31', simpleUser.fx);
    const august = at(simpleUser.positions, '2026-08-31', simpleUser.fx);
    const change = netWorthChange(july.totalNetWorth, august.totalNetWorth);
    expect(change === undefined ? null : serialize(change).amount).toBe('154');
  });
});

describe('golden: multi-currency (EUR reporting, a USD account)', () => {
  it('converts at the as-of date and keeps every digit', () => {
    const result = at(multiCurrency.positions, '2026-08-31', multiCurrency.fx);

    // The engine's own arithmetic, reproduced: 3000 / 1.1596 at 40 digits.
    const usdInEur = new Decimal('3000').dividedBy(new Decimal('1.1596'));
    const expected = usdInEur.plus(new Decimal('8055'));

    expect(exact(result.totalNetWorth)).toBe(expected.toFixed());
    expect(shown(result.totalNetWorth)).toBe('10642.10');
    expect(result.totalNetWorth.availability).toBe('available');
  });

  it('converts the earlier month end at the earlier month end’s rate', () => {
    const result = at(multiCurrency.positions, '2026-07-31', multiCurrency.fx);
    expect(shown(result.totalNetWorth)).toBe('10516.27');
  });

  it('uses Friday’s rate on a Sunday, and says the rate was not the day’s', () => {
    // 2026-09-06 is a Sunday; the newest stored rate is Friday the 4th (10.2).
    const result = at(multiCurrency.positions, '2026-09-06', multiCurrency.fx);
    const usd = result.positions.find((item) => item.value.position.currency === 'USD');

    expect(usd?.rate?.rateDate).toBe('2026-09-04');
    expect(usd?.rate?.exact).toBe(false);
    expect(usd?.rate?.source).toBe('ecb');
    expect(shown(result.totalNetWorth)).toBe('10636.31');
  });

  it('leaves the native amounts untouched, whatever the reporting currency', () => {
    const inEur = at(multiCurrency.positions, '2026-08-31', multiCurrency.fx, 'EUR');
    const inUsd = at(multiCurrency.positions, '2026-08-31', multiCurrency.fx, 'USD');

    const nativeOf = (result: NetWorthResult) =>
      result.positions.map((item) =>
        isUnavailable(item.value.native) ? null : serialize(item.value.native),
      );

    expect(nativeOf(inEur)).toEqual([
      { amount: '8055', currency: 'EUR' },
      { amount: '3000', currency: 'USD' },
    ]);
    expect(nativeOf(inUsd)).toEqual(nativeOf(inEur));

    // The native breakdown of the aggregate is per currency, unconverted.
    expect(inEur.totalNetWorth.native.map(serialize)).toEqual([
      { amount: '8055', currency: 'EUR' },
      { amount: '3000', currency: 'USD' },
    ]);
  });

  it('is partial — never zero — when the rate is missing', () => {
    const result = at(multiCurrency.positions, '2026-08-31', multiCurrency.fxUnavailable);

    expect(result.totalNetWorth.availability).toBe('partial');
    // Exactly the part that could be established, and nothing pretended.
    expect(exact(result.totalNetWorth)).toBe('8055');
    expect(result.totalNetWorth.contributingCount).toBe(1);
    expect(result.totalNetWorth.missing).toHaveLength(1);

    const [missing] = result.totalNetWorth.missing;
    expect(missing?.positionName).toBe('US checking');
    expect(missing?.reason).toBe('fx_missing');
    // The native amount rides along, so the interface can name what is absent.
    expect(missing?.native === undefined ? null : serialize(missing.native)).toEqual({
      amount: '3000',
      currency: 'USD',
    });
  });

  it('does not lose the native data when the rate publisher is down', () => {
    const [, chase] = multiCurrency.positions;
    const value = valueAt(chase!.position, chase!.valuations, on('2026-08-31'));
    expect(isUnavailable(value.native)).toBe(false);
    if (!isUnavailable(value.native)) expect(serialize(value.native).amount).toBe('3000');
  });

  it('refuses to report a change when either end is partial', () => {
    const complete = at(multiCurrency.positions, '2026-08-31', multiCurrency.fx);
    const partial = at(multiCurrency.positions, '2026-08-31', multiCurrency.fxUnavailable);
    expect(netWorthChange(partial.totalNetWorth, complete.totalNetWorth)).toBeUndefined();
    expect(netWorthChange(complete.totalNetWorth, partial.totalNetWorth)).toBeUndefined();
  });

  it('never needs a rate for a position already in the reporting currency', () => {
    // A single-currency user is never at the mercy of a cold FX cache.
    const result = at(simpleUser.positions, '2026-08-31', multiCurrency.fxUnavailable);
    expect(result.totalNetWorth.availability).toBe('available');
    expect(exact(result.totalNetWorth)).toBe('16564');
  });
});

describe('golden: complex-user (an excluded car, a dormant account, a closed one)', () => {
  it('separates total from financial net worth by exactly the excluded asset', () => {
    const result = at(complexUser.positions, '2026-08-31', complexUser.fx);

    expect(exact(result.totalNetWorth)).toBe('33055');
    expect(exact(result.financialNetWorth)).toBe('13055');
    expect(result.metricsDiffer).toBe(true);

    const difference = result.totalNetWorth.value.amount.minus(
      result.financialNetWorth.value.amount,
    );
    expect(difference.toFixed()).toBe('20000');
    expect(exact(result.components.otherAssetsExcluded)).toBe('20000');
    expect(exact(result.components.otherAssetsIncluded)).toBe('5000');
    expect(exact(result.components.cash)).toBe('8055');
  });

  it('moves the car into the headline metric — and nowhere out of the total', () => {
    const before = at(complexUser.positions, '2026-08-31', complexUser.fx);
    const after = at(complexUser.positionsWithCarIncluded, '2026-08-31', complexUser.fx);

    expect(exact(after.totalNetWorth)).toBe(exact(before.totalNetWorth));
    expect(exact(after.financialNetWorth)).toBe('33055');
    expect(after.metricsDiffer).toBe(false);
    expect(exact(after.components.otherAssetsExcluded)).toBe('0');
  });

  it('reclassifies the whole history when the inclusion flag is toggled', () => {
    // The preference is a **reporting definition**, not a dated event: it is a
    // statement about what "financial net worth" means for this user, so it
    // applies to every date at once. If somebody decides cars are outside their
    // financial net worth, last March's comparison has to use that same
    // definition or the series is not comparable with itself.
    //
    // Consequently: total net worth never moves, and every historical point of
    // the financial series moves together with the current one. There is no
    // effective-date column and no driver — nothing "entered" or "left" on the
    // day the switch was flipped.
    const seriesFor = (positions: typeof complexUser.positions) =>
      netWorthSeries({
        positions,
        reportingCurrency: complexUser.REPORTING,
        fx: complexUser.fx,
        today: complexUser.TODAY,
        months: 12,
      });

    const excluded = seriesFor(complexUser.positions);
    const included = seriesFor(complexUser.positionsWithCarIncluded);

    // The car was valued on 31 August, so August and the provisional point are
    // the dates it is part of the balance sheet at.
    const augustExcluded = excluded.find((point) => point.asOf === '2026-08-31');
    const augustIncluded = included.find((point) => point.asOf === '2026-08-31');

    // Total is untouched at every point in the series.
    expect(excluded.map((point) => point.totalNetWorth.value.amount.toFixed())).toEqual(
      included.map((point) => point.totalNetWorth.value.amount.toFixed()),
    );

    // …and the historical financial point moves by exactly the car, not only
    // the current one.
    expect(exact(augustExcluded!.financialNetWorth)).toBe('13055');
    expect(exact(augustIncluded!.financialNetWorth)).toBe('33055');
    expect(exact(excluded.at(-1)!.financialNetWorth)).toBe('13055');
    expect(exact(included.at(-1)!.financialNetWorth)).toBe('33055');

    // Before the car was on the balance sheet at all, the classification
    // changes nothing — there is nothing to classify.
    const july = (points: typeof excluded) =>
      exact(points.find((point) => point.asOf === '2026-07-31')!.financialNetWorth);
    expect(july(included)).toBe(july(excluded));
  });

  it('carries a dormant account at zero and drops a closed one', () => {
    const result = at(complexUser.positions, '2026-08-31', complexUser.fx);
    const byId = new Map(result.positions.map((item) => [item.value.position.id, item]));

    expect(byId.get(complexUser.ids.oldBank)?.value.state).toBe('carried');
    expect(byId.get(complexUser.ids.closedSavings)?.value.state).toBe('closed');
    expect(result.totalNetWorth.availability).toBe('available');
  });

  it('ignores an inclusion flag on anything that is not an other asset', () => {
    // The preference exists on `other_assets` and nowhere else (M15), so a
    // stray flag on a cash position — which the schema cannot even store — must
    // not be able to take it out of the headline metric.
    const account = position('BBVA', { id: 'f1', includeInFinancialNetWorth: false });
    const result = at(
      [entry(account, [valuation('f1', '2026-08-31', '8055.00')])],
      '2026-08-31',
      complexUser.fx,
    );

    expect(result.positions[0]?.inFinancialNetWorth).toBe(true);
    expect(exact(result.financialNetWorth)).toBe('8055');
    expect(exact(result.totalNetWorth)).toBe('8055');
    expect(result.metricsDiffer).toBe(false);
  });

  it('is partial when a tracked asset has never been valued', () => {
    const result = at(complexUser.positionsWithUnvaluedAsset, '2026-08-31', complexUser.fx);

    expect(result.totalNetWorth.availability).toBe('partial');
    expect(exact(result.totalNetWorth)).toBe('33055');
    expect(result.totalNetWorth.missing.map((item) => item.reason)).toEqual(['no_valuation']);
    expect(result.totalNetWorth.missing[0]?.positionName).toBe('Coin collection');

    // The coins are included in the financial metric, so that one is partial too.
    expect(result.financialNetWorth.availability).toBe('partial');
    expect(exact(result.financialNetWorth)).toBe('13055');
  });

  it('leaves the headline complete when only an excluded asset is unknown', () => {
    const car = complexUser.positions.find(
      (item) => item.position.id === complexUser.ids.car,
    );
    const withoutCarValue = complexUser.positions.map((item) =>
      item.position.id === complexUser.ids.car ? entry(car!.position, []) : item,
    );

    const result = at(withoutCarValue, '2026-08-31', complexUser.fx);
    expect(result.totalNetWorth.availability).toBe('partial');
    // Financial net worth does not contain the car, so nothing about it is
    // missing from that figure.
    expect(result.financialNetWorth.availability).toBe('available');
    expect(exact(result.financialNetWorth)).toBe('13055');
  });
});

describe('aggregation refuses to guess', () => {
  it('is unavailable, not zero, when nothing at all could be valued', () => {
    const usd = position('US checking', { id: 'u1', currency: 'USD' });
    const result = at(
      [entry(usd, [monthEnd('u1', '2026-08-31', '3000.00')])],
      '2026-08-31',
      fxTable([], '2026-09-06'),
    );

    expect(result.totalNetWorth.availability).toBe('unavailable');
    expect(result.totalNetWorth.contributingCount).toBe(0);
    expect(result.totalNetWorth.missing).toHaveLength(1);
  });

  it('does not depend on the order positions arrive in', () => {
    const forwards = at(complexUser.positions, '2026-08-31', complexUser.fx);
    const backwards = at([...complexUser.positions].reverse(), '2026-08-31', complexUser.fx);

    expect(exact(backwards.totalNetWorth)).toBe(exact(forwards.totalNetWorth));
    expect(exact(backwards.financialNetWorth)).toBe(exact(forwards.financialNetWorth));
    expect(backwards.totalNetWorth.native.map(serialize)).toEqual(
      forwards.totalNetWorth.native.map(serialize),
    );
  });

  it('does not depend on the order valuations arrive in', () => {
    const account = position('BBVA', { id: 'o1' });
    const rows = [
      valuation('o1', '2026-06-30', '1.00'),
      valuation('o1', '2026-08-31', '3.00'),
      valuation('o1', '2026-07-31', '2.00'),
    ];
    const forwards = at([entry(account, rows)], '2026-08-31', complexUser.fx);
    const backwards = at([entry(account, [...rows].reverse())], '2026-08-31', complexUser.fx);
    expect(exact(forwards.totalNetWorth)).toBe('3');
    expect(exact(backwards.totalNetWorth)).toBe('3');
  });

  it('keeps every digit of an amount no JavaScript number could hold', () => {
    const account = position('Vault', { id: 'big' });
    const result = at(
      [entry(account, [valuation('big', '2026-08-31', '12345678901234567.89')])],
      '2026-08-31',
      complexUser.fx,
    );
    expect(exact(result.totalNetWorth)).toBe('12345678901234567.89');
  });

  it('subtracts a liability through the sign, with no special case', () => {
    // Phase 5 owns liabilities; the arithmetic that will carry them is here
    // already, and is the same arithmetic every other kind goes through (7.8).
    const cash = position('BBVA', { id: 's1' });
    const loan = position('Mortgage', { id: 's2', kind: 'liability' });
    const result = at(
      [
        entry(cash, [valuation('s1', '2026-08-31', '8055.00')]),
        entry(loan, [valuation('s2', '2026-08-31', '98500.00')]),
      ],
      '2026-08-31',
      complexUser.fx,
    );

    expect(exact(result.totalNetWorth)).toBe('-90445');
    // …and a liability has no inclusion preference: it is in both metrics.
    expect(exact(result.financialNetWorth)).toBe('-90445');
  });
});

describe('the evidence a partial total carries', () => {
  /** A rate table that refuses without saying anything more (10.5). */
  const silentlyMissing = {
    rateOn: () => unavailable('fx_missing'),
    monthlyAverage: () => unavailable('fx_missing'),
    spanAverage: () => unavailable('fx_missing'),
  };

  it('names the position even when the refusal carries no detail', () => {
    const usd = position('US checking', { id: 'd1', currency: 'USD' });
    const result = netWorthAt({
      positions: [entry(usd, [valuation('d1', '2026-08-31', '3000.00')])],
      asOf: on('2026-08-31'),
      reportingCurrency: 'EUR',
      fx: silentlyMissing,
    });

    const [missing] = result.totalNetWorth.missing;
    expect(missing?.positionName).toBe('US checking');
    expect(missing?.reason).toBe('fx_missing');
    expect(missing?.detail).toBeUndefined();
    // The native amount is still known, and still reported.
    expect(missing?.native === undefined ? null : serialize(missing.native).amount).toBe('3000');
  });

  it('is stable even if a caller hands the same position in twice', () => {
    // A window assembled from two overlapping queries is a plausible caller
    // mistake; the engine's order must not depend on which copy came first.
    const account = position('BBVA', { id: 'd2' });
    const rows = [valuation('d2', '2026-08-31', '10.00')];
    const twice = [entry(account, rows), entry(account, rows)];

    const forwards = netWorthAt({
      positions: twice,
      asOf: on('2026-08-31'),
      reportingCurrency: 'EUR',
      fx: complexUser.fx,
    });
    const backwards = netWorthAt({
      positions: [...twice].reverse(),
      asOf: on('2026-08-31'),
      reportingCurrency: 'EUR',
      fx: complexUser.fx,
    });

    expect(exact(forwards.totalNetWorth)).toBe('20');
    expect(exact(backwards.totalNetWorth)).toBe(exact(forwards.totalNetWorth));
  });

  it('aggregates a hand-built contribution with no reason at all', () => {
    // `aggregate` is exported for the query services; it must stay honest even
    // about a contribution assembled outside `netWorthAt`.
    const account = position('Mystery', { id: 'd3' });
    const value = valueAt(account, [], on('2026-08-31'));
    const result = aggregate(
      [{ value, sign: 1, inFinancialNetWorth: true }],
      currencyCode('EUR'),
    );

    expect(result.availability).toBe('unavailable');
    expect(result.missing[0]?.reason).toBe('not_applicable');
    expect(result.missing[0]?.detail).toBeUndefined();
    expect(result.missing[0]?.native).toBeUndefined();
  });
});
