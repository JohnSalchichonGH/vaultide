import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/decimal';
import { addMonths, monthKey, monthKeyOf, startOfMonthKey, type MonthKey } from '../../src/dates/plain-date';
import { currencyCode } from '../../src/money/types';
import {
  isLargeUnclassifiedBaseline,
  largeUnclassifiedIssue,
  largeUnclassifiedWindow,
  type LargeUnclassifiedObservation,
  type ReconciliationStatus,
} from '../../src/reconciliation/index';

/**
 * Invariants of `large_unclassified` (v2.1.12 30.15 item 4).
 *
 * Six statements that hold for any history: order is irrelevant; nothing
 * outside `M−6 … M−1` is read; an ineligible month's number is never read; the
 * median is the median; the threshold is strict; and below three observations
 * there is nothing, above it only the threshold decides.
 */

const EUR = currencyCode('EUR');
const USD = currencyCode('USD');
const TARGET = monthKeyOf(2026, 11);
const shift = (month: MonthKey, count: number): MonthKey =>
  monthKey(addMonths(startOfMonthKey(month), count));
const WINDOW = largeUnclassifiedWindow(TARGET);
const OUTSIDE = [shift(TARGET, -9), shift(TARGET, -8), shift(TARGET, -7), shift(TARGET, 1), shift(TARGET, 2)];

const STATUSES: ReconciliationStatus[] = ['reliable', 'estimated', 'unresolved', 'unavailable', 'provisional'];

/** Two decimals, bounded, exact. */
const amountArb = fc
  .tuple(fc.integer({ min: 0, max: 5_000 }), fc.integer({ min: 0, max: 99 }))
  .map(([whole, cents]) => new Decimal(`${String(whole)}.${String(cents).padStart(2, '0')}`));

const observationArb = (month: MonthKey, currency = EUR): fc.Arbitrary<LargeUnclassifiedObservation> =>
  fc
    .record({
      status: fc.oneof(
        { weight: 2, arbitrary: fc.constant<ReconciliationStatus>('reliable') },
        { weight: 1, arbitrary: fc.constantFrom(...STATUSES) },
      ),
      unclassified: fc.option(amountArb, { nil: undefined }),
    })
    .map(({ status, unclassified }) => ({
      month,
      currency,
      status,
      ...(unclassified === undefined ? {} : { unclassified }),
    }));

/** One observation per window month, plus foreign and out-of-window noise. */
const historyArb: fc.Arbitrary<LargeUnclassifiedObservation[]> = fc
  .tuple(
    fc.tuple(...WINDOW.map((m) => observationArb(m))),
    fc.tuple(...WINDOW.map((m) => observationArb(m, USD))),
    fc.tuple(...OUTSIDE.map((m) => observationArb(m))),
  )
  .map(([inside, foreign, outside]) => [...inside, ...foreign, ...outside]);

const targetArb = amountArb.map(
  (unclassified): LargeUnclassifiedObservation => ({ month: TARGET, currency: EUR, status: 'reliable', unclassified }),
);

const baselineOf = (history: readonly LargeUnclassifiedObservation[]): Decimal[] =>
  history
    .filter((o) => o.currency === EUR && WINDOW.includes(o.month) && isLargeUnclassifiedBaseline(o))
    .map((o) => o.unclassified as Decimal);

/**
 * An independent median: the middle by index after a comparator sort, and for
 * an even count the lower middle plus half the gap — a different formula from
 * the production helper's mean of the two, that must agree with it exactly.
 */
function referenceMedian(values: readonly Decimal[]): Decimal {
  const sorted = [...values].sort((a, b) => (a.lessThan(b) ? -1 : a.greaterThan(b) ? 1 : 0));
  const n = sorted.length;
  if (n % 2 === 1) return sorted[(n - 1) / 2] as Decimal;
  const lower = sorted[n / 2 - 1] as Decimal;
  const upper = sorted[n / 2] as Decimal;
  return lower.plus(upper.minus(lower).dividedBy(2));
}

const serialized = (issue: ReturnType<typeof largeUnclassifiedIssue>): string =>
  issue === undefined ? 'absent' : `${issue.key}:${issue.currency ?? ''}:${issue.amount?.toString() ?? ''}`;

function withValue(
  history: readonly LargeUnclassifiedObservation[],
  index: number,
  unclassified: Decimal,
): LargeUnclassifiedObservation[] {
  return history.map((o, position) => (position === index ? { ...o, unclassified } : o));
}

describe('property P1: input order is irrelevant', () => {
  it('gives the same answer for any permutation of the history', () => {
    fc.assert(
      fc.property(historyArb, targetArb, fc.array(fc.nat(), { minLength: 20, maxLength: 20 }), (history, target, seeds) => {
        const before = serialized(largeUnclassifiedIssue(target, history));
        // A deterministic shuffle driven by the generated seeds.
        const shuffled = [...history];
        for (let i = shuffled.length - 1; i > 0; i -= 1) {
          const j = (seeds[i % seeds.length] ?? 0) % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j] as LargeUnclassifiedObservation, shuffled[i] as LargeUnclassifiedObservation];
        }
        expect(serialized(largeUnclassifiedIssue(target, shuffled))).toBe(before);
      }),
      { numRuns: 200 },
    );
  });
});

describe('property P2: nothing outside M−6 … M−1 is read', () => {
  it('is unchanged by any observation before the window or at/after the target', () => {
    fc.assert(
      fc.property(historyArb, targetArb, amountArb, (history, target, amount) => {
        const before = serialized(largeUnclassifiedIssue(target, history));
        history.forEach((o, index) => {
          if (WINDOW.includes(o.month)) return;
          // Made reliable and given a new value: the strongest change a
          // baseline month could undergo, on a month that is not one.
          const changed = history.map((h, position) =>
            position === index ? { ...h, status: 'reliable' as const, unclassified: amount } : h,
          );
          expect(serialized(largeUnclassifiedIssue(target, changed))).toBe(before);
        });
      }),
      { numRuns: 200 },
    );
  });

  it('never lets M−7 fill a missing slot', () => {
    fc.assert(
      fc.property(amountArb, amountArb, amountArb, (a, b, c) => {
        // Two reliable months in the window, one reliable just outside it.
        const history: LargeUnclassifiedObservation[] = [
          { month: shift(TARGET, -7), currency: EUR, status: 'reliable', unclassified: a },
          { month: shift(TARGET, -6), currency: EUR, status: 'reliable', unclassified: b },
          { month: shift(TARGET, -3), currency: EUR, status: 'reliable', unclassified: c },
        ];
        const target: LargeUnclassifiedObservation = {
          month: TARGET, currency: EUR, status: 'reliable', unclassified: new Decimal('1000000'),
        };
        expect(largeUnclassifiedIssue(target, history)).toBeUndefined();
      }),
      { numRuns: 200 },
    );
  });
});

describe('property P3: an ineligible month’s number is never read', () => {
  it('is unchanged by the value of any non-reliable or foreign observation in the window', () => {
    fc.assert(
      fc.property(historyArb, targetArb, amountArb, (history, target, amount) => {
        const before = serialized(largeUnclassifiedIssue(target, history));
        history.forEach((o, index) => {
          if (!WINDOW.includes(o.month)) return;
          if (o.currency === EUR && o.status === 'reliable') return;
          expect(serialized(largeUnclassifiedIssue(target, withValue(history, index, amount)))).toBe(before);
        });
      }),
      { numRuns: 200 },
    );
  });
});

describe('property P4: the median is the median', () => {
  it('agrees with an independent reference for three to six reliable values', () => {
    fc.assert(
      fc.property(fc.array(amountArb, { minLength: 3, maxLength: 6 }), (values) => {
        const history = values.map((unclassified, index) => ({
          month: WINDOW[index] as MonthKey, currency: EUR, status: 'reliable' as const, unclassified,
        }));
        const median = referenceMedian(values);
        const twice = median.times(2);
        // At exactly twice the reference median: absent. Just above: present.
        // Both readings must hold, which pins the production median to the
        // reference one from both sides.
        const at = { month: TARGET, currency: EUR, status: 'reliable' as const, unclassified: twice };
        const above = { ...at, unclassified: twice.plus('0.01') };
        expect(largeUnclassifiedIssue(at, history)).toBeUndefined();
        expect(largeUnclassifiedIssue(above, history)?.amount?.equals(twice.plus('0.01'))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

describe('property P5: the threshold is strict', () => {
  it('is absent at exactly twice the median and present any positive distance above', () => {
    fc.assert(
      fc.property(historyArb, fc.integer({ min: 1, max: 1_000_000 }), (history, deltaUnits) => {
        const baseline = baselineOf(history);
        fc.pre(baseline.length >= 3);
        const twice = referenceMedian(baseline).times(2);
        const delta = new Decimal(deltaUnits).dividedBy(100_000_000); // ≥ 1e-8
        const at = { month: TARGET, currency: EUR, status: 'reliable' as const, unclassified: twice };
        const above = { ...at, unclassified: twice.plus(delta) };
        expect(largeUnclassifiedIssue(at, history)).toBeUndefined();
        expect(largeUnclassifiedIssue(above, history)).toBeDefined();
      }),
      { numRuns: 200 },
    );
  });
});

describe('property P6: the minimum count, and nothing else below it', () => {
  it('is absent below three observations and decided by the threshold alone from three', () => {
    fc.assert(
      fc.property(historyArb, targetArb, (history, target) => {
        const baseline = baselineOf(history);
        const issue = largeUnclassifiedIssue(target, history);
        if (baseline.length < 3) {
          expect(issue).toBeUndefined();
          return;
        }
        const expected = (target.unclassified as Decimal).greaterThan(referenceMedian(baseline).times(2));
        expect(issue !== undefined).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });
});
