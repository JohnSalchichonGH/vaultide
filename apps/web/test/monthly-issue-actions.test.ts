import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ISSUE_CLASS, type ReconciliationIssueDto } from '@vaultide/application';

// The dialogs behind the controls reach the server actions and the app router;
// what this file is about is which controls exist and what they carry.
vi.mock('@/server/actions/flows', () => ({
  acceptAdjustmentAction: vi.fn(),
  createIncomeEntryAction: vi.fn(),
  updateIncomeEntryAction: vi.fn(),
  deleteIncomeEntryAction: vi.fn(),
  createExpenseEntryAction: vi.fn(),
  updateExpenseEntryAction: vi.fn(),
  deleteExpenseEntryAction: vi.fn(),
  createTransferAction: vi.fn(),
  updateTransferAction: vi.fn(),
  deleteTransferAction: vi.fn(),
}));
vi.mock('@/server/actions/recurring', () => ({
  acceptSuggestionAction: vi.fn(),
  skipSuggestionAction: vi.fn(),
  unskipSuggestionAction: vi.fn(),
  setTemplateTermAction: vi.fn(),
  createTemplateAction: vi.fn(),
  updateTemplateAction: vi.fn(),
  archiveTemplateAction: vi.fn(),
  unarchiveTemplateAction: vi.fn(),
}));
vi.mock('@/server/actions/positions', () => ({
  quickUpdateAction: vi.fn(),
  recordValuationAction: vi.fn(),
  correctValuationAction: vi.fn(),
  confirmMonthEndAction: vi.fn(),
  confirmUnchangedAction: vi.fn(),
  confirmUnchangedBatchAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement('a', { href, ...rest }, children),
}));

const {
  ACTIONABLE_ISSUE_KEYS,
  LATER_PHASE_ISSUE_KEYS,
  isActionableIssueKey,
  issueActions,
} = await import('@/features/monthly/issue-actions');
const { AdjustmentForm, IssueActionHost } = await import('@/features/monthly/issue-action-host');

/**
 * What each reconciliation issue offers (blueprint 8.5, 15.3 section 8, 30.21;
 * ADR 0009).
 *
 * The model is pure, so these are assertions about *offers*: which corrections
 * an issue proposes, in which order, and what each one carries into the form it
 * opens. Whether a correction resolves the issue is the engine's answer and is
 * tested where the engine is.
 */

function issue(
  over: Partial<ReconciliationIssueDto> & Pick<ReconciliationIssueDto, 'key' | 'class'>,
): ReconciliationIssueDto {
  return {
    currency: 'EUR',
    positionId: null,
    positionName: null,
    amount: null,
    variant: null,
    templateId: null,
    templateName: null,
    occurrenceDate: null,
    expectedAmount: null,
    ...over,
  };
}

const completed = {
  shape: 'completed' as const,
  month: '2026-09',
  previousMonth: '2026-08',
  monthName: 'September 2026',
  previousMonthName: 'August 2026',
  monthEndsOn: '2026-09-30',
  today: '2026-10-01',
  asOf: null,
  accounts: new Map([
    ['bbva', { name: 'BBVA', openState: 'month_end', closeState: 'missing' }],
    ['savings', { name: 'Savings', openState: 'carried', closeState: 'month_end' }],
    ['both', { name: 'Old account', openState: 'missing', closeState: 'carried' }],
  ]),
  participatingCurrencies: ['EUR', 'USD'],
  incomeAnchors: new Map([['inc-1', 'income-inc-1']]),
  expenseAnchors: new Map([['exp-1', 'expense-exp-1']]),
  formatDay: (iso: string) => `day ${iso}`,
};

const current = {
  ...completed,
  shape: 'current' as const,
  month: '2026-09',
  monthEndsOn: '2026-09-30',
  today: '2026-09-10',
  asOf: '2026-09-06',
};

const labelsOf = (issueRow: ReconciliationIssueDto, context = completed): string[] =>
  issueActions(issueRow, context).map((action) => action.label);

/* -------------------------------------------------------------------------- */
/* The catalogue                                                               */
/* -------------------------------------------------------------------------- */

describe('the catalogue of corrections', () => {
  it('covers every issue key the engine can raise, or says which phase owns it', () => {
    // The loud failure: a key added to 8.5's catalogue later is either given a
    // correction here or named as a later phase's, never silently inert.
    for (const key of Object.keys(ISSUE_CLASS)) {
      const handled = isActionableIssueKey(key);
      const deferred = Object.hasOwn(LATER_PHASE_ISSUE_KEYS, key);
      expect(handled || deferred, `${key} has neither a correction nor a reason`).toBe(true);
      expect(handled && deferred, `${key} is both offered and deferred`).toBe(false);
    }
  });

  it('offers nothing for a later phase’s issue', () => {
    for (const key of Object.keys(LATER_PHASE_ISSUE_KEYS)) {
      expect(issueActions(issue({ key, class: 'advisory' }), completed)).toEqual([]);
    }
  });

  it('offers nothing for a key it has never heard of', () => {
    expect(issueActions(issue({ key: 'something_new', class: 'advisory' }), completed)).toEqual([]);
  });

  it('keeps every offered key in the list the panel walks', () => {
    expect([...ACTIONABLE_ISSUE_KEYS].every(isActionableIssueKey)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Evidence                                                                    */
/* -------------------------------------------------------------------------- */

describe('a missing month-end balance', () => {
  const missing = (positionId: string) =>
    issue({ key: 'missing_month_end', class: 'blocking', positionId });

  it('lands on this month’s row when the closing statement is the one missing', () => {
    const actions = issueActions(missing('bbva'), completed);
    expect(actions[0]?.target).toEqual({ kind: 'anchor', anchor: '#account-bbva' });
    expect(actions.map((action) => action.target.kind)).toEqual(['anchor', 'link']);
    // The secondary is the account itself, for dormancy or closing.
    expect(actions[1]?.target).toEqual({ kind: 'link', href: '/accounts/bbva' });
  });

  it('lands on the previous month when the opening is the one missing', () => {
    const actions = issueActions(missing('savings'), completed);
    expect(actions[0]?.target).toEqual({ kind: 'link', href: '/monthly/2026-08#account-savings' });
    expect(actions[0]?.label).toBe('Enter August 2026’s balance');
  });

  it('offers both ends when both are missing, closing first', () => {
    const actions = issueActions(missing('both'), completed);
    expect(actions.map((action) => action.target)).toEqual([
      { kind: 'anchor', anchor: '#account-both' },
      { kind: 'link', href: '/monthly/2026-08#account-both' },
      { kind: 'link', href: '/accounts/both' },
    ]);
  });

  it('never promises that marking an account dormant today fixes the month', () => {
    const [, , manage] = issueActions(missing('both'), completed);
    expect(manage?.hint).toContain('from the zero balance that emptied it');
    expect(manage?.hint).not.toContain('today');
  });
});

describe('a first balance', () => {
  it('offers the earlier balance through the previous month’s editor', () => {
    const actions = issueActions(
      issue({ key: 'first_balance', class: 'info', positionId: 'savings' }),
      completed,
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]?.label).toBe('Enter an earlier balance');
    expect(actions[0]?.target).toEqual({ kind: 'link', href: '/monthly/2026-08#account-savings' });
    expect(actions[0]?.hint).toContain('August 2026');
  });
});

describe('the two month-to-date issues', () => {
  it('both open Quick update, and neither is a second form', () => {
    for (const key of ['mtd_no_common_date', 'mtd_newer_balances']) {
      const actions = issueActions(issue({ key, class: 'blocking', currency: null }), current);
      expect(actions).toHaveLength(1);
      expect(actions[0]?.label).toBe('Update all today');
      expect(actions[0]?.target).toEqual({ kind: 'quick_update' });
    }
  });
});

describe('a flow with no cash account', () => {
  const stray = (kind: 'income' | 'expense', id: string) =>
    issue({
      key: 'flow_without_cash_account',
      class: 'blocking',
      currency: 'USD',
      amount: { amount: '400', currency: 'USD' },
      source: { kind, id, on: '2026-09-12' },
    });

  it('offers the account first, because there is none to choose yet', () => {
    const actions = issueActions(stray('income', 'inc-1'), completed);
    expect(actions[0]?.label).toBe('Add a USD cash account');
    expect(actions[0]?.target).toEqual({ kind: 'link', href: '/accounts' });
  });

  it('lands on the exact record the issue names', () => {
    const actions = issueActions(stray('income', 'inc-1'), completed);
    expect(actions[1]?.label).toBe('Review this record');
    expect(actions[1]?.target).toEqual({ kind: 'anchor', anchor: '#income-inc-1' });
    expect(actions[1]?.hint).toContain('day 2026-09-12');

    const expense = issueActions(stray('expense', 'exp-1'), completed);
    expect(expense[1]?.target).toEqual({ kind: 'anchor', anchor: '#expense-exp-1' });
  });

  it('offers no record link when the page does not hold that row', () => {
    const actions = issueActions(stray('income', 'somewhere-else'), completed);
    expect(actions.map((action) => action.label)).toEqual(['Add a USD cash account']);
  });
});

/* -------------------------------------------------------------------------- */
/* The blocking correction                                                     */
/* -------------------------------------------------------------------------- */

describe('an unexplained inflow', () => {
  const inflow = (variant: 'a' | 'b') =>
    issue({
      key: 'unexplained_inflow',
      class: 'blocking',
      variant,
      amount: { amount: '1702', currency: 'EUR' },
    });

  it('leads with the missing income when cash grew beyond the records', () => {
    expect(labelsOf(inflow('a'))).toEqual([
      'Add missing income',
      'Record a transfer',
      'Review balances',
      'Review how expenses were paid',
      'Record reconciliation adjustment',
    ]);
  });

  it('leads with the expenses when they exceed the cash that left', () => {
    expect(labelsOf(inflow('b'))).toEqual([
      'Review how expenses were paid',
      'Add missing income',
      'Record a transfer',
      'Review balances',
      'Record reconciliation adjustment',
    ]);
  });

  it('marks the leading correction as the primary one, and the adjustment never', () => {
    const actions = issueActions(inflow('a'), completed);
    expect(actions[0]?.emphasis).toBe('primary');
    expect(actions.slice(1).every((action) => action.emphasis === 'secondary')).toBe(true);
  });

  it('offers no later-phase record type', () => {
    const hints = issueActions(inflow('a'), completed)
      .map((action) => `${action.label} ${action.hint}`)
      .join(' ')
      .toLowerCase();
    for (const word of ['withdrawal', 'loan proceeds', 'asset sale']) {
      expect(hints).not.toContain(word);
    }
  });

  it('offers no transfer when no other currency takes part', () => {
    const single = { ...completed, participatingCurrencies: ['EUR'] };
    expect(labelsOf(inflow('a'), single)).not.toContain('Record a transfer');
  });

  it('suggests the unexplained amount as a starting point, and says so', () => {
    const [addIncome] = issueActions(inflow('a'), completed);
    expect(addIncome?.target).toEqual({
      kind: 'add_income',
      initial: { currency: 'EUR', netAmount: '1702', receivedOn: null },
      dates: { min: '2026-09-01', max: '2026-09-30' },
    });
    expect(addIncome?.hint).toContain('change it to what actually arrived');
  });

  it('bounds a current month’s correction by the month-to-date date', () => {
    const actions = issueActions(inflow('a'), current);
    const addIncome = actions.find((action) => action.target.kind === 'add_income');
    expect(addIncome?.target).toMatchObject({ dates: { min: '2026-09-01', max: '2026-09-06' } });
    const adjustment = actions.find((action) => action.target.kind === 'adjustment');
    // The adjustment is dated where month-to-date stops, never today.
    expect(adjustment?.target).toEqual({
      kind: 'adjustment',
      currency: 'EUR',
      amount: { amount: '1702', currency: 'EUR' },
      recordedOn: '2026-09-06',
    });
  });

  it('dates a completed month’s adjustment at the month end', () => {
    const adjustment = issueActions(inflow('a'), completed).find(
      (action) => action.target.kind === 'adjustment',
    );
    expect(adjustment?.target).toMatchObject({ recordedOn: '2026-09-30' });
  });

  it('keeps its action ids free of the amount, so a refresh does not move them', () => {
    const before = issueActions(inflow('a'), completed).map((action) => action.id);
    const after = issueActions(
      { ...inflow('a'), amount: { amount: '900', currency: 'EUR' } },
      completed,
    ).map((action) => action.id);
    expect(after).toEqual(before);
  });
});

/* -------------------------------------------------------------------------- */
/* The two suggestions                                                         */
/* -------------------------------------------------------------------------- */

describe('a possible missing conversion', () => {
  const advisory = issue({
    key: 'possible_missing_conversion',
    class: 'advisory',
    currency: 'EUR',
    amount: { amount: '1000', currency: 'EUR' },
    candidates: [
      {
        sourceCurrency: 'USD',
        destinationCurrency: 'EUR',
        sourceAmount: { amount: '1100', currency: 'USD' },
        destinationAmount: { amount: '1000', currency: 'EUR' },
        comparisonAmount: { amount: '1080', currency: 'USD' },
        rate: '1.08',
        rateDate: '2026-09-30',
        rateSource: 'ecb',
      },
      {
        sourceCurrency: 'GBP',
        destinationCurrency: 'EUR',
        sourceAmount: { amount: '860', currency: 'GBP' },
        destinationAmount: { amount: '1000', currency: 'EUR' },
        comparisonAmount: { amount: '850', currency: 'GBP' },
        rate: '0.85',
        rateDate: '2026-09-30',
        rateSource: 'ecb',
      },
    ],
  });

  it('prefills the two native residuals, and never the comparison amount', () => {
    const [first] = issueActions(advisory, completed);
    expect(first?.target).toEqual({
      kind: 'transfer',
      initial: {
        occurredOn: null,
        from: { currency: 'USD', amount: '1100' },
        to: { currency: 'EUR', amount: '1000' },
      },
    });
    const serialized = JSON.stringify(issueActions(advisory, completed));
    // `X2` is evidence for the suggestion, and belongs in no field (30.15 item 9).
    expect(serialized).not.toContain('1080');
    expect(serialized).not.toContain('850');
  });

  it('chooses neither account and no day', () => {
    const [first] = issueActions(advisory, completed);
    const target = first?.target as { initial: { occurredOn: string | null } };
    expect(target.initial.occurredOn).toBeNull();
    expect(JSON.stringify(target)).not.toContain('positionId');
  });

  it('keeps every candidate separate, in the order the engine gave them', () => {
    const actions = issueActions(advisory, completed);
    expect(actions).toHaveLength(2);
    expect(actions.map((action) => action.id)).toEqual([
      'possible_missing_conversion:EUR::transfer:USD',
      'possible_missing_conversion:EUR::transfer:GBP',
    ]);
  });
});

describe('a possible missing interest', () => {
  const advisory = issue({
    key: 'possible_missing_interest',
    class: 'advisory',
    positionId: 'savings',
    positionName: 'Savings',
    amount: { amount: '31', currency: 'EUR' },
  });

  it('prefills the account the residual belongs to, the kind and the amount, and no date', () => {
    const [record] = issueActions(advisory, completed);
    expect(record?.label).toBe('Record interest');
    expect(record?.target).toEqual({
      kind: 'add_income',
      initial: {
        kind: 'interest',
        currency: 'EUR',
        netAmount: '31',
        cashPositionId: 'savings',
        receivedOn: null,
      },
      dates: { min: '2026-09-01', max: '2026-09-30' },
    });
    expect(record?.hint).toContain('what your statement shows');
  });
});

describe('the remaining advisories', () => {
  it('sends a missing scheduled income to its own occurrence row', () => {
    const actions = issueActions(
      issue({
        key: 'suggested_income_missing',
        class: 'advisory',
        templateId: 't1',
        templateName: 'Salary',
        occurrenceDate: '2026-09-25',
      }),
      completed,
    );
    expect(actions[0]?.label).toBe('Review scheduled income');
    expect(actions[0]?.target).toEqual({ kind: 'anchor', anchor: '#occurrence-t1-2026-09-25' });
  });

  it('offers a known expense for unusually large unclassified spending, with no amount', () => {
    const actions = issueActions(
      issue({
        key: 'large_unclassified',
        class: 'advisory',
        amount: { amount: '900', currency: 'EUR' },
      }),
      completed,
    );
    expect(actions[0]?.label).toBe('Add known expense');
    expect(actions[0]?.target).toEqual({ kind: 'add_expense', initial: { currency: 'EUR' } });
    // The advisory says the month's residual is large, not that one expense is.
    expect(JSON.stringify(actions[0]?.target)).not.toContain('900');
  });
});

/* -------------------------------------------------------------------------- */
/* The adjustment dialog                                                       */
/* -------------------------------------------------------------------------- */

describe('the adjustment dialog', () => {
  const html = renderToStaticMarkup(
    createElement(IssueActionHost, {
      resources: {
          month: '2026-09',
          monthName: 'September 2026',
          monthEndsOn: '2026-09-30',
          today: '2026-10-01',
          formatting: { locale: 'en-GB', minorUnitsByCurrency: { EUR: 2 } },
          currencies: ['EUR'],
          defaultCurrency: 'EUR',
          incomeAccounts: [],
          expenseAccounts: [],
          eligibleCategories: [],
          transferAccounts: [],
          quickUpdatePositions: [],
        bounds: { min: '2026-09-01', max: '2026-09-30' },
      },
      offeredActionIds: [],
      children: createElement(AdjustmentForm, {
        currency: 'EUR',
        amount: { amount: '1702', currency: 'EUR' },
        recordedOn: '2026-09-30',
        stale: false,
        onDone: () => undefined,
        onCancel: () => undefined,
        onBusyChange: () => undefined,
      }),
    }),
  );

  it('states the amount it will record, and offers no way to change it', () => {
    expect(html).toContain('1,702.00');
    expect(html).not.toContain('<input type="text" data-testid="adjustment-amount"');
    expect(html).not.toContain('name="amount"');
  });

  it('asks for no account, because the residual belongs to the currency', () => {
    expect(html).not.toContain('<select');
    expect(html).toContain('attributed to no account');
  });

  it('explains the bookkeeping date rather than asking for one', () => {
    expect(html).toContain('30 Sept 2026');
    expect(html).toContain('bookkeeping date');
    expect(html).not.toContain('type="date"');
  });

  it('says what an adjustment does not do, and needs an explicit confirmation', () => {
    expect(html).toContain('does not identify what caused the difference');
    expect(html).toContain('not income');
    expect(html).toContain('data-testid="adjustment-submit"');
  });
});
