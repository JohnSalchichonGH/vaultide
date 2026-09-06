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
