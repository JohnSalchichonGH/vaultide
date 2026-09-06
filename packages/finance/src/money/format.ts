import { D, ROUND_HALF_UP } from '../decimal';
import type { DecimalInput } from '../decimal';
import { assertMinorUnits, type MinorUnits } from './types';

/**
 * Exact display formatting (blueprint 7.1.1, R31).
 *
 * Money is formatted from its exact decimal **string**. It never passes through
 * a JavaScript number, so `"12345678901234567.89"` renders with every digit
 * intact and a 4-minor-unit currency such as CLF round-trips exactly.
 *
 * Path: round the string to the currency's minor units with Decimal (half-up),
 * then hand the resulting string to `Intl.NumberFormat`, whose `format()`
 * accepts decimal strings as exact mathematical values. A startup self-test
 * proves the runtime really is exact for a value far beyond 2^53; if it is not,
 * the fallback assembler builds the output from `formatToParts` instead.
 */

export interface FormatOptions {
  /** BCP 47 locale, e.g. "de-DE". */
  readonly locale: string;
  /** ISO 4217 code, e.g. "EUR". */
  readonly currency: string;
  /** Minor units of that currency (0 for JPY, 2 for EUR, 4 for CLF). */
  readonly minorUnits: number;
  /** Render the sign even when positive (blueprint 16.2). */
  readonly alwaysSign?: boolean;
}

/** The value the self-test formats: 19 significant digits, far beyond 2^53. */
export const SELF_TEST_AMOUNT = '12345678901234567.89';

type Strategy = 'intl-string' | 'fallback-assembler';

const strategyCache = new Map<string, Strategy>();

/** Round an exact decimal string to `minorUnits`, half-up, as a plain string. */
export function roundDecimalString(amount: DecimalInput, minorUnits: number): string {
  assertMinorUnits(minorUnits);
  return D(amount).toDecimalPlaces(minorUnits, ROUND_HALF_UP).toFixed(minorUnits);
}

function digitsOf(text: string): string {
  let digits = '';
  for (const char of text) {
    if (char >= '0' && char <= '9') digits += char;
  }
  return digits;
}

function intlFormat(value: string, options: FormatOptions): string {
  const formatter = new Intl.NumberFormat(options.locale, {
    style: 'currency',
    currency: options.currency,
    minimumFractionDigits: options.minorUnits,
    maximumFractionDigits: options.minorUnits,
    ...(options.alwaysSign === true ? { signDisplay: 'exceptZero' as const } : {}),
  });
  // `format` accepts a string and treats it as an exact decimal value.
  return formatter.format(value as unknown as number);
}

/**
 * Decide once per (locale, currency, minorUnits) whether this runtime formats
 * decimal strings exactly, by formatting SELF_TEST_AMOUNT and comparing digits.
 */
export function selfTest(options: FormatOptions): Strategy {
  const key = `${options.locale}|${options.currency}|${String(options.minorUnits)}`;
  const cached = strategyCache.get(key);
  if (cached !== undefined) return cached;

  let strategy: Strategy;
  try {
    const rounded = roundDecimalString(SELF_TEST_AMOUNT, options.minorUnits);
    const formatted = intlFormat(rounded, options);
    strategy = digitsOf(formatted) === digitsOf(rounded) ? 'intl-string' : 'fallback-assembler';
  } catch {
    // A runtime that cannot format the probe at all uses the assembler.
    strategy = 'fallback-assembler';
  }

  strategyCache.set(key, strategy);
  return strategy;
}

/** Test seam: forget cached self-test results. */
export function resetFormatterSelfTest(): void {
  strategyCache.clear();
}

/** Test seam: force a strategy for one (locale, currency, minorUnits) triple. */
export function forceFormatterStrategy(options: FormatOptions, strategy: Strategy): void {
  strategyCache.set(
    `${options.locale}|${options.currency}|${String(options.minorUnits)}`,
    strategy,
  );
}

interface LocaleParts {
  readonly group: string;
  readonly decimal: string;
  /** The formatted template of a reference value, used to place the currency. */
  readonly template: Intl.NumberFormatPart[];
}

function localeParts(options: FormatOptions): LocaleParts {
  const formatter = new Intl.NumberFormat(options.locale, {
    style: 'currency',
    currency: options.currency,
    minimumFractionDigits: options.minorUnits,
    maximumFractionDigits: options.minorUnits,
  });
  const parts = formatter.formatToParts(1234567.5);
  /* v8 ignore next 2 -- Intl always emits a group and a decimal part for the
     reference value 1234567.5; the defaults exist only so a future exotic
     locale degrades to something sane instead of `undefined`. */
  const group = parts.find((part) => part.type === 'group')?.value ?? ',';
  const decimal = parts.find((part) => part.type === 'decimal')?.value ?? '.';
  return { group, decimal, template: parts };
}

function groupInteger(integerDigits: string, group: string): string {
  let out = '';
  let count = 0;
  for (let index = integerDigits.length - 1; index >= 0; index -= 1) {
    out = (integerDigits[index] as string) + out;
    count += 1;
    if (count % 3 === 0 && index > 0) out = group + out;
  }
  return out;
}

/**
 * Fallback assembler (7.1.1 step 3): rebuild the formatted string from the
 * locale's own parts template, so grouping, decimal separator, currency symbol
 * placement and spacing stay locale-correct while the digits stay exact.
 */
export function assembleExact(rounded: string, options: FormatOptions): string {
  const { group, decimal, template } = localeParts(options);
  const negative = rounded.startsWith('-');
  const unsigned = negative ? rounded.slice(1) : rounded;
  const [integerPart = '0', fractionPart = ''] = unsigned.split('.');

  const number =
    groupInteger(integerPart, group) + (options.minorUnits > 0 ? decimal + fractionPart : '');

  let out = '';
  let numberWritten = false;
  for (const part of template) {
    switch (part.type) {
      case 'integer':
      case 'group':
      case 'decimal':
      case 'fraction':
        if (!numberWritten) {
          out += number;
          numberWritten = true;
        }
        break;
      case 'minusSign':
      case 'plusSign':
        break;
      default:
        out += part.value;
    }
  }
  if (!numberWritten) out += number;

  const sign = negative ? '-' : options.alwaysSign === true && D(rounded).isPositive() ? '+' : '';
  return sign + out;
}

/** Format an exact decimal string as money in the given locale. */
export function formatMoney(amount: string, options: FormatOptions): string {
  const rounded = roundDecimalString(amount, options.minorUnits);
  return selfTest(options) === 'intl-string'
    ? intlFormat(rounded, options)
    : assembleExact(rounded, options);
}

export interface PercentOptions {
  readonly locale: string;
  /** Decimals shown; 2 by default, 1 in dense tables (blueprint 7.3.4). */
  readonly fractionDigits?: number;
  readonly alwaysSign?: boolean;
}

/**
 * Format a rate held as an exact decimal **fraction** string ("0.5824" → "58.24 %").
 * The percentage is computed with Decimal, never with `number` arithmetic.
 */
export function formatPercent(fraction: string, options: PercentOptions): string {
  const digits = options.fractionDigits ?? 2;
  const scaled = D(fraction).times(100).toDecimalPlaces(digits, ROUND_HALF_UP).toFixed(digits);
  const formatter = new Intl.NumberFormat(options.locale, {
    style: 'percent',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    ...(options.alwaysSign === true ? { signDisplay: 'exceptZero' as const } : {}),
  });
  // Divide back by 100 exactly as a string so `style: 'percent'` re-scales it.
  const asFraction = D(scaled).dividedBy(100).toFixed(digits + 2);
  return formatter.format(asFraction as unknown as number);
}

/** Minor units as a typed value, for callers reading them from the currency table. */
export function minorUnits(value: number): MinorUnits {
  assertMinorUnits(value);
  return value;
}
