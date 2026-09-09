import { D, Decimal, ROUND_HALF_UP } from '../decimal';
import type { DecimalInput } from '../decimal';
import { assertMinorUnits, type Money } from './types';

/**
 * Largest-remainder allocation (blueprint 7.6): split `m` across `weights` in
 * whole minor units so the parts sum **exactly** back to `m` rounded to those
 * minor units. No part is ever lost or invented to rounding.
 *
 * Weights may be any non-negative numbers; they are normalized internally.
 */
export function allocate(
  m: Money,
  weights: readonly DecimalInput[],
  minorUnits: number,
): Money[] {
  assertMinorUnits(minorUnits);
  if (weights.length === 0) throw new RangeError('allocate requires at least one weight.');

  const decimalWeights = weights.map((w) => D(w));
  // `lessThan(0)`, not `isNegative()`: a weight of "-0" is zero, and a zero
  // weight is allowed — it simply receives nothing. decimal.js reads the sign
  // bit, so it would have called that weight negative and refused the call.
  if (decimalWeights.some((w) => w.lessThan(0))) {
    throw new RangeError('allocate requires non-negative weights.');
  }

  const totalWeight = decimalWeights.reduce((acc, w) => acc.plus(w), new Decimal(0));
  if (totalWeight.isZero()) throw new RangeError('allocate requires a non-zero total weight.');

  // Work in whole minor units so the sum is exact by construction.
  const quantum = new Decimal(10).pow(minorUnits);
  const totalUnits = m.amount.times(quantum).toDecimalPlaces(0, ROUND_HALF_UP);

  const exact = decimalWeights.map((w) => totalUnits.times(w).dividedBy(totalWeight));
  // Truncate toward zero, then hand out the remaining units by largest remainder.
  const floors = exact.map((value) => value.toDecimalPlaces(0, Decimal.ROUND_DOWN));
  const distributed = floors.reduce((acc, value) => acc.plus(value), new Decimal(0));

  let remaining = totalUnits.minus(distributed);
  const step = remaining.isNegative() ? new Decimal(-1) : new Decimal(1);
  const order = exact
    .map((value, index) => ({ index, remainder: value.minus(floors[index] as Decimal).abs() }))
    .sort((a, b) => {
      const byRemainder = b.remainder.comparedTo(a.remainder);
      return byRemainder !== 0 ? byRemainder : a.index - b.index;
    });

  const units = [...floors];
  let cursor = 0;
  while (!remaining.isZero()) {
    const target = order[cursor % order.length];
    /* v8 ignore next -- `order` has one entry per weight and weights is
       non-empty, so the modulo index always resolves. */
    if (target === undefined) break;
    units[target.index] = (units[target.index] as Decimal).plus(step);
    remaining = remaining.minus(step);
    cursor += 1;
  }

  return units.map((value) => ({
    amount: value.dividedBy(quantum),
    currency: m.currency,
  }));
}

/**
 * Round parts for display so that the displayed parts still sum to the
 * displayed total (blueprint 7.3.5): every part is rounded individually and the
 * residual is added to the designated component.
 */
export function reconcileRoundedParts(
  parts: readonly Money[],
  total: Money,
  minorUnits: number,
  residualIndex = parts.length - 1,
): Money[] {
  assertMinorUnits(minorUnits);
  if (parts.length === 0) return [];
  if (residualIndex < 0 || residualIndex >= parts.length) {
    throw new RangeError('reconcileRoundedParts: residualIndex is out of range.');
  }
  for (const part of parts) {
    if (part.currency !== total.currency) {
      throw new RangeError('reconcileRoundedParts: every part must share the total currency.');
    }
  }

  const rounded = parts.map((part) => part.amount.toDecimalPlaces(minorUnits, ROUND_HALF_UP));
  const roundedTotal = total.amount.toDecimalPlaces(minorUnits, ROUND_HALF_UP);
  const distributed = rounded.reduce((acc, value) => acc.plus(value), new Decimal(0));
  const residual = roundedTotal.minus(distributed);

  rounded[residualIndex] = (rounded[residualIndex] as Decimal).plus(residual);

  return rounded.map((amount) => ({ amount, currency: total.currency }));
}
