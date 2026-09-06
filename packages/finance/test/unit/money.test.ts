import { describe, expect, it } from 'vitest';
import {
  add,
  allocate,
  cmp,
  CurrencyMismatchError,
  div,
  equals,
  fitsMinorUnits,
  MoneyBag,
  money,
  mul,
  neg,
  parse,
  reconcileRoundedParts,
  roundToMinor,
  serialize,
  sub,
  sum,
  toMinorUnitString,
  unavailable,
  zero,
  type Money,
} from '../../src/index';

const eur = (amount: string): Money => money(amount, 'EUR');

describe('Money arithmetic', () => {
  it('proves 0.1 + 0.2 = 0.3 exactly (Phase 0 acceptance)', () => {
    const total = add(eur('0.1'), eur('0.2'));
    expect(serialize(total).amount).toBe('0.3');
    expect(equals(total, eur('0.3'))).toBe(true);
    // The float path this replaces would have produced 0.30000000000000004.
    expect(serialize(total).amount).not.toBe('0.30000000000000004');
  });

  it('adds and subtracts exactly at magnitudes a double cannot hold', () => {
    const big = eur('12345678901234567.89');
    // serialize() emits the canonical plain string, so a trailing zero is dropped.
    expect(serialize(add(big, eur('0.01'))).amount).toBe('12345678901234567.9');
    expect(toMinorUnitString(add(big, eur('0.01')), 2)).toBe('12345678901234567.90');
    expect(serialize(sub(big, eur('12345678901234567.88'))).amount).toBe('0.01');
  });

  it('refuses to mix currencies', () => {
    expect(() => add(eur('1'), money('1', 'USD'))).toThrow(CurrencyMismatchError);
    expect(() => sub(eur('1'), money('1', 'USD'))).toThrow(CurrencyMismatchError);
    expect(() => cmp(eur('1'), money('1', 'USD'))).toThrow(CurrencyMismatchError);
    expect(() => sum([eur('1'), money('1', 'USD')], 'EUR')).toThrow(CurrencyMismatchError);
  });

  it('multiplies, divides and negates without intermediate rounding', () => {
    const third = div(eur('1'), '3');
    // 40 significant digits, no rounding inside the engine (7.3.1).
    expect(serialize(third).amount.startsWith('0.3333333333333333333333333333333333333333')).toBe(
      true,
    );
    expect(serialize(mul(third, '3')).amount).toBe('0.9999999999999999999999999999999999999999');
    expect(serialize(neg(eur('4.20'))).amount).toBe('-4.2');
    expect(() => div(eur('1'), '0')).toThrow(RangeError);
  });

  it('rounds half-up away from zero at boundaries only', () => {
    expect(toMinorUnitString(eur('2.345'), 2)).toBe('2.35');
    expect(toMinorUnitString(eur('2.344'), 2)).toBe('2.34');
    expect(toMinorUnitString(eur('-2.345'), 2)).toBe('-2.35');
    expect(toMinorUnitString(money('2.5', 'JPY'), 0)).toBe('3');
    expect(serialize(roundToMinor(money('1.23456', 'CLF'), 4)).amount).toBe('1.2346');
  });

  it('round-trips through the DTO representation', () => {
    const original = eur('12345678901234567.89');
    expect(serialize(parse(serialize(original)))).toEqual({
      amount: '12345678901234567.89',
      currency: 'EUR',
    });
  });

  it('validates input scale against the currency minor units (7.2)', () => {
    expect(fitsMinorUnits(eur('1.23'), 2)).toBe(true);
    expect(fitsMinorUnits(eur('1.234'), 2)).toBe(false);
    expect(fitsMinorUnits(money('1.2345', 'CLF'), 4)).toBe(true);
    expect(fitsMinorUnits(money('1', 'JPY'), 0)).toBe(true);
    expect(fitsMinorUnits(money('1.5', 'JPY'), 0)).toBe(false);
  });

  it('sums an empty list to a typed zero', () => {
    expect(serialize(sum([], 'EUR'))).toEqual({ amount: '0', currency: 'EUR' });
    expect(equals(sum([], 'EUR'), zero('EUR'))).toBe(true);
  });
});

describe('allocate', () => {
  it('splits with largest remainder so the parts sum exactly', () => {
    const parts = allocate(eur('100'), [1, 1, 1], 2);
    expect(parts.map((part) => serialize(part).amount)).toEqual(['33.34', '33.33', '33.33']);
    expect(serialize(sum(parts, 'EUR')).amount).toBe('100');
  });

  it('handles weighted splits and negative totals', () => {
    const weighted = allocate(eur('0.05'), [3, 1], 2);
    expect(weighted.map((part) => serialize(part).amount)).toEqual(['0.04', '0.01']);

    const negative = allocate(eur('-100'), [1, 1, 1], 2);
    expect(serialize(sum(negative, 'EUR')).amount).toBe('-100');
  });

  it('respects the currency quantum', () => {
    const jpy = allocate(money('10', 'JPY'), [1, 1, 1], 0);
    expect(jpy.map((part) => serialize(part).amount)).toEqual(['4', '3', '3']);

    const clf = allocate(money('1', 'CLF'), [1, 1, 1], 4);
    expect(clf.map((part) => serialize(part).amount)).toEqual(['0.3334', '0.3333', '0.3333']);
  });

  it('rejects impossible inputs', () => {
    expect(() => allocate(eur('1'), [], 2)).toThrow(RangeError);
    expect(() => allocate(eur('1'), [0, 0], 2)).toThrow(RangeError);
    expect(() => allocate(eur('1'), [-1, 2], 2)).toThrow(RangeError);
  });
});

describe('reconcileRoundedParts', () => {
  it('makes displayed parts sum to the displayed total (7.3.5)', () => {
    const parts = [eur('33.333'), eur('33.333'), eur('33.334')];
    const rounded = reconcileRoundedParts(parts, eur('100'), 2);
    expect(rounded.map((part) => serialize(part).amount)).toEqual(['33.33', '33.33', '33.34']);
    expect(serialize(sum(rounded, 'EUR')).amount).toBe('100');
  });

  it('puts the residual in the designated component', () => {
    const parts = [eur('0.005'), eur('0.005')];
    const rounded = reconcileRoundedParts(parts, eur('0.01'), 2, 0);
    expect(rounded.map((part) => serialize(part).amount)).toEqual(['0', '0.01']);
    expect(serialize(sum(rounded, 'EUR')).amount).toBe('0.01');
  });

  it('rejects mismatched currencies and bad indexes', () => {
    expect(() => reconcileRoundedParts([money('1', 'USD')], eur('1'), 2)).toThrow(RangeError);
    expect(() => reconcileRoundedParts([eur('1')], eur('1'), 2, 5)).toThrow(RangeError);
    expect(reconcileRoundedParts([], eur('0'), 2)).toEqual([]);
  });
});

describe('MoneyBag', () => {
  it('keeps currencies apart until something converts them', () => {
    const bag = MoneyBag.from([eur('10'), money('5', 'USD'), eur('2.5')]);
    expect(bag.currencies()).toEqual(['EUR', 'USD']);
    expect(serialize(bag.get('EUR')).amount).toBe('12.5');
    expect(serialize(bag.get('GBP')).amount).toBe('0');
    expect(bag.isEmpty()).toBe(false);
    expect(new MoneyBag().isEmpty()).toBe(true);
  });

  it('reports a partial aggregate when a bucket cannot be converted', () => {
    const bag = MoneyBag.from([eur('10'), money('5', 'USD')]);
    const result = bag.convert('EUR', () => unavailable('fx_missing'));
    expect(result).toMatchObject({ kind: 'partial', missingCount: 1, reasons: ['fx_missing'] });
    if ('value' in result) expect(serialize(result.value).amount).toBe('10');
  });

  it('returns a complete aggregate when every bucket converts', () => {
    const bag = MoneyBag.from([eur('10'), money('5', 'USD')]);
    const result = bag.convert('EUR', (from) => mul(money(from.amount, 'EUR'), '0.9'));
    expect('kind' in result).toBe(false);
    expect(serialize(result as Money).amount).toBe('14.5');
  });
});
