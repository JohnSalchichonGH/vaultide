import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/decimal';
import { plainDate } from '../src/dates/plain-date';
import {
  anchorDay,
  firstOccurrence,
  monthsPerPeriod,
  nextUnresolvedOccurrence,
  occurrencesInRange,
  termForOccurrence,
  termsForOccurrences,
  type RecurrenceSchedule,
  type TemplateTerm,
} from '../src/recurring/index';

/**
 * Fixed-anchor recurrence (blueprint 6.2, v2.1.6 §30.9 item 3) and term
 * selection by scheduled identity (§30.9 item 4).
 *
 * The tests are named after the rule rather than the section, because the rule
 * is what a future reader has to keep true.
 */

function schedule(over: Partial<RecurrenceSchedule> = {}): RecurrenceSchedule {
  return {
    frequency: 'monthly',
    dayOfMonth: 25,
    startDate: plainDate('2026-01-01'),
    endDate: null,
    ...over,
  };
}

const from = plainDate('2026-01-01');
const to = plainDate('2026-12-31');

describe('a clamped month never moves the anchor', () => {
  it('returns to the 31st after February', () => {
    const dates = occurrencesInRange(
      schedule({ dayOfMonth: 31, startDate: plainDate('2026-01-01') }),
      from,
      plainDate('2026-05-31'),
    );
    expect(dates).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
    ]);
  });

  it('clamps a 31st anchor to 29 February in a leap year', () => {
    const dates = occurrencesInRange(
      schedule({ dayOfMonth: 31, startDate: plainDate('2028-01-01') }),
      plainDate('2028-01-01'),
      plainDate('2028-03-31'),
    );
    expect(dates).toEqual(['2028-01-31', '2028-02-29', '2028-03-31']);
  });

  it('keeps a 30th anchor on the 30th outside February', () => {
    const dates = occurrencesInRange(
      schedule({ dayOfMonth: 30, startDate: plainDate('2026-01-01') }),
      from,
      plainDate('2026-04-30'),
    );
    expect(dates).toEqual(['2026-01-30', '2026-02-28', '2026-03-30', '2026-04-30']);
  });

  it('keeps a 29th anchor on the 29th outside February', () => {
    const dates = occurrencesInRange(
      schedule({ dayOfMonth: 29, startDate: plainDate('2026-01-01') }),
      from,
      plainDate('2026-03-31'),
    );
    expect(dates).toEqual(['2026-01-29', '2026-02-28', '2026-03-29']);
  });

  it('gives an annual 29 February anchor 28 Feb in common years and 29 Feb in leap years', () => {
    const dates = occurrencesInRange(
      schedule({ frequency: 'annual', dayOfMonth: 29, startDate: plainDate('2028-02-29') }),
      plainDate('2028-01-01'),
      plainDate('2032-12-31'),
    );
    expect(dates).toEqual(['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
  });
});

describe('generation respects the template’s own dates', () => {
  it('discards an occurrence before start_date without shifting the anchor', () => {
    // The January target month contains 5 Jan, which is before the template
    // existed. The sequence starts at 5 Feb and stays on the 5th.
    const dates = occurrencesInRange(
      schedule({ dayOfMonth: 5, startDate: plainDate('2026-01-20') }),
      from,
      plainDate('2026-04-30'),
    );
    expect(dates).toEqual(['2026-02-05', '2026-03-05', '2026-04-05']);
  });

  it('includes the first month when the anchor day is after start_date’s day', () => {
    const dates = occurrencesInRange(
      schedule({ dayOfMonth: 25, startDate: plainDate('2026-01-20') }),
      from,
      plainDate('2026-03-31'),
    );
    expect(dates).toEqual(['2026-01-25', '2026-02-25', '2026-03-25']);
  });

  it('includes the first month when the anchor day equals start_date’s day', () => {
    const dates = occurrencesInRange(
      schedule({ dayOfMonth: 20, startDate: plainDate('2026-01-20') }),
      from,
      plainDate('2026-02-28'),
    );
    expect(dates).toEqual(['2026-01-20', '2026-02-20']);
  });

  it('takes start_date’s day when day_of_month is NULL', () => {
    const dates = occurrencesInRange(
      schedule({ dayOfMonth: null, startDate: plainDate('2026-01-17') }),
      from,
      plainDate('2026-03-31'),
    );
    expect(dates).toEqual(['2026-01-17', '2026-02-17', '2026-03-17']);
  });

  it('stops at end_date', () => {
    const dates = occurrencesInRange(
      schedule({ dayOfMonth: 10, startDate: plainDate('2026-01-01'), endDate: plainDate('2026-03-15') }),
      from,
      to,
    );
    expect(dates).toEqual(['2026-01-10', '2026-02-10', '2026-03-10']);
  });

  it('excludes an occurrence that falls after end_date in the same month', () => {
    const dates = occurrencesInRange(
      schedule({ dayOfMonth: 20, startDate: plainDate('2026-01-01'), endDate: plainDate('2026-03-15') }),
      from,
      to,
    );
    expect(dates).toEqual(['2026-01-20', '2026-02-20']);
  });

  it('keeps a clamped occurrence that lands exactly on end_date', () => {
    const dates = occurrencesInRange(
      schedule({ dayOfMonth: 31, startDate: plainDate('2026-01-01'), endDate: plainDate('2026-02-28') }),
      from,
      to,
    );
    expect(dates).toEqual(['2026-01-31', '2026-02-28']);
  });

  it('produces nothing when the template starts after the range', () => {
    expect(
      occurrencesInRange(schedule({ startDate: plainDate('2027-01-01') }), from, to),
    ).toEqual([]);
  });

  it('produces nothing for an inverted range', () => {
    expect(occurrencesInRange(schedule(), to, from)).toEqual([]);
  });
});

describe('period lengths', () => {
  it('steps a quarter at a time', () => {
    const dates = occurrencesInRange(
      schedule({ frequency: 'quarterly', dayOfMonth: 15, startDate: plainDate('2026-01-01') }),
      from,
      to,
    );
    expect(dates).toEqual(['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15']);
  });

  it('steps half a year at a time', () => {
    const dates = occurrencesInRange(
      schedule({ frequency: 'semiannual', dayOfMonth: 1, startDate: plainDate('2026-02-01') }),
      from,
      plainDate('2027-12-31'),
    );
    expect(dates).toEqual(['2026-02-01', '2026-08-01', '2027-02-01', '2027-08-01']);
  });

  it('steps a year at a time', () => {
    const dates = occurrencesInRange(
      schedule({ frequency: 'annual', dayOfMonth: 3, startDate: plainDate('2026-06-01') }),
      from,
      plainDate('2029-12-31'),
    );
    expect(dates).toEqual(['2026-06-03', '2027-06-03', '2028-06-03', '2029-06-03']);
  });

  it('names the months per period', () => {
    expect(monthsPerPeriod('monthly')).toBe(1);
    expect(monthsPerPeriod('quarterly')).toBe(3);
    expect(monthsPerPeriod('semiannual')).toBe(6);
    expect(monthsPerPeriod('annual')).toBe(12);
  });
});

describe('the generated sequence is well formed', () => {
  it('is strictly ordered with no duplicates over a long range', () => {
    const dates = occurrencesInRange(
      schedule({ dayOfMonth: 31, startDate: plainDate('2020-01-01') }),
      plainDate('2020-01-01'),
      plainDate('2032-12-31'),
    );
    expect(dates.length).toBe(13 * 12);
    expect(new Set(dates).size).toBe(dates.length);
    for (let i = 1; i < dates.length; i += 1) {
      expect((dates[i - 1] as string) < (dates[i] as string)).toBe(true);
    }
  });

  it('is a pure function of its inputs', () => {
    const args = schedule({ dayOfMonth: 31 });
    expect(occurrencesInRange(args, from, to)).toEqual(occurrencesInRange(args, from, to));
  });

  it('reports the anchor day it will use', () => {
    expect(anchorDay(schedule({ dayOfMonth: 9 }))).toBe(9);
    expect(anchorDay(schedule({ dayOfMonth: null, startDate: plainDate('2026-03-08') }))).toBe(8);
  });

  it('finds the first occurrence, skipping one discarded by start_date', () => {
    expect(firstOccurrence(schedule({ dayOfMonth: 5, startDate: plainDate('2026-01-20') }))).toBe(
      '2026-02-05',
    );
    expect(firstOccurrence(schedule({ dayOfMonth: 25, startDate: plainDate('2026-01-20') }))).toBe(
      '2026-01-25',
    );
  });

  it('has no first occurrence when end_date precedes it', () => {
    expect(
      firstOccurrence(
        schedule({ dayOfMonth: 25, startDate: plainDate('2026-01-20'), endDate: plainDate('2026-01-21') }),
      ),
    ).toBeUndefined();
  });
});

describe('a term is chosen by the scheduled occurrence, not the financial date', () => {
  const terms: TemplateTerm[] = [
    {
      id: 'a',
      templateId: 't',
      effectiveFrom: plainDate('2026-01-01'),
      amount: new Decimal('2100'),
      grossAmount: null,
    },
    {
      id: 'b',
      templateId: 't',
      effectiveFrom: plainDate('2026-10-01'),
      amount: new Decimal('2250'),
      grossAmount: null,
    },
  ];

  it('takes the greatest effective_from on or before the occurrence', () => {
    expect(termForOccurrence(terms, plainDate('2026-09-25'))?.id).toBe('a');
    expect(termForOccurrence(terms, plainDate('2026-10-01'))?.id).toBe('b');
    expect(termForOccurrence(terms, plainDate('2026-11-01'))?.id).toBe('b');
  });

  it('gives an occurrence scheduled for 1 October the October term even when received on 30 September', () => {
    // "Received today" moves the financial date, never the occurrence's
    // identity — so an October raise is not missed by an early payment.
    const occurrenceDate = plainDate('2026-10-01');
    const receivedOn = plainDate('2026-09-30');
    expect(termForOccurrence(terms, occurrenceDate)?.amount.toString()).toBe('2250');
    expect(termForOccurrence(terms, receivedOn)?.amount.toString()).toBe('2100');
  });

  it('returns undefined rather than inventing a zero amount', () => {
    expect(termForOccurrence(terms, plainDate('2025-12-31'))).toBeUndefined();
    expect(termForOccurrence([], plainDate('2026-09-25'))).toBeUndefined();
  });

  it('answers for many occurrences in one pass, identically', () => {
    const dates = [plainDate('2026-09-25'), plainDate('2026-10-01'), plainDate('2025-01-01')];
    const many = termsForOccurrences(terms, dates);
    for (const date of dates) {
      expect(many.get(date)?.id).toBe(termForOccurrence(terms, date)?.id);
    }
  });

  it('is unaffected by the order the terms arrive in', () => {
    const reversed = [...terms].reverse();
    expect(termForOccurrence(reversed, plainDate('2026-10-05'))?.id).toBe('b');
  });
});

describe('the next occurrence nothing has resolved', () => {
  // 30.10: early materialization reaches this occurrence and no other. The
  // bound is the schedule, never a window in days or months.
  const monthly = schedule({ dayOfMonth: 1, startDate: plainDate('2026-01-01') });
  const today = plainDate('2026-09-15');

  it('is the first scheduled date after today when nothing is resolved', () => {
    expect(nextUnresolvedOccurrence(monthly, today, new Set())).toBe('2026-10-01');
  });

  it('skips past the ones already resolved, in order', () => {
    expect(nextUnresolvedOccurrence(monthly, today, new Set(['2026-10-01']))).toBe('2026-11-01');
    expect(
      nextUnresolvedOccurrence(monthly, today, new Set(['2026-10-01', '2026-11-01'])),
    ).toBe('2026-12-01');
  });

  it('ignores resolved occurrences that are not in the future', () => {
    // August is behind us; it says nothing about what comes next.
    expect(nextUnresolvedOccurrence(monthly, today, new Set(['2026-08-01']))).toBe('2026-10-01');
  });

  it('imposes no horizon: a distant annual occurrence is still the next one', () => {
    const annual = schedule({
      frequency: 'annual',
      dayOfMonth: 1,
      startDate: plainDate('2026-06-01'),
    });
    expect(nextUnresolvedOccurrence(annual, today, new Set())).toBe('2027-06-01');
  });

  it('runs out when end_date ends the schedule', () => {
    const ending = schedule({
      dayOfMonth: 1,
      startDate: plainDate('2026-01-01'),
      endDate: plainDate('2026-10-01'),
    });
    expect(nextUnresolvedOccurrence(ending, today, new Set())).toBe('2026-10-01');
    expect(nextUnresolvedOccurrence(ending, today, new Set(['2026-10-01']))).toBeUndefined();
  });

  it('follows the clamped anchor rather than a nominal day', () => {
    const anchored = schedule({ dayOfMonth: 31, startDate: plainDate('2026-01-01') });
    expect(nextUnresolvedOccurrence(anchored, plainDate('2026-01-31'), new Set())).toBe(
      '2026-02-28',
    );
  });

  it('has nothing left once the schedule is exhausted', () => {
    const past = schedule({
      dayOfMonth: 1,
      startDate: plainDate('2020-01-01'),
      endDate: plainDate('2020-03-01'),
    });
    expect(nextUnresolvedOccurrence(past, today, new Set())).toBeUndefined();
  });
});
