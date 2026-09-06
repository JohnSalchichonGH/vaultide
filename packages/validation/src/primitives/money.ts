import { z } from 'zod';

/**
 * Money as an exact decimal **string** (blueprint 7.1, 7.2, 20.1).
 *
 * Validation never parses the value into a JavaScript number: it checks the
 * shape with a regular expression and counts digits, so a 19-significant-digit
 * amount survives the boundary untouched.
 */

/** Storage is NUMERIC(24,8): 16 integer digits, 8 decimals. */
export const MAX_INTEGER_DIGITS = 16;
export const MAX_SCALE = 8;

const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

export interface DecimalParts {
  readonly negative: boolean;
  readonly integer: string;
  readonly fraction: string;
}

export function decimalParts(value: string): DecimalParts | null {
  if (!DECIMAL_PATTERN.test(value)) return null;
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integer = '0', fraction = ''] = unsigned.split('.');
  return { negative, integer, fraction };
}

/** Decimals actually written in the string. */
export function scaleOf(value: string): number {
  return decimalParts(value)?.fraction.length ?? 0;
}

export interface MoneyStringOptions {
  /** Maximum decimals allowed — the currency's minor units (0..8). */
  readonly minorUnits?: number;
  /** Reject negative amounts (most flow amounts; balances may be negative). */
  readonly nonNegative?: boolean;
  /** Reject zero and negatives (amounts that must be strictly positive). */
  readonly positive?: boolean;
}

/**
 * A money string schema. `minorUnits` comes from the `currencies` table, so a
 * EUR field rejects three decimals while a CLF field accepts four.
 */
export function moneyString(options: MoneyStringOptions = {}) {
  const { minorUnits = MAX_SCALE, nonNegative = false, positive = false } = options;

  return z
    .string()
    .trim()
    .superRefine((value, ctx) => {
      const parts = decimalParts(value);
      if (parts === null) {
        ctx.addIssue({
          code: 'custom',
          message: 'Enter an amount using digits and at most one decimal point.',
        });
        return;
      }
      if (parts.integer.length > MAX_INTEGER_DIGITS) {
        ctx.addIssue({
          code: 'custom',
          message: `Amounts may have at most ${String(MAX_INTEGER_DIGITS)} digits before the decimal point.`,
        });
      }
      if (parts.fraction.length > minorUnits) {
        ctx.addIssue({
          code: 'custom',
          message:
            minorUnits === 0
              ? 'This currency has no decimals.'
              : `Use at most ${String(minorUnits)} decimals for this currency.`,
        });
      }
      const isZero = /^0+$/.test(parts.integer) && /^0*$/.test(parts.fraction);
      if ((nonNegative || positive) && parts.negative && !isZero) {
        ctx.addIssue({ code: 'custom', message: 'This amount cannot be negative.' });
      }
      if (positive && isZero) {
        ctx.addIssue({ code: 'custom', message: 'This amount must be greater than zero.' });
      }
    });
}

/** A rate or percentage held as a fraction, e.g. "0.0325" for 3.25 %. */
export function percentFraction(options: { maxScale?: number } = {}) {
  const maxScale = options.maxScale ?? MAX_SCALE;
  return z
    .string()
    .trim()
    .superRefine((value, ctx) => {
      const parts = decimalParts(value);
      if (parts === null) {
        ctx.addIssue({ code: 'custom', message: 'Enter a rate as a decimal fraction.' });
        return;
      }
      if (parts.fraction.length > maxScale) {
        ctx.addIssue({
          code: 'custom',
          message: `Use at most ${String(maxScale)} decimals for a rate.`,
        });
      }
    });
}

/** The DTO shape money takes when it crosses the server/client boundary (7.1). */
export const moneyDtoSchema = z.object({
  amount: moneyString(),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/u, 'Use a three-letter ISO currency code.'),
});

export type MoneyDtoInput = z.infer<typeof moneyDtoSchema>;
