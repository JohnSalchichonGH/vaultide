import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { monthKeyOf, plainDate } from '../../src/dates/plain-date';
import { currencyCode } from '../../src/money/types';
import type { PositionWithValuations, ValuationRecord } from '../../src/positions/types';
import { entry, position, valuation } from '../helpers/records';
import {
  completedMonthCompleteness,
  type CompletedMonthCompletenessInput,
  type CompletenessState,
} from '../../src/completeness/index';
import { occurrenceKey, type CompletenessTemplate } from '../../src/reconciliation/index';

/**
 * Invariants of completed-month completeness (12.6, v2.1.15 30.18).
 *
 * Four statements that hold for any balance sheet and any schedule: the answer
 * does not depend on the order the records arrive in; the counts explain
 * themselves and the ratio is theirs; resolving one more scheduled occurrence
 * satisfies exactly one more item and never makes the state worse; and
 * evidence dated after the month changes nothing at all.
 */

const SEPTEMBER = monthKeyOf(2026, 9);
const TODAY = plainDate('2026-10-01');

/** Dates around September, including both of its edges and the days either side. */
const DATES = ['2026-07-31', '2026-08-15', '2026-08-31', '2026-09-01', '2026-09-14', '2026-09-30', '2026-10-01'];
const MONTH_ENDS = new Set(['2026-07-31', '2026-08-31', '2026-09-30']);

const valuationsArb = (id: string): fc.Arbitrary<ValuationRecord[]> =>
  fc
    .uniqueArray(fc.constantFrom(...DATES), { maxLength: 4 })
    .chain((dates) =>
      fc.tuple(...dates.map((date) => fc.boolean().map((statement) => [date, statement] as const))),
    )
    .map((pairs) =>
      pairs.map(([date, statement]) =>
        valuation(id, date, '100', {
          precision: statement && MONTH_ENDS.has(date) ? 'month_end' : 'exact',
        }),
      ),
    );

const cashArb = (id: string): fc.Arbitrary<PositionWithValuations> =>
  fc
    .record({
      openedOn: fc.constantFrom(null, '2026-08-01', '2026-09-10', '2026-10-05'),
      closedOn: fc.constantFrom(null, '2026-08-20', '2026-09-01', '2026-09-15'),
      isDormant: fc.boolean(),
      valuations: valuationsArb(id),
    })
    .map(({ openedOn, closedOn, isDormant, valuations }) =>
      entry(
        position(id, {
          id,
          openedOn,
          closedOn: closedOn !== null && openedOn !== null && closedOn < openedOn ? null : closedOn,
          isDormant,
        }),
        valuations,
      ),
    );

const otherAssetArb = (id: string): fc.Arbitrary<PositionWithValuations> =>
  valuationsArb(id).map((valuations) => entry(position(id, { id, kind: 'other_asset' }), valuations));

const templateArb = (id: string): fc.Arbitrary<CompletenessTemplate> =>
  fc
    .record({
      kind: fc.constantFrom<CompletenessTemplate['kind']>('income', 'expense'),
      dayOfMonth: fc.integer({ min: 1, max: 31 }),
      startDate: fc.constantFrom('2026-01-01', '2026-09-10', '2026-09-30', '2026-10-01'),
      endDate: fc.constantFrom(null, '2026-09-05', '2026-09-30', '2027-01-01'),
      currency: fc.constantFrom('EUR', 'USD'),
    })
    .map(({ kind, dayOfMonth, startDate, endDate, currency }) => ({
      templateId: id,
      name: id,
      kind,
      currency: currencyCode(currency),
      incomeKind: kind === 'income' ? 'employment' : null,
      schedule: {
        frequency: 'monthly',
        dayOfMonth,
        startDate: plainDate(startDate),
        endDate: endDate === null ? null : plainDate(endDate),
      },
    }));

/** Resolution keys: every September day for the templates, some chosen. */
const resolvedArb = (templateIds: readonly string[]): fc.Arbitrary<Set<string>> => {
  const keys = templateIds.flatMap((id) =>
    Array.from({ length: 30 }, (_, day) => occurrenceKey(id, `2026-09-${String(day + 1).padStart(2, '0')}`)),
  );
  return fc.subarray(keys, { maxLength: Math.min(12, keys.length) }).map((chosen) => new Set(chosen));
};

const inputArb: fc.Arbitrary<CompletedMonthCompletenessInput> = fc
  .record({
    cash: fc.uniqueArray(fc.constantFrom('c1', 'c2', 'c3', 'c4'), { maxLength: 4 }),
    assets: fc.uniqueArray(fc.constantFrom('o1', 'o2'), { maxLength: 2 }),
    templates: fc.uniqueArray(fc.constantFrom('t1', 't2', 't3', 't4'), { maxLength: 4 }),
  })
  .chain(({ cash, assets, templates }) =>
    fc.record({
      positions: fc.tuple(...cash.map(cashArb), ...assets.map(otherAssetArb)),
      templates: fc.tuple(...templates.map(templateArb)),
      resolvedOccurrences: resolvedArb(templates),
    }),
  )
  .map(({ positions, templates, resolvedOccurrences }) => ({
    month: SEPTEMBER,
    today: TODAY,
    positions,
    templates,
    resolvedOccurrences,
  }));

const SEVERITY: Readonly<Record<CompletenessState, number>> = {
  stale: 3,
  incomplete: 2,
  partial: 1,
  sufficient: 0,
};

describe('completed-month completeness invariants', () => {
  it('does not depend on the order positions and templates arrive in', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const reversed = {
          ...input,
          positions: [...input.positions].reverse(),
          templates: [...input.templates].reverse(),
        };
        expect(completedMonthCompleteness(reversed)).toEqual(completedMonthCompleteness(input));
      }),
    );
  });

  it('keeps counts that explain themselves, and a ratio that is theirs', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const result = completedMonthCompleteness(input);
        const items = [...result.cashAccounts, ...result.recurringOccurrences];

        expect(result.required).toBe(items.length);
        expect(result.satisfied).toBe(items.filter((item) => item.satisfied).length);
        expect(result.satisfied).toBeLessThanOrEqual(result.required);
        if (result.required === 0) {
          expect(result.ratio).toBeNull();
        } else {
          expect(result.ratio?.times(result.required).minus(result.satisfied).abs().lessThan('1e-30')).toBe(true);
        }
      }),
    );
  });

  it('satisfies exactly one more item per resolved occurrence, and never worsens the state', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const before = completedMonthCompleteness(input);
        const open = before.recurringOccurrences.find((item) => !item.satisfied);
        if (open === undefined) return;

        const after = completedMonthCompleteness({
          ...input,
          resolvedOccurrences: new Set([
            ...input.resolvedOccurrences,
            occurrenceKey(open.templateId, open.occurrenceDate),
          ]),
        });

        expect(after.required).toBe(before.required);
        expect(after.satisfied).toBe(before.satisfied + 1);
        expect(SEVERITY[after.state]).toBeLessThanOrEqual(SEVERITY[before.state]);
      }),
    );
  });

  it('changes nothing for evidence dated after the month', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const later = {
          ...input,
          positions: input.positions.map((item) =>
            entry(item.position, [...item.valuations, valuation(item.position.id, '2026-10-15', '1')]),
          ),
        };
        expect(completedMonthCompleteness(later)).toEqual(completedMonthCompleteness(input));
      }),
    );
  });
});
