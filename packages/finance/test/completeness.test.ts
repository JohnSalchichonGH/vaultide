import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/decimal';
import { monthKeyOf, plainDate } from '../src/dates/plain-date';
import { currencyCode } from '../src/money/types';
import type { PositionWithValuations } from '../src/positions/types';
import { entry, monthEnd, position, valuation } from './helpers/records';
import {
  completedMonthCompleteness,
  type CompletedMonthCompletenessInput,
} from '../src/completeness/index';
import {
  MonthNotCompletedError,
  missingIncomeOccurrences,
  occurrenceKey,
  reconcileCompletedMonth,
  scheduledOccurrences,
  type CompletedMonthInput,
  type CompletenessTemplate,
} from '../src/reconciliation/index';

/**
 * Completed-month completeness (blueprint 12.6, v2.1.15 30.18).
 *
 * Every expectation below is read off 12.6's table and 30.18's rulings, not off
 * the engine: which items are required, what satisfies each, the precedence
 * `stale` > `incomplete` > `partial` > `sufficient`, the in-month valuation
 * predicate, and a ratio that is not applicable when nothing is required.
 *
 * September 2026 throughout, judged on 1 October — the first day it is a
 * completed month (8.1).
 */

const EUR = currencyCode('EUR');
const USD = currencyCode('USD');
const SEPTEMBER = monthKeyOf(2026, 9);
const FIRST_OF_OCTOBER = plainDate('2026-10-01');

function cash(
  id: string,
  valuations: PositionWithValuations['valuations'],
  options: { currency?: string; openedOn?: string; closedOn?: string; isDormant?: boolean } = {},
): PositionWithValuations {
  return entry(
    position(id.toUpperCase(), {
      id,
      currency: options.currency ?? 'EUR',
      ...(options.openedOn === undefined ? {} : { openedOn: options.openedOn }),
      ...(options.closedOn === undefined ? {} : { closedOn: options.closedOn, status: 'closed' }),
      ...(options.isDormant === undefined ? {} : { isDormant: options.isDormant }),
    }),
    valuations,
  );
}

/** A Phase 2 other asset — a car — with whatever valuations it has. */
function car(valuations: PositionWithValuations['valuations']): PositionWithValuations {
  return entry(position('Car', { id: 'car', kind: 'other_asset' }), valuations);
}

/** An account with August's and September's statements: satisfied, and evidence in M. */
const closedMonth = (id: string, options: { currency?: string } = {}) =>
  cash(id, [monthEnd(id, '2026-08-31', '1000'), monthEnd(id, '2026-09-30', '900')], options);

function template(
  templateId: string,
  over: Partial<Omit<CompletenessTemplate, 'schedule'>> & {
    dayOfMonth?: number;
    startDate?: string;
    endDate?: string | null;
  } = {},
): CompletenessTemplate {
  return {
    templateId,
    name: over.name ?? templateId,
    kind: over.kind ?? 'income',
    currency: over.currency ?? EUR,
    incomeKind: over.kind === 'expense' ? null : (over.incomeKind ?? 'employment'),
    schedule: {
      frequency: 'monthly',
      dayOfMonth: over.dayOfMonth ?? 25,
      startDate: plainDate(over.startDate ?? '2026-01-01'),
      endDate: over.endDate === undefined || over.endDate === null ? null : plainDate(over.endDate),
    },
  };
}

function input(over: Partial<CompletedMonthCompletenessInput> = {}): CompletedMonthCompletenessInput {
  return {
    month: SEPTEMBER,
    today: FIRST_OF_OCTOBER,
    positions: [],
    templates: [],
    resolvedOccurrences: new Set<string>(),
    ...over,
  };
}

const judge = (over: Partial<CompletedMonthCompletenessInput> = {}) =>
  completedMonthCompleteness(input(over));

const resolved = (...keys: [string, string][]): Set<string> =>
  new Set(keys.map(([templateId, date]) => occurrenceKey(templateId, date)));

describe('a sufficient Phase 3 month', () => {
  it('counts every cash account and every occurrence, all satisfied', () => {
    const result = judge({
      positions: [closedMonth('bbva'), closedMonth('savings')],
      templates: [template('salary'), template('rent', { kind: 'expense', dayOfMonth: 1 })],
      resolvedOccurrences: resolved(['salary', '2026-09-25'], ['rent', '2026-09-01']),
    });

    expect(result.state).toBe('sufficient');
    expect(result.required).toBe(4);
    expect(result.satisfied).toBe(4);
    expect(result.ratio?.toString()).toBe('1');
    expect(result.month).toBe(SEPTEMBER);
  });
});

describe('cash items (12.6 row 1, 8.1)', () => {
  it('is incomplete when an active account has no statement for M', () => {
    // A mid-month snapshot is evidence inside M, so the month is not stale —
    // and it is not a closing (8.8), so the account is still unsatisfied.
    const result = judge({
      positions: [
        cash('bbva', [monthEnd('bbva', '2026-08-31', '1000'), valuation('bbva', '2026-09-15', '950')]),
      ],
    });

    expect(result.state).toBe('incomplete');
    expect(result.cashAccounts).toEqual([
      { positionId: 'bbva', name: 'BBVA', currency: EUR, satisfied: false, closeState: 'carried' },
    ]);
    expect(result.satisfied).toBe(0);
    expect(result.required).toBe(1);
    expect(result.ratio?.toString()).toBe('0');
  });

  it('is not satisfied by an ordinary snapshot dated the last day', () => {
    const result = judge({
      positions: [cash('bbva', [valuation('bbva', '2026-09-30', '900')])],
    });
    expect(result.cashAccounts[0]).toMatchObject({ satisfied: false, closeState: 'carried' });
    expect(result.state).toBe('incomplete');
  });

  it('is satisfied by a month-end statement', () => {
    const result = judge({ positions: [closedMonth('bbva')] });
    expect(result.cashAccounts[0]).toMatchObject({ satisfied: true, closeState: 'month_end' });
    expect(result.state).toBe('sufficient');
  });

  it('is satisfied by closing inside M', () => {
    const result = judge({
      positions: [
        cash('old', [monthEnd('old', '2026-08-31', '500'), valuation('old', '2026-09-15', '0')], {
          closedOn: '2026-09-15',
        }),
      ],
    });
    expect(result.cashAccounts[0]).toMatchObject({ satisfied: true, closeState: 'closed_zero' });
    expect(result.state).toBe('sufficient');
  });

  it('leaves a dormant account out of the count, rather than counting it satisfied', () => {
    const result = judge({
      positions: [closedMonth('bbva'), cash('dormant', [], { isDormant: true })],
    });
    expect(result.cashAccounts.map((item) => item.positionId)).toEqual(['bbva']);
    expect(result.required).toBe(1);
    expect(result.satisfied).toBe(1);
  });

  it('leaves a dormant account out even when it has a statement for M', () => {
    // 12.6 counts non-dormant accounts. The flag decides that, not whether the
    // account happens to hold evidence.
    const result = judge({
      positions: [closedMonth('bbva'), cash('dormant', [monthEnd('dormant', '2026-09-30', '0')], { isDormant: true })],
    });
    expect(result.required).toBe(1);
  });

  describe('which accounts take part, by 8.1 participation', () => {
    const ids = (positions: PositionWithValuations[]) =>
      judge({ positions: [closedMonth('anchor'), ...positions] }).cashAccounts.map((item) => item.positionId);

    it('excludes an account opened after M', () => {
      expect(ids([cash('later', [], { openedOn: '2026-10-01' })])).toEqual(['anchor']);
    });

    it('excludes an account closed before M', () => {
      expect(ids([cash('gone', [valuation('gone', '2026-08-31', '0')], { closedOn: '2026-08-31' })])).toEqual([
        'anchor',
      ]);
    });

    it('includes an account opened on the last day of M, which owes a statement', () => {
      const result = judge({ positions: [closedMonth('anchor'), cash('new', [], { openedOn: '2026-09-30' })] });
      expect(result.cashAccounts.find((item) => item.positionId === 'new')).toMatchObject({
        satisfied: false,
        closeState: 'missing',
      });
      expect(result.state).toBe('incomplete');
    });

    it('includes an account that closed on the first day of M, as closed_zero', () => {
      const result = judge({
        positions: [
          closedMonth('anchor'),
          cash('first', [monthEnd('first', '2026-08-31', '0')], { closedOn: '2026-09-01' }),
        ],
      });
      expect(result.cashAccounts.find((item) => item.positionId === 'first')).toMatchObject({
        satisfied: true,
        closeState: 'closed_zero',
      });
    });

    it('includes a pre-existing account whose tracking starts later, as 8.1 always has', () => {
      // `opened_on` NULL participates in every month (8.1). Its first statement
      // is in November, so September is missing — the same account
      // reconciliation reports as `missing_month_end`.
      const result = judge({
        positions: [closedMonth('anchor'), cash('pre', [monthEnd('pre', '2026-11-30', '10')])],
      });
      expect(result.cashAccounts.find((item) => item.positionId === 'pre')).toMatchObject({
        satisfied: false,
        closeState: 'missing',
      });
    });

    it('excludes positions that are not cash from the cash row', () => {
      expect(ids([car([valuation('car', '2026-09-10', '9000')])])).toEqual(['anchor']);
    });
  });

  it('orders the accounts the same whichever order they arrive in', () => {
    const a = closedMonth('a-account');
    const b = cash('b-account', []);
    const forward = judge({ positions: [a, b] }).cashAccounts.map((item) => item.positionId);
    const backward = judge({ positions: [b, a] }).cashAccounts.map((item) => item.positionId);
    expect(forward).toEqual(['a-account', 'b-account']);
    expect(backward).toEqual(forward);
  });
});

describe('recurring items (12.6 occurrence row, 30.10)', () => {
  const withCash = (over: Partial<CompletedMonthCompletenessInput>) =>
    judge({ positions: [closedMonth('bbva')], ...over });

  it('is partial when cash is complete and an income occurrence is missing', () => {
    const result = withCash({ templates: [template('salary')] });
    expect(result.state).toBe('partial');
    expect(result.recurringOccurrences).toEqual([
      {
        templateId: 'salary',
        templateName: 'salary',
        templateKind: 'income',
        currency: EUR,
        occurrenceDate: '2026-09-25',
        satisfied: false,
      },
    ]);
    expect(result.satisfied).toBe(1);
    expect(result.required).toBe(2);
    expect(result.ratio?.toString()).toBe('0.5');
  });

  it('counts a missing expense occurrence as well', () => {
    const result = withCash({ templates: [template('insurance', { kind: 'expense', dayOfMonth: 12 })] });
    expect(result.state).toBe('partial');
    expect(result.recurringOccurrences[0]).toMatchObject({
      templateKind: 'expense',
      occurrenceDate: '2026-09-12',
      satisfied: false,
    });
  });

  it('satisfies exactly the occurrence a resolution names', () => {
    const result = withCash({
      templates: [template('salary'), template('bonus', { dayOfMonth: 15 })],
      resolvedOccurrences: resolved(['salary', '2026-09-25']),
    });
    expect(result.recurringOccurrences.map((item) => [item.templateId, item.satisfied])).toEqual([
      ['bonus', false],
      ['salary', true],
    ]);
    expect(result.satisfied).toBe(2);
    expect(result.required).toBe(3);
  });

  it('ignores a resolution for a date the schedule never had, and one from another month', () => {
    // The identity is `(template_id, occurrence_date)`. A resolution that names
    // no scheduled occurrence satisfies nothing and adds nothing.
    const result = withCash({
      templates: [template('salary')],
      resolvedOccurrences: resolved(['salary', '2026-09-24'], ['salary', '2026-08-25'], ['other', '2026-09-25']),
    });
    expect(result.recurringOccurrences[0]?.satisfied).toBe(false);
    expect(result.required).toBe(2);
    expect(result.satisfied).toBe(1);
  });

  it('counts a resolved occurrence once, however many records resolve it', () => {
    // A flow and a skip for one occurrence reach the engine as one identity in a
    // set, so a second record cannot become a second satisfied item.
    const keys = [occurrenceKey('salary', '2026-09-25'), occurrenceKey('salary', '2026-09-25')];
    const result = withCash({ templates: [template('salary')], resolvedOccurrences: new Set(keys) });
    expect(result.required).toBe(2);
    expect(result.satisfied).toBe(2);
  });

  it('has no archive state to consult', () => {
    // 30.10: archiving is present-tense. The input cannot carry it, so a template
    // archived since still expects its occurrence; the application tests prove
    // the loader does not filter it out.
    expect(Object.keys(template('salary'))).not.toContain('archivedAt');
    expect(withCash({ templates: [template('salary')] }).recurringOccurrences).toHaveLength(1);
  });

  describe('the schedule bounds (6.2, 30.9 item 3)', () => {
    const count = (over: Parameters<typeof template>[1]) =>
      withCash({ templates: [template('salary', over)] }).recurringOccurrences.length;

    it('counts an occurrence on the template’s own start date', () => {
      expect(count({ startDate: '2026-09-25' })).toBe(1);
    });

    it('expects nothing when the template starts after the anchor day', () => {
      expect(count({ startDate: '2026-09-26' })).toBe(0);
    });

    it('counts an occurrence on the template’s own end date', () => {
      expect(count({ endDate: '2026-09-25' })).toBe(1);
    });

    it('expects nothing when the template ended the day before', () => {
      expect(count({ endDate: '2026-09-24' })).toBe(0);
    });

    it('expects nothing from a template that starts in a later month', () => {
      expect(count({ startDate: '2026-10-01' })).toBe(0);
    });
  });

  it('orders occurrences by date, then template, whichever order templates arrive in', () => {
    const templates = [
      template('zeta', { dayOfMonth: 1 }),
      template('beta', { dayOfMonth: 25 }),
      template('alpha', { dayOfMonth: 25, kind: 'expense' }),
    ];
    const order = (list: CompletenessTemplate[]) =>
      withCash({ templates: list }).recurringOccurrences.map((item) => `${item.occurrenceDate} ${item.templateId}`);

    expect(order(templates)).toEqual(['2026-09-01 zeta', '2026-09-25 alpha', '2026-09-25 beta']);
    expect(order([...templates].reverse())).toEqual(order(templates));
  });

  it('is one global count across currencies, including one no bucket exists for', () => {
    // A USD template with no USD account: reconciliation has no USD bucket to
    // raise anything in, and completeness still expects the occurrence.
    const usdSalary = template('usd-salary', { currency: USD });
    const result = withCash({ templates: [template('salary'), usdSalary] });

    expect(result.recurringOccurrences.map((item) => item.currency)).toEqual([EUR, USD]);
    expect(result.required).toBe(3);

    const reconciliation = reconcileCompletedMonth(reconciliationInputFor(result.month, [usdSalary]));
    expect(reconciliation.buckets.map((bucket) => bucket.currency)).toEqual(['EUR']);
  });
});

describe('the stale state (30.18 items 1–3)', () => {
  it('outranks incomplete: an active account and no valuation inside M', () => {
    const result = judge({ positions: [cash('bbva', [monthEnd('bbva', '2026-08-31', '1000')])] });
    expect(result.state).toBe('stale');
    expect(result.cashAccounts[0]?.satisfied).toBe(false);
    expect(result.satisfied).toBe(0);
    expect(result.required).toBe(1);
  });

  it('outranks partial: no cash requirement, a missing occurrence, nothing valued inside M', () => {
    const result = judge({
      positions: [cash('dormant', [], { isDormant: true }), car([valuation('car', '2026-08-10', '9000')])],
      templates: [template('salary')],
    });
    expect(result.state).toBe('stale');
    expect(result.required).toBe(1);
    expect(result.satisfied).toBe(0);
  });

  it('outranks sufficient: every requirement satisfied, nothing valued inside M', () => {
    // The account closed on the 15th with its zero statement from August, which
    // is allowed (M6 asks for a zero balance, not one dated the closing day).
    const result = judge({
      positions: [cash('old', [monthEnd('old', '2026-08-31', '0')], { closedOn: '2026-09-15' })],
      templates: [template('salary')],
      resolvedOccurrences: resolved(['salary', '2026-09-25']),
    });
    expect(result.state).toBe('stale');
    expect(result.satisfied).toBe(2);
    expect(result.required).toBe(2);
    expect(result.ratio?.toString()).toBe('1');
  });

  it('is prevented by an other asset valued inside M, and the state then resolves normally', () => {
    const over = {
      positions: [cash('dormant', [], { isDormant: true }), car([valuation('car', '2026-09-10', '9000')])],
      templates: [template('salary')],
    };
    expect(judge(over).state).toBe('partial');
    expect(judge({ ...over, resolvedOccurrences: resolved(['salary', '2026-09-25']) }).state).toBe(
      'sufficient',
    );
    expect(
      judge({ ...over, positions: [...over.positions, cash('bbva', [monthEnd('bbva', '2026-08-31', '1')])] })
        .state,
    ).toBe('incomplete');
  });

  it('is not prevented by a balance carried from before M', () => {
    const result = judge({
      positions: [
        cash('bbva', [valuation('bbva', '2026-08-15', '1000'), monthEnd('bbva', '2026-08-31', '1000')]),
        car([valuation('car', '2026-08-31', '9000')]),
      ],
    });
    expect(result.state).toBe('stale');
  });

  it('is not prevented by a valuation dated after M', () => {
    // The loader never passes one; the interval is the engine's own rule all the
    // same, not an accident of what it was handed.
    const result = judge({
      positions: [
        cash('bbva', [monthEnd('bbva', '2026-08-31', '1000'), valuation('bbva', '2026-10-01', '1000')]),
      ],
    });
    expect(result.state).toBe('stale');
  });

  describe('is prevented by any valuation dated inside M, whatever its precision or source', () => {
    const notStale = (positions: PositionWithValuations[]) => judge({ positions }).state !== 'stale';

    it('an ordinary snapshot on the first day', () => {
      expect(notStale([cash('bbva', [valuation('bbva', '2026-09-01', '1000')])])).toBe(true);
    });

    it('a confirmed-unchanged statement on the last day', () => {
      expect(
        notStale([cash('bbva', [monthEnd('bbva', '2026-09-30', '1000', 'confirmed_unchanged')])]),
      ).toBe(true);
    });

    it('an other asset’s purchase valuation', () => {
      expect(notStale([car([valuation('car', '2026-09-20', '9000', { source: 'purchase' })])])).toBe(true);
    });
  });
});

describe('nothing required (30.18 items 4–5)', () => {
  it('is stale with a null ratio when nothing was valued either', () => {
    const result = judge({ positions: [cash('dormant', [], { isDormant: true })] });
    expect(result).toMatchObject({ state: 'stale', satisfied: 0, required: 0, ratio: null });
  });

  it('is sufficient with a null ratio when something was valued inside M', () => {
    const result = judge({
      positions: [cash('dormant', [], { isDormant: true }), car([valuation('car', '2026-09-10', '9000')])],
    });
    expect(result).toMatchObject({ state: 'sufficient', satisfied: 0, required: 0, ratio: null });
  });

  it('makes no exception for a user with no positions at all', () => {
    expect(judge()).toMatchObject({ state: 'stale', satisfied: 0, required: 0, ratio: null });
  });

  it('never reports a percentage for it: the ratio is absent, not 0 or 1', () => {
    const { ratio } = judge();
    expect(ratio).toBeNull();
  });
});

describe('the ratio is derived from the counts', () => {
  it('is the unrounded quotient', () => {
    const result = judge({
      positions: [closedMonth('bbva')],
      templates: [template('a', { dayOfMonth: 1 }), template('b', { dayOfMonth: 2 }), template('c', { dayOfMonth: 3 })],
      resolvedOccurrences: resolved(['a', '2026-09-01'], ['b', '2026-09-02']),
    });
    expect(result.satisfied).toBe(3);
    expect(result.required).toBe(4);
    expect(result.ratio?.toString()).toBe('0.75');
    expect(result.ratio?.times(result.required).equals(result.satisfied)).toBe(true);
  });
});

describe('completed months only', () => {
  it('refuses the current month, on its last day too', () => {
    expect(() => judge({ today: plainDate('2026-09-30') })).toThrow(MonthNotCompletedError);
  });

  it('answers from the first day of the next month', () => {
    expect(() => judge({ today: FIRST_OF_OCTOBER })).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Nothing else moves                                                          */
/* -------------------------------------------------------------------------- */

/** The same September, in the shape the reconciliation engine takes. */
function reconciliationInputFor(
  month: CompletedMonthInput['month'],
  templates: CompletenessTemplate[],
  resolvedOccurrences: ReadonlySet<string> = new Set(),
): CompletedMonthInput {
  const bbva = closedMonth('bbva');
  return {
    month,
    today: FIRST_OF_OCTOBER,
    cashAccounts: [{ position: bbva.position, valuations: bbva.valuations, accountType: 'checking' }],
    income: [],
    expenses: [],
    transfers: [],
    templates,
    resolvedOccurrences,
  };
}

describe('reconciliation is unchanged by completeness', () => {
  it('raises no issue for a missing expense occurrence, which still counts here', () => {
    const insurance = template('insurance', { kind: 'expense', dayOfMonth: 12 });
    const reconciliation = reconcileCompletedMonth(reconciliationInputFor(SEPTEMBER, [insurance]));
    expect(reconciliation.buckets[0]?.issues).toEqual([]);
    expect(reconciliation.monthStatus).toBe('reliable');

    expect(judge({ positions: [closedMonth('bbva')], templates: [insurance] }).state).toBe('partial');
  });

  it('gives the same reconciliation before and after completeness is judged', () => {
    const templates = [template('salary'), template('insurance', { kind: 'expense', dayOfMonth: 12 })];
    const reconciliationInput = reconciliationInputFor(SEPTEMBER, templates);
    const before = reconcileCompletedMonth(reconciliationInput);

    judge({ positions: [closedMonth('bbva')], templates, resolvedOccurrences: reconciliationInput.resolvedOccurrences });

    expect(reconcileCompletedMonth(reconciliationInput)).toEqual(before);
    expect(before.buckets[0]?.issues.map((issue) => issue.key)).toEqual(['suggested_income_missing']);
  });
});

describe('the occurrence primitive under suggested_income_missing', () => {
  const templates = [
    template('tpl-salary', { name: 'Salary' }),
    template('tpl-aaa', { name: 'Second job' }),
    template('tpl-zzz', { name: 'Rent in', dayOfMonth: 1, incomeKind: 'rental' }),
    template('tpl-rent', { name: 'Rent out', kind: 'expense', dayOfMonth: 1 }),
    template('tpl-ended', { name: 'Ended', endDate: '2026-08-31' }),
  ];
  const resolvedKeys = resolved(['tpl-aaa', '2026-09-25']);

  it('still lists exactly the unresolved income occurrences, in the same order and shape', () => {
    // Hand-written, including key order, so the refactor cannot have moved a
    // byte of what the issue detector reads.
    expect(JSON.stringify(missingIncomeOccurrences(templates, resolvedKeys, SEPTEMBER))).toBe(
      JSON.stringify([
        { templateId: 'tpl-zzz', templateName: 'Rent in', currency: 'EUR', occurrenceDate: '2026-09-01' },
        { templateId: 'tpl-salary', templateName: 'Salary', currency: 'EUR', occurrenceDate: '2026-09-25' },
      ]),
    );
  });

  it('is the income, unresolved part of the whole schedule', () => {
    const schedule = scheduledOccurrences(templates, resolvedKeys, SEPTEMBER);
    expect(schedule.map((item) => `${item.occurrenceDate} ${item.templateId} ${String(item.resolved)}`)).toEqual([
      '2026-09-01 tpl-rent false',
      '2026-09-01 tpl-zzz false',
      '2026-09-25 tpl-aaa true',
      '2026-09-25 tpl-salary false',
    ]);
  });

  it('feeds the same issues the reconciliation raised before the refactor', () => {
    const reconciliation = reconcileCompletedMonth(reconciliationInputFor(SEPTEMBER, templates, resolvedKeys));
    expect(
      reconciliation.buckets[0]?.issues.map((issue) => [issue.key, issue.templateId, issue.occurrenceDate]),
    ).toEqual([
      ['suggested_income_missing', 'tpl-zzz', '2026-09-01'],
      ['suggested_income_missing', 'tpl-salary', '2026-09-25'],
    ]);
  });
});

describe('what the result is made of', () => {
  it('carries the counts beside every item, satisfied and unsatisfied', () => {
    const result = judge({
      positions: [closedMonth('bbva'), cash('savings', [valuation('savings', '2026-09-10', '5')])],
      templates: [template('salary')],
      resolvedOccurrences: resolved(['salary', '2026-09-25']),
    });

    const items = [...result.cashAccounts, ...result.recurringOccurrences];
    expect(result.required).toBe(items.length);
    expect(result.satisfied).toBe(items.filter((item) => item.satisfied).length);
    expect(Object.keys(result)).toEqual([
      'month',
      'state',
      'satisfied',
      'required',
      'ratio',
      'cashAccounts',
      'recurringOccurrences',
    ]);
    expect(result.ratio).toBeInstanceOf(Decimal);
  });
});
