import type { IncomeKind, IncomeSettlement, ExpenseSettlement } from '@vaultide/validation';
import type { TransferFeeArgs, TransferFeeExpectation, LinkedFeeExpectation } from '../flows/transfers';

/**
 * A `CorrectionDraft` is **user intent**, never trusted fact (§17 of the slice
 * prompt).
 *
 * It carries three things and nothing else: which record the user is editing,
 * the version they were looking at, and the values they want it to have. Every
 * other fact a correction rests on — the before-image, the affected months, the
 * issues, the spans, the statuses, the completeness, the dormancy consequence
 * and the user id — is derived on the server from rows it reads for itself.
 *
 * There is deliberately no `historical`, `confirmed` or `bypassReview` field.
 * Whether an operation is a Historical Correction is a conclusion the server
 * reaches from the resolved facts, not a claim the browser can make.
 *
 * ## Which operations are here, and which are not
 *
 * The four source families that can be **revised** — a valuation, an income
 * entry, an expense entry and a transfer aggregate — each have an update and a
 * delete arm, because those are the operations 30.22 item 1 defines as
 * corrections. A skip is a fifth source fact, and the product revises one in
 * only one way: restoring its occurrence deletes it (ADR 0013 §1).
 *
 * Beside them are the otherwise-ordinary operations whose **dormancy
 * consequence** can reach completed history and which therefore need a preview
 * when it does: recording a balance, a quick update, creating a flow, accepting
 * a recurring occurrence, confirming a month unchanged — for one account or for
 * several — and editing a cash account's dormant flag. They are here because
 * the review has to be able to show and then apply them — not for symmetry.
 * Operations that cannot rewrite history are not in this union.
 *
 * A Bulk History save is here for a third reason: it has no other write path at
 * all. Every grid save is reviewed whatever mix of creates, updates and clears
 * it carries (15.3, 30.22 item 2; ADR 0011 D7), so this union is the only way
 * one reaches the database.
 */

export interface ValuationUpdateDraft {
  readonly kind: 'valuation_update';
  readonly valuationId: string;
  readonly expectedVersion: number;
  readonly valuedOn: string;
  readonly amount: string;
  readonly datePrecision: 'exact' | 'month_end';
  readonly note?: string | null | undefined;
}

export interface ValuationDeleteDraft {
  readonly kind: 'valuation_delete';
  readonly valuationId: string;
  readonly expectedVersion: number;
}

export interface ValuationCreateDraft {
  readonly kind: 'valuation_create';
  readonly positionId: string;
  readonly valuedOn: string;
  readonly amount: string;
  readonly datePrecision: 'exact' | 'month_end';
  readonly note?: string | undefined;
}

export interface QuickUpdateDraft {
  readonly kind: 'quick_update';
  readonly entries: readonly {
    readonly positionId: string;
    readonly amount: string;
    readonly expectedVersion?: number | undefined;
  }[];
}

export interface IncomeCreateDraft {
  readonly kind: 'income_create';
  readonly incomeKind: IncomeKind;
  readonly receivedOn: string;
  readonly netAmount: string;
  readonly grossAmount?: string | undefined;
  readonly currency: string;
  readonly settlement: IncomeSettlement;
  readonly cashPositionId?: string | null | undefined;
  readonly description?: string | undefined;
  readonly tags?: string[] | undefined;
  readonly isOneOff?: boolean | undefined;
}

export interface IncomeUpdateDraft {
  readonly kind: 'income_update';
  readonly entryId: string;
  readonly expectedVersion: number;
  readonly incomeKind?: IncomeKind | undefined;
  readonly receivedOn?: string | undefined;
  readonly netAmount?: string | undefined;
  readonly grossAmount?: string | null | undefined;
  readonly settlement?: IncomeSettlement | undefined;
  readonly cashPositionId?: string | null | undefined;
  readonly description?: string | null | undefined;
  readonly tags?: string[] | undefined;
  readonly isOneOff?: boolean | undefined;
}

export interface IncomeDeleteDraft {
  readonly kind: 'income_delete';
  readonly entryId: string;
  readonly expectedVersion: number;
}

export interface ExpenseCreateDraft {
  readonly kind: 'expense_create';
  readonly categoryId: string;
  readonly incurredOn: string;
  readonly amount: string;
  readonly currency: string;
  readonly settlement: ExpenseSettlement;
  readonly cashPositionId?: string | null | undefined;
  readonly description?: string | undefined;
  readonly tags?: string[] | undefined;
  readonly isOneOff?: boolean | undefined;
}

export interface ExpenseUpdateDraft {
  readonly kind: 'expense_update';
  readonly entryId: string;
  readonly expectedVersion: number;
  readonly categoryId?: string | undefined;
  readonly incurredOn?: string | undefined;
  readonly amount?: string | undefined;
  readonly settlement?: ExpenseSettlement | undefined;
  readonly cashPositionId?: string | null | undefined;
  readonly description?: string | null | undefined;
  readonly tags?: string[] | undefined;
  readonly isOneOff?: boolean | undefined;
}

export interface ExpenseDeleteDraft {
  readonly kind: 'expense_delete';
  readonly entryId: string;
  readonly expectedVersion: number;
}

export interface TransferCreateDraft {
  readonly kind: 'transfer_create';
  readonly occurredOn: string;
  readonly fromPositionId: string;
  readonly toPositionId: string;
  readonly fromAmount: string;
  readonly toAmount: string;
  readonly description?: string | undefined;
  readonly tags?: string[] | undefined;
  readonly fee?: TransferFeeArgs | undefined;
}

export interface TransferUpdateDraft {
  readonly kind: 'transfer_update';
  readonly transferId: string;
  readonly expectedVersion: number;
  readonly occurredOn: string;
  readonly fromPositionId: string;
  readonly toPositionId: string;
  readonly fromAmount: string;
  readonly toAmount: string;
  readonly description: string | null;
  readonly tags?: string[] | undefined;
  readonly fee: TransferFeeArgs | null;
  readonly expectedFee: TransferFeeExpectation;
}

export interface TransferDeleteDraft {
  readonly kind: 'transfer_delete';
  readonly transferId: string;
  readonly expectedVersion: number;
  readonly expectedFees: readonly LinkedFeeExpectation[];
}

/**
 * Restoring a skipped occurrence: the skip and the version the page showed.
 *
 * The occurrence it excused, and so the month it changes, is the server's to
 * read from the skip itself.
 */
export interface SkipDeleteDraft {
  readonly kind: 'skip_delete';
  readonly skipId: string;
  readonly expectedVersion: number;
}

export interface AcceptSuggestionDraft {
  readonly kind: 'accept_suggestion';
  readonly templateId: string;
  readonly occurrenceDate: string;
  readonly financialDate?: string | undefined;
  readonly receivedToday?: boolean | undefined;
  readonly amount?: string | undefined;
  readonly grossAmount?: string | null | undefined;
  readonly cashPositionId?: string | null | undefined;
  readonly description?: string | undefined;
}

/**
 * "Confirm unchanged for this month", for one account.
 *
 * Intent only, like every draft: which account and which month. The figure is
 * the previous month's statement, which the server reads, and whether the
 * account is dormant is the server's to know — there is no amount, no balance,
 * no dormant state and no source here to forge.
 */
export interface ConfirmUnchangedDraft {
  readonly kind: 'confirm_unchanged';
  readonly positionId: string;
  /** `YYYY-MM`. */
  readonly month: string;
}

/** "Confirm all untouched as unchanged": the same intent, for several accounts at once. */
export interface ConfirmUnchangedBatchDraft {
  readonly kind: 'confirm_unchanged_batch';
  /** `YYYY-MM`. */
  readonly month: string;
  readonly positionIds: readonly string[];
}

export interface CashAccountUpdateDraft {
  readonly kind: 'cash_account_update';
  readonly positionId: string;
  readonly expectedVersion: number;
  readonly name?: string | undefined;
  readonly accountType?: 'checking' | 'savings' | 'cash' | 'other' | undefined;
  readonly institution?: string | null | undefined;
  readonly notes?: string | null | undefined;
  readonly isDormant?: boolean | undefined;
}

/**
 * One cell of the history grid, as the user changed it (15.3 "Bulk history";
 * ADR 0011).
 *
 * A balance cell is an account's month end; an income cell is one scheduled
 * occurrence, named by `(template_id, occurrence_date)` exactly as everywhere
 * else. An update or a clear names the stored row it is about and the version
 * the grid showed; the server proves that row **is** the named cell. Nothing
 * else about the row — its source, its precision, its gross, its account — is
 * the browser's to say.
 */
export type BulkHistoryOperation =
  | {
      readonly kind: 'valuation_create';
      readonly positionId: string;
      /** `YYYY-MM`; the balance is dated `end(month)`. */
      readonly month: string;
      readonly amount: string;
    }
  | {
      readonly kind: 'valuation_update';
      readonly positionId: string;
      readonly month: string;
      readonly valuationId: string;
      readonly expectedVersion: number;
      readonly amount: string;
    }
  | {
      readonly kind: 'valuation_clear';
      readonly positionId: string;
      readonly month: string;
      readonly valuationId: string;
      readonly expectedVersion: number;
    }
  | {
      readonly kind: 'income_create';
      readonly templateId: string;
      readonly occurrenceDate: string;
      readonly netAmount: string;
    }
  | {
      readonly kind: 'income_update';
      readonly templateId: string;
      readonly occurrenceDate: string;
      readonly entryId: string;
      readonly expectedVersion: number;
      readonly netAmount: string;
    }
  | {
      readonly kind: 'income_clear';
      readonly templateId: string;
      readonly occurrenceDate: string;
      readonly entryId: string;
      readonly expectedVersion: number;
    };

/**
 * One save of the history grid: every changed cell, as one act.
 *
 * Always reviewed, whatever mix it carries (15.3, 30.22 item 2): the thing to
 * see is the batch's aggregate effect, so there is no ordinary write for it.
 */
export interface BulkHistoryDraft {
  readonly kind: 'bulk_history';
  /** The grid's first row, `YYYY-MM`. */
  readonly startMonth: string;
  readonly operations: readonly BulkHistoryOperation[];
}

export type CorrectionDraft =
  | ValuationCreateDraft
  | ValuationUpdateDraft
  | ValuationDeleteDraft
  | QuickUpdateDraft
  | IncomeCreateDraft
  | IncomeUpdateDraft
  | IncomeDeleteDraft
  | ExpenseCreateDraft
  | ExpenseUpdateDraft
  | ExpenseDeleteDraft
  | TransferCreateDraft
  | TransferUpdateDraft
  | TransferDeleteDraft
  | SkipDeleteDraft
  | AcceptSuggestionDraft
  | ConfirmUnchangedDraft
  | ConfirmUnchangedBatchDraft
  | CashAccountUpdateDraft
  | BulkHistoryDraft;

export type CorrectionDraftKind = CorrectionDraft['kind'];
