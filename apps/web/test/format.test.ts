import { describe, expect, it } from 'vitest';
import { formatMoney, formatPercent, runFormatterSelfTest, SELF_TEST_AMOUNT } from '@/lib/format';
import { normalizeMoneyInput } from '@/lib/money-input';
import { validateRecordDate } from '@/lib/date-input';

const digitsOf = (text: string): string => [...text].filter((c) => c >= '0' && c <= '9').join('');

describe('the UI formatting module (7.1.1)', () => {
  it('formats money exactly, with the app defaults', () => {
    expect(formatMoney({ amount: '1234.5' })).toBe('€1,234.50');
    expect(formatMoney({ amount: '-0.005' })).toBe('-€0.01');
    expect(formatMoney({ amount: '430', alwaysSign: true })).toBe('+€430.00');
  });

  it('keeps every digit of a value a JavaScript number cannot hold', () => {
    expect(digitsOf(formatMoney({ amount: SELF_TEST_AMOUNT }))).toBe('1234567890123456789');
  });

  it('honours a currency with four minor units', () => {
    const formatted = formatMoney({
      amount: '38123.4567',
      currency: 'CLF',
      locale: 'en-US',
      minorUnits: 4,
    });
    expect(digitsOf(formatted)).toBe('381234567');
  });

  it('reports the self-test result per locale', () => {
    const report = runFormatterSelfTest([
      { locale: 'en-US', currency: 'USD', minorUnits: 2 },
      { locale: 'ja-JP', currency: 'JPY', minorUnits: 0 },
    ]);
    expect(report).toHaveLength(2);
    expect(report.every((row) => row.exact)).toBe(true);
    expect(report[0]?.strategy).toBe('intl-string');
  });

  it('formats percentages from exact fractions', () => {
    expect(formatPercent('0.5824', { locale: 'en-US' })).toBe('58.24%');
  });
});

describe('money input normalization (16.6)', () => {
  it('accepts both decimal separators without parsing a number', () => {
    expect(normalizeMoneyInput('1234,5678')).toBe('1234.5678');
    expect(normalizeMoneyInput('1234.5678')).toBe('1234.5678');
    expect(normalizeMoneyInput(' 12 345,67 ')).toBe('12345.67');
    expect(normalizeMoneyInput('1.234,56')).toBe('1234.56');
    expect(normalizeMoneyInput('-0.01')).toBe('-0.01');
    expect(normalizeMoneyInput('')).toBe('');
  });
});

describe('record dates are never in the future (M5, R17)', () => {
  const today = '2026-09-06';

  it('accepts today and earlier', () => {
    expect(validateRecordDate(today, today)).toBeNull();
    expect(validateRecordDate('2026-08-31', today)).toBeNull();
  });

  it('rejects a later date with the wording the server uses', () => {
    expect(validateRecordDate('2026-09-07', today)).toBe(
      'This date is in the future. Records can only be dated up to today.',
    );
    expect(validateRecordDate('2099-12-31', today)).toContain('in the future');
  });

  it('rejects a date that never existed', () => {
    expect(validateRecordDate('2026-02-30', today)).toBe('Enter a real calendar date.');
  });

  it('treats an empty value per the field requirement', () => {
    expect(validateRecordDate('', today)).toBeNull();
    expect(validateRecordDate('', today, { required: true })).toBe('Enter a date.');
  });
});
