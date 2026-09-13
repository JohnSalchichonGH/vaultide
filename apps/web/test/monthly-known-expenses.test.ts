import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SaveOutcome } from '@/features/monthly/autosave';
import type {
  CurrentMonthlyExpensesDto,
  ExpenseCategoryDto,
  ExpenseOccurrenceDto,
  ExpenseSourceDto,
  ExpenseTermDto,
  MonthlyExpenseEntryDto,
  MonthlyExpensesDto,
  PaidTodayCandidateDto,
} from '@vaultide/application';

// The section calls server actions and the app router; neither exists outside
// Next, and neither is what these tests are about.
vi.mock('@/server/actions/flows', () => ({
  createExpenseEntryAction: vi.fn(),
  deleteExpenseEntryAction: vi.fn(),
  updateExpenseEntryAction: vi.fn(),
}));
vi.mock('@/server/actions/recurring', () => ({
  acceptSuggestionAction: vi.fn(),
  createTemplateAction: vi.fn(),
  setTemplateTermAction: vi.fn(),
  skipSuggestionAction: vi.fn(),
  unskipSuggestionAction: vi.fn(),
  updateTemplateAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement('a', { href, ...rest }, children),
}));

const { AddExpenseForm, AddExpenseSourceForm, KnownExpensesSection } = await import(
  '@/features/monthly/expenses-editor'
);
const { canWrite, draftsAfterSave, runSave } = await import('@/features/monthly/autosave');
const {
  EXPENSE_HISTORICAL_START_NOTE,
  MONEY_OUT_NOTE,
  NO_ACCOUNT,
  PAYMENT_METHOD_LABEL,
  TRANSFER_FEE_NOTE,
  accountAfterChange,
  accountChoices,
  adjustmentAmountDefault,
  categoryOptionGroups,
  decideExpenseAmountOnBlur,
  endDateChangeOf,
  endDateChangeSummary,
  expenseAmountProblem,
  expenseCrossMonthNotice,
  expenseOccurrenceStateLabel,
  expenseSkipReasonOptions,
  knownExpensesHref,
  ownsExpense,
  paymentMethodFor,
  paymentMethodLabel,
  paymentMethodOptions,
  protectedSourceNote,
  termAmountProblem,
} = await import('@/features/monthly/expenses-presentation');

/**
 * Monthly's Known-expenses section (blueprint 6.2, 7.4, 15.3 section 3, 16.6,
 * 20.3).
 *
 * Every state arrives from the server. These tests pin how each row reads,
 * which controls it offers and — more often the point — which it must never
 * offer: a control the services would refuse, a category the section does not
 * own, or a figure the section has no business totalling.
 */

const eur = (amount: string) => ({ amount, currency: 'EUR' });
const formatting = { locale: 'en-GB', minorUnitsByCurrency: { EUR: 2, USD: 2, JPY: 0 } };

const ACCOUNTS: MonthlyExpensesDto['cashAccounts'] = [
  { positionId: 'pos-bbva', name: 'BBVA', currency: 'EUR', openedOn: null, closedOn: null },
  { positionId: 'pos-usd', name: 'Dollars', currency: 'USD', openedOn: null, closedOn: null },
  { positionId: 'pos-late', name: 'Late card', currency: 'EUR', openedOn: '2026-09-20', closedOn: null },
  { positionId: 'pos-shut', name: 'Old card', currency: 'EUR', openedOn: null, closedOn: '2026-09-05' },
];

function category(over: Partial<ExpenseCategoryDto> = {}): ExpenseCategoryDto {
  return {
    categoryId: 'cat-groceries',
    name: 'Groceries',
    kind: 'food',
    use: 'spending',
    archived: false,
    selectable: true,
    ...over,
  };
}

const GROCERIES = category();
const SUBSCRIPTIONS = category({ categoryId: 'cat-subs', name: 'Subscriptions', kind: 'subscriptions' });
const MONEY_OUT = category({
  categoryId: 'cat-out',
  name: 'Money out of tracked accounts',
  kind: 'external_outflow',
  use: 'money_out',
});
const ELIGIBLE = [GROCERIES, SUBSCRIPTIONS, MONEY_OUT];

function term(over: Partial<ExpenseTermDto> = {}): ExpenseTermDto {
  return { amount: eur('40'), effectiveFrom: '2026-01-01', exact: { state: 'absent' }, ...over };
}

function source(over: Partial<ExpenseSourceDto> = {}): ExpenseSourceDto {
  return {
    templateId: 'tpl-gym',
    version: 2,
    name: 'Gym',
    counterparty: 'FitCo',
    currency: 'EUR',
    category: SUBSCRIPTIONS,
    startDate: '2026-01-01',
    endDate: null,
    archived: false,
    protection: null,
    defaultCashPositionId: 'pos-bbva',
    defaultCashAccountName: 'BBVA',
    completedOccurrenceDates: ['2026-07-15', '2026-08-15', '2026-09-15'],
    ...over,
  };
}

function entry(over: Partial<MonthlyExpenseEntryDto> = {}): MonthlyExpenseEntryDto {
  return {
    entryId: 'exp-1',
    version: 3,
    category: GROCERIES,
    settlement: 'tracked_cash',
    incurredOn: '2026-09-12',
    incurredMonth: '2026-09',
    amount: eur('62.4'),
    currency: 'EUR',
    cashPositionId: 'pos-bbva',
    cashAccountName: 'BBVA',
    description: null,
    isOneOff: false,
    readOnly: null,
    occurrence: null,
    ...over,
  };
}

const recurringEntry = (over: Partial<MonthlyExpenseEntryDto> = {}): MonthlyExpenseEntryDto =>
  entry({
    entryId: 'exp-gym',
    category: SUBSCRIPTIONS,
    incurredOn: '2026-09-15',
    amount: eur('40'),
    occurrence: {
      templateId: 'tpl-gym',
      templateName: 'Gym',
      occurrenceDate: '2026-09-15',
      occurrenceMonth: '2026-09',
    },
    ...over,
  });

function occurrence(over: Partial<ExpenseOccurrenceDto> = {}): ExpenseOccurrenceDto {
  return {
    templateId: 'tpl-gym',
    occurrenceDate: '2026-09-15',
    source: source(),
    term: term(),
    recordableAsExpected: true,
    state: { kind: 'due' },
    ...over,
  };
}

function candidate(over: Partial<PaidTodayCandidateDto> = {}): PaidTodayCandidateDto {
  return {
    templateId: 'tpl-insurance',
    occurrenceDate: '2027-03-01',
    occurrenceMonth: '2027-03',
    source: source({ templateId: 'tpl-insurance', name: 'Insurance' }),
    term: term({ amount: eur('300') }),
    recordableAsExpected: true,
    ...over,
  };
}

function expenses(over: Partial<CurrentMonthlyExpensesDto> = {}): CurrentMonthlyExpensesDto {
  return {
    occurrences: [],
    otherRecurring: [],
    direct: [],
    eligibleCategories: ELIGIBLE,
    cashAccounts: ACCOUNTS,
    paidTodayCandidates: [],
    ...over,
  };
}

function render(
  value: MonthlyExpensesDto | CurrentMonthlyExpensesDto,
  over: { month?: string; today?: string; monthEndsOn?: string } = {},
): string {
  return renderToStaticMarkup(
    createElement(KnownExpensesSection, {
      expenses: value,
      month: over.month ?? '2026-09',
      monthName: 'September 2026',
      monthEndsOn: over.monthEndsOn ?? '2026-09-30',
      today: over.today ?? '2026-10-01',
      reportingCurrency: 'EUR',
      selectableCurrencyCodes: ['CHF', 'EUR', 'USD'],
      formatting,
    }),
  );
}

const count = (html: string, testId: string): number =>
  html.match(new RegExp(`data-testid="${testId}"`, 'gu'))?.length ?? 0;

const has = (html: string, testId: string): boolean => count(html, testId) > 0;

/** The markup of one `<select data-testid="…">`, options included. */
function selectMarkup(html: string, testId: string): string {
  const match = new RegExp(`<select[^>]*data-testid="${testId}"[^>]*>(.*?)</select>`, 'su').exec(html);
  if (match === null) throw new Error(`no select ${testId}`);
  return match[0];
}

const optionLabels = (markup: string): string[] =>
  [...markup.matchAll(/<option[^>]*>([^<]*)<\/option>/gu)].map((match) => match[1] as string);

/* -------------------------------------------------------------------------- */
/* Scheduled occurrences                                                       */
/* -------------------------------------------------------------------------- */

describe('a scheduled expense occurrence', () => {
  it('offers recording, adjusting, a skip, a future amount and an end date when it is due', () => {
    const html = render(expenses({ occurrences: [occurrence()] }));
    for (const control of ['expense-record', 'expense-adjust', 'expense-skip', 'expense-term', 'expense-end']) {
      expect(has(html, control), control).toBe(true);
    }
    expect(has(html, 'expense-paid-today')).toBe(false);
    expect(has(html, 'expense-amount')).toBe(false);
    expect(html).toContain('Not recorded');
    expect(html).toContain('Scheduled 15 Sept 2026');
    expect(html).toContain('Subscriptions · FitCo · EUR');
    expect(html).toContain('>From this month on<');
    expect(html).toContain('>Ends on…<');
  });

  it('does not offer one-click recording of a zero expected amount, and keeps adjusting and skipping', () => {
    const html = render(
      expenses({
        occurrences: [occurrence({ term: term({ amount: eur('0') }), recordableAsExpected: false })],
      }),
    );
    // Recording zero is known in advance to be refused: an expense is more than zero.
    expect(has(html, 'expense-record')).toBe(false);
    expect(has(html, 'expense-adjust')).toBe(true);
    expect(has(html, 'expense-skip')).toBe(true);
    expect(html).toContain('€0.00');
    expect(html).toContain('Its expected amount is zero');
  });

  it('does not offer one-click recording when no amount is set, and says why', () => {
    const html = render(
      expenses({
        occurrences: [
          occurrence({ term: term({ amount: null, effectiveFrom: null }), recordableAsExpected: false }),
        ],
      }),
    );
    expect(has(html, 'expense-record')).toBe(false);
    expect(has(html, 'expense-adjust')).toBe(true);
    expect(html).toContain('No amount is set for this date');
  });

  it('offers a future occurrence “Paid today” only when the server says it is next', () => {
    const eligible = render(
      expenses({ occurrences: [occurrence({ state: { kind: 'upcoming', paidTodayEligible: true } })] }),
      { today: '2026-09-10' },
    );
    expect(has(eligible, 'expense-paid-today')).toBe(true);
    expect(eligible).toMatch(/data-testid="expense-paid-today"[^>]*>Paid today</u);
    expect(has(eligible, 'expense-record')).toBe(false);
    expect(has(eligible, 'expense-adjust')).toBe(false);
    // An upcoming occurrence inside the month is offered in place, not listed again.
    expect(has(eligible, 'expense-paid-today-candidates')).toBe(false);

    const ineligible = render(
      expenses({ occurrences: [occurrence({ state: { kind: 'upcoming', paidTodayEligible: false } })] }),
      { today: '2026-09-10' },
    );
    expect(has(ineligible, 'expense-paid-today')).toBe(false);
    expect(has(ineligible, 'expense-skip')).toBe(true);
    expect(has(ineligible, 'expense-term')).toBe(true);
  });

  it('shows a recorded occurrence with both dates, and only the corrections a source’s expense allows', () => {
    const html = render(
      expenses({
        occurrences: [
          occurrence({ state: { kind: 'accepted', entry: recurringEntry({ incurredOn: '2026-09-14' }) } }),
        ],
      }),
    );
    expect(html).toContain('Scheduled 15 Sept 2026');
    expect(html).toContain('Incurred 14 Sept 2026');
    for (const control of ['expense-amount', 'expense-incurred-on', 'expense-account', 'expense-description', 'expense-delete']) {
      expect(has(html, control), control).toBe(true);
    }
    // Category, payment method and the one-off flag are the source's.
    for (const control of ['expense-category', 'expense-payment', 'expense-one-off', 'expense-apply-classification']) {
      expect(has(html, control), control).toBe(false);
    }
    // Owner month, never past it.
    expect(html).toContain('min="2026-09-01"');
    expect(html).toContain('max="2026-09-30"');
    expect(html).toContain('data-occurrence-date="2026-09-15"');
    expect(has(html, 'expense-record')).toBe(false);
  });

  it('shows a skipped occurrence with its reason and note, and offers a restore', () => {
    const html = render(
      expenses({
        occurrences: [
          occurrence({ state: { kind: 'skipped', skipId: 'skip-1', reason: 'skipped', note: 'Closed for works' } }),
        ],
      }),
    );
    expect(html).toContain('Not charged — Closed for works');
    expect(has(html, 'expense-restore')).toBe(true);
    expect(has(html, 'expense-record')).toBe(false);
    expect(has(html, 'expense-skip')).toBe(false);
  });

  it('offers an archived source’s open occurrence nothing but its end date', () => {
    const html = render(expenses({ occurrences: [occurrence({ source: source({ archived: true }) })] }));
    expect(html).toContain('Source archived');
    for (const control of ['expense-record', 'expense-adjust', 'expense-skip', 'expense-term']) {
      expect(has(html, control), control).toBe(false);
    }
    // Archiving is not a schedule boundary; ending it is how a source stops.
    expect(has(html, 'expense-end')).toBe(true);
    expect(html.toLowerCase()).not.toContain('unarchive');
  });

  it('says when a source ends', () => {
    const html = render(expenses({ occurrences: [occurrence({ source: source({ endDate: '2026-12-31' }) })] }));
    expect(html).toContain('Ends 31 Dec 2026');
  });
});

/* -------------------------------------------------------------------------- */
/* Legacy sources this section cannot record                                   */
/* -------------------------------------------------------------------------- */

describe('an occurrence of a legacy source this section cannot record', () => {
  const capex = source({
    templateId: 'tpl-works',
    name: 'Extension works',
    category: category({
      categoryId: 'cat-capex',
      name: 'Capital improvements',
      kind: 'capital_improvement',
      use: 'other',
      selectable: false,
    }),
    protection: 'capital_improvement',
  });
  const fees = source({
    templateId: 'tpl-fees',
    name: 'Wire fees',
    category: category({
      categoryId: 'cat-fee',
      name: 'Transfer fees',
      kind: 'transfer_fee',
      use: 'other',
      selectable: false,
    }),
    protection: 'transfer_fee',
  });
  const protectedOccurrence = (over: Partial<ExpenseOccurrenceDto> = {}): ExpenseOccurrenceDto =>
    occurrence({
      templateId: 'tpl-works',
      occurrenceDate: '2026-09-20',
      source: capex,
      recordableAsExpected: false,
      ...over,
    });

  const NEVER = ['expense-record', 'expense-adjust', 'expense-paid-today', 'expense-term'];

  it('offers a due occurrence a skip and an end date, and nothing that would record it', () => {
    const html = render(expenses({ occurrences: [protectedOccurrence()] }));
    for (const control of NEVER) expect(has(html, control), control).toBe(false);
    for (const control of ['expense-skip', 'expense-end']) expect(has(html, control), control).toBe(true);
    expect(html).toContain('data-reason="capital_improvement"');
    expect(html).toContain('This editor cannot record it');
    // Not told to state an amount it could never record.
    expect(has(html, 'expense-needs-amount')).toBe(false);
  });

  it('offers an upcoming occurrence no “Paid today”, whatever the read says about eligibility', () => {
    const html = render(
      expenses({
        occurrences: [
          protectedOccurrence({
            templateId: 'tpl-fees',
            source: fees,
            state: { kind: 'upcoming', paidTodayEligible: true },
          }),
        ],
      }),
      { today: '2026-09-10' },
    );
    for (const control of NEVER) expect(has(html, control), control).toBe(false);
    expect(has(html, 'expense-skip')).toBe(true);
    expect(has(html, 'expense-end')).toBe(true);
    expect(html).toContain('data-reason="transfer_fee"');
  });

  it('restores a skipped occurrence and ends the source, and still offers no future amount', () => {
    const html = render(
      expenses({
        occurrences: [
          protectedOccurrence({ state: { kind: 'skipped', skipId: 'skip-9', reason: 'other', note: null } }),
        ],
      }),
    );
    expect(has(html, 'expense-restore')).toBe(true);
    expect(has(html, 'expense-end')).toBe(true);
    for (const control of [...NEVER, 'expense-skip']) expect(has(html, control), control).toBe(false);
  });

  it('leaves an archived one what any archived source keeps: its end date', () => {
    const html = render(expenses({ occurrences: [protectedOccurrence({ source: { ...capex, archived: true } })] }));
    for (const control of [...NEVER, 'expense-skip']) expect(has(html, control), control).toBe(false);
    expect(has(html, 'expense-end')).toBe(true);
    expect(html).toContain('Source archived');
  });

  it('shows history it already recorded as recorded, with nothing to correct or delete and nowhere to go', () => {
    const recorded = entry({
      entryId: 'exp-works',
      category: capex.category,
      incurredOn: '2026-10-02',
      incurredMonth: '2026-10',
      amount: eur('100'),
      readOnly: 'other_workflow',
      occurrence: {
        templateId: 'tpl-works',
        templateName: 'Extension works',
        occurrenceDate: '2026-09-20',
        occurrenceMonth: '2026-09',
      },
    });
    const html = render(expenses({ occurrences: [protectedOccurrence({ state: { kind: 'accepted', entry: recorded } })] }));
    expect(html).toContain('Recorded');
    for (const control of [
      ...NEVER,
      'expense-amount',
      'expense-incurred-on',
      'expense-account',
      'expense-delete',
      'expense-elsewhere',
    ]) {
      expect(has(html, control), control).toBe(false);
    }
    expect(has(html, 'expense-read-only')).toBe(true);
    expect(has(html, 'expense-end')).toBe(true);
    // No link to a month that could not change it either, and none to an editor that does not exist.
    const row = /<tr[^>]*data-testid="expense-occurrence".*?<\/tr>/su.exec(html)?.[0] ?? '';
    expect(row).not.toContain('href=');
  });

  it('says why, per protected kind, and nothing for a source it can record', () => {
    expect(protectedSourceNote(capex)).toBe(
      'A legacy source filed under Capital improvements. This editor cannot record it: a capital improvement belongs to the asset it improves, not to Known expenses.',
    );
    expect(protectedSourceNote(fees)).toBe(
      'A legacy source filed under Transfer fees. This editor cannot record it: a transfer fee is recorded with the transfer it was charged on.',
    );
    expect(protectedSourceNote(source())).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Across a month boundary                                                     */
/* -------------------------------------------------------------------------- */

describe('an expense whose money belongs to another month', () => {
  const paidInOctober = occurrence({
    state: {
      kind: 'accepted',
      entry: recurringEntry({ incurredOn: '2026-10-02', incurredMonth: '2026-10' }),
    },
  });

  it('is read-only on the schedule’s page, with a link to the owner month’s Known expenses', () => {
    const html = render(expenses({ occurrences: [paidInOctober] }));
    expect(has(html, 'expense-elsewhere')).toBe(true);
    expect(html).toContain('href="/monthly/2026-10#known-expenses"');
    expect(has(html, 'expense-amount')).toBe(false);
    expect(has(html, 'expense-delete')).toBe(false);
  });

  it('is editable on the page whose month holds the money', () => {
    const html = render(expenses({ occurrences: [paidInOctober] }), {
      month: '2026-10',
      monthEndsOn: '2026-10-31',
      today: '2026-11-01',
    });
    expect(has(html, 'expense-amount')).toBe(true);
    expect(has(html, 'expense-elsewhere')).toBe(false);
  });

  it('links recurring spending incurred here to its occurrence’s month', () => {
    const html = render(
      expenses({
        otherRecurring: [
          recurringEntry({
            incurredOn: '2026-09-30',
            occurrence: {
              templateId: 'tpl-gym',
              templateName: 'Gym',
              occurrenceDate: '2026-10-01',
              occurrenceMonth: '2026-10',
            },
          }),
        ],
      }),
    );
    expect(has(html, 'expense-other-recurring')).toBe(true);
    expect(html).toContain('For the occurrence scheduled 1 Oct 2026');
    expect(html).toContain('href="/monthly/2026-10#known-expenses"');
    expect(has(html, 'expense-amount')).toBe(true);
    expect(has(html, 'expense-category')).toBe(false);
  });

  it('renders one expense exactly once, whichever group holds it', () => {
    const html = render(
      expenses({
        occurrences: [occurrence({ state: { kind: 'accepted', entry: recurringEntry() } })],
        direct: [entry({ entryId: 'exp-other' })],
      }),
    );
    expect(count(html, 'expense-entry')).toBe(1);
    expect(html.match(/data-entry-id="exp-gym"/gu)).toBeNull();
    expect(count(html, 'expense-occurrence')).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Paid today                                                                  */
/* -------------------------------------------------------------------------- */

describe('Paid today', () => {
  it('lists a candidate beyond the month with the month it belongs to', () => {
    const html = render(expenses({ paidTodayCandidates: [candidate()] }), { today: '2026-09-10' });
    expect(has(html, 'expense-paid-today-candidates')).toBe(true);
    expect(html).toContain('Next on 1 Mar 2027');
    expect(html).toContain('March 2027');
    expect(html).toMatch(/data-testid="expense-candidate-paid-today"[^>]*>Paid today</u);
  });

  it('offers a candidate’s end date only when no row above already does', () => {
    const alone = render(expenses({ paidTodayCandidates: [candidate()] }), { today: '2026-09-10' });
    expect(count(alone, 'expense-end')).toBe(1);

    const both = render(
      expenses({
        occurrences: [occurrence({ templateId: 'tpl-insurance', source: source({ templateId: 'tpl-insurance' }) })],
        paidTodayCandidates: [candidate()],
      }),
      { today: '2026-09-10' },
    );
    expect(count(both, 'expense-end')).toBe(1);
  });

  it('says “Paid today” on this section, and never the income words', () => {
    const html = render(
      expenses({
        occurrences: [occurrence({ state: { kind: 'upcoming', paidTodayEligible: true } })],
        paidTodayCandidates: [candidate()],
      }),
      { today: '2026-09-10' },
    );
    expect(html).toContain('Paid today');
    expect(html.toLowerCase()).not.toContain('received today');

    // The panels are closed in static markup, so their words are checked where
    // they are written.
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const file of ['expenses-editor.tsx', 'expenses-presentation.ts']) {
      const text = readFileSync(path.join(here, '..', 'src', 'features', 'monthly', file), 'utf8');
      expect(text, file).not.toMatch(/received today/iu);
      expect(text, file).not.toMatch(/Received today/u);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Recorded direct expenses                                                    */
/* -------------------------------------------------------------------------- */

describe('a recorded direct expense', () => {
  it('offers every correction a direct expense has, with the one-off flag', () => {
    const html = render(expenses({ direct: [entry({ isOneOff: true })] }));
    for (const control of [
      'expense-amount',
      'expense-incurred-on',
      'expense-category',
      'expense-payment',
      'expense-account',
      'expense-description',
      'expense-one-off',
      'expense-delete',
    ]) {
      expect(has(html, control), control).toBe(true);
    }
    expect(html).toMatch(/data-testid="expense-one-off"[^>]*checked/u);
    expect(html).toContain('Paid from tracked account · one-off');
    // Nothing to reload until a save has failed, and nothing to apply until a draft differs.
    expect(has(html, 'expense-reload')).toBe(false);
    expect(has(html, 'expense-apply-classification')).toBe(false);
    // No currency field: `updateExpenseEntry` does not take one.
    expect(html).not.toContain('data-testid="expense-currency"');
  });

  it('bounds its date to the owner month, and to today inside a current month', () => {
    const completedHtml = render(expenses({ direct: [entry()] }), { today: '2026-10-15' });
    expect(completedHtml).toContain('min="2026-09-01"');
    expect(completedHtml).toContain('max="2026-09-30"');

    const currentHtml = render(expenses({ direct: [entry({ incurredOn: '2026-09-04' })] }), {
      today: '2026-09-10',
    });
    expect(currentHtml).toContain('max="2026-09-10"');
  });

  it('shows the account picker only for an expense paid from a tracked account', () => {
    expect(has(render(expenses({ direct: [entry()] })), 'expense-account')).toBe(true);
    for (const settlement of ['untracked_self', 'third_party']) {
      const html = render(
        expenses({ direct: [entry({ settlement, cashPositionId: null, cashAccountName: null })] }),
      );
      expect(has(html, 'expense-account'), settlement).toBe(false);
    }
  });

  it('offers only accounts of its currency that are open on its date', () => {
    const labels = optionLabels(selectMarkup(render(expenses({ direct: [entry()] })), 'expense-account'));
    // BBVA holds euros on 12 September; the dollar account cannot, the late card
    // had not opened and the old card had closed.
    expect(labels).toEqual(['Not attributed yet', 'BBVA']);
  });

  it('says a tracked expense nobody attributed yet is exactly that, never untracked', () => {
    const html = render(expenses({ direct: [entry({ cashPositionId: null, cashAccountName: null })] }));
    expect(html).toMatch(/data-testid="expense-attribution"[^>]*>Not attributed yet</u);
  });

  it('pays money out of tracked accounts from a tracked account and nothing else', () => {
    const html = render(expenses({ direct: [entry({ category: MONEY_OUT })] }));
    expect(optionLabels(selectMarkup(html, 'expense-payment'))).toEqual(['Paid from tracked account']);
    expect(html).toContain(MONEY_OUT_NOTE);
  });

  it('shows an archived category as it is, and offers it for nothing new', () => {
    const archived = category({ categoryId: 'cat-club', name: 'Old club', archived: true, selectable: false });
    const html = render(expenses({ direct: [entry({ category: archived })] }));
    const picker = selectMarkup(html, 'expense-category');
    expect(picker).toMatch(/<option value="cat-club" disabled="" selected="">Old club \(archived\)<\/option>/u);
    expect(html).toContain('archived category');
  });

  it('shows a transfer’s fee as part of its transfer, with nothing to change and nowhere dead to go', () => {
    const fee = entry({
      category: category({ categoryId: 'cat-fee', name: 'Transfer fees', kind: 'transfer_fee', use: 'other', selectable: false }),
      readOnly: 'transfer_fee',
      amount: eur('5'),
    });
    const html = render(expenses({ direct: [fee] }));
    expect(html).toContain(TRANSFER_FEE_NOTE);
    expect(html).toContain('data-reason="transfer_fee"');
    for (const control of ['expense-amount', 'expense-delete', 'expense-category', 'expense-incurred-on']) {
      expect(has(html, control), control).toBe(false);
    }
    // No transfer editor exists yet, so there is no link to one.
    const row = /<tr[^>]*data-testid="expense-entry".*?<\/tr>/su.exec(html)?.[0] ?? '';
    expect(row).not.toContain('href=');
  });

  it('shows a row another workflow filed as recorded, without a picker that could reclassify it', () => {
    const html = render(
      expenses({
        direct: [
          entry({
            category: category({ categoryId: 'cat-prop', name: 'Property operating costs', kind: 'property_operating', use: 'other', selectable: false }),
            readOnly: 'other_workflow',
          }),
        ],
      }),
    );
    expect(has(html, 'expense-read-only')).toBe(true);
    expect(html).toContain('Filed under Property operating costs');
    expect(has(html, 'expense-category')).toBe(false);
  });

  it('never offers a category the read did not make eligible', () => {
    const html = renderToStaticMarkup(
      createElement(AddExpenseForm, {
        accounts: ACCOUNTS,
        eligibleCategories: ELIGIBLE,
        currencies: ['EUR', 'USD'],
        bounds: { min: '2026-09-01', max: '2026-09-30' },
        defaultCurrency: 'EUR',
        formatting,
      }),
    );
    // Capital improvements, transfer fees and the other kinds a later workflow
    // owns are left out by the read; the picker adds nothing of its own.
    expect(optionLabels(selectMarkup(html, 'expense-add-category'))).toEqual([
      'Groceries',
      'Subscriptions',
      'Money out of tracked accounts',
    ]);
    expect(html).not.toContain('Capital improvement');
  });
});

/* -------------------------------------------------------------------------- */
/* The section's shape                                                         */
/* -------------------------------------------------------------------------- */

describe('the section’s shape', () => {
  it('says plainly when a month has no schedule and nothing recorded', () => {
    const html = render(expenses());
    expect(has(html, 'expense-occurrences-empty')).toBe(true);
    expect(has(html, 'expense-direct-empty')).toBe(true);
    expect(has(html, 'expense-other-recurring')).toBe(false);
    expect(has(html, 'expense-paid-today-candidates')).toBe(false);
  });

  it('totals nothing: it holds more than the known tracked figure, which Reconciliation owns', () => {
    const html = render(
      expenses({
        occurrences: [occurrence({ state: { kind: 'accepted', entry: recurringEntry() } })],
        direct: [
          entry({ entryId: 'a', settlement: 'untracked_self', cashPositionId: null, cashAccountName: null }),
          entry({ entryId: 'b', settlement: 'third_party', cashPositionId: null, cashAccountName: null }),
        ],
      }),
    );
    expect(html).not.toMatch(/total/iu);
    expect(html).not.toContain('(K)');
    expect(html).not.toContain('Known tracked expenses');
  });

  it('keeps every wide table, and everything in it, inside its own positioned scroller', () => {
    const html = render(
      expenses({
        occurrences: [occurrence()],
        direct: [entry()],
        otherRecurring: [recurringEntry({ entryId: 'exp-other' })],
        paidTodayCandidates: [candidate()],
      }),
    );
    expect(count(html, 'expense-occurrences') + count(html, 'expense-direct')).toBe(2);
    expect(html.match(/class="relative overflow-x-auto"/gu)?.length).toBe(4);
    expect(html).not.toContain('min-w-');
  });

  it('labels every table for assistive technology', () => {
    const html = render(expenses({ occurrences: [occurrence()], direct: [entry()] }));
    expect(html).toContain('Recurring expenses scheduled in September 2026');
    expect(html).toContain('Expenses incurred in September 2026 that no source scheduled');
  });

  it('offers adding an expense and a source, and nothing that archives one', () => {
    const html = render(expenses());
    expect(has(html, 'expense-add-toggle')).toBe(true);
    expect(has(html, 'expense-source-add-toggle')).toBe(true);
    const lower = html.toLowerCase();
    expect(lower).not.toContain('archive');
    expect(lower).not.toContain('delete source');
  });
});

/* -------------------------------------------------------------------------- */
/* The two forms                                                               */
/* -------------------------------------------------------------------------- */

const addExpense = (): string =>
  renderToStaticMarkup(
    createElement(AddExpenseForm, {
      accounts: ACCOUNTS,
      eligibleCategories: ELIGIBLE,
      currencies: ['CHF', 'EUR', 'USD'],
      bounds: { min: '2026-09-01', max: '2026-09-30' },
      defaultCurrency: 'EUR',
      formatting,
    }),
  );

const addSource = (): string =>
  renderToStaticMarkup(
    createElement(AddExpenseSourceForm, {
      accounts: ACCOUNTS,
      eligibleCategories: ELIGIBLE,
      currencies: ['CHF', 'EUR', 'USD'],
      defaultCurrency: 'EUR',
      today: '2026-09-10',
      formatting,
    }),
  );

describe('adding a known expense by hand', () => {
  it('offers the three payment methods in the blueprint’s words, and nothing deducted from an asset', () => {
    expect(optionLabels(selectMarkup(addExpense(), 'expense-add-payment'))).toEqual([
      'Paid from tracked account',
      'Paid by me outside tracked accounts',
      'Paid by someone else',
    ]);
    expect(addExpense()).not.toContain('Deducted');
  });

  it('groups money out of tracked accounts apart from spending', () => {
    const picker = selectMarkup(addExpense(), 'expense-add-category');
    expect(picker).toMatch(/<optgroup label="Spending">.*Groceries.*Subscriptions.*<\/optgroup>/su);
    expect(picker).toMatch(/<optgroup label="Not spending"><option value="cat-out">Money out of tracked accounts<\/option><\/optgroup>/u);
  });

  it('offers every supported currency, and the tracked accounts of the chosen one', () => {
    const html = addExpense();
    for (const code of ['CHF', 'EUR', 'USD']) expect(html).toContain(`<option value="${code}"`);
    // The form starts on the month's last day: the dollar account holds another
    // currency, the old card has closed, and BBVA and the late card are open.
    expect(optionLabels(selectMarkup(html, 'expense-add-account'))).toEqual([
      'Not attributed yet',
      'BBVA',
      'Late card',
    ]);
  });

  it('bounds the date to the month on screen, and offers a one-off flag', () => {
    const html = addExpense();
    expect(html).toContain('min="2026-09-01"');
    expect(html).toContain('max="2026-09-30"');
    expect(has(html, 'expense-add-one-off')).toBe(true);
    expect(html).not.toContain('tag');
  });
});

describe('adding a recurring expense source', () => {
  it('asks for what the source input has, and no payment method or tags', () => {
    const html = addSource();
    for (const field of [
      'expense-source-name',
      'expense-source-payee',
      'expense-source-category',
      'expense-source-currency',
      'expense-source-frequency',
      'expense-source-day',
      'expense-source-start-date',
      'expense-source-end-date',
      'expense-source-amount',
      'expense-source-account',
    ]) {
      expect(has(html, field), field).toBe(true);
    }
    expect(html).not.toContain('How it was paid');
    expect(html.toLowerCase()).not.toContain('tag');
    expect(optionLabels(selectMarkup(html, 'expense-source-account'))[0]).toBe('No usual account');
  });

  it('explains a start in the past without claiming months will become incomplete', () => {
    expect(EXPENSE_HISTORICAL_START_NOTE).toBe(
      'Starting this source in the past creates expected occurrences from that date. Past completed months may need those occurrences recorded or skipped.',
    );
    expect(EXPENSE_HISTORICAL_START_NOTE).not.toContain('incomplete');
  });
});

/* -------------------------------------------------------------------------- */
/* The rules behind the controls                                               */
/* -------------------------------------------------------------------------- */

describe('what a control may offer', () => {
  it('names the payment methods, and a row another workflow paid, truthfully', () => {
    expect(PAYMENT_METHOD_LABEL).toEqual({
      tracked_cash: 'Paid from tracked account',
      untracked_self: 'Paid by me outside tracked accounts',
      third_party: 'Paid by someone else',
    });
    expect(paymentMethodLabel('deducted_from_asset')).toBe('Deducted from the investment’s value');
    expect(paymentMethodOptions(undefined).map((option) => option.value)).not.toContain('deducted_from_asset');
  });

  it('narrows money out to tracked cash, and opens the methods again when the category changes back', () => {
    expect(paymentMethodOptions(MONEY_OUT).map((option) => option.value)).toEqual(['tracked_cash']);
    expect(paymentMethodFor(MONEY_OUT, 'third_party')).toBe('tracked_cash');
    expect(paymentMethodFor(GROCERIES, 'third_party')).toBe('third_party');
    expect(paymentMethodOptions(GROCERIES)).toHaveLength(3);
  });

  it('groups eligible categories, and shows a row’s own ineligible one without offering it', () => {
    const archived = category({ categoryId: 'cat-club', name: 'Old club', archived: true, selectable: false });
    const groups = categoryOptionGroups(ELIGIBLE, archived);
    expect(groups.spending.map((option) => option.label)).toEqual(['Groceries', 'Subscriptions']);
    expect(groups.moneyOut.map((option) => option.label)).toEqual(['Money out of tracked accounts']);
    expect(groups.current).toEqual({ value: 'cat-club', label: 'Old club (archived)' });
    expect(categoryOptionGroups(ELIGIBLE, GROCERIES).current).toBeNull();
  });

  it('offers accounts by currency and by the day they were open, and drops a choice that no longer fits', () => {
    expect(accountChoices(ACCOUNTS, 'EUR', '2026-09-03').map((row) => row.name)).toEqual(['BBVA', 'Old card']);
    expect(accountChoices(ACCOUNTS, 'EUR', '2026-09-25').map((row) => row.name)).toEqual(['BBVA', 'Late card']);
    // A saved row's own account stays listed; the server judges its date.
    expect(accountChoices(ACCOUNTS, 'EUR', '2026-09-25', 'pos-shut').map((row) => row.name)).toContain('Old card');
    expect(accountAfterChange(ACCOUNTS, 'pos-bbva', 'USD', '2026-09-10')).toBe(NO_ACCOUNT);
    expect(accountAfterChange(ACCOUNTS, 'pos-late', 'EUR', '2026-09-10')).toBe(NO_ACCOUNT);
    expect(accountAfterChange(ACCOUNTS, 'pos-bbva', 'EUR', '2026-09-10')).toBe('pos-bbva');
    expect(accountAfterChange(ACCOUNTS, NO_ACCOUNT, 'EUR', '2026-09-10')).toBe(NO_ACCOUNT);
  });

  it('offers an expense no occupancy reason', () => {
    expect(expenseSkipReasonOptions().map((option) => option.value)).toEqual(['skipped', 'other']);
  });

  it('refuses a zero or negative expense and accepts a zero term, as exact strings', () => {
    expect(expenseAmountProblem('0', 2)).toBe('This amount must be greater than zero.');
    expect(expenseAmountProblem('0.00', 2)).not.toBeNull();
    expect(expenseAmountProblem('-5', 2)).not.toBeNull();
    expect(expenseAmountProblem('', 2)).toBe('Enter what it cost.');
    expect(expenseAmountProblem('12.345', 2)).toBe('Use at most 2 decimals for this currency.');
    expect(expenseAmountProblem('1250', 0)).toBeNull();
    expect(termAmountProblem('0', 2)).toBeNull();
    expect(termAmountProblem('-1', 2)).not.toBeNull();
  });

  it('never autosaves an expense down to zero, and never saves what did not change', () => {
    expect(decideExpenseAmountOnBlur({ draft: '0', saved: '40', minorUnits: 2 })).toEqual({
      kind: 'invalid',
      message: 'This amount must be greater than zero.',
    });
    expect(decideExpenseAmountOnBlur({ draft: '', saved: '40', minorUnits: 2 })).toEqual({ kind: 'unchanged' });
    expect(decideExpenseAmountOnBlur({ draft: '40.00', saved: '40', minorUnits: 2 })).toEqual({ kind: 'unchanged' });
    expect(decideExpenseAmountOnBlur({ draft: '42,50', saved: '40', minorUnits: 2 })).toEqual({
      kind: 'save',
      amount: '42.50',
    });
  });

  it('starts an adjustment from the term only when recording it could succeed', () => {
    expect(adjustmentAmountDefault(term(), true)).toBe('40');
    expect(adjustmentAmountDefault(term({ amount: eur('0') }), false)).toBe('');
    expect(adjustmentAmountDefault(term({ amount: null }), false)).toBe('');
  });

  it('gives editing to the month holding the money, and links to its section', () => {
    expect(ownsExpense({ incurredMonth: '2026-09' }, '2026-09')).toBe(true);
    expect(ownsExpense({ incurredMonth: '2026-10' }, '2026-09')).toBe(false);
    expect(knownExpensesHref('2026-10')).toBe('/monthly/2026-10#known-expenses');
  });

  it('warns before recording lands in another month, and stays quiet otherwise', () => {
    const name = (month: string) => (month === '2026-09' ? 'September' : 'October');
    expect(expenseCrossMonthNotice('2026-09-25', '2026-09', name)).toBeNull();
    expect(expenseCrossMonthNotice('2026-10-02', '2026-09', name)).toBe(
      'The occurrence stays on September’s schedule, but the expense will belong to October and count in October’s reconciliation.',
    );
  });

  it('names occurrence states as the income section does', () => {
    expect(expenseOccurrenceStateLabel({ kind: 'due' })).toBe('Not recorded');
    expect(expenseOccurrenceStateLabel({ kind: 'upcoming', paidTodayEligible: false })).toBe('Upcoming');
    expect(expenseOccurrenceStateLabel({ kind: 'accepted', entry: entry() })).toBe('Recorded');
    expect(expenseOccurrenceStateLabel({ kind: 'skipped', skipId: 's', reason: 'other', note: null })).toBe('Skipped');
  });
});

/* -------------------------------------------------------------------------- */
/* An end-date change                                                          */
/* -------------------------------------------------------------------------- */

describe('an end-date change', () => {
  const dates = ['2026-06-15', '2026-07-15', '2026-08-15', '2026-09-15'];
  const words = {
    source: 'Gym',
    day: (date: string) => date,
    month: (month: string) => month,
  };

  it('setting one stops what came after it, and names the completed months that changes', () => {
    const change = endDateChangeOf({ endDate: null, completedOccurrenceDates: dates }, '2026-07-31');
    expect(change).toEqual({
      kind: 'ends',
      previous: null,
      next: '2026-07-31',
      affected: { first: '2026-08', last: '2026-09', count: 2 },
    });
    if (change.kind === 'unchanged') throw new Error('expected a change');
    expect(endDateChangeSummary(change, words)).toEqual([
      'Gym will end on 2026-07-31.',
      'Occurrences after that date that are not recorded or skipped stop being expected.',
      'Completed months whose expected occurrences change: 2026-08 – 2026-09.',
    ]);
  });

  it('moving it earlier affects only what lay between the two dates', () => {
    expect(endDateChangeOf({ endDate: '2026-08-31', completedOccurrenceDates: dates }, '2026-07-01')).toMatchObject({
      kind: 'ends',
      affected: { first: '2026-07', last: '2026-08', count: 2 },
    });
  });

  it('moving it later, or clearing it, may bring occurrences back', () => {
    const later = endDateChangeOf({ endDate: '2026-06-30', completedOccurrenceDates: dates }, '2026-07-31');
    expect(later).toEqual({
      kind: 'extends',
      previous: '2026-06-30',
      next: '2026-07-31',
      affected: { first: '2026-07', last: '2026-07', count: 1 },
    });
    if (later.kind === 'unchanged') throw new Error('expected a change');
    expect(endDateChangeSummary(later, words)).toEqual([
      'Gym will end on 2026-07-31 instead of 2026-06-30.',
      'Occurrences after 2026-06-30 may become expected again.',
      'Completed months whose expected occurrences change: 2026-07.',
    ]);

    const cleared = endDateChangeOf({ endDate: '2026-06-30', completedOccurrenceDates: dates }, null);
    expect(cleared).toMatchObject({ kind: 'extends', next: null, affected: { first: '2026-07', last: '2026-09' } });
    if (cleared.kind === 'unchanged') throw new Error('expected a change');
    expect(endDateChangeSummary(cleared, words)[0]).toBe('Gym will no longer have an end date.');
  });

  it('says so when no completed month is touched, and recognizes no change at all', () => {
    const future = endDateChangeOf({ endDate: null, completedOccurrenceDates: dates }, '2026-12-31');
    expect(future).toMatchObject({ kind: 'ends', affected: null });
    if (future.kind === 'unchanged') throw new Error('expected a change');
    expect(endDateChangeSummary(future, words)[2]).toBe('No completed month’s expected occurrences change.');
    expect(endDateChangeOf({ endDate: '2026-12-31', completedOccurrenceDates: dates }, '2026-12-31')).toEqual({
      kind: 'unchanged',
    });
    expect(endDateChangeOf({ endDate: null, completedOccurrenceDates: dates }, null)).toEqual({ kind: 'unchanged' });
  });
});

/* -------------------------------------------------------------------------- */
/* What a refused save does to what the user typed                             */
/* -------------------------------------------------------------------------- */

describe('a row’s drafts across a save', () => {
  const drafts = { incurredOn: '2026-09-18', cashPositionId: 'pos-bbva', isOneOff: true };

  const finish = async (outcome: SaveOutcome, fields: readonly string[]) => {
    const states: string[] = [];
    const refresh = vi.fn();
    const final = await runSave(() => Promise.resolve(outcome), (state) => states.push(state.kind), refresh);
    return { states, refresh, kept: draftsAfterSave(drafts, fields, final) };
  };

  it('keeps the attempted value when the write conflicts, and refreshes nothing over it', async () => {
    const { states, refresh, kept } = await finish(
      { ok: false, error: { code: 'CONFLICT_VERSION', message: 'This expense changed while you were editing it.' } },
      ['incurredOn'],
    );
    expect(states).toEqual(['saving', 'conflict']);
    expect(refresh).not.toHaveBeenCalled();
    expect(kept).toEqual(drafts);
  });

  it('keeps it through a refusal too, and hands back only what a success saved', async () => {
    expect(
      (await finish({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'No.' } }, ['isOneOff'])).kept,
    ).toEqual(drafts);
    const saved = await finish({ ok: true }, ['isOneOff']);
    expect(saved.refresh).toHaveBeenCalledTimes(1);
    expect(saved.kept).toEqual({ incurredOn: '2026-09-18', cashPositionId: 'pos-bbva' });
  });

  it('will not start a second write under the same rendered version', () => {
    expect(canWrite({ kind: 'saving' })).toBe(false);
    expect(canWrite({ kind: 'conflict', message: 'x' })).toBe(true);
  });
});
