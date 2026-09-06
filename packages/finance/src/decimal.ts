import DecimalJs from 'decimal.js';

/**
 * Package-local Decimal constructor (blueprint 7.1).
 *
 * Cloned so third-party code can never change the configuration the finance
 * engines rely on: 40 significant digits, half-up rounding (away from zero),
 * and exponential notation pushed far enough out that every money value we
 * serialize is a plain decimal string.
 */
export const Decimal = DecimalJs.clone({
  precision: 40,
  rounding: DecimalJs.ROUND_HALF_UP,
  toExpNeg: -30,
  toExpPos: 40,
});

export type Decimal = InstanceType<typeof Decimal>;

/** Rounding mode used everywhere money is rounded (blueprint 7.3.6). */
export const ROUND_HALF_UP = DecimalJs.ROUND_HALF_UP;

/** A value that can be turned into a Decimal without going through `number`. */
export type DecimalInput = Decimal | string | number;

/** Construct a Decimal. Strings are the only lossless input for money. */
export function D(value: DecimalInput): Decimal {
  return value instanceof Decimal ? value : new Decimal(value);
}

/**
 * Serialize a Decimal as a plain (never exponential) decimal string.
 * `toFixed()` without arguments keeps every significant digit.
 */
export function toPlainString(value: Decimal): string {
  return value.toFixed();
}
