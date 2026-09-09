import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/decimal';
import { addMonths, monthKey, monthKeyOf, startOfMonthKey, type MonthKey } from '../../src/dates/plain-date';
import { currencyCode, money } from '../../src/money/index';
import type { ReconciliationStatus } from '../../src/reconciliation/index';
import {
  buildRollingTrackedSpendingSeries,
  isRollingEligible,
  ROLLING_WINDOWS,
  type ReportingAvailability,
  type RollingAverage,
  type RollingTrackedSpendingObservation,
  type RollingTrackedSpendingPoint,
  type RollingWindow,
} from '../../src/reporting/index';

/**
 * Invariants of rolling tracked spending (v2.1.12 30.15 item 5, v2.1.13 30.16
 * item 11).
 *
 * Five statements that must hold for any series at all: only the `N` calendar
 * months ending at `M` are read; an ineligible month's value is never read; the
 * mean is the exact unweighted mean of what survived; the count is exactly the
 * number of survivors, bounded by the window; and a qualifying zero is a
 * survivor like any other.
 */

const EUR = currencyCode('EUR');
const FIRST = monthKeyOf(2024, 1);
const LENGTH = 18;
const shift = (month: MonthKey, count: number): MonthKey =>
  monthKey(addMonths(startOfMonthKey(month), count));
const MONTHS: MonthKey[] = Array.from({ length: LENGTH }, (_, index) => shift(FIRST, index));

const STATUSES: ReconciliationStatus[] = ['reliable', 'estimated', 'provisional', 'unavailable', 'unresolved'];
const AVAILABILITIES: ReportingAvailability[] = ['available', 'partial', 'unavailable'];

/** Two fractional digits and small, so sums are exact and quotients are legible. */
const amountArb = fc
  .tuple(fc.integer({ min: 0, max: 5_000 }), fc.integer({ min: 0, max: 99 }))
  .map(([whole, cents]) => `${String(whole)}.${String(cents).padStart(2, '0')}`);

const observationArb = (month: MonthKey): fc.Arbitrary<RollingTrackedSpendingObservation> =>
  fc
    .record({
      // Reliable and available more often than not, so windows are rarely empty.
      monthStatus: fc.oneof(
        { weight: 3, arbitrary: fc.constant<ReconciliationStatus>('reliable') },
        { weight: 1, arbitrary: fc.constantFrom(...STATUSES) },
      ),
      availability: fc.oneof(
        { weight: 3, arbitrary: fc.constant<ReportingAvailability>('available') },
        { weight: 1, arbitrary: fc.constantFrom(...AVAILABILITIES) },
      ),
      amount: amountArb,
    })
    .map(({ monthStatus, availability, amount }) => ({
      month,
      monthStatus,
      trackedTotalSpending: { value: money(amount, EUR), availability },
    }));

/** Eighteen consecutive months, one observation each, in order. */
const seriesArb: fc.Arbitrary<RollingTrackedSpendingObservation[]> = fc.tuple(
  ...MONTHS.map(observationArb),
);

/** A display month with at least eleven months of history before it. */
const displayIndexArb = fc.integer({ min: 11, max: LENGTH - 1 });
const windowArb = fc.constantFrom<RollingWindow>(...ROLLING_WINDOWS);

const pointFor = (series: readonly RollingTrackedSpendingObservation[], month: MonthKey): RollingTrackedSpendingPoint => {
  const [point] = buildRollingTrackedSpendingSeries(series, { from: month, to: month });
  if (point === undefined) throw new Error('expected a point');
  return point;
};

const windowOf = (point: RollingTrackedSpendingPoint, size: RollingWindow): RollingAverage | null =>
  size === 3 ? point.rolling3 : size === 6 ? point.rolling6 : point.rolling12;

const serialized = (average: RollingAverage | null): string =>
  average === null ? 'null' : `${average.value.amount.toString()}#${String(average.count)}`;

/** Replace one observation's value, leaving everything else as it was. */
function withAmount(
  series: readonly RollingTrackedSpendingObservation[],
  index: number,
  amount: string,
): RollingTrackedSpendingObservation[] {
  return series.map((observation, position) =>
    position === index
      ? { ...observation, trackedTotalSpending: { ...observation.trackedTotalSpending, value: money(amount, EUR) } }
      : observation,
  );
}

describe('property P1: only the N calendar months ending at M are read', () => {
  it('is unchanged by any observation earlier than M−(N−1), whatever it says', () => {
    fc.assert(
      fc.property(seriesArb, displayIndexArb, windowArb, amountArb, (series, index, size, amount) => {
        const month = MONTHS[index] as MonthKey;
        const before = serialized(windowOf(pointFor(series, month), size));

        // Every month before the window, one at a time, given a different value
        // — and made reliable and available too, so the change is one the
        // window would certainly have noticed had it been looking.
        for (let earlier = 0; earlier < index - (size - 1); earlier += 1) {
          const changed = withAmount(series, earlier, amount).map((observation, position) =>
            position === earlier
              ? { ...observation, monthStatus: 'reliable' as const, trackedTotalSpending: { ...observation.trackedTotalSpending, availability: 'available' as const } }
              : observation,
          );
          expect(serialized(windowOf(pointFor(changed, month), size))).toBe(before);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('is unchanged by any observation later than M', () => {
    fc.assert(
      fc.property(seriesArb, displayIndexArb, windowArb, amountArb, (series, index, size, amount) => {
        const month = MONTHS[index] as MonthKey;
        const before = serialized(windowOf(pointFor(series, month), size));
        for (let later = index + 1; later < LENGTH; later += 1) {
          expect(serialized(windowOf(pointFor(withAmount(series, later, amount), month), size))).toBe(before);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('property P2: an ineligible month’s value is never read', () => {
  it('is unchanged by the value of any month in the window that does not qualify', () => {
    fc.assert(
      fc.property(seriesArb, displayIndexArb, windowArb, amountArb, (series, index, size, amount) => {
        const month = MONTHS[index] as MonthKey;
        const before = serialized(windowOf(pointFor(series, month), size));
        for (let inside = index - (size - 1); inside <= index; inside += 1) {
          const observation = series[inside] as RollingTrackedSpendingObservation;
          if (isRollingEligible(observation)) continue;
          expect(serialized(windowOf(pointFor(withAmount(series, inside, amount), month), size))).toBe(before);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('is changed by the value of a qualifying month, so the statement above is not vacuous', () => {
    fc.assert(
      fc.property(seriesArb, displayIndexArb, windowArb, (series, index, size) => {
        const month = MONTHS[index] as MonthKey;
        const eligible: number[] = [];
        for (let inside = index - (size - 1); inside <= index; inside += 1) {
          if (isRollingEligible(series[inside] as RollingTrackedSpendingObservation)) eligible.push(inside);
        }
        fc.pre(eligible.length > 0);
        const target = eligible[0] as number;
        const before = windowOf(pointFor(series, month), size);
        const current = (series[target] as RollingTrackedSpendingObservation).trackedTotalSpending.value.amount;
        // Move one survivor by exactly `count`, which moves the mean by exactly 1.
        const moved = withAmount(series, target, current.plus(before?.count ?? 0).toString());
        const after = windowOf(pointFor(moved, month), size);
        expect(after?.value.amount.minus(before?.value.amount ?? 0).toString()).toBe('1');
      }),
      { numRuns: 200 },
    );
  });
});

describe('property P3: the mean is the exact unweighted mean of the survivors', () => {
  it('equals the sum of qualifying values divided by their number, at working precision', () => {
    fc.assert(
      fc.property(seriesArb, displayIndexArb, windowArb, (series, index, size) => {
        const month = MONTHS[index] as MonthKey;
        const survivors: Decimal[] = [];
        for (let inside = index - (size - 1); inside <= index; inside += 1) {
          const observation = series[inside] as RollingTrackedSpendingObservation;
          if (isRollingEligible(observation)) survivors.push(observation.trackedTotalSpending.value.amount);
        }
        const result = windowOf(pointFor(series, month), size);
        if (survivors.length === 0) {
          expect(result).toBeNull();
          return;
        }
        // Same operation, same precision, no rounding on either side.
        const expected = survivors.reduce((total, v) => total.plus(v), new Decimal(0)).dividedBy(survivors.length);
        expect(result?.value.amount.equals(expected)).toBe(true);
        expect(result?.value.currency).toBe(EUR);
      }),
      { numRuns: 200 },
    );
  });

  it('gives every survivor weight one: permuting values within the window changes nothing', () => {
    fc.assert(
      fc.property(seriesArb, displayIndexArb, windowArb, (series, index, size) => {
        const month = MONTHS[index] as MonthKey;
        const eligible: number[] = [];
        for (let inside = index - (size - 1); inside <= index; inside += 1) {
          if (isRollingEligible(series[inside] as RollingTrackedSpendingObservation)) eligible.push(inside);
        }
        fc.pre(eligible.length >= 2);
        // Rotate the survivors' values one seat along, so a February's amount
        // sits in a March and vice versa. A weighted mean would move.
        const values = eligible.map((i) => (series[i] as RollingTrackedSpendingObservation).trackedTotalSpending.value.amount.toString());
        const rotated = [...values.slice(1), values[0] as string];
        let permuted = series;
        eligible.forEach((i, position) => {
          permuted = withAmount(permuted, i, rotated[position] as string);
        });
        expect(serialized(windowOf(pointFor(permuted, month), size))).toBe(
          serialized(windowOf(pointFor(series, month), size)),
        );
      }),
      { numRuns: 200 },
    );
  });
});

describe('property P4: the count is exactly the number of survivors', () => {
  it('is between one and N when present, equals the survivors, and is absent at zero', () => {
    fc.assert(
      fc.property(seriesArb, displayIndexArb, (series, index) => {
        const month = MONTHS[index] as MonthKey;
        const point = pointFor(series, month);
        for (const size of ROLLING_WINDOWS) {
          let survivors = 0;
          for (let inside = index - (size - 1); inside <= index; inside += 1) {
            if (isRollingEligible(series[inside] as RollingTrackedSpendingObservation)) survivors += 1;
          }
          const result = windowOf(point, size);
          if (survivors === 0) {
            expect(result).toBeNull();
          } else {
            expect(result?.count).toBe(survivors);
            expect(result?.count).toBeGreaterThanOrEqual(1);
            expect(result?.count).toBeLessThanOrEqual(size);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('property P5: a qualifying zero is an observation', () => {
  it('increments the count and enters the mean', () => {
    fc.assert(
      fc.property(seriesArb, displayIndexArb, windowArb, (series, index, size) => {
        const month = MONTHS[index] as MonthKey;
        const before = windowOf(pointFor(series, month), size);

        // Make the display month itself a qualifying zero.
        const zeroed = series.map((observation, position) =>
          position === index
            ? { month: observation.month, monthStatus: 'reliable' as const, trackedTotalSpending: { value: money('0', EUR), availability: 'available' as const } }
            : observation,
        );
        const after = windowOf(pointFor(zeroed, month), size);

        const wasEligible = isRollingEligible(series[index] as RollingTrackedSpendingObservation);
        const previousCount = before?.count ?? 0;
        const previousSum = before === null ? new Decimal(0) : before.value.amount.times(before.count);
        const previousOwn = wasEligible ? (series[index] as RollingTrackedSpendingObservation).trackedTotalSpending.value.amount : new Decimal(0);

        // Count: unchanged if it already qualified, one more if it did not.
        expect(after?.count).toBe(wasEligible ? previousCount : previousCount + 1);
        // Mean: the others' sum, plus zero, over the new count — never absent.
        const othersSum = previousSum.minus(previousOwn);
        const expected = othersSum.dividedBy(after?.count ?? 1);
        // `previousSum` is `mean × count`, a working-precision product of a
        // working-precision quotient, so compare at the same precision the
        // engine produced it at rather than pretending it is rational.
        expect(after?.value.amount.toSignificantDigits(30).equals(expected.toSignificantDigits(30))).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
