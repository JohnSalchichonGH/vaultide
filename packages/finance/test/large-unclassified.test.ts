import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/decimal';
import { addMonths, endOfMonthKey, monthKey, monthKeyOf, plainDate, startOfMonthKey, type MonthKey } from '../src/dates/plain-date';
import { currencyCode } from '../src/money/types';
import { monthEnd, position } from './helpers/records';
import {
  bucketObservations,
  DuplicateBucketObservationError,
  ISSUE_CLASS,
  isLargeUnclassifiedBaseline,
  isLargeUnclassifiedTarget,
  largeUnclassifiedIssue,
  largeUnclassifiedWindow,
  reconcileCompletedMonth,
  withLargeUnclassified,
  type CashAccountInput,
  type LargeUnclassifiedObservation,
  type MonthReconciliation,
  type ReconciliationStatus,
} from '../src/reconciliation/index';

/**
 * `large_unclassified` (blueprint 8.5, v2.1.12 30.15 item 4).
 *
 * The goldens are 30.15 item 4's sentences as numbers: six calendar months and
 * no more, only reliable months in the baseline, an estimated target still
 * judged, three observations enough and two not, an exact median with no
 * rounding, a strict trigger, and a zero median that is not special. The matrix
 * pins the target/baseline asymmetry status by status, so it cannot be inferred
 * from one example.
 */

const EUR = currencyCode('EUR');
const USD = currencyCode('USD');
/** November 2026 is the target throughout; May … October are its window. */
const NOVEMBER = monthKeyOf(2026, 11);
const M = (offset: number): MonthKey => monthKeyOf(2026, 11 + offset);

const observe = (
  month: MonthKey,
  status: ReconciliationStatus,
  unclassified?: string,
  currency = EUR,
): LargeUnclassifiedObservation => ({
  month,
  currency,
  status,
  ...(unclassified === undefined ? {} : { unclassified: new Decimal(unclassified) }),
});

const reliable = (month: MonthKey, unclassified: string, currency = EUR) =>
  observe(month, 'reliable', unclassified, currency);

const target = (unclassified: string, status: ReconciliationStatus = 'reliable', currency = EUR) =>
  observe(NOVEMBER, status, unclassified, currency);

/** Six reliable months, 10 … 60, so the median is 35 and the threshold 70. */
const sixReliable = (): LargeUnclassifiedObservation[] =>
  [10, 20, 30, 40, 50, 60].map((value, index) => reliable(M(-6 + index), String(value)));

describe('the window is the six calendar months before the target', () => {
  it('names exactly M−6 … M−1, oldest first', () => {
    expect(largeUnclassifiedWindow(NOVEMBER).map(String)).toEqual([
      '2026-05-01',
      '2026-06-01',
      '2026-07-01',
      '2026-08-01',
      '2026-09-01',
      '2026-10-01',
    ]);
  });

  it('crosses a year boundary without losing a month', () => {
    expect(largeUnclassifiedWindow(monthKeyOf(2027, 2)).map(String)).toEqual([
      '2026-08-01',
      '2026-09-01',
      '2026-10-01',
      '2026-11-01',
      '2026-12-01',
      '2027-01-01',
    ]);
  });
});

describe('the target/baseline status matrix', () => {
  const statuses: ReconciliationStatus[] = ['reliable', 'estimated', 'unresolved', 'unavailable', 'provisional'];

  it('judges a target only when it is reliable or estimated with a residual of at least zero', () => {
    for (const status of statuses) {
      expect(isLargeUnclassifiedTarget(observe(NOVEMBER, status, '5'))).toBe(
        status === 'reliable' || status === 'estimated',
      );
      // No residual: never a target, whatever the status says.
      expect(isLargeUnclassifiedTarget(observe(NOVEMBER, status))).toBe(false);
    }
    // A negative residual is an unresolved month's, and is not judged.
    expect(isLargeUnclassifiedTarget(observe(NOVEMBER, 'reliable', '-0.01'))).toBe(false);
    expect(isLargeUnclassifiedTarget(observe(NOVEMBER, 'reliable', '0'))).toBe(true);
  });

  it('admits a baseline month only when it is exactly reliable, with a residual', () => {
    for (const status of statuses) {
      expect(isLargeUnclassifiedBaseline(observe(M(-1), status, '5'))).toBe(status === 'reliable');
      expect(isLargeUnclassifiedBaseline(observe(M(-1), status))).toBe(false);
    }
  });

  it('is the same asymmetry end to end: an estimated target is judged, an estimated baseline is not', () => {
    const history = [reliable(M(-3), '10'), reliable(M(-2), '20'), reliable(M(-1), '30')];
    expect(largeUnclassifiedIssue(target('100', 'estimated'), history)).toBeDefined();
    for (const status of ['unresolved', 'unavailable', 'provisional'] as const) {
      expect(largeUnclassifiedIssue(target('100', status), history)).toBeUndefined();
    }
    const withEstimatedBaseline = [reliable(M(-3), '10'), reliable(M(-2), '20'), observe(M(-1), 'estimated', '30')];
    expect(largeUnclassifiedIssue(target('100'), withEstimatedBaseline)).toBeUndefined();
  });
});

describe('G1 — an odd median, a strict threshold, and three months are enough', () => {
  const history = [
    reliable(M(-6), '10'),
    reliable(M(-5), '20'),
    reliable(M(-4), '30'),
    observe(M(-3), 'unavailable'),
    observe(M(-2), 'estimated', '1000'),
    observe(M(-1), 'unresolved', '-5'),
  ];

  it('does not raise at exactly twice the median', () => {
    expect(largeUnclassifiedIssue(target('40'), history)).toBeUndefined();
  });

  it('raises just above it, naming the currency and the residual', () => {
    expect(largeUnclassifiedIssue(target('40.01'), history)).toEqual({
      key: 'large_unclassified',
      class: 'advisory',
      currency: 'EUR',
      amount: new Decimal('40.01'),
    });
    expect(ISSUE_CLASS.large_unclassified).toBe('advisory');
  });
});

describe('G2 — an even median is the exact mean of the two middle values', () => {
  const history = [
    reliable(M(-6), '10'),
    reliable(M(-5), '20'),
    observe(M(-4), 'unavailable'),
    reliable(M(-3), '30'),
    observe(M(-2), 'estimated', '999'),
    reliable(M(-1), '40'),
  ];

  it('has median 25 and threshold 50', () => {
    expect(largeUnclassifiedIssue(target('50'), history)).toBeUndefined();
    expect(largeUnclassifiedIssue(target('50.01'), history)?.amount?.toString()).toBe('50.01');
  });
});

describe('G3 — a median of zero is not special', () => {
  const history = [reliable(M(-3), '0'), reliable(M(-2), '0'), reliable(M(-1), '0')];

  it('leaves a residual of zero alone', () => {
    expect(largeUnclassifiedIssue(target('0'), history)).toBeUndefined();
  });

  it('raises on any positive residual, with no floor invented', () => {
    expect(largeUnclassifiedIssue(target('0.01'), history)?.amount?.toString()).toBe('0.01');
  });
});

describe('G4 — two observations are not a baseline', () => {
  it('raises nothing, however large the target', () => {
    const history = [reliable(M(-2), '1'), reliable(M(-1), '1')];
    expect(largeUnclassifiedIssue(target('1000000'), history)).toBeUndefined();
  });
});

describe('G5 — the window never reaches back', () => {
  it('ignores a reliable M−7 that would have been the third observation', () => {
    const history = [
      reliable(M(-7), '10'),
      reliable(M(-6), '20'),
      observe(M(-5), 'unavailable'),
      observe(M(-4), 'estimated', '25'),
      reliable(M(-3), '30'),
      observe(M(-2), 'unavailable'),
      observe(M(-1), 'estimated', '35'),
    ];
    expect(largeUnclassifiedIssue(target('1000000'), history)).toBeUndefined();
    // And with M−7 moved into the window it is a baseline, and the issue exists.
    const shifted = history.map((o) => (o.month === M(-7) ? { ...o, month: M(-5) } : o)).filter((o) => o.month !== M(-5) || o.status === 'reliable');
    expect(largeUnclassifiedIssue(target('1000000'), shifted)).toBeDefined();
  });
});

describe('G6 / G7 — the asymmetry on one history', () => {
  const qualifying = [reliable(M(-3), '10'), reliable(M(-2), '20'), reliable(M(-1), '30')];

  it('G6 — judges an estimated target against a reliable baseline', () => {
    const issue = largeUnclassifiedIssue(target('40.01', 'estimated'), qualifying);
    expect(issue?.key).toBe('large_unclassified');
  });

  it('G7 — drops the issue when one baseline month turns estimated', () => {
    const one = qualifying.map((o, index) => (index === 0 ? { ...o, status: 'estimated' as const } : o));
    expect(largeUnclassifiedIssue(target('40.01', 'estimated'), one)).toBeUndefined();
  });
});

describe('G8 — history in another currency is not this bucket’s history', () => {
  const eurHistory = [reliable(M(-3), '10'), reliable(M(-2), '20'), reliable(M(-1), '30')];
  const usdHistory = (scale: string) =>
    [M(-6), M(-5), M(-4), M(-3), M(-2), M(-1)].map((month) => reliable(month, scale, USD));

  it('keeps the EUR median at 20 whatever the USD numbers are', () => {
    for (const scale of ['0', '0.000001', '1000000']) {
      const history = [...eurHistory, ...usdHistory(scale)];
      expect(largeUnclassifiedIssue(target('40'), history)).toBeUndefined();
      expect(largeUnclassifiedIssue(target('40.01'), history)?.currency).toBe('EUR');
    }
  });

  it('judges a USD target against USD history only', () => {
    const history = [...eurHistory, ...usdHistory('1000')];
    expect(largeUnclassifiedIssue(target('2000', 'reliable', USD), history)).toBeUndefined();
    expect(largeUnclassifiedIssue(target('2000.01', 'reliable', USD), history)?.currency).toBe('USD');
  });
});

describe('G9 — a bucket is judged on its own status, never on the month’s', () => {
  const EUR_ACCOUNT = 'eur';
  const USD_ACCOUNT = 'usd';

  /** A month whose EUR bucket reconciles and whose USD bucket has no closing balance. */
  function month(key: MonthKey, eurOpening: string, eurClosing: string, usdClosing?: string): MonthReconciliation {
    const open = endOfMonthKey(monthKey(addMonths(startOfMonthKey(key), -1)));
    const close = endOfMonthKey(key);
    const accounts: CashAccountInput[] = [
      {
        position: position('Euros', { id: EUR_ACCOUNT, currency: 'EUR' }),
        valuations: [monthEnd(EUR_ACCOUNT, open, eurOpening), monthEnd(EUR_ACCOUNT, close, eurClosing)],
        accountType: 'checking',
      },
      {
        position: position('Dollars', { id: USD_ACCOUNT, currency: 'USD' }),
        valuations: [
          monthEnd(USD_ACCOUNT, open, '500'),
          ...(usdClosing === undefined ? [] : [monthEnd(USD_ACCOUNT, close, usdClosing)]),
        ],
        accountType: 'checking',
      },
    ];
    return reconcileCompletedMonth({
      month: key,
      today: plainDate('2026-12-01'),
      cashAccounts: accounts,
      income: [],
      expenses: [],
      transfers: [],
      templates: [],
      resolvedOccurrences: new Set<string>(),
    });
  }

  it('lets a reliable EUR bucket in an unavailable month be a baseline observation', () => {
    const history = [
      month(M(-3), '1000', '990'),
      month(M(-2), '990', '970'),
      month(M(-1), '970', '940'),
    ].map((reconciliation) => {
      expect(reconciliation.monthStatus).toBe('unavailable');
      expect(reconciliation.buckets.find((b) => b.currency === 'EUR')?.status).toBe('reliable');
      expect(reconciliation.buckets.find((b) => b.currency === 'USD')?.status).toBe('unavailable');
      return reconciliation;
    });
    const observations = history.flatMap(bucketObservations);

    // EUR residuals 10, 20, 30: median 20, threshold 40.
    expect(largeUnclassifiedIssue(target('40'), observations)).toBeUndefined();
    expect(largeUnclassifiedIssue(target('40.01'), observations)?.currency).toBe('EUR');
  });

  it('judges a reliable EUR target inside an unavailable month', () => {
    const history = [month(M(-3), '1000', '990'), month(M(-2), '990', '970'), month(M(-1), '970', '940')].flatMap(bucketObservations);
    const november = month(NOVEMBER, '940', '840');
    expect(november.monthStatus).toBe('unavailable');

    const enriched = withLargeUnclassified(november, history);
    const eur = enriched.buckets.find((b) => b.currency === 'EUR');
    const usd = enriched.buckets.find((b) => b.currency === 'USD');
    expect(eur?.issues.map((i) => i.key)).toContain('large_unclassified');
    expect(usd?.issues.map((i) => i.key)).not.toContain('large_unclassified');
    // Metadata only: the month is exactly as unavailable as it was.
    expect(enriched.monthStatus).toBe('unavailable');
    expect(eur?.status).toBe('reliable');
  });
});

describe('the median, exactly', () => {
  const at = (values: string[], targetValue: string) =>
    largeUnclassifiedIssue(
      target(targetValue),
      values.map((value, index) => reliable(M(-6 + index), value)),
    );

  it('takes the middle sorted value for an odd count, whatever order it arrived in', () => {
    // [10, 30, 20] → 20; threshold 40.
    expect(at(['10', '30', '20'], '40')).toBeUndefined();
    expect(at(['10', '30', '20'], '40.01')).toBeDefined();
    // [1, 100, 4, 8, 9] → 8; threshold 16.
    expect(at(['1', '100', '4', '8', '9'], '16')).toBeUndefined();
    expect(at(['1', '100', '4', '8', '9'], '16.01')).toBeDefined();
  });

  it('takes the exact mean of the two middle values for an even count', () => {
    // [10, 20, 30, 40] → 25; threshold 50.
    expect(at(['10', '20', '30', '40'], '50')).toBeUndefined();
    expect(at(['10', '20', '30', '40'], '50.01')).toBeDefined();
    // [0.01 … 0.06] → 0.035; threshold 0.07.
    expect(at(['0.01', '0.02', '0.03', '0.04', '0.05', '0.06'], '0.07')).toBeUndefined();
    expect(at(['0.01', '0.02', '0.03', '0.04', '0.05', '0.06'], '0.0700000001')).toBeDefined();
  });

  it('keeps a residual’s full precision rather than the currency’s', () => {
    // Residuals are exact upstream arithmetic and may carry more than two
    // decimals; the threshold is 2 × 0.333333333, and nothing is rounded to
    // cents before the comparison.
    const history = [reliable(M(-3), '0.333333333'), reliable(M(-2), '0.333333333'), reliable(M(-1), '0.333333333')];
    expect(largeUnclassifiedIssue(target('0.666666666'), history)).toBeUndefined();
    expect(largeUnclassifiedIssue(target('0.666666667'), history)).toBeDefined();
  });
});

describe('input contract', () => {
  it('does not depend on the order observations arrive in', () => {
    const forward = sixReliable();
    const backward = [...forward].reverse();
    expect(largeUnclassifiedIssue(target('70'), forward)).toBeUndefined();
    expect(largeUnclassifiedIssue(target('70'), backward)).toBeUndefined();
    expect(largeUnclassifiedIssue(target('70.01'), forward)).toEqual(largeUnclassifiedIssue(target('70.01'), backward));
  });

  it('refuses two observations for one month and currency', () => {
    expect(() => largeUnclassifiedIssue(target('100'), [...sixReliable(), reliable(M(-1), '5')])).toThrow(
      DuplicateBucketObservationError,
    );
  });

  it('accepts the same month in two currencies', () => {
    expect(() => largeUnclassifiedIssue(target('100'), [...sixReliable(), reliable(M(-1), '5', USD)])).not.toThrow();
  });
});

describe('enriching a reconciled month', () => {
  const A = 'bbva';
  const account = (openingOn: string, opening: string, closingOn: string, closing: string): CashAccountInput => ({
    position: position('BBVA', { id: A, currency: 'EUR' }),
    valuations: [monthEnd(A, openingOn, opening), monthEnd(A, closingOn, closing)],
    accountType: 'checking',
  });
  const november = (): MonthReconciliation =>
    reconcileCompletedMonth({
      month: NOVEMBER,
      today: plainDate('2026-12-01'),
      cashAccounts: [account('2026-10-31', '1000', '2026-11-30', '900')],
      income: [],
      expenses: [],
      transfers: [],
      templates: [],
      resolvedOccurrences: new Set<string>(),
    });
  const history = [reliable(M(-3), '10'), reliable(M(-2), '20'), reliable(M(-1), '30')];

  it('appends the advisory after the engine’s own issues, and changes nothing else', () => {
    const before = november();
    const after = withLargeUnclassified(before, history);

    const bucket = after.buckets[0];
    const original = before.buckets[0];
    if (bucket === undefined || original === undefined) throw new Error('expected a bucket');
    expect(bucket.issues.map((i) => i.key)).toEqual([...original.issues.map((i) => i.key), 'large_unclassified']);

    // Everything but the appended issue is the engine's, unchanged.
    expect({ ...bucket, issues: bucket.issues.slice(0, -1) }).toEqual(original);
    expect(after.monthStatus).toBe(before.monthStatus);
    expect(bucket.status).toBe('reliable');
    expect(bucket.totals.unclassified?.toString()).toBe('100');
  });

  it('raises it once, however many times the month passes through', () => {
    const twice = withLargeUnclassified(withLargeUnclassified(november(), history), history);
    expect(twice.buckets[0]?.issues.filter((i) => i.key === 'large_unclassified')).toHaveLength(1);
  });

  it('leaves a month alone when the baseline does not reach three', () => {
    const before = november();
    expect(withLargeUnclassified(before, history.slice(1))).toEqual(before);
  });

  it('reads the month’s own buckets as observations', () => {
    expect(bucketObservations(november())).toEqual([
      { month: NOVEMBER, currency: 'EUR', status: 'reliable', unclassified: new Decimal('100') },
    ]);
  });
});
