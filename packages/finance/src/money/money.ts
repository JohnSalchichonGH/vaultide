import { D, Decimal, ROUND_HALF_UP, toPlainString } from '../decimal';
import type { DecimalInput } from '../decimal';
import {
  assertMinorUnits,
  currencyCode,
  CurrencyMismatchError,
  type CurrencyCode,
  type MinorUnits,
  type Money,
  type MoneyDto,
} from './types';

/** Build a Money value. Amounts arrive as exact decimal strings. */
export function money(amount: DecimalInput, currency: CurrencyCode | string): Money {
  // `currencyCode` validates and returns the same string, so an already-branded
  // code passes through unchanged and a raw string is checked exactly once.
  return { amount: D(amount), currency: currencyCode(currency) };
}

export function zero(currency: CurrencyCode | string): Money {
  return money('0', currency);
}

function sameCurrency(a: Money, b: Money): CurrencyCode {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
  return a.currency;
}

export function add(a: Money, b: Money): Money {
  const currency = sameCurrency(a, b);
  return { amount: a.amount.plus(b.amount), currency };
}

export function sub(a: Money, b: Money): Money {
  const currency = sameCurrency(a, b);
  return { amount: a.amount.minus(b.amount), currency };
}

/** Multiply money by a dimensionless factor (a rate, a weight, a count). */
export function mul(m: Money, factor: DecimalInput): Money {
  return { amount: m.amount.times(D(factor)), currency: m.currency };
}

/** Divide money by a dimensionless divisor. */
export function div(m: Money, divisor: DecimalInput): Money {
  const d = D(divisor);
  if (d.isZero()) throw new RangeError('Division of money by zero.');
  return { amount: m.amount.dividedBy(d), currency: m.currency };
}

export function neg(m: Money): Money {
  return { amount: m.amount.negated(), currency: m.currency };
}

export function abs(m: Money): Money {
  return { amount: m.amount.absoluteValue(), currency: m.currency };
}

export function isZero(m: Money): boolean {
  return m.amount.isZero();
}

export function isNegative(m: Money): boolean {
  return m.amount.isNegative() && !m.amount.isZero();
}

export function isPositive(m: Money): boolean {
  return m.amount.isPositive() && !m.amount.isZero();
}

/** −1, 0 or 1. Throws on a currency mismatch: unlike amounts are not ordered. */
export function cmp(a: Money, b: Money): -1 | 0 | 1 {
  sameCurrency(a, b);
  return a.amount.comparedTo(b.amount) as -1 | 0 | 1;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amount.equals(b.amount);
}

/** Sum a list of same-currency amounts. The currency is explicit so an empty list still has one. */
export function sum(list: readonly Money[], currency: CurrencyCode | string): Money {
  const code = currencyCode(currency);
  let total = new Decimal(0);
  for (const item of list) {
    if (item.currency !== code) throw new CurrencyMismatchError(code, item.currency);
    total = total.plus(item.amount);
  }
  return { amount: total, currency: code };
}

export function min(a: Money, b: Money): Money {
  return cmp(a, b) <= 0 ? a : b;
}

export function max(a: Money, b: Money): Money {
  return cmp(a, b) >= 0 ? a : b;
}

/**
 * Round to the currency's minor units, half-up away from zero.
 * Only ever called at a boundary: persistence of a computed value, or display
 * (blueprint 7.3).
 */
export function roundToMinor(m: Money, minorUnits: number): Money {
  assertMinorUnits(minorUnits);
  return {
    amount: m.amount.toDecimalPlaces(minorUnits, ROUND_HALF_UP),
    currency: m.currency,
  };
}

/** True when the amount has no more decimals than the currency allows (7.2). */
export function fitsMinorUnits(m: Money, minorUnits: number): boolean {
  assertMinorUnits(minorUnits);
  return m.amount.decimalPlaces() <= minorUnits;
}

export function serialize(m: Money): MoneyDto {
  return { amount: toPlainString(m.amount), currency: m.currency };
}

export function parse(dto: MoneyDto): Money {
  return money(dto.amount, dto.currency);
}

/** The exact decimal string of an amount, padded to the currency's minor units. */
export function toMinorUnitString(m: Money, minorUnits: MinorUnits): string {
  return roundToMinor(m, minorUnits).amount.toFixed(minorUnits);
}
