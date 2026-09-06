import { beforeEach, describe, expect, it } from 'vitest';
import {
  assembleExact,
  forceFormatterStrategy,
  formatMoney,
  formatPercent,
  money,
  parse,
  resetFormatterSelfTest,
  roundDecimalString,
  selfTest,
  serialize,
  SELF_TEST_AMOUNT,
  toMinorUnitString,
  type FormatOptions,
} from '../../src/index';

const digitsOf = (text: string): string => [...text].filter((c) => c >= '0' && c <= '9').join('');

/** The three locales named in blueprint 21.1, with their minor units. */
const LOCALES: readonly FormatOptions[] = [
  { locale: 'en-US', currency: 'USD', minorUnits: 2 },
  { locale: 'de-DE', currency: 'EUR', minorUnits: 2 },
  { locale: 'ja-JP', currency: 'JPY', minorUnits: 0 },
];

describe('exact money formatting (7.1.1)', () => {
  beforeEach(() => {
    resetFormatterSelfTest();
  });

  it('formats "12345678901234567.89" without losing a digit, in every required locale', () => {
    for (const options of LOCALES) {
      const expectedDigits = digitsOf(roundDecimalString(SELF_TEST_AMOUNT, options.minorUnits));
      const formatted = formatMoney(SELF_TEST_AMOUNT, options);
      expect(digitsOf(formatted), `${options.locale} lost precision: ${formatted}`).toBe(
        expectedDigits,
      );
    }
  });

  it('produces the same output through the Intl string path and the fallback assembler', () => {
    for (const options of LOCALES) {
      resetFormatterSelfTest();
      forceFormatterStrategy(options, 'intl-string');
      const viaIntl = formatMoney(SELF_TEST_AMOUNT, options);

      resetFormatterSelfTest();
      forceFormatterStrategy(options, 'fallback-assembler');
      const viaFallback = formatMoney(SELF_TEST_AMOUNT, options);

      expect(viaFallback).toBe(viaIntl);
      expect(digitsOf(viaFallback)).toBe(
        digitsOf(roundDecimalString(SELF_TEST_AMOUNT, options.minorUnits)),
      );
    }
  });

  it('pins the expected rendering in en-US, de-DE and ja-JP', () => {
    expect(formatMoney(SELF_TEST_AMOUNT, LOCALES[0] as FormatOptions)).toBe(
      '$12,345,678,901,234,567.89',
    );
    // de-DE groups with "." and uses "," as the decimal separator.
    expect(digitsOf(formatMoney(SELF_TEST_AMOUNT, LOCALES[1] as FormatOptions))).toBe(
      '1234567890123456789',
    );
    expect(formatMoney(SELF_TEST_AMOUNT, LOCALES[1] as FormatOptions)).toContain(
      '12.345.678.901.234.567,89',
    );
    // JPY has 0 minor units, so the value is rounded half-up to ...568.
    expect(digitsOf(formatMoney(SELF_TEST_AMOUNT, LOCALES[2] as FormatOptions))).toBe(
      '12345678901234568',
    );
  });

  it('reports which strategy this runtime uses and caches the decision', () => {
    const options = LOCALES[0] as FormatOptions;
    const strategy = selfTest(options);
    expect(['intl-string', 'fallback-assembler']).toContain(strategy);
    // Node 22 formats decimal strings exactly, so the primary path must be live.
    expect(strategy).toBe('intl-string');
    expect(selfTest(options)).toBe(strategy);
  });

  it('renders signs, zero and negatives', () => {
    const options = LOCALES[0] as FormatOptions;
    expect(formatMoney('-729.005', options)).toBe('-$729.01');
    expect(formatMoney('0', options)).toBe('$0.00');
    expect(formatMoney('430', { ...options, alwaysSign: true })).toBe('+$430.00');
    expect(assembleExact('430.00', { ...options, alwaysSign: true })).toBe('+$430.00');
    expect(assembleExact('-729.01', options)).toBe('-$729.01');
  });

  it('rounds to the currency minor units half-up before formatting', () => {
    const options = LOCALES[0] as FormatOptions;
    expect(formatMoney('2.345', options)).toBe('$2.35');
    expect(formatMoney('2.344', options)).toBe('$2.34');
  });
});

describe('when the runtime cannot format at all', () => {
  it('falls back to the assembler rather than throwing', () => {
    resetFormatterSelfTest();
    // An unknown currency makes Intl throw; the self-test must degrade, not fail.
    const broken: FormatOptions = { locale: 'en-US', currency: 'ZZZZ', minorUnits: 2 };
    expect(selfTest(broken)).toBe('fallback-assembler');
  });
});

describe('4-minor-unit currency (CLF) round-trip', () => {
  const clf: FormatOptions = { locale: 'en-US', currency: 'CLF', minorUnits: 4 };

  beforeEach(() => {
    resetFormatterSelfTest();
  });

  it('round-trips input → storage → display exactly', () => {
    const input = '38123.4567';

    // storage: the exact string the NUMERIC(24,8) column receives
    const stored = serialize(money(input, 'CLF'));
    expect(stored).toEqual({ amount: '38123.4567', currency: 'CLF' });

    // storage → domain → display, with no digit lost or invented
    const loaded = parse(stored);
    expect(toMinorUnitString(loaded, 4)).toBe('38123.4567');
    expect(digitsOf(formatMoney(stored.amount, clf))).toBe('381234567');
    expect(formatMoney(stored.amount, clf)).toContain('38,123.4567');
  });

  it('keeps all four decimals through the fallback assembler too', () => {
    forceFormatterStrategy(clf, 'fallback-assembler');
    expect(formatMoney('38123.4567', clf)).toContain('38,123.4567');
    expect(formatMoney('0.0001', clf)).toContain('0.0001');
  });

  it('does not truncate a fourth decimal to two', () => {
    expect(formatMoney('1.2345', clf)).not.toContain('1.23 ');
    expect(digitsOf(formatMoney('1.2345', clf))).toBe('12345');
  });
});

describe('percent formatting', () => {
  it('formats an exact fraction string as a percentage', () => {
    expect(formatPercent('0.5824', { locale: 'en-US' })).toBe('58.24%');
    expect(formatPercent('0.6058', { locale: 'en-US' })).toBe('60.58%');
    expect(formatPercent('0.2602', { locale: 'en-US', fractionDigits: 1 })).toBe('26.0%');
    expect(formatPercent('0.03', { locale: 'en-US', alwaysSign: true })).toBe('+3.00%');
    expect(formatPercent('-0.0123', { locale: 'en-US' })).toBe('-1.23%');
  });
});
