import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/decimal';
import { monthKeyOf, plainDate, type MonthKey } from '../src/dates/plain-date';
import { createFxTable } from '../src/fx/index';
import { currencyCode, money } from '../src/money/index';
import type { ReconciliationStatus } from '../src/reconciliation/index';
import {
  buildRollingTrackedSpendingSeries,
  DuplicateObservationError,
  isRollingEligible,
  reportCashFlow,
  type ReportingAvailability,
  type RollingTrackedSpendingObservation,
  type RollingTrackedSpendingPoint,
} from '../src/reporting/index';

/**
 * Rolling tracked-spending averages (blueprint 15.2, 15.5, v2.1.12 30.15 item
 * 5, v2.1.13 30.16 item 11).
 *
 * The goldens below are the sentences of 30.15 item 5 written as numbers: the
 * window is calendar and never reaches back, a month qualifies on exactly two
 * conditions, the mean is unweighted and unrounded, absence and zero are
 * different answers, and the display month is a boundary rather than a
 * required survivor.
 */

const EUR = currencyCode('EUR');
const M = (month: number, year = 2026): MonthKey => monthKeyOf(year, month);

/** One observation, with its two eligibility inputs spelled out. */
function observe(
  month: MonthKey,
  monthStatus: ReconciliationStatus,
  availability: ReportingAvailability,
  amount: string,
): RollingTrackedSpendingObservation {
  return {
    month,
    monthStatus,
    trackedTotalSpending: { value: money(amount, EUR), availability },
  };
}

const reliable = (month: MonthKey, amount: string) => observe(month, 'reliable', 'available', amount);

const value = (point: RollingTrackedSpendingPoint, window: 'rolling3' | 'rolling6' | 'rolling12') => {
  const average = point[window];
  return average === null ? null : { amount: average.value.amount.toString(), count: average.count };
};

const only = (points: readonly RollingTrackedSpendingPoint[]): RollingTrackedSpendingPoint => {
  const [point] = points;
  if (point === undefined || points.length !== 1) throw new Error('expected exactly one point');
  return point;
};

describe('eligibility is exactly two conditions', () => {
  const statuses: ReconciliationStatus[] = ['reliable', 'estimated', 'provisional', 'unavailable', 'unresolved'];
  const availabilities: ReportingAvailability[] = ['available', 'partial', 'unavailable'];

  it('admits a month only when it is reliable and its reporting total is available', () => {
    for (const status of statuses) {
      for (const availability of availabilities) {
        const eligible = isRollingEligible(observe(M(1), status, availability, '10'));
        expect(eligible).toBe(status === 'reliable' && availability === 'available');
      }
    }
  });

  it('excludes the provisional current month by status, before any clock is consulted', () => {
    expect(isRollingEligible(observe(M(9), 'provisional', 'available', '10'))).toBe(false);
  });

  it('is unchanged by how the rates behind an available figure were found', () => {
    // 30.16 item 11: an average-rate residual carries `estimatedConversion`,
    // a dated fallback is not `exact`, and neither marks anything as missing.
    // The observation type does not even carry provenance, and a full
    // `ReportingAmount` still satisfies it.
    // Real Slice-10a output: one USD rate on the 10th, so a cost dated the 12th
    // converts on a dated fallback (`exact: false`) and the residual converts
    // at the month's average (`estimatedConversion: true`).
    const result = reportCashFlow({
      reportingCurrency: EUR,
      fx: createFxTable(
        [{ quote: currencyCode('USD'), rateDate: plainDate('2026-09-10'), rate: new Decimal('2'), source: 'ECB' }],
        { today: plainDate('2026-10-05') },
      ),
      contributions: [
        { field: 'knownConsumption', amount: money('40', 'USD'), basis: { kind: 'dated', on: plainDate('2026-09-12') } },
        { field: 'unclassified', amount: money('60', 'USD'), basis: { kind: 'average', month: M(9) }, quality: 'reliable' },
      ],
      missing: [],
      countAdditionalSpending: true,
    });
    const figure = result.trackedTotalSpending;
    expect(figure.availability).toBe('available');
    expect(figure.provenance.estimatedConversion).toBe(true);
    expect(figure.provenance.exact).toBe(false);

    const observation: RollingTrackedSpendingObservation = {
      month: M(9),
      monthStatus: 'reliable',
      trackedTotalSpending: figure,
    };
    expect(isRollingEligible(observation)).toBe(true);
    // 40/2 + 60/2, and it is in the mean.
    expect(value(only(buildRollingTrackedSpendingSeries([observation], { from: M(9), to: M(9) })), 'rolling3')).toEqual({
      amount: '50',
      count: 1,
    });
  });
});

describe('golden: eligibility and no reachback', () => {
  // Jan..Jun 2026. February is estimated and April's reporting total is
  // partial, so each keeps its calendar seat and contributes nothing.
  const observations: RollingTrackedSpendingObservation[] = [
    reliable(M(1), '10'),
    observe(M(2), 'estimated', 'available', '20'),
    reliable(M(3), '30'),
    observe(M(4), 'reliable', 'partial', '40'),
    reliable(M(5), '50'),
    reliable(M(6), '60'),
  ];
  const june = only(buildRollingTrackedSpendingSeries(observations, { from: M(6), to: M(6) }));

  it('3M is April, May, June — and March is not reached back to', () => {
    expect(value(june, 'rolling3')).toEqual({ amount: '55', count: 2 });
  });

  it('6M is January through June, four survivors', () => {
    expect(value(june, 'rolling6')).toEqual({ amount: '37.5', count: 4 });
  });

  it('12M has the same four survivors, and missing earlier history suppresses nothing', () => {
    expect(value(june, 'rolling12')).toEqual({ amount: '37.5', count: 4 });
  });

  it('would have said 46.666… had March been reached back to, so the distinction is load-bearing', () => {
    // Not a behaviour this layer has; the number the wrong behaviour would give,
    // written down so the golden above cannot be satisfied by it.
    const wrong = new Decimal('30').plus('50').plus('60').dividedBy(3);
    expect(wrong.toString()).not.toBe('55');
  });
});

describe('golden: the display month itself need not qualify', () => {
  it('averages April and May for an estimated June', () => {
    const june = only(
      buildRollingTrackedSpendingSeries(
        [reliable(M(4), '30'), reliable(M(5), '60'), observe(M(6), 'estimated', 'available', '999')],
        { from: M(6), to: M(6) },
      ),
    );
    expect(value(june, 'rolling3')).toEqual({ amount: '45', count: 2 });
  });

  it('and for a reliable June whose reporting total is partial', () => {
    const june = only(
      buildRollingTrackedSpendingSeries(
        [reliable(M(4), '30'), reliable(M(5), '60'), observe(M(6), 'reliable', 'partial', '999')],
        { from: M(6), to: M(6) },
      ),
    );
    expect(value(june, 'rolling3')).toEqual({ amount: '45', count: 2 });
  });

  it('and for a June with no observation at all', () => {
    const june = only(
      buildRollingTrackedSpendingSeries([reliable(M(4), '30'), reliable(M(5), '60')], {
        from: M(6),
        to: M(6),
      }),
    );
    expect(value(june, 'rolling3')).toEqual({ amount: '45', count: 2 });
  });
});

describe('golden: absence and an exact zero are different answers', () => {
  it('is absent when no month in the window qualified', () => {
    const june = only(
      buildRollingTrackedSpendingSeries(
        [
          observe(M(4), 'estimated', 'available', '10'),
          observe(M(5), 'reliable', 'partial', '20'),
          observe(M(6), 'unavailable', 'unavailable', '0'),
        ],
        { from: M(6), to: M(6) },
      ),
    );
    expect(june.rolling3).toBeNull();
    expect(june.rolling6).toBeNull();
    expect(june.rolling12).toBeNull();
  });

  it('is zero over one observation when the only qualifying month measured zero', () => {
    const june = only(
      buildRollingTrackedSpendingSeries(
        [
          observe(M(4), 'estimated', 'available', '10'),
          reliable(M(5), '0'),
          observe(M(6), 'unavailable', 'unavailable', '0'),
        ],
        { from: M(6), to: M(6) },
      ),
    );
    expect(value(june, 'rolling3')).toEqual({ amount: '0', count: 1 });
  });
});

describe('the mean is arithmetic, unweighted and unrounded', () => {
  it('weighs a 28-day February the same as a 31-day March', () => {
    const march = only(
      buildRollingTrackedSpendingSeries(
        [reliable(M(1), '0'), reliable(M(2), '100'), reliable(M(3), '200')],
        { from: M(3), to: M(3) },
      ),
    );
    expect(value(march, 'rolling3')).toEqual({ amount: '100', count: 3 });
  });

  it('keeps the working-precision quotient and rounds at no scale', () => {
    // A third: forty significant digits, not eight decimals and not two.
    const june = only(
      buildRollingTrackedSpendingSeries(
        [reliable(M(4), '0'), reliable(M(5), '0'), reliable(M(6), '1')],
        { from: M(6), to: M(6) },
      ),
    );
    expect(value(june, 'rolling3')).toEqual({
      amount: '0.3333333333333333333333333333333333333333',
      count: 3,
    });
  });

  it('returns one survivor exactly', () => {
    const june = only(
      buildRollingTrackedSpendingSeries([reliable(M(6), '123.45')], { from: M(6), to: M(6) }),
    );
    expect(value(june, 'rolling3')).toEqual({ amount: '123.45', count: 1 });
    expect(value(june, 'rolling12')).toEqual({ amount: '123.45', count: 1 });
  });
});

describe('the series shape', () => {
  it('returns one point per calendar month of the display range, oldest first', () => {
    const points = buildRollingTrackedSpendingSeries(
      [reliable(M(11, 2025), '10'), reliable(M(1), '20'), reliable(M(2), '30')],
      { from: M(12, 2025), to: M(2) },
    );
    expect(points.map((point) => String(point.month))).toEqual([
      '2025-12-01',
      '2026-01-01',
      '2026-02-01',
    ]);
    // December has no observation of its own and still has a point: November
    // is inside its 3M window.
    expect(value(points[0] as RollingTrackedSpendingPoint, 'rolling3')).toEqual({ amount: '10', count: 1 });
  });

  it('does not return the calculation history it was given before the range', () => {
    const points = buildRollingTrackedSpendingSeries(
      [reliable(M(7, 2025), '10'), reliable(M(6), '20')],
      { from: M(6), to: M(6) },
    );
    expect(points).toHaveLength(1);
    // July 2025 is exactly twelve months before June: inside the 12M window.
    expect(value(points[0] as RollingTrackedSpendingPoint, 'rolling12')).toEqual({ amount: '15', count: 2 });
    expect(value(points[0] as RollingTrackedSpendingPoint, 'rolling6')).toEqual({ amount: '20', count: 1 });
  });

  it('ignores an observation later than the display range', () => {
    const points = buildRollingTrackedSpendingSeries(
      [reliable(M(6), '20'), reliable(M(7), '1000')],
      { from: M(6), to: M(6) },
    );
    expect(value(only(points), 'rolling3')).toEqual({ amount: '20', count: 1 });
  });

  it('returns nothing for an inverted range', () => {
    expect(buildRollingTrackedSpendingSeries([reliable(M(6), '20')], { from: M(7), to: M(6) })).toEqual([]);
  });

  it('does not depend on the order observations arrive in', () => {
    const forward = [reliable(M(4), '30'), reliable(M(5), '60'), reliable(M(6), '90')];
    const backward = [...forward].reverse();
    const a = buildRollingTrackedSpendingSeries(forward, { from: M(6), to: M(6) });
    const b = buildRollingTrackedSpendingSeries(backward, { from: M(6), to: M(6) });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(value(only(a), 'rolling3')).toEqual({ amount: '60', count: 3 });
  });

  it('refuses two observations for one month rather than letting position decide', () => {
    expect(() =>
      buildRollingTrackedSpendingSeries([reliable(M(6), '20'), reliable(M(6), '40')], {
        from: M(6),
        to: M(6),
      }),
    ).toThrow(DuplicateObservationError);
  });

  it('refuses to average two currencies together', () => {
    const usd: RollingTrackedSpendingObservation = {
      month: M(5),
      monthStatus: 'reliable',
      trackedTotalSpending: { value: money('10', 'USD'), availability: 'available' },
    };
    expect(() =>
      buildRollingTrackedSpendingSeries([usd, reliable(M(6), '20')], { from: M(6), to: M(6) }),
    ).toThrow();
  });
});

describe('what the observation type leaves out', () => {
  it('needs nothing but the month, its status and the one figure', () => {
    // A hand-built observation carries no provenance, quality, missing list,
    // additional spending, savings rate, span or as-of date — so none of them
    // can reach the decision. Compile-time shape, restated at runtime.
    const observation = reliable(M(6), '20');
    expect(Object.keys(observation).sort()).toEqual(['month', 'monthStatus', 'trackedTotalSpending']);
    expect(Object.keys(observation.trackedTotalSpending).sort()).toEqual(['availability', 'value']);
  });
});
