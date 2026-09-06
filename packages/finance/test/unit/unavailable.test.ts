import { describe, expect, it } from 'vitest';
import {
  add,
  aggregateValue,
  foldAvailable,
  isPartial,
  isUnavailable,
  money,
  partial,
  serialize,
  unavailable,
  zero,
  type Money,
} from '../../src/index';

describe('Unavailable', () => {
  it('is a value with a reason, never 0 and never null (7.6)', () => {
    const missing = unavailable('fx_missing', 'no USD rate within 10 days');
    expect(isUnavailable(missing)).toBe(true);
    expect(missing.reason).toBe('fx_missing');
    expect(missing.detail).toBe('no USD rate within 10 days');
    expect(missing).not.toBe(0);
    expect(missing).not.toBeNull();
  });

  it('omits an absent detail rather than storing undefined', () => {
    expect(Object.keys(unavailable('no_root'))).toEqual(['kind', 'reason']);
  });

  it('recognizes non-values safely', () => {
    expect(isUnavailable(null)).toBe(false);
    expect(isUnavailable(0)).toBe(false);
    expect(isUnavailable({ kind: 'partial' })).toBe(false);
    expect(isPartial(null)).toBe(false);
    expect(isPartial(partial(1, 1, ['fx_missing']))).toBe(true);
  });
});

describe('aggregation over unavailable items', () => {
  const fold = (items: (Money | ReturnType<typeof unavailable>)[]) =>
    foldAvailable(items, zero('EUR'), (acc, item) => add(acc, item));

  it('produces a complete total when nothing is missing', () => {
    const result = fold([money('10', 'EUR'), money('2.5', 'EUR')]);
    expect(isPartial(result)).toBe(false);
    expect(serialize(aggregateValue(result)).amount).toBe('12.5');
  });

  it('produces a partial total that counts what is missing and why', () => {
    const result = fold([
      money('10', 'EUR'),
      unavailable('fx_missing'),
      unavailable('no_valuation_in_period'),
      unavailable('fx_missing'),
    ]);

    expect(isPartial(result)).toBe(true);
    if (!isPartial<Money>(result)) throw new Error('expected a partial aggregate');
    expect(result.missingCount).toBe(3);
    expect(result.reasons).toEqual(['fx_missing', 'no_valuation_in_period']);
    expect(serialize(result.value).amount).toBe('10');
  });

  it('never silently substitutes zero for a missing item', () => {
    const result = fold([unavailable('fx_missing')]);
    expect(isPartial(result)).toBe(true);
    // The carried value is 0 only because nothing was available to add — and
    // the aggregate says so, which is the whole point.
    if (isPartial<Money>(result)) expect(result.missingCount).toBe(1);
  });
});
