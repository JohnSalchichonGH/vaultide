/**
 * Exact money and percentage formatting for the UI (blueprint 7.1.1, R31).
 *
 * The implementation lives in `@vaultide/finance/client` — the one finance
 * entry point apps/web may import (section 19) — so the same exact string path
 * formats a table cell and an engine's explanation sentence. Money never passes
 * through a JavaScript number here: `Number(amount)` is reserved for chart
 * coordinates and is banned by lint everywhere else.
 */
import {
  formatMoney as formatMoneyExact,
  formatPercent as formatPercentExact,
  roundDecimalString,
  selfTest,
  SELF_TEST_AMOUNT,
  type FormatOptions,
  type PercentOptions,
} from '@vaultide/finance/client';

export { roundDecimalString, SELF_TEST_AMOUNT };
export type { FormatOptions, PercentOptions };

/** Defaults until Phase 1 stores the user's real locale and reporting currency. */
export const DEFAULT_LOCALE = 'en-GB';
export const DEFAULT_CURRENCY = 'EUR';
export const DEFAULT_MINOR_UNITS = 2;

export interface MoneyFormatInput {
  readonly amount: string;
  readonly currency?: string;
  readonly locale?: string;
  readonly minorUnits?: number;
  readonly alwaysSign?: boolean;
}

export function formatMoney(input: MoneyFormatInput): string {
  return formatMoneyExact(input.amount, {
    locale: input.locale ?? DEFAULT_LOCALE,
    currency: input.currency ?? DEFAULT_CURRENCY,
    minorUnits: input.minorUnits ?? DEFAULT_MINOR_UNITS,
    ...(input.alwaysSign === undefined ? {} : { alwaysSign: input.alwaysSign }),
  });
}

export function formatPercent(fraction: string, options: PercentOptions): string {
  return formatPercentExact(fraction, options);
}

export interface FormatterSelfTest {
  readonly locale: string;
  readonly currency: string;
  readonly minorUnits: number;
  readonly strategy: 'intl-string' | 'fallback-assembler';
  readonly sample: string;
  readonly exact: boolean;
}

const digitsOf = (text: string): string => [...text].filter((c) => c >= '0' && c <= '9').join('');

/**
 * The startup self-test of 7.1.1, run for the locales the shell renders. It
 * reports which path each locale uses and proves the digits survived; the
 * fallback assembler takes over automatically if a runtime ever loses exactness.
 */
export function runFormatterSelfTest(
  locales: readonly Omit<FormatOptions, 'alwaysSign'>[],
): FormatterSelfTest[] {
  return locales.map((options) => {
    const strategy = selfTest(options);
    const sample = formatMoneyExact(SELF_TEST_AMOUNT, options);
    const expected = digitsOf(roundDecimalString(SELF_TEST_AMOUNT, options.minorUnits));
    return {
      locale: options.locale,
      currency: options.currency,
      minorUnits: options.minorUnits,
      strategy,
      sample,
      exact: digitsOf(sample) === expected,
    };
  });
}
