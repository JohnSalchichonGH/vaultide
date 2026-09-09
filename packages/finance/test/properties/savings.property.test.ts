import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/decimal';
import { currencyCode } from '../../src/money/types';
import { isUnavailable } from '../../src/unavailable';
import type { ReconciliationStatus } from '../../src/reconciliation/index';
import {
  reconcileSavings,
  CostClassificationExceedsKnownError,
  type SavingsInput,
} from '../../src/savings/index';

/**
 * Invariants of the savings decomposition (blueprint 12.3, 12.5, v2.1.12 30.15).
 *
 * These are the statements that must hold for any amounts at all: the cost
 * buckets partition what reconciliation already counted, the setting moves the
 * savings and not the spending, what someone else paid moves nothing, and a
 * classification larger than `ΣK` is refused rather than absorbed.
 *
 * Amounts are exact decimal strings at the storage scale, never floats, so a
 * property that passes here passes on the real numbers.
 */

const EUR = currencyCode('EUR');

const amountArb = fc
  .tuple(fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 0, max: 99_999_999 }))
  .map(([whole, fraction]) => new Decimal(`${String(whole)}.${String(fraction).padStart(8, '0')}`));

/** A signed amount: tracked totals and residuals may be either way round. */
const signedArb = fc
  .tuple(amountArb, fc.boolean())
  .map(([amount, negative]) => (negative ? amount.negated() : amount));

/**
 * A bucket whose spending arithmetic is valid, with a cost classification that
 * genuinely partitions its `ΣK`.
 *
 * The four non-consumption shares are generated as fractions of `ΣK` summing to
 * at most one, so the remainder is never negative and the calculator is being
 * asked a question it can answer.
 */
const validArb = fc
  .tuple(
    amountArb, // ΣK
    fc.array(fc.integer({ min: 0, max: 25 }), { minLength: 4, maxLength: 4 }),
    amountArb, // external income
    signedArb, // unclassified
    amountArb, // additional
    amountArb, // third party
    fc.boolean(),
    fc.constantFrom<ReconciliationStatus>('reliable', 'estimated', 'provisional'),
  )
  .map(
    ([
      knownTrackedExpenses,
      shares,
      externalIncome,
      unclassified,
      additionalSpending,
      thirdPartyPaid,
      countAdditionalSpending,
      status,
    ]): SavingsInput => {
      const share = (index: number): Decimal =>
        knownTrackedExpenses.times(shares[index] ?? 0).dividedBy(100);
      return {
        currency: EUR,
        reconciliation: {
          status,
          knownTrackedExpenses,
          // The identity's own shape: `unclassified = tracked − ΣK`.
          trackedTotalSpending: knownTrackedExpenses.plus(unclassified),
          unclassified,
        },
        externalIncome,
        nonConsumptionCosts: {
          propertyOperatingCosts: share(0),
          interestAndFees: share(1),
          transactionCosts: share(2),
          externalOutflows: share(3),
        },
        additionalSpending,
        thirdPartyPaid,
        countAdditionalSpending,
      };
    },
  );

function nonConsumption(input: SavingsInput): Decimal {
  const c = input.nonConsumptionCosts;
  return c.propertyOperatingCosts
    .plus(c.interestAndFees)
    .plus(c.transactionCosts)
    .plus(c.externalOutflows);
}

describe('property: the cost buckets partition what reconciliation counted', () => {
  it('sums the known partition back to ΣK exactly', () => {
    fc.assert(
      fc.property(validArb, (input) => {
        const { source } = reconcileSavings(input);
        const total = source.knownConsumption
          .plus(source.propertyOperatingCosts)
          .plus(source.interestAndFees)
          .plus(source.transactionCosts)
          .plus(source.externalOutflows);
        expect(total.equals(input.reconciliation.knownTrackedExpenses)).toBe(true);
      }),
    );
  });

  it('sums the five spending buckets back to TrackedTotalSpending exactly', () => {
    fc.assert(
      fc.property(validArb, (input) => {
        const result = reconcileSavings(input);
        if (result.derived.kind !== 'available') return;
        const { source, derived } = result;
        const total = derived.consumption
          .plus(source.propertyOperatingCosts)
          .plus(source.interestAndFees)
          .plus(source.transactionCosts)
          .plus(source.externalOutflows);
        expect(total.equals(input.reconciliation.trackedTotalSpending ?? new Decimal(0))).toBe(true);
      }),
    );
  });

  it('moves nothing overall when a cost is reclassified out of the remainder', () => {
    fc.assert(
      fc.property(validArb, fc.integer({ min: 0, max: 100 }), (input, share) => {
        const result = reconcileSavings(input);
        if (result.derived.kind !== 'available') return;

        // Reclassify part of the consumption remainder as a fee. Nothing is
        // added: the remainder shrinks by exactly what the fee gains.
        const moved = result.source.knownConsumption.times(share).dividedBy(100);
        const after = reconcileSavings({
          ...input,
          nonConsumptionCosts: {
            ...input.nonConsumptionCosts,
            interestAndFees: input.nonConsumptionCosts.interestAndFees.plus(moved),
          },
        });
        if (after.derived.kind !== 'available') throw new Error('expected available');

        expect(after.source.knownConsumption.plus(moved).equals(result.source.knownConsumption)).toBe(
          true,
        );
        expect(after.derived.totalSpending.equals(result.derived.totalSpending)).toBe(true);
        // Both terms are subtracted by 12.5, so the savings do not move either.
        expect(
          after.derived.trackedSavingsFromIncome.equals(result.derived.trackedSavingsFromIncome),
        ).toBe(true);
      }),
    );
  });

  it('refuses a classification larger than ΣK rather than inventing a negative remainder', () => {
    fc.assert(
      fc.property(validArb, amountArb, (input, excess) => {
        fc.pre(excess.greaterThan(0));
        const over = input.reconciliation.knownTrackedExpenses
          .minus(nonConsumption(input))
          .plus(excess);
        expect(() =>
          reconcileSavings({
            ...input,
            nonConsumptionCosts: {
              ...input.nonConsumptionCosts,
              interestAndFees: input.nonConsumptionCosts.interestAndFees.plus(over),
            },
          }),
        ).toThrow(CostClassificationExceedsKnownError);
      }),
    );
  });
});

describe('property: the setting changes the savings, not the spending', () => {
  it('differs by exactly the additional spending, with total spending identical', () => {
    fc.assert(
      fc.property(validArb, (input) => {
        const counted = reconcileSavings({ ...input, countAdditionalSpending: true });
        const trackedOnly = reconcileSavings({ ...input, countAdditionalSpending: false });
        if (counted.derived.kind !== 'available') return;
        if (trackedOnly.derived.kind !== 'available') throw new Error('expected available');

        expect(
          trackedOnly.derived.personalSavings
            .minus(counted.derived.personalSavings)
            .equals(input.additionalSpending),
        ).toBe(true);
        expect(counted.derived.totalSpending.equals(trackedOnly.derived.totalSpending)).toBe(true);
        expect(counted.source.additionalSpending.equals(trackedOnly.source.additionalSpending)).toBe(
          true,
        );
      }),
    );
  });
});

describe('property: what someone else paid changes nothing', () => {
  it('leaves every savings and spending figure untouched', () => {
    fc.assert(
      fc.property(validArb, amountArb, (input, other) => {
        const before = reconcileSavings(input);
        const after = reconcileSavings({ ...input, thirdPartyPaid: other });
        expect({ ...after.source, thirdPartyPaid: before.source.thirdPartyPaid }).toEqual(
          before.source,
        );
        expect(after.derived).toEqual(before.derived);
      }),
    );
  });
});

describe('property: the rate exists exactly when income does', () => {
  it('is unavailable at zero income and leaves the other figures standing', () => {
    fc.assert(
      fc.property(validArb, (input) => {
        const result = reconcileSavings({ ...input, externalIncome: new Decimal(0) });
        if (result.derived.kind !== 'available') return;
        expect(isUnavailable(result.derived.savingsRate)).toBe(true);
        expect(result.derived.consumption).toBeDefined();
        expect(result.derived.totalSpending).toBeDefined();
      }),
    );
  });

  it('is the exact unrounded quotient whenever income is not zero', () => {
    fc.assert(
      fc.property(validArb, (input) => {
        const result = reconcileSavings(input);
        if (result.derived.kind !== 'available') return;
        const rate = result.derived.savingsRate;
        if (input.externalIncome.equals(0)) {
          expect(isUnavailable(rate)).toBe(true);
          return;
        }
        if (isUnavailable(rate)) throw new Error('expected a rate');
        expect(
          rate.equals(result.derived.personalSavings.dividedBy(input.externalIncome)),
        ).toBe(true);
        // Negative savings give a negative rate; nothing clamps it.
        expect(rate.lessThan(0)).toBe(result.derived.personalSavings.lessThan(0));
      }),
    );
  });
});

describe('property: a bucket without valid arithmetic derives nothing', () => {
  it('keeps every source classification and no derived figure', () => {
    fc.assert(
      fc.property(
        validArb,
        fc.constantFrom<ReconciliationStatus>('unresolved', 'unavailable'),
        (input, status) => {
          const broken = reconcileSavings({
            ...input,
            reconciliation:
              status === 'unresolved'
                ? { ...input.reconciliation, status }
                : { status, knownTrackedExpenses: input.reconciliation.knownTrackedExpenses },
          });
          const whole = reconcileSavings(input);

          expect(broken.source).toEqual(whole.source);
          expect(broken.derived.kind).toBe('unavailable');
          if (broken.derived.kind !== 'unavailable') return;
          expect(broken.derived.because).toBe(
            status === 'unresolved' ? 'unresolved' : 'reconciliation_unavailable',
          );
        },
      ),
    );
  });
});
