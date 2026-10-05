import { moneyString } from '@vaultide/validation';

/**
 * Locale-tolerant money input handling (blueprint 16.6, 20.1).
 *
 * Users type `1.234,56` or `1234.56` depending on their locale. The input is
 * normalized to one canonical decimal **string**; it is never parsed into a
 * number, so no digit is ever lost on the way to validation or storage.
 */
export function normalizeMoneyInput(raw: string): string {
  const trimmed = raw.trim().replace(/\s/gu, '');
  // A comma means "decimal separator"; dots then act as grouping separators.
  return trimmed.includes(',')
    ? trimmed.replace(/\.(?=\d{3}\b)/gu, '').replace(',', '.')
    : trimmed;
}

/**
 * Why a normalized amount cannot be sent in a currency with these minor units,
 * or `null` when it can (7.2 "Input scale").
 *
 * `moneyString`'s own answer, so the browser refuses in the words the server
 * would use. Whether the amount may be negative is the server's to say: this
 * judges the spelling and the decimals.
 */
export function moneyInputProblem(amount: string, minorUnits: number): string | null {
  const parsed = moneyString({ minorUnits }).safeParse(amount);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Enter an amount.');
}
