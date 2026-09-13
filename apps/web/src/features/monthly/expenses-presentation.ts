import type {
  ExpenseCategoryDto,
  ExpenseOccurrenceDto,
  ExpenseSourceDto,
  ExpenseTermDto,
  MonthlyExpenseEntryDto,
  MonthlyExpensesDto,
} from '@vaultide/application';
import {
  moneyString,
  phase3ExpenseSettlements,
  rentalOnlySkipReasons,
  skipReasons,
} from '@vaultide/validation';
import { decideOnBlur, type BlurDecision } from '@/features/monthly/autosave';

/**
 * How Monthly's Known-expenses section says what the read returned (blueprint
 * 6.2, 7.4, 15.3 section 3, v2.1.7 §30.10).
 *
 * Words, options and boundaries — never a financial decision. Every rule here is
 * either enforced again by the server or is a contract of this section alone;
 * what it buys is a control that does not offer something the services would
 * refuse, which is a courtesy rather than an authority (20.1). Which occurrences
 * a month has, what one costs, who owns a row and what a category is used for
 * all arrive decided in the read.
 */

/* -------------------------------------------------------------------------- */
/* How it was paid                                                             */
/* -------------------------------------------------------------------------- */

/** The three Phase 3 payment methods, in the blueprint's own words (6.2). */
export const PAYMENT_METHOD_LABEL: Readonly<Record<string, string>> = {
  tracked_cash: 'Paid from tracked account',
  untracked_self: 'Paid by me outside tracked accounts',
  third_party: 'Paid by someone else',
};

/**
 * How a recorded row says it was paid.
 *
 * One more word than there are options: a row the investment workflow wrote
 * says so truthfully, and that method is still never offered here (6.2).
 */
export function paymentMethodLabel(settlement: string): string {
  if (settlement === 'deducted_from_asset') return 'Deducted from the investment’s value';
  return PAYMENT_METHOD_LABEL[settlement] ?? settlement;
}

/**
 * The payment methods a category may carry on this section.
 *
 * Money leaving tracked accounts exists to explain where tracked cash went
 * (7.4, 12.5), so here it is recorded as paid from a tracked account and nothing
 * else. Every other category offers all three Phase 3 methods.
 */
export function paymentMethodOptions(
  category: Pick<ExpenseCategoryDto, 'use'> | undefined,
): readonly { readonly value: string; readonly label: string }[] {
  const methods: readonly string[] =
    category?.use === 'money_out' ? ['tracked_cash'] : phase3ExpenseSettlements;
  return methods.map((value) => ({ value, label: PAYMENT_METHOD_LABEL[value] ?? value }));
}

/** The method a form holds once its category changes: kept while it is still offered. */
export function paymentMethodFor(
  category: Pick<ExpenseCategoryDto, 'use'> | undefined,
  current: string,
): string {
  return paymentMethodOptions(category).some((option) => option.value === current)
    ? current
    : 'tracked_cash';
}

/* -------------------------------------------------------------------------- */
/* Categories                                                                  */
/* -------------------------------------------------------------------------- */

export const SPENDING_GROUP_LABEL = 'Spending';
export const MONEY_OUT_GROUP_LABEL = 'Not spending';

export const MONEY_OUT_NOTE =
  'Money that left your tracked accounts without being spending. It is recorded as paid from a tracked account.';

interface Option {
  readonly value: string;
  readonly label: string;
}

export interface CategoryOptionGroups {
  /** Consumption categories: ordinary spending. */
  readonly spending: readonly Option[];
  /** `external_outflow`, apart from spending so the picker never calls it consumption. */
  readonly moneyOut: readonly Option[];
  /**
   * The row's own category when the picker would not offer it — archived, or a
   * kind another workflow owns. Shown so the row reads truthfully, and never
   * offered for anything new.
   */
  readonly current: Option | null;
}

/** The picker's options, from the set the read already decided is eligible. */
export function categoryOptionGroups(
  eligible: readonly ExpenseCategoryDto[],
  current?: ExpenseCategoryDto,
): CategoryOptionGroups {
  const option = (category: ExpenseCategoryDto): Option => ({
    value: category.categoryId,
    label: category.name,
  });
  const offered = current !== undefined && eligible.some((row) => row.categoryId === current.categoryId);
  return {
    spending: eligible.filter((row) => row.use === 'spending').map(option),
    moneyOut: eligible.filter((row) => row.use === 'money_out').map(option),
    current:
      current === undefined || offered
        ? null
        : {
            value: current.categoryId,
            label: current.archived ? `${current.name} (archived)` : current.name,
          },
  };
}

/** The eligible category a picker starts on: the first ordinary spending one. */
export function defaultCategoryId(eligible: readonly ExpenseCategoryDto[]): string {
  return (eligible.find((row) => row.use === 'spending') ?? eligible[0])?.categoryId ?? '';
}

/* -------------------------------------------------------------------------- */
/* Accounts                                                                    */
/* -------------------------------------------------------------------------- */

type CashAccount = MonthlyExpensesDto['cashAccounts'][number];

export const NO_ACCOUNT = '__none__';

/**
 * Whether an account could hold an expense of this currency on this date: its
 * own currency, and open on the day (8.1, R4). The service asks the same.
 *
 * A date not yet chosen filters nothing but currency, rather than hiding every
 * account behind a half-typed field.
 */
export function canHold(account: CashAccount, currency: string, on: string): boolean {
  if (account.currency !== currency) return false;
  if (on === '') return true;
  if (account.openedOn !== null && on < account.openedOn) return false;
  return account.closedOn === null || on <= account.closedOn;
}

/**
 * The accounts a picker offers.
 *
 * `keep` is the account a saved row already carries: it stays listed so the row
 * reads truthfully, and a date it cannot hold is the server's to refuse.
 */
export function accountChoices(
  accounts: readonly CashAccount[],
  currency: string,
  on: string,
  keep: string | null = null,
): readonly CashAccount[] {
  return accounts.filter(
    (account) => canHold(account, currency, on) || account.positionId === keep,
  );
}

/**
 * The account a form should hold after its currency or date changes.
 *
 * A selection the new currency or date cannot hold is dropped to the
 * unattributed state — which is still tracked cash (8.1) — rather than kept out
 * of sight for the server to refuse.
 */
export function accountAfterChange(
  accounts: readonly CashAccount[],
  selected: string,
  currency: string,
  on: string,
): string {
  if (selected === NO_ACCOUNT) return NO_ACCOUNT;
  const account = accounts.find((row) => row.positionId === selected);
  return account !== undefined && canHold(account, currency, on) ? selected : NO_ACCOUNT;
}

/* -------------------------------------------------------------------------- */
/* Amounts                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Why an expense amount cannot be sent, or `null` when it can.
 *
 * Checked as the decimal string it is, never as a number. An expense is more
 * than zero (6.2): a zero is refused here rather than saved as a stand-in for
 * "did not happen", which is a skip or a delete.
 */
export function expenseAmountProblem(amount: string, minorUnits: number): string | null {
  if (amount === '') return 'Enter what it cost.';
  const parsed = moneyString({ minorUnits, positive: true }).safeParse(amount);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Enter an amount greater than zero.');
}

/** A term may be zero (6.2), so it gets the non-negative check instead. */
export function termAmountProblem(amount: string, minorUnits: number): string | null {
  if (amount === '') return 'Enter the amount.';
  const parsed = moneyString({ minorUnits, nonNegative: true }).safeParse(amount);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Enter an amount.');
}

/** Leaving an expense amount field: the shared autosave rule, and more than zero. */
export function decideExpenseAmountOnBlur(input: {
  readonly draft: string;
  readonly saved: string | null;
  readonly minorUnits: number;
}): BlurDecision {
  const decision = decideOnBlur(input);
  if (decision.kind !== 'save') return decision;
  const problem = expenseAmountProblem(decision.amount, input.minorUnits);
  return problem === null ? decision : { kind: 'invalid', message: problem };
}

/**
 * What an adjustment starts from: the term's amount when recording it could
 * succeed, and nothing when the read says it could not — a zero term is not an
 * amount anybody was charged.
 */
export function adjustmentAmountDefault(term: ExpenseTermDto, recordableAsExpected: boolean): string {
  return recordableAsExpected && term.amount !== null ? term.amount.amount : '';
}

/* -------------------------------------------------------------------------- */
/* Occurrences and ownership                                                   */
/* -------------------------------------------------------------------------- */

/** What an occurrence's row says it is, in the month it is being read in. */
export function expenseOccurrenceStateLabel(state: ExpenseOccurrenceDto['state']): string {
  switch (state.kind) {
    case 'accepted':
      return 'Recorded';
    case 'skipped':
      return 'Skipped';
    case 'upcoming':
      return 'Upcoming';
    case 'due':
      return 'Not recorded';
  }
}

export const EXPENSE_SKIP_REASON_LABEL: Readonly<Record<string, string>> = {
  skipped: 'Not charged',
  other: 'Another reason',
};

/**
 * The reasons an expense occurrence may be skipped for.
 *
 * `vacant` and `non_payment` are occupancy facts a rental alone records (6.2,
 * F18); an expense source is never a rental, so they are never offered.
 */
export function expenseSkipReasonOptions(): readonly Option[] {
  const rentalOnly = rentalOnlySkipReasons as readonly string[];
  return skipReasons
    .filter((reason) => !rentalOnly.includes(reason))
    .map((value) => ({ value, label: EXPENSE_SKIP_REASON_LABEL[value] ?? value }));
}

/**
 * Whether this page may change an expense.
 *
 * The month the expense financially happened in owns it: a September occurrence
 * paid on 2 October is October's to correct or delete, because editing it from
 * September would change a reconciliation September is not showing.
 */
export const ownsExpense = (entry: Pick<MonthlyExpenseEntryDto, 'incurredMonth'>, month: string): boolean =>
  entry.incurredMonth === month;

/** The owner month's Known-expenses section. */
export const knownExpensesHref = (month: string): string => `/monthly/${month}#known-expenses`;

/**
 * What to say before recording lands an expense in another month.
 *
 * `null` when the financial date belongs to the month on screen.
 */
export function expenseCrossMonthNotice(
  incurredOn: string,
  displayedMonth: string,
  monthNameOf: (month: string) => string,
): string | null {
  const target = incurredOn.slice(0, 7);
  if (incurredOn === '' || target === displayedMonth) return null;
  return `The occurrence stays on ${monthNameOf(displayedMonth)}’s schedule, but the expense will belong to ${monthNameOf(target)} and count in ${monthNameOf(target)}’s reconciliation.`;
}

export const TRANSFER_FEE_NOTE =
  'Part of a transfer. This fee was recorded with the transfer it was charged on and changes only with it, so it cannot be edited or removed here.';

/** Why a row filed by another workflow is shown but not changed here. */
export function otherWorkflowNote(entry: Pick<MonthlyExpenseEntryDto, 'category'>): string {
  return `Filed under ${entry.category.name}, a kind of cost recorded by its own workflow rather than here. It is shown as it was recorded.`;
}

/**
 * Why a legacy source's occurrences cannot be recorded here, or `null` when
 * they can (7.4).
 *
 * The read says which protection applies; this only says it in words. The row
 * keeps what can resolve an occurrence without recording it — a skip, a
 * restore, an end date — and links to no other editor, because none exists yet
 * for either workflow.
 */
export function protectedSourceNote(
  source: Pick<ExpenseSourceDto, 'protection' | 'category'>,
): string | null {
  switch (source.protection) {
    case null:
      return null;
    case 'capital_improvement':
      return `A legacy source filed under ${source.category.name}. This editor cannot record it: a capital improvement belongs to the asset it improves, not to Known expenses.`;
    case 'transfer_fee':
      return `A legacy source filed under ${source.category.name}. This editor cannot record it: a transfer fee is recorded with the transfer it was charged on.`;
  }
}

/* -------------------------------------------------------------------------- */
/* A source's end date                                                         */
/* -------------------------------------------------------------------------- */

/** The completed months an end-date change reaches, as a range. */
export interface AffectedMonths {
  /** `YYYY-MM`. */
  readonly first: string;
  readonly last: string;
  readonly count: number;
}

export type EndDateChange =
  | { readonly kind: 'unchanged' }
  /** Setting or shortening: occurrences after `next` stop being expected. */
  | {
      readonly kind: 'ends';
      readonly previous: string | null;
      readonly next: string;
      readonly affected: AffectedMonths | null;
    }
  /** Extending or clearing: occurrences after `previous` may be expected again. */
  | {
      readonly kind: 'extends';
      readonly previous: string;
      readonly next: string | null;
      readonly affected: AffectedMonths | null;
    };

function monthsOf(dates: readonly string[]): AffectedMonths | null {
  if (dates.length === 0) return null;
  const months = [...new Set(dates.map((date) => date.slice(0, 7)))].sort();
  return {
    first: months[0] as string,
    last: months[months.length - 1] as string,
    count: months.length,
  };
}

/**
 * What changing a source's end date would do to completed months.
 *
 * The dates compared are the ones the read generated from the source's own
 * schedule (`completedOccurrenceDates`); nothing here generates a schedule. A
 * change the server refuses — an end before an occurrence already recorded or
 * skipped — is still the server's to refuse.
 */
export function endDateChangeOf(
  source: Pick<ExpenseSourceDto, 'endDate' | 'completedOccurrenceDates'>,
  proposed: string | null,
): EndDateChange {
  const previous = source.endDate;
  if (proposed === previous) return { kind: 'unchanged' };
  const dates = source.completedOccurrenceDates;

  if (proposed !== null && (previous === null || proposed < previous)) {
    return {
      kind: 'ends',
      previous,
      next: proposed,
      affected: monthsOf(dates.filter((date) => date > proposed && (previous === null || date <= previous))),
    };
  }

  /* v8 ignore next -- both null is `unchanged`, returned above. */
  if (previous === null) return { kind: 'unchanged' };
  return {
    kind: 'extends',
    previous,
    next: proposed,
    affected: monthsOf(dates.filter((date) => date > previous && (proposed === null || date <= proposed))),
  };
}

/** The confirmation's sentences, before a change to the schedule is applied. */
export function endDateChangeSummary(
  change: Exclude<EndDateChange, { readonly kind: 'unchanged' }>,
  words: {
    readonly source: string;
    readonly day: (date: string) => string;
    readonly month: (month: string) => string;
  },
): readonly string[] {
  const range =
    change.affected === null
      ? null
      : change.affected.first === change.affected.last
        ? words.month(change.affected.first)
        : `${words.month(change.affected.first)} – ${words.month(change.affected.last)}`;
  const completed =
    range === null
      ? 'No completed month’s expected occurrences change.'
      : `Completed months whose expected occurrences change: ${range}.`;

  if (change.kind === 'ends') {
    return [
      `${words.source} will end on ${words.day(change.next)}.`,
      `Occurrences after that date that are not recorded or skipped stop being expected.`,
      completed,
    ];
  }
  return [
    change.next === null
      ? `${words.source} will no longer have an end date.`
      : `${words.source} will end on ${words.day(change.next)} instead of ${words.day(change.previous)}.`,
    `Occurrences after ${words.day(change.previous)} may become expected again.`,
    completed,
  ];
}

/* -------------------------------------------------------------------------- */
/* Creating a source                                                           */
/* -------------------------------------------------------------------------- */

export const EXPENSE_FREQUENCIES = [
  { value: 'monthly', label: 'Every month' },
  { value: 'quarterly', label: 'Every three months' },
  { value: 'semiannual', label: 'Every six months' },
  { value: 'annual', label: 'Every year' },
] as const;

export const EXPENSE_HISTORICAL_START_NOTE =
  'Starting this source in the past creates expected occurrences from that date. Past completed months may need those occurrences recorded or skipped.';
