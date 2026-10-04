import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { monthKeyOf, plainDate } from '../src/dates/plain-date';
import { money } from '../src/money/money';
import { currencyCode } from '../src/money/types';
import { missingIncomeOccurrences, occurrenceKey } from '../src/reconciliation/completeness';
import type { CompletenessTemplate } from '../src/reconciliation/types';
import { occurrencesInRange } from '../src/recurring/occurrences';
import { incomeSourceYear, type SourcePayment, type SourceSkip } from '../src/income/index';

/**
 * One income source on its own page (blueprint 15.2 "Income source", v2.1.20
 * 30.23 items 2, 7, 8; ADR 0012 D4).
 *
 * The oracles are the schedule and the records themselves: every occurrence
 * the schedule places in the year appears once, in one state; a payment or a
 * skip decides its own; and "missing" is compared with
 * `missingIncomeOccurrences`, month by month, rather than restated.
 */

const EUR = currencyCode('EUR');
const SALARY = 'tpl-salary';
const TODAY = plainDate('2026-10-04');

function template(over: { start?: string; end?: string | null; day?: number } = {}): CompletenessTemplate {
  return {
    templateId: SALARY,
    name: 'Salary',
    kind: 'income',
    currency: EUR,
    incomeKind: 'employment',
    schedule: {
      frequency: 'monthly',
      dayOfMonth: over.day ?? 25,
      startDate: plainDate(over.start ?? '2026-01-01'),
      endDate: over.end === undefined || over.end === null ? null : plainDate(over.end),
    },
  };
}

function payment(occurrence: string, over: { receivedOn?: string; net?: string; gross?: string } = {}): SourcePayment {
  return {
    id: `entry-${occurrence}`,
    occurrenceDate: plainDate(occurrence),
    receivedOn: plainDate(over.receivedOn ?? occurrence),
    net: money(over.net ?? '2000', EUR),
    gross: over.gross === undefined ? null : money(over.gross, EUR),
  };
}

const skip = (occurrence: string, reason = 'skipped', note: string | null = null): SourceSkip => ({
  id: `skip-${occurrence}`,
  occurrenceDate: plainDate(occurrence),
  reason,
  note,
});

const states = (view: ReturnType<typeof incomeSourceYear>): Record<string, string> =>
  Object.fromEntries(view.occurrences.map((occurrence) => [occurrence.occurrenceDate, occurrence.state.kind]));

describe('what became of each occurrence of a year', () => {
  const salary = template();
  const payments = [
    payment('2026-01-25'),
    // Scheduled for 25 March, arrived on 2 April: still March's occurrence.
    payment('2026-03-25', { receivedOn: '2026-04-02' }),
    payment('2026-05-25', { gross: '2800' }),
  ];
  const skips = [skip('2026-02-25', 'other', 'Unpaid leave'), skip('2026-11-25')];
  const view = incomeSourceYear({ template: salary, payments, skips, year: 2026, today: TODAY });

  it('lists every occurrence the schedule places in the year, once, in date order', () => {
    expect(view.occurrences.map((occurrence) => occurrence.occurrenceDate)).toEqual(
      occurrencesInRange(salary.schedule, plainDate('2026-01-01'), plainDate('2026-12-31')),
    );
  });

  it('is received when a payment records it, whenever the money arrived', () => {
    const march = view.occurrences.find((occurrence) => occurrence.occurrenceDate === '2026-03-25');
    expect(march?.state).toEqual({ kind: 'received', payment: payments[1] });
  });

  it('is skipped when a skip states its absence, with the skip’s reason', () => {
    const february = view.occurrences.find((occurrence) => occurrence.occurrenceDate === '2026-02-25');
    expect(february?.state).toEqual({ kind: 'skipped', skip: skips[0] });
    // A skip can state an absence ahead of time.
    expect(states(view)['2026-11-25']).toBe('skipped');
  });

  it('is missing in a completed month, and not yet due in the current month or later', () => {
    expect(states(view)).toEqual({
      '2026-01-25': 'received',
      '2026-02-25': 'skipped',
      '2026-03-25': 'received',
      '2026-04-25': 'missing',
      '2026-05-25': 'received',
      '2026-06-25': 'missing',
      '2026-07-25': 'missing',
      '2026-08-25': 'missing',
      '2026-09-25': 'missing',
      // October has not ended: its salary may still arrive.
      '2026-10-25': 'not_yet_due',
      '2026-11-25': 'skipped',
      '2026-12-25': 'not_yet_due',
    });
  });

  it('reports as missing exactly what missingIncomeOccurrences finds, month by month', () => {
    const resolved = new Set([
      ...payments.map((row) => occurrenceKey(SALARY, row.occurrenceDate)),
      ...skips.map((row) => occurrenceKey(SALARY, row.occurrenceDate)),
    ]);
    const expected: string[] = [];
    for (let month = 1; month <= 9; month += 1) {
      for (const missing of missingIncomeOccurrences([salary], resolved, monthKeyOf(2026, month))) {
        expected.push(missing.occurrenceDate);
      }
    }
    expect(view.missing).toEqual(expected);
    expect(view.occurrences.filter((occurrence) => occurrence.state.kind === 'missing').map((row) => row.occurrenceDate)).toEqual(
      expected,
    );
  });

  it('flags nothing in a year that has not ended a month, and has nothing before the source starts', () => {
    const january = incomeSourceYear({ template: salary, payments: [], skips: [], year: 2026, today: plainDate('2026-01-20') });
    expect(january.missing).toEqual([]);
    expect(new Set(Object.values(states(january)))).toEqual(new Set(['not_yet_due']));

    const before = incomeSourceYear({ template: salary, payments: [], skips: [], year: 2025, today: TODAY });
    expect(before.occurrences).toEqual([]);
    expect(before.missing).toEqual([]);
  });

  it('counts a past year whole, and stops at the source’s end date', () => {
    const ended = template({ start: '2025-01-01', end: '2025-06-30', day: 1 });
    const past = incomeSourceYear({ template: ended, payments: [payment('2025-01-01')], skips: [], year: 2025, today: TODAY });
    expect(past.missing).toEqual(['2025-02-01', '2025-03-01', '2025-04-01', '2025-05-01', '2025-06-01']);
    expect(past.occurrences).toHaveLength(6);
  });

  it('leaves the year outside what it reads untouched by payments of other years', () => {
    const lastYear = template({ start: '2025-12-01', day: 1 });
    const view2026 = incomeSourceYear({
      template: lastYear,
      payments: [payment('2025-12-01'), payment('2026-01-01')],
      skips: [],
      year: 2026,
      today: TODAY,
    });
    expect(view2026.occurrences[0]?.state.kind).toBe('received');
    expect(view2026.occurrences.some((occurrence) => occurrence.occurrenceDate === '2025-12-01')).toBe(false);
  });

  it('puts every occurrence in exactly one state, and every payment and skip of the year on its own occurrence', () => {
    const months = fc.subarray(['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']);
    fc.assert(
      fc.property(months, months, fc.integer({ min: 1, max: 12 }), (paidMonths, skippedMonths, todayMonth) => {
        const skipOnly = skippedMonths.filter((month) => !paidMonths.includes(month));
        const today = plainDate(`2026-${String(todayMonth).padStart(2, '0')}-10`);
        const result = incomeSourceYear({
          template: salary,
          payments: paidMonths.map((month) => payment(`2026-${month}-25`)),
          skips: skipOnly.map((month) => skip(`2026-${month}-25`)),
          year: 2026,
          today,
        });
        expect(result.occurrences).toHaveLength(12);
        for (const occurrence of result.occurrences) {
          const month = occurrence.occurrenceDate.slice(5, 7);
          const completed = occurrence.occurrenceDate.slice(0, 7) < today.slice(0, 7);
          const expected = paidMonths.includes(month)
            ? 'received'
            : skipOnly.includes(month)
              ? 'skipped'
              : completed
                ? 'missing'
                : 'not_yet_due';
          expect(occurrence.state.kind).toBe(expected);
        }
      }),
    );
  });
});
