import type { MoneyDto } from '@vaultide/finance';
import type { CashMonthStateDto, PositionStatusDto, ValueStateDto } from '../positions/types';
import type {
  MonthCompletenessDto,
  MonthReconciliationDto,
  MonthReportingCashFlowDto,
  MonthToDateDto,
  MonthToDateReportingCashFlowDto,
} from '../reconciliation/types';

/**
 * The Monthly page's read model (blueprint 15.2, 15.3).
 *
 * One month, in one of two shapes. Every financial part is the authoritative
 * read's own DTO, carried unchanged: this module composes, it never restates a
 * figure, a status or an issue. The review state beside them is the user's own
 * and changes none of them.
 */

/**
 * What the user has recorded about a month (5.1 MonthReview, 20.3).
 *
 * Presentation state, never a financial fact: a review mark locks nothing and
 * completes nothing, and a dismissed key hides an advisory from the month's
 * normal presentation without removing it from any result.
 */
export interface MonthReviewDto {
  /** When the month was marked reviewed, as an ISO instant; `null` until then. */
  readonly reviewedAt: string | null;
  /**
   * The stored dismissal keys, sorted and each once. Opaque strings: a key this
   * version does not know is still listed, because it is still the user's.
   */
  readonly dismissedIssueKeys: readonly string[];
}

/** The months either side, as `YYYY-MM`. There is never a path into the future. */
export interface MonthlyNavigationDto {
  readonly previous: string;
  /** `null` on the current month: the month after it has not begun. */
  readonly next: string | null;
  /** The month containing today. */
  readonly current: string;
}

interface MonthlyPageBase {
  /** `YYYY-MM`. */
  readonly month: string;
  /** The last day of the month, `YYYY-MM-DD`. */
  readonly monthEndsOn: string;
  /** The request's today in the user's timezone, `YYYY-MM-DD`. */
  readonly today: string;
  readonly navigation: MonthlyNavigationDto;
  /** Minor units per currency, so every amount formats in its own scale. */
  readonly minorUnitsByCurrency: Readonly<Record<string, number>>;
  /**
   * The currencies a picker on this page may offer: active and FX-supported
   * (10.5). Deliberately **not** the currencies the user holds an account in —
   * income received outside tracked accounts, and tracked income still awaiting
   * attribution, are both legitimate in a currency no account exists for.
   */
  readonly selectableCurrencyCodes: readonly string[];
  readonly review: MonthReviewDto;
}

/* -------------------------------------------------------------------------- */
/* Income (15.3 section 2)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What the schedule says an occurrence is worth, and what a forward-looking
 * edit of it must claim (blueprint 6.2, §30.9 item 4, 20.3).
 *
 * Two related questions live here and they are deliberately not one field. The
 * **applicable** term is the row with the greatest `effective_from ≤
 * occurrence_date` — it decides what the suggestion is worth, and it usually
 * started months earlier. The **exact** term is whether a row starts on this
 * occurrence's own date, which is what "From this occurrence on" has to state:
 * `setTemplateTerm` is a replacement, not a patch, and the server must never
 * decide create-versus-update from a read it took for itself.
 */
export interface OccurrenceTermDto {
  /** The applicable term's amount, or `null` when no term covers the date yet. */
  readonly net: MoneyDto | null;
  readonly gross: MoneyDto | null;
  /** The applicable term's own effective date — never the financial date. */
  readonly effectiveFrom: string | null;
  /**
   * Whether a term starts **exactly** at this occurrence's date.
   *
   * `absent` means a write there creates one: net and gross may be prefilled
   * from the applicable term as a convenience, but the note starts blank,
   * because an older term's note explains why *that* term began.
   *
   * `version` carries the row a write would replace, note included, so the form
   * can resubmit the complete state deliberately rather than clearing a note it
   * never saw.
   */
  readonly exact:
    | { readonly state: 'absent' }
    | {
        readonly state: 'version';
        readonly termId: string;
        readonly version: number;
        readonly note: string | null;
      };
}

/** One income entry: a materialized occurrence, or a row nothing scheduled. */
export interface MonthlyIncomeEntryDto {
  readonly entryId: string;
  readonly version: number;
  readonly kind: string;
  readonly settlement: string;
  /** The financial date (6.2). Never after today. */
  readonly receivedOn: string;
  /** `YYYY-MM` of `receivedOn`: the month that owns this row's editing. */
  readonly receivedMonth: string;
  readonly net: MoneyDto;
  readonly gross: MoneyDto | null;
  readonly currency: string;
  /** `null` is tracked cash awaiting attribution, never external (8.1). */
  readonly cashPositionId: string | null;
  readonly cashAccountName: string | null;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly isOneOff: boolean;
  /** The scheduled occurrence this row materializes, when it materializes one. */
  readonly occurrence: {
    readonly templateId: string;
    readonly templateName: string;
    readonly occurrenceDate: string;
    /** `YYYY-MM` of `occurrenceDate`: the month whose schedule expects it. */
    readonly occurrenceMonth: string;
  } | null;
}

/**
 * What has become of one scheduled occurrence.
 *
 * The same four states the accept/skip service names, so the page and the
 * engine cannot disagree about what an occurrence is. A completed month's
 * unresolved occurrence is `due` — the presentation says "not recorded", and it
 * is the same occurrence `suggested_income_missing` reports.
 */
export type IncomeOccurrenceStateDto =
  | { readonly kind: 'due' }
  | {
      readonly kind: 'upcoming';
      /**
       * This is the one occurrence "received today" may reach (§30.10). Server
       * evidence, not a browser derivation: deciding it needs every resolved
       * occurrence after today and the source's whole schedule beyond the month.
       * The server checks it again under the template's lock regardless.
       */
      readonly receivedTodayEligible: boolean;
    }
  | { readonly kind: 'accepted'; readonly entry: MonthlyIncomeEntryDto }
  | {
      readonly kind: 'skipped';
      readonly skipId: string;
      readonly reason: string;
      readonly note: string | null;
    };

/** One occurrence the schedule placed in the displayed month. */
export interface IncomeOccurrenceDto {
  readonly templateId: string;
  readonly templateName: string;
  readonly counterparty: string | null;
  readonly incomeKind: string;
  readonly currency: string;
  /** The scheduling identity (6.2). Never a financial date, never editable. */
  readonly occurrenceDate: string;
  readonly term: OccurrenceTermDto;
  /** The source's default cash account; acceptance may choose another. */
  readonly defaultCashPositionId: string | null;
  readonly defaultCashAccountName: string | null;
  /**
   * Present-tense visibility (§30.10). It rewrites no history, and the services
   * refuse a new acceptance or skip while it is set — so the page offers
   * neither, rather than offering a control the server will refuse.
   */
  readonly sourceArchived: boolean;
  readonly state: IncomeOccurrenceStateDto;
}

/**
 * The one occurrence of a source that "received today" may reach, when it lies
 * outside the displayed month (§30.10).
 *
 * There is no horizon: an annual source whose genuine next payment is eight
 * months away is here when it is the next thing unresolved.
 */
export interface EarlyReceiptCandidateDto {
  readonly templateId: string;
  readonly templateName: string;
  readonly incomeKind: string;
  readonly currency: string;
  /** Strictly after today, in whatever later month the schedule puts it. */
  readonly occurrenceDate: string;
  readonly occurrenceMonth: string;
  readonly term: OccurrenceTermDto;
  readonly defaultCashPositionId: string | null;
  readonly defaultCashAccountName: string | null;
}

/**
 * The month's income, partitioned so no entry is ever rendered twice.
 *
 * The three groups answer two different questions and the partition is a set
 * difference, not a convention: `occurrences` is schedule membership
 * (`occurrence_date ∈ M`) and embeds the entry that resolved each one;
 * `otherRecurring` and `direct` are financial membership (`received_on ∈ M`)
 * minus every entry already embedded above. A salary scheduled for 1 October
 * and received on 30 September is therefore an accepted occurrence on October's
 * page and an `otherRecurring` row on September's — one row, two questions,
 * counted once in each.
 */
export interface MonthlyIncomeDto {
  /** Every occurrence the schedule placed in M, by date then template. */
  readonly occurrences: readonly IncomeOccurrenceDto[];
  /** Recurring income received in M whose occurrence is not one of the above. */
  readonly otherRecurring: readonly MonthlyIncomeEntryDto[];
  /** Income received in M that no source scheduled. */
  readonly direct: readonly MonthlyIncomeEntryDto[];
  /**
   * Cash accounts an income row may attach to, from the rows the page already
   * loaded. The services remain authoritative for ownership, currency and the
   * participation window.
   */
  readonly cashAccounts: readonly {
    readonly positionId: string;
    readonly name: string;
    readonly currency: string;
  }[];
}

/** The current month's income, with the operational surface a live month has. */
export interface CurrentMonthlyIncomeDto extends MonthlyIncomeDto {
  /** At most one per active source, and only when it lies outside the month. */
  readonly earlyReceiptCandidates: readonly EarlyReceiptCandidateDto[];
}

/* -------------------------------------------------------------------------- */
/* Known expenses (15.3 section 3)                                             */
/* -------------------------------------------------------------------------- */

/**
 * How Known expenses may use a category (blueprint 7.4, 15.3 section 3).
 *
 * The generic expense service accepts more kinds than this section offers, and
 * that is deliberate: several system kinds are ordinary tracked expenses whose
 * recording workflow belongs to an aggregate a later phase builds. So the use
 * says which of three things a category is here:
 *
 *  - `spending` — a consumption kind: offered, with every Phase 3 payment method;
 *  - `money_out` — `external_outflow`: offered apart from spending, because it
 *    is not consumption, and only as paid from a tracked account;
 *  - `other` — a kind whose workflow another aggregate owns (investment fees,
 *    property costs, transfer fees, capital improvements): shown as recorded,
 *    never offered for a new classification.
 */
export type ExpenseCategoryUseDto = 'spending' | 'money_out' | 'other';

export interface ExpenseCategoryDto {
  readonly categoryId: string;
  /** The user's own name for it. The kind, never the name, decides its accounting (7.4). */
  readonly name: string;
  readonly kind: string;
  readonly use: ExpenseCategoryUseDto;
  /** Archived categories keep every expense filed under them and take no new ones (R12). */
  readonly archived: boolean;
  /** Offered for a new classification: live, and `spending` or `money_out`. */
  readonly selectable: boolean;
}

/**
 * Why Known expenses shows a row without offering to change it.
 *
 *  - `transfer_fee` — the row is a transfer's fee. The transfer owns it (M14),
 *    and the services refuse to edit or delete it on its own.
 *  - `other_workflow` — a row nothing scheduled, filed under a kind this
 *    section does not offer (or paid in a way it does not offer). Its recording
 *    belongs to another aggregate, so a generic picker here must not quietly
 *    reclassify it.
 */
export type ExpenseReadOnlyReasonDto = 'transfer_fee' | 'other_workflow';

/** One expense entry: a materialized occurrence, or a row nothing scheduled. */
export interface MonthlyExpenseEntryDto {
  readonly entryId: string;
  readonly version: number;
  readonly category: ExpenseCategoryDto;
  /** How it was paid (6.2, 7.4). */
  readonly settlement: string;
  /** The financial date (6.2). Never after today. */
  readonly incurredOn: string;
  /** `YYYY-MM` of `incurredOn`: the month that owns this row's editing. */
  readonly incurredMonth: string;
  readonly amount: MoneyDto;
  readonly currency: string;
  /** `null` with `tracked_cash` is tracked cash awaiting attribution, never untracked (8.1). */
  readonly cashPositionId: string | null;
  readonly cashAccountName: string | null;
  readonly description: string | null;
  readonly isOneOff: boolean;
  /** `null` when the displayed owner month may correct it. */
  readonly readOnly: ExpenseReadOnlyReasonDto | null;
  /** The scheduled occurrence this row materializes, when it materializes one. */
  readonly occurrence: {
    readonly templateId: string;
    readonly templateName: string;
    readonly occurrenceDate: string;
    /** `YYYY-MM` of `occurrenceDate`: the month whose schedule expects it. */
    readonly occurrenceMonth: string;
  } | null;
}

/**
 * A recurring expense source, as far as Known expenses shows it and ends it.
 *
 * `end_date` is the one field of a source this section edits, and only because
 * a source that cannot be stopped leaves every later month expecting it:
 * `archived_at` is present-tense visibility and never a schedule boundary
 * (§30.10).
 */
export interface ExpenseSourceDto {
  readonly templateId: string;
  /** The template's optimistic version, which an end-date change must claim (20.3). */
  readonly version: number;
  readonly name: string;
  readonly counterparty: string | null;
  readonly currency: string;
  readonly category: ExpenseCategoryDto;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly archived: boolean;
  readonly defaultCashPositionId: string | null;
  readonly defaultCashAccountName: string | null;
  /**
   * Every date this schedule places in a completed month, generated as though it
   * never ended — what a proposed end date is measured against.
   *
   * From the same recurrence function the services use (6.2), so a page
   * summarizing an end-date change compares dates against these and never
   * generates a schedule of its own. Bounded by the source's start and by the end
   * of the last completed month; the server still decides whether a change is
   * allowed.
   */
  readonly completedOccurrenceDates: readonly string[];
}

/**
 * What the schedule says an expense occurrence costs (6.2, §30.9 item 4).
 *
 * The same two questions as income's term, without a gross figure, which
 * `expense_entries` has no column for.
 */
export interface ExpenseTermDto {
  /**
   * The applicable term's amount, or `null` when no term covers the date yet.
   * Zero is a real amount here: a term may be zero while an expense may not.
   */
  readonly amount: MoneyDto | null;
  /** The applicable term's own effective date — never the financial date. */
  readonly effectiveFrom: string | null;
  /** Whether a term starts **exactly** at this occurrence's date (see `OccurrenceTermDto`). */
  readonly exact:
    | { readonly state: 'absent' }
    | {
        readonly state: 'version';
        readonly termId: string;
        readonly version: number;
        readonly note: string | null;
      };
}

/** What has become of one scheduled expense occurrence, in the accept/skip service's four states. */
export type ExpenseOccurrenceStateDto =
  | { readonly kind: 'due' }
  | {
      readonly kind: 'upcoming';
      /**
       * This is the one occurrence "Paid today" may reach (§30.10). Server
       * evidence, checked again under the template's lock when it is used.
       */
      readonly paidTodayEligible: boolean;
    }
  | { readonly kind: 'accepted'; readonly entry: MonthlyExpenseEntryDto }
  | {
      readonly kind: 'skipped';
      readonly skipId: string;
      readonly reason: string;
      readonly note: string | null;
    };

/** One expense occurrence the schedule placed in the displayed month. */
export interface ExpenseOccurrenceDto {
  readonly templateId: string;
  /** The scheduling identity (6.2). Never a financial date, never editable. */
  readonly occurrenceDate: string;
  readonly source: ExpenseSourceDto;
  readonly term: ExpenseTermDto;
  /**
   * One-click recording can succeed as far as the amount goes: a term covers the
   * date and it is more than zero. An expense is strictly positive while a term
   * may be zero (6.2), so a zero or missing term is known in advance to need the
   * amount stated — or a skip, when nothing was charged.
   */
  readonly recordableAsExpected: boolean;
  readonly state: ExpenseOccurrenceStateDto;
}

/**
 * The one occurrence of a source that "Paid today" may reach, when it lies
 * outside the displayed month (§30.10). There is no horizon.
 */
export interface PaidTodayCandidateDto {
  readonly templateId: string;
  /** Strictly after today, in whatever later month the schedule puts it. */
  readonly occurrenceDate: string;
  readonly occurrenceMonth: string;
  readonly source: ExpenseSourceDto;
  readonly term: ExpenseTermDto;
  readonly recordableAsExpected: boolean;
}

/**
 * The month's known expenses, partitioned so no entry is ever rendered twice.
 *
 * The same set difference as income: `occurrences` is schedule membership
 * (`occurrence_date ∈ M`) and embeds the entry that resolved each one;
 * `otherRecurring` and `direct` are financial membership (`incurred_on ∈ M`)
 * minus every entry already embedded above.
 *
 * It is every expense the month knows about — paid from a tracked account, paid
 * by the user outside tracked accounts, and paid by somebody else — so it is not
 * `ΣK` and carries no total. Reconciliation owns the known tracked figure.
 * Capital improvements are not here: they are capital allocation (`Nout`), and
 * they stay in every financial figure the page shows.
 */
export interface MonthlyExpensesDto {
  /** Every expense occurrence the schedule placed in M, by date then template. */
  readonly occurrences: readonly ExpenseOccurrenceDto[];
  /** Recurring expenses incurred in M whose occurrence is not one of the above. */
  readonly otherRecurring: readonly MonthlyExpenseEntryDto[];
  /** Expenses incurred in M that no source scheduled. */
  readonly direct: readonly MonthlyExpenseEntryDto[];
  /**
   * What a category picker on this section offers: the live `spending` and
   * `money_out` categories, in the user's order. Derived once here, never
   * reassembled from kinds in the browser.
   */
  readonly eligibleCategories: readonly ExpenseCategoryDto[];
  /**
   * Cash accounts an expense may attach to, from the rows the page already
   * loaded, with the window a flow's date must fall in (8.1). The services
   * remain authoritative for ownership, currency and participation.
   */
  readonly cashAccounts: readonly {
    readonly positionId: string;
    readonly name: string;
    readonly currency: string;
    readonly openedOn: string | null;
    readonly closedOn: string | null;
  }[];
}

/** The current month's known expenses, with the operational surface a live month has. */
export interface CurrentMonthlyExpensesDto extends MonthlyExpensesDto {
  /** At most one per active source, and only when it lies outside the month. */
  readonly paidTodayCandidates: readonly PaidTodayCandidateDto[];
}

/* -------------------------------------------------------------------------- */
/* Accounts (15.3 section 4)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * An account's opening for the month — its Previous cell (8.1, 8.6).
 *
 * One shape for both kinds of month, each decided by its own authority: Phase
 * 2's `cashMonthState` for a completed month, the month-to-date engine's
 * opening for the current one. Every variant is one of those states; none is a
 * state of its own, and unknown evidence has no amount at all.
 */
export type AccountOpeningDto =
  /** The statement balance at the end of the previous month. */
  | { readonly kind: 'statement'; readonly amount: MoneyDto; readonly valuedOn: string }
  /**
   * Zero by definition rather than by evidence: the account opened in the
   * month, is dormant, or closed (R22, 8.1).
   */
  | { readonly kind: 'opened_zero' }
  | { readonly kind: 'dormant_zero' }
  | { readonly kind: 'closed_zero' }
  /**
   * A pre-existing account first tracked in the month. Excluded from the
   * month's arithmetic — never an opening of zero (8.1, 8.6).
   */
  | { readonly kind: 'first_balance' }
  /** No statement at the end of the previous month: unknown, never zero. */
  | { readonly kind: 'no_statement'; readonly state: 'carried' | 'missing' };

/**
 * A completed month's Current cell: the balance at `end(M)` (15.3 section 4).
 *
 * The variant follows the month's closing state (8.1) and carries what an edit
 * of it needs. It says what to offer; every action checks again on the server.
 */
export type CompletedClosingDto =
  /** A statement balance exists: corrected in place, against its version. */
  | {
      readonly kind: 'statement';
      readonly valuationId: string;
      readonly version: number;
      readonly amount: MoneyDto;
      /** Written by "Unchanged this month" rather than typed. */
      readonly confirmedUnchanged: boolean;
    }
  /**
   * An ordinary snapshot dated the month's last day (8.8). Not a statement
   * until it is confirmed as one; typing the statement figure instead corrects
   * this row, because a second valuation on the same date cannot exist (M1).
   */
  | {
      readonly kind: 'last_day_snapshot';
      readonly valuationId: string;
      readonly version: number;
      readonly amount: MoneyDto;
    }
  /** No statement and nothing on the last day: one can be entered. */
  | {
      readonly kind: 'no_statement';
      readonly state: 'carried' | 'missing';
      /** The latest ordinary snapshot inside the month: a hint, never a statement. */
      readonly latestSnapshot: { readonly amount: MoneyDto; readonly valuedOn: string } | null;
      /** The previous month's statement exists to carry forward (8.1, R22). */
      readonly canConfirmUnchanged: boolean;
    }
  /** Zero by definition: closed inside the month, or dormant (R22). */
  | { readonly kind: 'closed_zero' }
  | { readonly kind: 'dormant_zero' };

/** One cash account taking part in a completed month (8.1). */
export interface CompletedAccountDto {
  readonly positionId: string;
  readonly name: string;
  readonly currency: string;
  readonly dormant: boolean;
  /** Exactly the month state the Accounts pages read, from the same helper (8.1). */
  readonly state: CashMonthStateDto;
  readonly opening: AccountOpeningDto;
  readonly closing: CompletedClosingDto;
}

export interface CompletedAccountsDto {
  /** `YYYY-MM` of the month whose statements are the openings. */
  readonly previousMonth: string;
  /** Every cash account taking part in the month, in the user's order. */
  readonly accounts: readonly CompletedAccountDto[];
}

/** An account's latest balance on record, valued at today as Phase 2 values it (12.1). */
export interface LatestBalanceDto {
  readonly state: ValueStateDto;
  /** `null` exactly when nothing is recorded: unknown, never zero. */
  readonly amount: MoneyDto | null;
  /** The balance's own date — never implied to be today's. */
  readonly valuedOn: string | null;
  /** It is a statement month-end balance rather than a snapshot. */
  readonly statement: boolean;
}

/** One cash account taking part in the current month (8.1). */
export interface CurrentAccountDto {
  readonly positionId: string;
  readonly name: string;
  readonly currency: string;
  readonly status: PositionStatusDto;
  readonly dormant: boolean;
  /** 8.6's opening, by the month-to-date engine's own rule. */
  readonly opening: AccountOpeningDto;
  readonly latest: LatestBalanceDto;
  /** Today's snapshot, which "Update today" corrects rather than duplicates (M1). */
  readonly todaySnapshot: {
    readonly valuationId: string;
    readonly version: number;
    readonly amount: MoneyDto;
  } | null;
  /** Active and not dormant: what "Update today" may write (15.3, R22). */
  readonly canUpdateToday: boolean;
}

export interface CurrentAccountsDto {
  /** `YYYY-MM` of the month whose statements are the openings. */
  readonly previousMonth: string;
  /**
   * The first day this month's statement balances can be entered: the day
   * after it ends. Never earlier, not even on its last day (M5, R15).
   */
  readonly closableFrom: string;
  /** Every cash account taking part in the month, in the user's order. */
  readonly accounts: readonly CurrentAccountDto[];
}

/** A completed month (`today > end(M)`). */
export interface CompletedMonthlyPageDto extends MonthlyPageBase {
  readonly kind: 'completed';
  /** Exactly `getMonthReconciliation`'s answer, advisories included. */
  readonly reconciliation: MonthReconciliationDto;
  /** Exactly `getMonthReportingCashFlow`'s answer. */
  readonly reporting: MonthReportingCashFlowDto;
  /** Exactly `getMonthCompleteness`'s answer. */
  readonly completeness: MonthCompletenessDto;
  /** The month's cash accounts, from the rows the reconciliation read. */
  readonly accounts: CompletedAccountsDto;
  /** The month's income: its schedule, and the money that arrived in it. */
  readonly income: MonthlyIncomeDto;
  /** The month's known expenses: its expense schedule, and what was spent in it. */
  readonly expenses: MonthlyExpensesDto;
}

/**
 * The month containing today. It has no completeness (12.6 is defined for
 * completed months only) and it cannot be marked reviewed.
 */
export interface CurrentMonthlyPageDto extends MonthlyPageBase {
  readonly kind: 'current';
  /** Exactly `getMonthToDate`'s answer. */
  readonly monthToDate: MonthToDateDto;
  /** Exactly `getMonthToDateReportingCashFlow`'s answer. */
  readonly reporting: MonthToDateReportingCashFlowDto;
  /** The month's cash accounts, from the rows the month-to-date read loaded. */
  readonly accounts: CurrentAccountsDto;
  /** The month's income so far, and the schedule it is being measured against. */
  readonly income: CurrentMonthlyIncomeDto;
  /**
   * The month's known expenses through today — not through the month-to-date
   * date, which bounds reconciliation figures and not which records exist.
   */
  readonly expenses: CurrentMonthlyExpensesDto;
}

export type MonthlyPageDto = CompletedMonthlyPageDto | CurrentMonthlyPageDto;
