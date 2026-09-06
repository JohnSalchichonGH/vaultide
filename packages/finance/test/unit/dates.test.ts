import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  compareDates,
  daysBetween,
  endOfMonth,
  fixedClock,
  InvalidPlainDateError,
  InvalidTimeZoneError,
  isCurrentMonth,
  isMonthCompleted,
  isMonthEnd,
  isValidPlainDate,
  maxDate,
  minDate,
  monthKey,
  monthLabel,
  monthsBetween,
  plainDate,
  startOfMonth,
  todayIn,
} from '../../src/index';

describe('PlainDate', () => {
  it('accepts only real calendar dates', () => {
    expect(isValidPlainDate('2026-09-30')).toBe(true);
    expect(isValidPlainDate('2026-02-29')).toBe(false);
    expect(isValidPlainDate('2024-02-29')).toBe(true);
    expect(isValidPlainDate('2026-13-01')).toBe(false);
    expect(isValidPlainDate('2026-09-31')).toBe(false);
    expect(isValidPlainDate('20260930')).toBe(false);
    expect(() => plainDate('2026-09-31')).toThrow(InvalidPlainDateError);
  });

  it('computes month boundaries', () => {
    expect(endOfMonth(plainDate('2026-09-06'))).toBe('2026-09-30');
    expect(endOfMonth(plainDate('2026-02-10'))).toBe('2026-02-28');
    expect(endOfMonth(plainDate('2024-02-10'))).toBe('2024-02-29');
    expect(startOfMonth(plainDate('2026-09-30'))).toBe('2026-09-01');
    expect(isMonthEnd(plainDate('2026-09-30'))).toBe(true);
    expect(isMonthEnd(plainDate('2026-09-29'))).toBe(false);
  });

  it('adds months by clamping to the target month length', () => {
    expect(addMonths(plainDate('2026-01-31'), 1)).toBe('2026-02-28');
    expect(addMonths(plainDate('2026-09-30'), 1)).toBe('2026-10-30');
    expect(addMonths(plainDate('2026-09-06'), -9)).toBe('2025-12-06');
    expect(addMonths(plainDate('2026-09-06'), 12)).toBe('2027-09-06');
    expect(addMonths(plainDate('2026-09-06'), 0)).toBe('2026-09-06');
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays(plainDate('2026-09-30'), 1)).toBe('2026-10-01');
    expect(addDays(plainDate('2026-01-01'), -1)).toBe('2025-12-31');
    expect(addDays(plainDate('2024-02-28'), 1)).toBe('2024-02-29');
  });

  it('measures distances', () => {
    expect(daysBetween(plainDate('2026-09-01'), plainDate('2026-09-30'))).toBe(29);
    expect(daysBetween(plainDate('2026-09-30'), plainDate('2026-09-01'))).toBe(-29);
    expect(daysBetween(plainDate('2025-09-06'), plainDate('2026-09-06'))).toBe(365);
    expect(monthsBetween(plainDate('2025-09-06'), plainDate('2026-09-06'))).toBe(12);
    expect(monthsBetween(plainDate('2025-09-06'), plainDate('2026-09-05'))).toBe(11);
  });

  it('orders dates', () => {
    const a = plainDate('2026-09-06');
    const b = plainDate('2026-09-30');
    expect(compareDates(a, b)).toBe(-1);
    expect(compareDates(b, a)).toBe(1);
    expect(compareDates(a, a)).toBe(0);
    expect(minDate(a, b)).toBe(a);
    expect(maxDate(a, b)).toBe(b);
  });

  it('derives months and their completion state (M5, R15)', () => {
    const september = monthKey(plainDate('2026-09-06'));
    expect(september).toBe('2026-09-01');
    expect(monthLabel(september)).toBe('2026-09');

    // A month is completed only once today is past its last day.
    expect(isMonthCompleted(september, plainDate('2026-09-30'))).toBe(false);
    expect(isMonthCompleted(september, plainDate('2026-10-01'))).toBe(true);
    expect(isCurrentMonth(september, plainDate('2026-09-30'))).toBe(true);
    expect(isCurrentMonth(september, plainDate('2026-10-01'))).toBe(false);
  });
});

describe('today in the user timezone', () => {
  it('resolves the calendar date in the given zone, not the host zone', () => {
    // 2026-09-06T23:30Z is already the 7th in Madrid and still the 6th in New York.
    const clock = fixedClock('2026-09-06T23:30:00Z');
    expect(todayIn('Europe/Madrid', clock)).toBe('2026-09-07');
    expect(todayIn('America/New_York', clock)).toBe('2026-09-06');
    expect(todayIn('UTC', clock)).toBe('2026-09-06');
  });

  it('rejects an unknown timezone and an invalid instant', () => {
    expect(() => todayIn('Mars/Olympus', fixedClock('2026-09-06T00:00:00Z'))).toThrow(
      InvalidTimeZoneError,
    );
    expect(() => fixedClock('not-a-date')).toThrow(RangeError);
  });

  it('never reads the clock implicitly: the same clock always yields the same day', () => {
    const clock = fixedClock('2026-09-06T12:00:00Z');
    expect(todayIn('Europe/Madrid', clock)).toBe(todayIn('Europe/Madrid', clock));
  });
});
