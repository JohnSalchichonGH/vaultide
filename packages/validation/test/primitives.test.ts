import { describe, expect, it } from 'vitest';
import {
  currencyCode,
  isCalendarDate,
  isMonthEnd,
  locale,
  minorUnits,
  moneyDtoSchema,
  moneyString,
  percentFraction,
  plainDate,
  plainDateNotAfter,
  plainDateNotBefore,
  positionKinds,
  timeZone,
  valuationDateSchema,
} from '../src/index';

describe('money strings', () => {
  it('accepts exact decimal strings without going through a number', () => {
    const schema = moneyString({ minorUnits: 2 });
    expect(schema.safeParse('12345678901234567.89').success).toBe(false); // 17 integer digits
    expect(schema.safeParse('1234567890123456.89').success).toBe(true); // 16 integer digits
    expect(schema.safeParse('0').success).toBe(true);
    expect(schema.safeParse('-12.34').success).toBe(true);
  });

  it('enforces the currency minor units (7.2)', () => {
    expect(moneyString({ minorUnits: 2 }).safeParse('1.234').success).toBe(false);
    expect(moneyString({ minorUnits: 0 }).safeParse('1.5').success).toBe(false);
    expect(moneyString({ minorUnits: 0 }).safeParse('1').success).toBe(true);
    expect(moneyString({ minorUnits: 4 }).safeParse('38123.4567').success).toBe(true);
    expect(moneyString({ minorUnits: 3 }).safeParse('1.234').success).toBe(true);
  });

  it('rejects malformed input', () => {
    const schema = moneyString({ minorUnits: 2 });
    for (const bad of ['', '1,23', '1.2.3', 'abc', '1e5', '01.5', '+1.5', '.5', '1.']) {
      expect(schema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('supports non-negative and strictly positive amounts', () => {
    expect(moneyString({ nonNegative: true }).safeParse('-0.01').success).toBe(false);
    expect(moneyString({ nonNegative: true }).safeParse('0').success).toBe(true);
    expect(moneyString({ positive: true }).safeParse('0').success).toBe(false);
    expect(moneyString({ positive: true }).safeParse('0.01').success).toBe(true);
    expect(moneyString({ nonNegative: true }).safeParse('-0.00').success).toBe(true);
  });

  it('validates rates as fractions and the money DTO', () => {
    expect(percentFraction().safeParse('0.0325').success).toBe(true);
    expect(percentFraction({ maxScale: 2 }).safeParse('0.0325').success).toBe(false);
    expect(percentFraction().safeParse('3,25%').success).toBe(false);

    expect(moneyDtoSchema.safeParse({ amount: '10.00', currency: 'EUR' }).success).toBe(true);
    expect(moneyDtoSchema.safeParse({ amount: '10.00', currency: 'eur' }).success).toBe(false);
  });
});

describe('currency codes', () => {
  it('accepts ISO codes and normalizes case', () => {
    expect(currencyCode.parse(' eur ')).toBe('EUR');
    expect(currencyCode.safeParse('EURO').success).toBe(false);
    expect(minorUnits.safeParse(4).success).toBe(true);
    expect(minorUnits.safeParse(9).success).toBe(false);
    expect(minorUnits.safeParse(-1).success).toBe(false);
  });
});

describe('dates', () => {
  it('accepts only real calendar dates', () => {
    expect(isCalendarDate('2026-09-30')).toBe(true);
    expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(plainDate.safeParse('2026-09-31').success).toBe(false);
    expect(plainDate.safeParse('2026-09-06').success).toBe(true);
  });

  it('refuses future-dated actual records (M5, R17)', () => {
    const schema = plainDateNotAfter('2026-09-06');
    expect(schema.safeParse('2026-09-06').success).toBe(true);
    expect(schema.safeParse('2026-09-05').success).toBe(true);
    expect(schema.safeParse('2026-09-07').success).toBe(false);
    expect(plainDateNotBefore('2026-01-01').safeParse('2025-12-31').success).toBe(false);
  });

  it('identifies month ends', () => {
    expect(isMonthEnd('2026-09-30')).toBe(true);
    expect(isMonthEnd('2026-09-29')).toBe(false);
    expect(isMonthEnd('2024-02-29')).toBe(true);
  });
});

describe('month-end valuation rule (R15)', () => {
  it('refuses a September month-end balance while September is still running', () => {
    const onThe30th = valuationDateSchema('2026-09-30');
    const result = onThe30th.safeParse({ valuedOn: '2026-09-30', datePrecision: 'month_end' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('has not ended');

    // The same day is fine as an ordinary snapshot.
    expect(onThe30th.safeParse({ valuedOn: '2026-09-30', datePrecision: 'exact' }).success).toBe(
      true,
    );
  });

  it('accepts it from the first day of October', () => {
    const onOctober1 = valuationDateSchema('2026-10-01');
    expect(
      onOctober1.safeParse({ valuedOn: '2026-09-30', datePrecision: 'month_end' }).success,
    ).toBe(true);
  });

  it('requires a month-end balance to be dated the last day of its month', () => {
    const schema = valuationDateSchema('2026-10-05');
    expect(schema.safeParse({ valuedOn: '2026-09-29', datePrecision: 'month_end' }).success).toBe(
      false,
    );
  });

  it('refuses any future-dated valuation, whatever its precision', () => {
    const schema = valuationDateSchema('2026-09-06');
    expect(schema.safeParse({ valuedOn: '2026-09-07', datePrecision: 'exact' }).success).toBe(false);
    expect(schema.safeParse({ valuedOn: '2026-10-31', datePrecision: 'month_end' }).success).toBe(
      false,
    );
  });

  it('defaults precision to exact', () => {
    const schema = valuationDateSchema('2026-09-06');
    const parsed = schema.parse({ valuedOn: '2026-09-06' });
    expect(parsed.datePrecision).toBe('exact');
  });
});

describe('settings primitives', () => {
  it('validates time zones and locales', () => {
    expect(timeZone.safeParse('Europe/Madrid').success).toBe(true);
    expect(timeZone.safeParse('Mars/Olympus').success).toBe(false);
    expect(locale.safeParse('de-DE').success).toBe(true);
    expect(locale.safeParse('not a locale').success).toBe(false);
  });

  it('declares the position kinds the schema uses', () => {
    expect([...positionKinds]).toEqual([
      'cash',
      'investment',
      'property',
      'other_asset',
      'liability',
    ]);
  });
});
