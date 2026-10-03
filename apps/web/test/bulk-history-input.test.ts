import { describe, expect, it } from 'vitest';
import {
  canonicalOf,
  editableText,
  localeNumberFormat,
  parseLocaleNumber,
} from '@/features/history/numbers';
import { parseTsv } from '@/features/history/tsv';

/**
 * What a person types or pastes into the history grid (blueprint 15.3; ADR
 * 0011 D4): spreadsheet text, and numbers in the person's own locale, turned
 * into exact canonical decimal strings without ever becoming a JavaScript
 * number.
 */

const ok = (raw: string, locale: string) => {
  const parsed = parseLocaleNumber(raw, locale);
  return parsed.ok ? parsed.value : `refused: ${parsed.message}`;
};

describe('numbers in the reader’s locale', () => {
  it('reads plain, grouped and European forms by the locale’s own separators', () => {
    expect(ok('1234.56', 'en-US')).toBe('1234.56');
    expect(ok('1,234.56', 'en-US')).toBe('1234.56');
    expect(ok('1.234,56', 'de-DE')).toBe('1234.56');
    expect(ok('1234,56', 'de-DE')).toBe('1234.56');
    expect(ok('12,34,567.8', 'en-IN')).toBe('1234567.8');
  });

  it('takes space and no-break-space grouping in any locale', () => {
    expect(ok('1 234,56', 'fr-FR')).toBe('1234.56');
    expect(ok('1 234,56', 'fr-FR')).toBe('1234.56');
    expect(ok('1 234,56', 'fr-FR')).toBe('1234.56');
    expect(ok('1 234.56', 'en-GB')).toBe('1234.56');
  });

  it('refuses grouping where the locale does not group, rather than guessing', () => {
    expect(ok('1,5', 'en-US')).toMatch(/^refused/u);
    expect(ok('1234.56', 'de-DE')).toMatch(/^refused/u);
    expect(ok('1,23,4.5', 'en-US')).toMatch(/^refused/u);
  });

  it('refuses a second decimal separator', () => {
    expect(ok('1.2.3', 'en-US')).toMatch(/only once/u);
    expect(ok('1,2,3', 'de-DE')).toMatch(/only once/u);
  });

  it('refuses symbols, percentages and bracketed negatives with a reason', () => {
    expect(ok('€12', 'de-DE')).toMatch(/currency/u);
    expect(ok('12 EUR', 'de-DE')).toMatch(/currency/u);
    expect(ok('12%', 'en-US')).toMatch(/percentage/u);
    expect(ok('(12.00)', 'en-US')).toMatch(/minus sign/u);
  });

  it('keeps zero a value, a minus sign a sign, and every digit exact', () => {
    expect(ok('0', 'en-US')).toBe('0');
    expect(ok('-0', 'en-US')).toBe('0');
    expect(ok('0.00', 'en-US')).toBe('0');
    expect(ok('-12.50', 'en-US')).toBe('-12.5');
    expect(ok('−12,50', 'de-DE')).toBe('-12.5');
    expect(ok('12345678901234567', 'en-US')).toMatch(/16 digits/u);
    expect(ok('0001234567890123456.12345678', 'en-US')).toBe('1234567890123456.12345678');
    expect(ok('1234567890123456.12345678', 'en-US')).toBe('1234567890123456.12345678');
    expect(ok('.5', 'en-US')).toBe('0.5');
  });

  it('knows a blank is not a number', () => {
    expect(ok('   ', 'en-US')).toMatch(/^refused/u);
  });

  it('writes an editable figure the parser reads back exactly', () => {
    expect(editableText('1234.5', 'de-DE', 2)).toBe('1234,50');
    expect(editableText('-7', 'en-GB', 2)).toBe('-7.00');
    expect(editableText('1000', 'ja-JP', 0)).toBe('1000');
    expect(ok(editableText('1234.5', 'de-DE', 2), 'de-DE')).toBe('1234.5');
    expect(canonicalOf(false, '000', '000')).toBe('0');
    expect(localeNumberFormat('de-DE')).toMatchObject({ decimal: ',', group: '.' });
  });
});

describe('spreadsheet text', () => {
  const rows = (text: string) => {
    const parsed = parseTsv(text);
    return parsed.ok ? parsed.rows : parsed.message;
  };

  it('splits on tabs and either kind of line break, and a final break adds no row', () => {
    expect(rows('1\t2\r\n3\t4\r\n')).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
    expect(rows('1\t2\n3\t4')).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
    expect(rows('1\t\t3\n')).toEqual([['1', '', '3']]);
  });

  it('reads quoted fields as a spreadsheet writes them', () => {
    expect(rows('"1,234.56"\t2')).toEqual([['1,234.56', '2']]);
    expect(rows('"a""b"\t2')).toEqual([['a"b', '2']]);
    expect(rows('"one\ttab"\t"two\nlines"\n3')).toEqual([
      ['one\ttab', 'two\nlines'],
      ['3'],
    ]);
  });

  it('refuses a quote that never closes, or text after one', () => {
    expect(rows('"1234\t5\n6')).toMatch(/never closes/u);
    expect(rows('"12"34\t5')).toMatch(/after a closing quote/u);
  });
});
