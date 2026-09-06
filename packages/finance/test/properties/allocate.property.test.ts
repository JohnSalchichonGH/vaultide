import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  allocate,
  D,
  ROUND_HALF_UP,
  money,
  reconcileRoundedParts,
  serialize,
  sum,
  type Money,
} from '../../src/index';

/** Amounts as exact decimal strings — never generated as floats. */
const amountArb = fc
  .tuple(fc.integer({ min: -10_000_000, max: 10_000_000 }), fc.integer({ min: 0, max: 99_999_999 }))
  .map(([whole, fraction]) => {
    const sign = whole < 0 ? '-' : '';
    return `${sign}${String(Math.abs(whole))}.${String(fraction).padStart(8, '0')}`;
  });

const minorUnitsArb = fc.constantFrom(0, 2, 3, 4);

describe('property 9: allocate and reconcileRoundedParts sum to their inputs', () => {
  it('allocate: parts sum exactly to the rounded total', () => {
    fc.assert(
      fc.property(
        amountArb,
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 8 }),
        minorUnitsArb,
        (amount, weights, minorUnits) => {
          fc.pre(weights.some((weight) => weight > 0));

          const total = money(amount, 'EUR');
          const parts = allocate(total, weights, minorUnits);

          expect(parts).toHaveLength(weights.length);

          const expected = D(amount).toDecimalPlaces(minorUnits, ROUND_HALF_UP).toFixed();
          expect(serialize(sum(parts, 'EUR')).amount).toBe(expected);

          // Every part is a whole number of minor units.
          for (const part of parts) {
            expect(part.amount.decimalPlaces()).toBeLessThanOrEqual(minorUnits);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('allocate: a zero weight never receives more than one rounding unit', () => {
    fc.assert(
      fc.property(amountArb, minorUnitsArb, (amount, minorUnits) => {
        const total = money(amount, 'EUR');
        const parts = allocate(total, [1, 0], minorUnits);
        const quantum = D(10).pow(-minorUnits);
        expect((parts[1] as Money).amount.abs().lessThanOrEqualTo(quantum)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('reconcileRoundedParts: displayed parts always sum to the displayed total', () => {
    fc.assert(
      fc.property(
        fc.array(amountArb, { minLength: 1, maxLength: 8 }),
        minorUnitsArb,
        (amounts, minorUnits) => {
          const parts = amounts.map((amount) => money(amount, 'EUR'));
          const total = sum(parts, 'EUR');
          const rounded = reconcileRoundedParts(parts, total, minorUnits);

          const expected = total.amount.toDecimalPlaces(minorUnits, ROUND_HALF_UP).toFixed();
          expect(serialize(sum(rounded, 'EUR')).amount).toBe(expected);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('reconcileRoundedParts: only the residual component differs from its own rounding', () => {
    fc.assert(
      fc.property(
        fc.array(amountArb, { minLength: 2, maxLength: 6 }),
        minorUnitsArb,
        (amounts, minorUnits) => {
          const parts = amounts.map((amount) => money(amount, 'EUR'));
          const total = sum(parts, 'EUR');
          const rounded = reconcileRoundedParts(parts, total, minorUnits, 0);

          for (let index = 1; index < parts.length; index += 1) {
            const own = (parts[index] as Money).amount.toDecimalPlaces(minorUnits, ROUND_HALF_UP).toFixed();
            expect((rounded[index] as Money).amount.toFixed()).toBe(own);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
