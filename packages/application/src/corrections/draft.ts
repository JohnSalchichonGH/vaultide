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
 * corrections.
 *
 * Beside them are the otherwise-ordinary operations whose **dormancy
 * consequence** can reach completed history and which therefore need a preview
 * when it does: recording a balance, a quick update, creating a flow, accepting
 * a recurring occurrence, and editing a cash account's dormant flag. They are
 * here because the review has to be able to show and then apply them — not for
 * symmetry. Operations that cannot rewrite history are not in this union.
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
  | AcceptSuggestionDraft
  | CashAccountUpdateDraft;

export type CorrectionDraftKind = CorrectionDraft['kind'];
