import type { MonthlyPageDto, ReconciliationIssueDto } from '@vaultide/application';
import type { MoneyDto } from '@vaultide/finance/client';
import {
  accountAnchorId,
  expenseEntryAnchorId,
  incomeEntryAnchorId,
} from '@/features/monthly/presentation';
import { occurrenceAnchorId, type AddIncomeInitialValues } from '@/features/monthly/income-presentation';
import type { AddExpenseInitialValues } from '@/features/monthly/expenses-presentation';
import type { TransferInitialValues } from '@/features/monthly/transfers-presentation';

/**
 * What a reconciliation issue offers the user (blueprint 8.5, 15.3 section 8,
 * 30.21; ADR 0009).
 *
 * One pure mapping from an issue to the controls beside it, so the corrections
 * are one list to read and to test rather than a tree of conditions inside JSX.
 * Three rules shape every entry:
 *
 *  - **one click enters the correction.** An action either navigates to the
 *    surface that already maintains the record, or opens a focused form with
 *    what the issue knows filled in. None of them writes anything; the form or
 *    the editor it opens does that, once the user confirms (30.21 item 1);
 *  - **the most likely fix first.** An `unexplained_inflow` leads with the
 *    correction its variant points at, and the adjustment — which explains
 *    nothing — is always last;
 *  - **only what this phase can record.** A withdrawal, loan proceeds, an asset
 *    sale and a suggested liability payment are absent rather than disabled,
 *    because their record types do not exist yet.
 *
 * Nothing financial is decided here: every amount is carried as the DTO's own
 * `MoneyDto` and never formatted into a sentence, no figure is computed, and no
 * issue trigger is re-derived. What the engine raised is what this offers a
 * correction for.
 */

/** The issue keys Phase 3 can raise, and therefore the ones that need controls. */
export const ACTIONABLE_ISSUE_KEYS = [
  'missing_month_end',
  'mtd_no_common_date',
  'mtd_newer_balances',
  'first_balance',
  'flow_without_cash_account',
  'unexplained_inflow',
  'possible_missing_conversion',
  'possible_missing_interest',
  'suggested_income_missing',
  'large_unclassified',
] as const;

export type ActionableIssueKey = (typeof ACTIONABLE_ISSUE_KEYS)[number];

/**
 * The keys 8.5 lists that this phase cannot act on, and why.
 *
 * Named rather than forgotten: the unit test walks the whole catalogue, so a key
 * that is neither handled above nor excused here fails the suite instead of
 * quietly reaching a user with no way to act on it.
 */
export const LATER_PHASE_ISSUE_KEYS: Readonly<Record<string, string>> = {
  suggested_payment_missing: 'Liabilities and their payments arrive with Phase 5.',
  stale_investment: 'Investments arrive with Phase 4.',
  stale_property: 'Properties arrive with Phase 6.',
};

/** The first and last day a correction for this issue may be dated. */
export interface CorrectionDates {
  readonly min: string;
  readonly max: string;
}

/** Where a control takes the user, or what it opens. */
export type IssueActionTarget =
  /** A row or section of this page. */
  | { readonly kind: 'anchor'; readonly anchor: string }
  /** Another page: another month, an account. */
  | { readonly kind: 'link'; readonly href: string }
  | {
      readonly kind: 'add_income';
      readonly initial: AddIncomeInitialValues;
      readonly dates: CorrectionDates;
    }
  | { readonly kind: 'add_expense'; readonly initial: AddExpenseInitialValues }
  | { readonly kind: 'transfer'; readonly initial: TransferInitialValues }
  | {
      readonly kind: 'adjustment';
      readonly currency: string;
      readonly amount: MoneyDto;
      /** The interval's endpoint: where the discrepancy was measured (30.21 item 5). */
      readonly recordedOn: string;
    }
  | { readonly kind: 'quick_update' };

export interface IssueAction {
  /** Stable across refreshes: the issue it belongs to and what it does, never an amount. */
  readonly id: string;
  readonly label: string;
  /** One line under the control: what it does, and what it does not claim. */
  readonly hint: string;
  readonly emphasis: 'primary' | 'secondary';
  readonly target: IssueActionTarget;
}

/** An account's two endpoints, as the month's own reconciliation states them. */
export interface IssueAccountState {
  readonly name: string;
  readonly openState: string;
  /**
   * `null` for the current month, which has no closing statement to be missing:
   * its value at `D` is a snapshot, and `missing_month_end` is completed-month
   * only (8.6, 30.13 item 10).
   */
  readonly closeState: string | null;
}

export interface IssueActionContext {
  readonly shape: 'completed' | 'current';
  /** `YYYY-MM`. */
  readonly month: string;
  readonly previousMonth: string;
  readonly monthName: string;
  readonly previousMonthName: string;
  readonly monthEndsOn: string;
  readonly today: string;
  /** `D`, the month-to-date evidence date, when the current month has one. */
  readonly asOf: string | null;
  readonly accounts: ReadonlyMap<string, IssueAccountState>;
  /** The currencies with a cash account taking part in the month. */
  readonly participatingCurrencies: readonly string[];
  /** Where each income entry of the month is rendered on this page. */
  readonly incomeAnchors: ReadonlyMap<string, string>;
  readonly expenseAnchors: ReadonlyMap<string, string>;
  /** A day as the reader's locale writes it; never a money value. */
  readonly formatDay: (iso: string) => string;
}

const UNSETTLED_ENDPOINTS: readonly string[] = ['carried', 'missing'];

/**
 * The last day a correction for this issue may carry.
 *
 * A completed month ends at its own last day. The current month ends at `D`:
 * month-to-date covers flows dated on or before it, so a record dated later
 * cannot change the figure the correction was offered for (8.6, 30.21 item 7).
 */
function correctionDates(context: IssueActionContext): CorrectionDates {
  const max =
    context.shape === 'current' ? (context.asOf ?? context.today) : context.monthEndsOn;
  return { min: `${context.month}-01`, max };
}

function action(
  issue: ReconciliationIssueDto,
  suffix: string,
  rest: Omit<IssueAction, 'id'>,
): IssueAction {
  const scope = [issue.key, issue.currency ?? '', issue.positionId ?? '', suffix].join(':');
  return { id: scope, ...rest };
}

/* -------------------------------------------------------------------------- */
/* One handler per key                                                         */
/* -------------------------------------------------------------------------- */

type Handler = (
  issue: ReconciliationIssueDto,
  context: IssueActionContext,
) => readonly IssueAction[];

/**
 * Evidence repair, at the row that holds the evidence (ADR 0009 §15).
 *
 * The month's own Accounts row enters a statement balance, confirms a last-day
 * snapshot as one, or confirms the month unchanged; the previous month's row is
 * where this month's opening comes from. Nothing is duplicated here, and
 * dormancy is not promised as a fix: marking an account dormant carries it from
 * the zero balance that justified it, not from today (8.8, ADR 0007).
 */
const missingMonthEnd: Handler = (issue, context) => {
  const positionId = issue.positionId;
  if (positionId === null) return [];
  const state = context.accounts.get(positionId);
  const name = issue.positionName ?? state?.name ?? 'this account';
  const actions: IssueAction[] = [];

  if (state?.closeState === undefined || UNSETTLED_ENDPOINTS.includes(state.closeState ?? '')) {
    actions.push(
      action(issue, 'closing', {
        label: 'Enter the closing balance',
        hint: `${name}’s statement balance at the end of ${context.monthName} — or confirm the balance did not change.`,
        emphasis: 'primary',
        target: { kind: 'anchor', anchor: `#${accountAnchorId(positionId)}` },
      }),
    );
  }

  if (state !== undefined && UNSETTLED_ENDPOINTS.includes(state.openState)) {
    actions.push(
      action(issue, 'opening', {
        label: `Enter ${context.previousMonthName}’s balance`,
        hint: `${context.monthName} starts from ${name}’s statement at the end of ${context.previousMonthName}, and there is none.`,
        emphasis: actions.length === 0 ? 'primary' : 'secondary',
        target: {
          kind: 'link',
          href: `/monthly/${context.previousMonth}#${accountAnchorId(positionId)}`,
        },
      }),
    );
  }

  actions.push(
    action(issue, 'account', {
      label: 'Manage account',
      hint: 'Mark it dormant from the zero balance that emptied it, or close it, if it holds nothing.',
      emphasis: 'secondary',
      target: { kind: 'link', href: `/accounts/${positionId}` },
    }),
  );

  return actions;
};

/** Both month-to-date issues are answered by the same existing modal (15.3). */
const quickUpdate =
  (hint: string): Handler =>
  (issue) => [
    action(issue, 'quick-update', {
      label: 'Update all today',
      hint,
      emphasis: 'primary',
      target: { kind: 'quick_update' },
    }),
  ];

/**
 * One earlier balance, through the editor that already records one (ADR 0009
 * §12). The bulk editor a later slice adds is for many months at once.
 */
const firstBalance: Handler = (issue, context) => {
  const positionId = issue.positionId;
  if (positionId === null) return [];
  const name = issue.positionName ?? context.accounts.get(positionId)?.name ?? 'this account';
  return [
    action(issue, 'earlier-balance', {
      label: 'Enter an earlier balance',
      hint: `If you know ${name}’s balance at the end of ${context.previousMonthName}, entering it lets ${context.monthName} include the account.`,
      emphasis: 'primary',
      target: {
        kind: 'link',
        href: `/monthly/${context.previousMonth}#${accountAnchorId(positionId)}`,
      },
    }),
  ];
};

/**
 * The record with no account, and the account it needs (ADR 0009 §13).
 *
 * There is nothing to choose while no account of the currency takes part, so
 * the first action adds one; the second lands on the exact record, which the
 * issue names.
 */
const flowWithoutCashAccount: Handler = (issue, context) => {
  const actions: IssueAction[] = [
    action(issue, 'add-account', {
      label: `Add a ${issue.currency ?? 'cash'} cash account`,
      hint: `No ${issue.currency ?? 'matching'} account took part in ${context.monthName}, so this record has nothing to reconcile against. Add the account it went through.`,
      emphasis: 'primary',
      target: { kind: 'link', href: '/accounts' },
    }),
  ];

  const source = issue.source;
  const anchor =
    source === undefined
      ? undefined
      : source.kind === 'income'
        ? context.incomeAnchors.get(source.id)
        : source.kind === 'expense'
          ? context.expenseAnchors.get(source.id)
          : undefined;

  if (source !== undefined && anchor !== undefined) {
    actions.push(
      action(issue, 'review-record', {
        label: 'Review this record',
        hint: `The ${source.kind === 'income' ? 'income' : 'expense'} recorded on ${context.formatDay(source.on)}. Once an account of this currency takes part, it can name one.`,
        emphasis: 'secondary',
        target: { kind: 'anchor', anchor: `#${anchor}` },
      }),
    );
  }

  return actions;
};

/**
 * The blocking correction, ordered by what the variant says happened (ADR 0009
 * §3). Variant A is cash that grew beyond the records; variant B is known
 * expenses beyond the cash that left. The choices are the same; which is likely
 * is not.
 */
const unexplainedInflow: Handler = (issue, context) => {
  const currency = issue.currency ?? '';
  const dates = correctionDates(context);
  const amount = issue.amount;

  const addIncome = action(issue, 'add-income', {
    label: 'Add missing income',
    hint: `Money that arrived and nothing records. The amount starts at the unexplained difference — change it to what actually arrived, and date it inside ${context.monthName}.`,
    emphasis: 'secondary',
    target: {
      kind: 'add_income',
      initial: {
        currency,
        ...(amount === null ? {} : { netAmount: amount.amount }),
        // Nothing evidences the day it arrived (ADR 0009 §11's reasoning).
        receivedOn: null,
      },
      dates,
    },
  });

  const reviewExpenses = action(issue, 'review-expenses', {
    label: 'Review how expenses were paid',
    hint: 'An expense paid from outside your tracked accounts, or by somebody else, should say so — then it stops being cash that had to leave.',
    emphasis: 'secondary',
    target: { kind: 'anchor', anchor: '#known-expenses' },
  });

  const reviewBalances = action(issue, 'review-balances', {
    label: 'Review balances',
    hint: 'A statement balance typed a digit out shows up here as cash nobody explained.',
    emphasis: 'secondary',
    target: { kind: 'anchor', anchor: '#accounts' },
  });

  const actions: IssueAction[] = [];
  if (issue.variant === 'b') {
    actions.push(reviewExpenses, addIncome);
  } else {
    actions.push(addIncome, reviewExpenses);
  }

  // A transfer can only explain this bucket when another currency's account
  // takes part: within one currency its two legs cancel (7.4, 8.2).
  if (context.participatingCurrencies.some((code) => code !== currency)) {
    actions.push(
      action(issue, 'transfer', {
        label: 'Record a transfer',
        hint: 'Money moved in from another of your accounts is neither income nor spending.',
        emphasis: 'secondary',
        target: {
          kind: 'transfer',
          initial: { occurredOn: null, to: { currency } },
        },
      }),
    );
  }

  actions.push(reviewBalances);

  if (amount !== null) {
    actions.push(
      action(issue, 'adjustment', {
        label: 'Record reconciliation adjustment',
        hint: `The fallback: accept the difference as it stands. It makes ${context.monthName} add up without saying what caused it, and you can replace it later.`,
        emphasis: 'secondary',
        target: {
          kind: 'adjustment',
          currency,
          amount,
          recordedOn: dates.max,
        },
      }),
    );
  }

  // The first choice of the variant's own order leads.
  const [first, ...rest] = actions;
  return first === undefined ? [] : [{ ...first, emphasis: 'primary' as const }, ...rest];
};

/**
 * One control per candidate, prefilled with the two native residuals and
 * nothing else (30.15 item 9, 30.17 item 7, ADR 0009 §10).
 *
 * `X2` and the month's average rate stay in the advisory's own text as the
 * evidence for the suggestion. Neither account is chosen, even where only one
 * account of a currency takes part, and the date starts empty.
 */
const possibleMissingConversion: Handler = (issue, context) =>
  (issue.candidates ?? []).map((candidate) =>
    action(issue, `transfer:${candidate.sourceCurrency}`, {
      label: 'Record this transfer',
      hint: `Opens a transfer out of ${candidate.sourceCurrency} and into ${candidate.destinationCurrency} with the two unexplained amounts. Choose the accounts and the day it moved, inside ${context.monthName}, and change the amounts to what your statements show.`,
      emphasis: 'primary',
      target: {
        kind: 'transfer',
        initial: {
          occurredOn: null,
          from: {
            currency: candidate.sourceCurrency,
            amount: candidate.sourceAmount.amount,
          },
          to: {
            currency: candidate.destinationCurrency,
            amount: candidate.destinationAmount.amount,
          },
        },
      },
    }),
  );

/**
 * The one suggestion that knows an account: the residual is that account's
 * (8.3, 8.5). The amount is a starting point, and no date is evidenced.
 */
const possibleMissingInterest: Handler = (issue, context) => {
  const positionId = issue.positionId;
  if (positionId === null || issue.amount === null) return [];
  return [
    action(issue, 'record-interest', {
      label: 'Record interest',
      hint: `Opens the income form for ${issue.positionName ?? 'this account'} with the unexplained growth as a starting amount. Record what your statement shows, on the day it was credited.`,
      emphasis: 'primary',
      target: {
        kind: 'add_income',
        initial: {
          kind: 'interest',
          currency: issue.currency ?? '',
          netAmount: issue.amount.amount,
          cashPositionId: positionId,
          receivedOn: null,
        },
        dates: correctionDates(context),
      },
    }),
  ];
};

/** The occurrence's own row already accepts, edits and skips it (ADR 0009 §4). */
const suggestedIncomeMissing: Handler = (issue) => {
  if (issue.templateId === null || issue.occurrenceDate === null) return [];
  return [
    action(issue, 'occurrence', {
      label: 'Review scheduled income',
      hint: 'Record what arrived, change the amount, or skip the occurrence if it never came.',
      emphasis: 'primary',
      target: {
        kind: 'anchor',
        anchor: `#${occurrenceAnchorId(issue.templateId, issue.occurrenceDate)}`,
      },
    }),
  ];
};

/** More unexplained spending than usual often means expenses nobody recorded (8.5). */
const largeUnclassified: Handler = (issue, context) => [
  action(issue, 'add-expense', {
    label: 'Add known expense',
    hint: `Each expense you record moves that much of ${context.monthName}’s spending from unexplained to known, and changes no total.`,
    emphasis: 'primary',
    target: {
      kind: 'add_expense',
      initial: { currency: issue.currency ?? '' },
    },
  }),
];

const HANDLERS: Readonly<Record<ActionableIssueKey, Handler>> = {
  missing_month_end: missingMonthEnd,
  mtd_no_common_date: quickUpdate(
    'Records today’s balance for every active account. Month to date needs one date they all share.',
  ),
  mtd_newer_balances: quickUpdate(
    'Month to date stays valid where it is; updating every account today moves that date forward.',
  ),
  first_balance: firstBalance,
  flow_without_cash_account: flowWithoutCashAccount,
  unexplained_inflow: unexplainedInflow,
  possible_missing_conversion: possibleMissingConversion,
  possible_missing_interest: possibleMissingInterest,
  suggested_income_missing: suggestedIncomeMissing,
  large_unclassified: largeUnclassified,
};

export function isActionableIssueKey(key: string): key is ActionableIssueKey {
  return Object.hasOwn(HANDLERS, key);
}

/** The controls one issue instance offers, in the order they should be read. */
export function issueActions(
  issue: ReconciliationIssueDto,
  context: IssueActionContext,
): readonly IssueAction[] {
  return isActionableIssueKey(issue.key) ? HANDLERS[issue.key](issue, context) : [];
}

/* -------------------------------------------------------------------------- */
/* The context, from the page the reads already returned                       */
/* -------------------------------------------------------------------------- */

function accountStatesOf(page: MonthlyPageDto): Map<string, IssueAccountState> {
  const states = new Map<string, IssueAccountState>();
  if (page.kind === 'completed') {
    for (const bucket of page.reconciliation.buckets) {
      for (const account of bucket.accounts) {
        states.set(account.positionId, {
          name: account.name,
          openState: account.openState,
          closeState: account.closeState,
        });
      }
    }
    return states;
  }
  for (const bucket of page.monthToDate.buckets ?? []) {
    for (const account of bucket.accounts) {
      states.set(account.positionId, {
        name: account.name,
        openState: account.openState,
        closeState: null,
      });
    }
  }
  return states;
}

/**
 * Where each of the month's income and expense rows is rendered.
 *
 * A row the schedule placed in the month is drawn inside its occurrence, so its
 * anchor is the occurrence's; everything else has a row of its own. Building
 * the map from the page's own sections is what keeps a link from pointing at an
 * element that is not there.
 */
function entryAnchorsOf(page: MonthlyPageDto): {
  income: Map<string, string>;
  expenses: Map<string, string>;
} {
  const income = new Map<string, string>();
  for (const occurrence of page.income.occurrences) {
    if (occurrence.state.kind === 'accepted') {
      income.set(
        occurrence.state.entry.entryId,
        occurrenceAnchorId(occurrence.templateId, occurrence.occurrenceDate),
      );
    }
  }
  for (const entry of [...page.income.otherRecurring, ...page.income.direct]) {
    income.set(entry.entryId, incomeEntryAnchorId(entry.entryId));
  }

  const expenses = new Map<string, string>();
  for (const entry of [...page.expenses.otherRecurring, ...page.expenses.direct]) {
    expenses.set(entry.entryId, expenseEntryAnchorId(entry.entryId));
  }
  for (const occurrence of page.expenses.occurrences) {
    if (occurrence.state.kind === 'accepted') {
      expenses.set(occurrence.state.entry.entryId, expenseEntryAnchorId(occurrence.state.entry.entryId));
    }
  }
  return { income, expenses };
}

export function issueActionContextOf(
  page: MonthlyPageDto,
  labels: {
    readonly monthName: string;
    readonly previousMonthName: string;
    readonly formatDay: (iso: string) => string;
  },
): IssueActionContext {
  const anchors = entryAnchorsOf(page);
  const currencies = new Set<string>();
  for (const account of page.accounts.accounts) currencies.add(account.currency);
  return {
    shape: page.kind,
    month: page.month,
    previousMonth: page.accounts.previousMonth,
    monthName: labels.monthName,
    previousMonthName: labels.previousMonthName,
    monthEndsOn: page.monthEndsOn,
    today: page.today,
    // 8.6's evidence date, when the current month has one.
    asOf: page.kind === 'current' ? page.monthToDate.asOf : null,
    accounts: accountStatesOf(page),
    participatingCurrencies: [...currencies],
    incomeAnchors: anchors.income,
    expenseAnchors: anchors.expenses,
    formatDay: labels.formatDay,
  };
}
