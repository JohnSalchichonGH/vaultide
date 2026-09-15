import { describe, expect, it } from 'vitest';
import { EXAMPLE_MONTH } from '@/features/home/content';
import { formatMoney } from '@/lib/format';

/**
 * The homepage's example month (`apps/web/src/features/home/content.ts`).
 *
 * The figures are illustration, but the page presents them as a month the
 * product reconciled, so they have to reconcile. Proven here on the very
 * strings the page formats, in exact minor units — never through a
 * floating-point number (blueprint 7.1.1).
 */

/** Exact minor units of a two-decimal amount string. */
function minorUnits(decimal: string): bigint {
  const match = /^(\d+)\.(\d{2})$/u.exec(decimal);
  if (match === null) throw new Error(`Not a two-decimal amount: ${decimal}`);
  return BigInt(match[1] ?? '') * 100n + BigInt(match[2] ?? '');
}

describe('the homepage example month', () => {
  const figures = EXAMPLE_MONTH.figures;
  const opening = minorUnits(figures.opening);
  const income = minorUnits(figures.income);
  const closing = minorUnits(figures.closing);
  const spending = minorUnits(figures.spending);
  const knownExpenses = minorUnits(figures.knownExpenses);
  const unclassified = minorUnits(figures.unclassified);
  const saved = minorUnits(figures.saved);

  it('infers spending from the balances and the income: 15,740 + 2,600 − 16,260 = 2,080', () => {
    expect(opening + income - closing).toBe(spending);
    expect(spending).toBe(208000n);
  });

  it('splits spending into known expenses and the unclassified rest: 1,145 + 935 = 2,080', () => {
    expect(knownExpenses + unclassified).toBe(spending);
  });

  it('saves what the income left: 2,600 − 2,080 = 520', () => {
    expect(income - spending).toBe(saved);
    expect(saved).toBe(52000n);
  });

  it('saves exactly what the cash grew by, with no transfers in the month: 16,260 − 15,740 = 520', () => {
    expect(closing - opening).toBe(saved);
  });

  it('carries every figure with the two minor units of its currency', () => {
    expect(EXAMPLE_MONTH.currency).toBe('EUR');
    expect(EXAMPLE_MONTH.minorUnits).toBe(2);
    for (const amount of Object.values(figures)) {
      expect(amount).toMatch(/^\d+\.\d{2}$/u);
    }
  });

  it('formats through the exact path into the figures the page shows', () => {
    const shown = (amount: string): string =>
      formatMoney({
        amount,
        currency: EXAMPLE_MONTH.currency,
        locale: EXAMPLE_MONTH.locale,
        minorUnits: EXAMPLE_MONTH.minorUnits,
      });

    expect(shown(figures.opening)).toBe('€15,740.00');
    expect(shown(figures.income)).toBe('€2,600.00');
    expect(shown(figures.closing)).toBe('€16,260.00');
    expect(shown(figures.spending)).toBe('€2,080.00');
    expect(shown(figures.knownExpenses)).toBe('€1,145.00');
    expect(shown(figures.unclassified)).toBe('€935.00');
    expect(shown(figures.saved)).toBe('€520.00');
  });
});
