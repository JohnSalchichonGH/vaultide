import { describe, expect, it } from 'vitest';
import {
  abs,
  aggregateValue,
  assertMinorUnits,
  currencyCode,
  CurrencyMismatchError,
  endOfMonthKey,
  FloatBackend,
  fixedClock,
  InvalidCurrencyCodeError,
  InvalidMinorUnitsError,
  InvalidPlainDateError,
  isCurrencyCode,
  isLeapYear,
  isNegative,
  isPositionKind,
  isPositive,
  isZero,
  max,
  min,
  maxDate,
  minDate,
  minorUnits,
  money,
  monthKeyOf,
  MoneyBag,
  partial,
  plainDate,
  serialize,
  sum,
  startOfMonthKey,
  systemClock,
  toPlainString,
  D,
} from '../../src/index';

const eur = (amount: string) => money(amount, 'EUR');

describe('currency codes', () => {
  it('accepts ISO alphabetic codes and rejects everything else', () => {
    expect(currencyCode('EUR')).toBe('EUR');
    expect(isCurrencyCode('CLF')).toBe(true);
    expect(isCurrencyCode('eur')).toBe(false);
    expect(isCurrencyCode('EURO')).toBe(false);
    expect(() => currencyCode('eur')).toThrow(InvalidCurrencyCodeError);
    expect(() => currencyCode('')).toThrow(InvalidCurrencyCodeError);
  });

  it('names both currencies when they are mixed', () => {
    const error = new CurrencyMismatchError(currencyCode('EUR'), currencyCode('USD'));
    expect(error.message).toContain('EUR');
    expect(error.message).toContain('USD');
    expect(error.code).toBe('CURRENCY_MISMATCH');
  });
});

describe('minor units', () => {
  it('accepts 0 through 8 and rejects anything else', () => {
    expect(minorUnits(0)).toBe(0);
    expect(minorUnits(4)).toBe(4);
    expect(minorUnits(8)).toBe(8);
    expect(() => minorUnits(9)).toThrow(InvalidMinorUnitsError);
    expect(() => minorUnits(-1)).toThrow(InvalidMinorUnitsError);
    expect(() => minorUnits(2.5)).toThrow(InvalidMinorUnitsError);
    expect(() => {
      assertMinorUnits(3);
    }).not.toThrow();
  });
});

describe('money predicates and ordering', () => {
  it('reports sign and zero without arithmetic surprises', () => {
    expect(isZero(eur('0'))).toBe(true);
    expect(isZero(eur('-0.00'))).toBe(true);
    expect(isPositive(eur('0'))).toBe(false);
    expect(isNegative(eur('0'))).toBe(false);
    expect(isPositive(eur('0.01'))).toBe(true);
    expect(isNegative(eur('-0.01'))).toBe(true);
    expect(serialize(abs(eur('-729.01'))).amount).toBe('729.01');
  });

  it('orders same-currency amounts and refuses to order unlike ones', () => {
    expect(serialize(min(eur('1'), eur('2'))).amount).toBe('1');
    expect(serialize(max(eur('1'), eur('2'))).amount).toBe('2');
    expect(serialize(min(eur('2'), eur('1'))).amount).toBe('1');
    expect(serialize(max(eur('2'), eur('1'))).amount).toBe('2');
    expect(() => min(eur('1'), money('1', 'USD'))).toThrow(CurrencyMismatchError);
    // Equal amounts resolve deterministically to the first argument.
    expect(serialize(min(eur('1'), eur('1'))).amount).toBe('1');
    expect(serialize(max(eur('1'), eur('1'))).amount).toBe('1');
  });
});

describe('branded currency inputs', () => {
  it('accepts an already-branded code as well as a plain string', () => {
    const code = currencyCode('EUR');
    expect(serialize(money('1', code)).currency).toBe('EUR');
    expect(serialize(new MoneyBag().add(money('2', code)).get(code)).amount).toBe('2');
    expect(serialize(sum([money('3', code)], code)).amount).toBe('3');

    const converted = MoneyBag.from([money('4', code)]).convert(code, (from) => from);
    expect(serialize(converted as ReturnType<typeof money>).amount).toBe('4');
  });
});

describe('Decimal helpers', () => {
  it('serializes without exponential notation at either extreme', () => {
    expect(toPlainString(D('0.00000001'))).toBe('0.00000001');
    expect(toPlainString(D('1e20'))).toBe('100000000000000000000');
    expect(toPlainString(D(5))).toBe('5');
  });
});

describe('MoneyBag', () => {
  it('accepts a batch of amounts', () => {
    const bag = new MoneyBag().addAll([eur('1'), eur('2'), money('3', 'USD')]);
    expect(serialize(bag.get('EUR')).amount).toBe('3');
    expect(serialize(bag.get('USD')).amount).toBe('3');
    expect(bag.entries()).toHaveLength(2);
  });
});

describe('aggregates', () => {
  it('exposes the value of a partial aggregate as well as a complete one', () => {
    expect(aggregateValue(partial(42, 1, ['fx_missing']))).toBe(42);
    expect(aggregateValue(42)).toBe(42);
  });
});

describe('calendar helpers', () => {
  it('knows leap years', () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2026)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(isLeapYear(1900)).toBe(false);
  });

  it('addresses months by their first day', () => {
    const september = monthKeyOf(2026, 9);
    expect(september).toBe('2026-09-01');
    expect(startOfMonthKey(september)).toBe('2026-09-01');
    expect(endOfMonthKey(september)).toBe('2026-09-30');
    expect(endOfMonthKey(monthKeyOf(2024, 2))).toBe('2024-02-29');
  });

  it('orders dates in both directions', () => {
    const early = plainDate('2026-09-06');
    const late = plainDate('2026-09-30');
    expect(minDate(late, early)).toBe(early);
    expect(maxDate(early, late)).toBe(late);
    expect(minDate(early, early)).toBe(early);
    expect(maxDate(late, late)).toBe(late);
  });

  it('rejects a value that was never a calendar date', () => {
    expect(() => plainDate('2026-02-30')).toThrow(InvalidPlainDateError);
  });
});

describe('clocks', () => {
  it('the system clock advances and a fixed clock does not', () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);

    const frozen = fixedClock(new Date('2026-09-06T12:00:00Z'));
    expect(frozen.now().toISOString()).toBe('2026-09-06T12:00:00.000Z');
    // A caller cannot mutate the clock's instant through the value it returns.
    frozen.now().setFullYear(1999);
    expect(frozen.now().toISOString()).toBe('2026-09-06T12:00:00.000Z');
  });
});

describe('position kinds', () => {
  it('recognizes only the kinds the schema defines', () => {
    expect(isPositionKind('cash')).toBe(true);
    expect(isPositionKind('liability')).toBe(true);
    expect(isPositionKind('crypto')).toBe(false);
    expect(isPositionKind('')).toBe(false);
  });
});

describe('float backend edge cases', () => {
  it('reports non-finite results honestly rather than as a number', () => {
    expect(FloatBackend.toDecimalString(FloatBackend.div(1, 0))).toBe('Infinity');
    expect(FloatBackend.toDecimalString(FloatBackend.div(0, 0))).toBe('NaN');
    expect(FloatBackend.toDecimalString(FloatBackend.from('2.5'))).toBe('2.5');
  });
});
