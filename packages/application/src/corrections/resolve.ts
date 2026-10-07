import type { Transaction } from '@vaultide/db';
import {
  applyBulkHistoryPlanIn,
  resolveBulkHistoryIn,
  type BulkHistoryWritePlan,
} from '../bulk-history/plan';
import type { RequestContext } from '../context';
import {
  applyExpensePlanIn,
  resolveExpenseCreateIn,
  resolveExpenseDeleteIn,
  resolveExpenseUpdateIn,
  type ExpenseWritePlan,
} from '../flows/expenses';
import {
  applyIncomePlanIn,
  resolveIncomeCreateIn,
  resolveIncomeDeleteIn,
  resolveIncomeUpdateIn,
  type IncomeWritePlan,
} from '../flows/income';
import {
  applyTransferPlanIn,
  resolveCreateTransferIn,
  resolveDeleteTransferIn,
  resolveUpdateTransferIn,
  type TransferWritePlan,
} from '../flows/transfers';
import {
  applyCashAccountPlanIn,
  resolveUpdateCashAccountIn,
  type CashAccountWritePlan,
} from '../positions/service';
import {
  applyConfirmUnchangedPlanIn,
  applyQuickUpdatePlanIn,
  applyValuationPlanIn,
  resolveConfirmUnchangedBatchIn,
  resolveConfirmUnchangedIn,
  resolveCorrectValuationIn,
  resolveQuickUpdateIn,
  resolveRecordValuationIn,
  resolveRemoveValuationIn,
  type ConfirmUnchangedWritePlan,
  type QuickUpdateWritePlan,
  type ValuationWritePlan,
} from '../positions/valuations';
import {
  applyAcceptPlanIn,
  applyUnskipPlanIn,
  resolveAcceptSuggestionIn,
  resolveUnskipIn,
  type AcceptWritePlan,
  type UnskipWritePlan,
} from '../recurring/suggestions';
import type { ResolvedWrite, ResolveOptions, SupportWarm } from '../write-plan';
import type { CorrectionDraft } from './draft';

/**
 * One authoritative resolver for every correction family (§20 of the slice
 * prompt).
 *
 * It resolves **nothing itself**. Each arm calls the same `resolve…In` the
 * ordinary mutation calls, and applying calls the same `apply…In` the ordinary
 * mutation calls — so there is no shadow validator that can drift from what
 * actually happens when the row is written, and a rule added to a mutation is
 * a rule the preview gets for free.
 *
 * The only thing this module adds is the dispatch, and the `lock` mode:
 *
 * ```text
 * preview  -> lock: false   coherent reads, no row locks (READ ONLY)
 * confirm  -> lock: true    the target, the aggregate, the references
 * ```
 *
 * The business rules either side of that switch are identical. That is what
 * makes "Preview must not approve an operation Confirm rejects on unchanged
 * data" true by construction rather than by testing every pair.
 */

export type CorrectionPlan =
  | { readonly family: 'valuation'; readonly plan: ValuationWritePlan }
  | { readonly family: 'quick_update'; readonly plan: QuickUpdateWritePlan }
  | { readonly family: 'income'; readonly plan: IncomeWritePlan }
  | { readonly family: 'expense'; readonly plan: ExpenseWritePlan }
  | { readonly family: 'transfer'; readonly plan: TransferWritePlan }
  | { readonly family: 'accept'; readonly plan: AcceptWritePlan }
  /** Restoring a skipped occurrence, which deletes its skip (ADR 0013). */
  | { readonly family: 'skip'; readonly plan: UnskipWritePlan }
  /**
   * A month confirmed unchanged, for one account or several. Its own family
   * rather than a `valuation` creation: its figure is the server's to read,
   * its persisted source is `confirmed_unchanged`, and its eligibility rests on
   * the previous month's statement.
   */
  | { readonly family: 'confirm_unchanged'; readonly plan: ConfirmUnchangedWritePlan }
  | { readonly family: 'cash_account'; readonly plan: CashAccountWritePlan }
  /**
   * One save of the history grid: many cells of two families resolved as one
   * batch (ADR 0011). Its own family because it is reviewed whatever it
   * carries, and because it is applied as one act rather than cell by cell.
   */
  | { readonly family: 'bulk_history'; readonly plan: BulkHistoryWritePlan };

/** The resolved write every plan carries, whatever family it belongs to. */
export const writeOf = (resolved: CorrectionPlan): ResolvedWrite => resolved.plan;

export const supportOf = (resolved: CorrectionPlan): readonly SupportWarm[] =>
  resolved.plan.support;

export async function resolveCorrectionIn(
  tx: Transaction,
  ctx: RequestContext,
  draft: CorrectionDraft,
  options: ResolveOptions,
): Promise<CorrectionPlan> {
  switch (draft.kind) {
    case 'valuation_create':
      return {
        family: 'valuation',
        plan: await resolveRecordValuationIn(tx, ctx, {
          positionId: draft.positionId,
          valuedOn: draft.valuedOn,
          amount: draft.amount,
          datePrecision: draft.datePrecision,
          note: draft.note,
        }),
      };

    case 'valuation_update':
      return {
        family: 'valuation',
        plan: await resolveCorrectValuationIn(
          tx,
          ctx,
          {
            valuationId: draft.valuationId,
            expectedVersion: draft.expectedVersion,
            valuedOn: draft.valuedOn,
            amount: draft.amount,
            datePrecision: draft.datePrecision,
            note: draft.note,
          },
          options,
        ),
      };

    case 'valuation_delete':
      return {
        family: 'valuation',
        plan: await resolveRemoveValuationIn(
          tx,
          { valuationId: draft.valuationId, expectedVersion: draft.expectedVersion },
          options,
        ),
      };

    case 'quick_update':
      return {
        family: 'quick_update',
        plan: await resolveQuickUpdateIn(tx, ctx, { entries: draft.entries }),
      };

    case 'income_create':
      return {
        family: 'income',
        plan: await resolveIncomeCreateIn(tx, ctx, {
          kind: draft.incomeKind,
          receivedOn: draft.receivedOn,
          netAmount: draft.netAmount,
          grossAmount: draft.grossAmount,
          currency: draft.currency,
          settlement: draft.settlement,
          cashPositionId: draft.cashPositionId,
          description: draft.description,
          tags: draft.tags,
          isOneOff: draft.isOneOff,
        }),
      };

    case 'income_update':
      return {
        family: 'income',
        plan: await resolveIncomeUpdateIn(
          tx,
          ctx,
          {
            entryId: draft.entryId,
            expectedVersion: draft.expectedVersion,
            kind: draft.incomeKind,
            receivedOn: draft.receivedOn,
            netAmount: draft.netAmount,
            grossAmount: draft.grossAmount,
            settlement: draft.settlement,
            cashPositionId: draft.cashPositionId,
            description: draft.description,
            tags: draft.tags,
            isOneOff: draft.isOneOff,
          },
          options,
        ),
      };

    case 'income_delete':
      return {
        family: 'income',
        plan: await resolveIncomeDeleteIn(
          tx,
          { entryId: draft.entryId, expectedVersion: draft.expectedVersion },
          options,
        ),
      };

    case 'expense_create':
      return {
        family: 'expense',
        plan: await resolveExpenseCreateIn(
          tx,
          ctx,
          {
            categoryId: draft.categoryId,
            incurredOn: draft.incurredOn,
            amount: draft.amount,
            currency: draft.currency,
            settlement: draft.settlement,
            cashPositionId: draft.cashPositionId,
            description: draft.description,
            tags: draft.tags,
            isOneOff: draft.isOneOff,
          },
          options,
        ),
      };

    case 'expense_update':
      return {
        family: 'expense',
        plan: await resolveExpenseUpdateIn(
          tx,
          ctx,
          {
            entryId: draft.entryId,
            expectedVersion: draft.expectedVersion,
            categoryId: draft.categoryId,
            incurredOn: draft.incurredOn,
            amount: draft.amount,
            settlement: draft.settlement,
            cashPositionId: draft.cashPositionId,
            description: draft.description,
            tags: draft.tags,
            isOneOff: draft.isOneOff,
          },
          options,
        ),
      };

    case 'expense_delete':
      return {
        family: 'expense',
        plan: await resolveExpenseDeleteIn(
          tx,
          { entryId: draft.entryId, expectedVersion: draft.expectedVersion },
          options,
        ),
      };

    case 'transfer_create':
      return {
        family: 'transfer',
        plan: await resolveCreateTransferIn(
          tx,
          ctx,
          {
            occurredOn: draft.occurredOn,
            fromPositionId: draft.fromPositionId,
            toPositionId: draft.toPositionId,
            fromAmount: draft.fromAmount,
            toAmount: draft.toAmount,
            description: draft.description,
            tags: draft.tags,
            fee: draft.fee,
          },
          options,
        ),
      };

    case 'transfer_update':
      return {
        family: 'transfer',
        plan: await resolveUpdateTransferIn(
          tx,
          ctx,
          {
            transferId: draft.transferId,
            expectedVersion: draft.expectedVersion,
            occurredOn: draft.occurredOn,
            fromPositionId: draft.fromPositionId,
            toPositionId: draft.toPositionId,
            fromAmount: draft.fromAmount,
            toAmount: draft.toAmount,
            description: draft.description,
            tags: draft.tags,
            fee: draft.fee,
            expectedFee: draft.expectedFee,
          },
          options,
        ),
      };

    case 'transfer_delete':
      return {
        family: 'transfer',
        plan: await resolveDeleteTransferIn(
          tx,
          {
            transferId: draft.transferId,
            expectedVersion: draft.expectedVersion,
            expectedFees: draft.expectedFees,
          },
          options,
        ),
      };

    case 'skip_delete':
      return {
        family: 'skip',
        plan: await resolveUnskipIn(
          tx,
          { skipId: draft.skipId, expectedVersion: draft.expectedVersion },
          options,
        ),
      };

    case 'accept_suggestion':
      return {
        family: 'accept',
        plan: await resolveAcceptSuggestionIn(
          tx,
          ctx,
          {
            templateId: draft.templateId,
            occurrenceDate: draft.occurrenceDate,
            financialDate: draft.financialDate,
            receivedToday: draft.receivedToday,
            amount: draft.amount,
            grossAmount: draft.grossAmount,
            cashPositionId: draft.cashPositionId,
            description: draft.description,
          },
          options,
        ),
      };

    case 'confirm_unchanged':
      return {
        family: 'confirm_unchanged',
        plan: await resolveConfirmUnchangedIn(
          tx,
          ctx,
          { positionId: draft.positionId, month: draft.month },
          options,
        ),
      };

    case 'confirm_unchanged_batch':
      return {
        family: 'confirm_unchanged',
        plan: await resolveConfirmUnchangedBatchIn(
          tx,
          ctx,
          { month: draft.month, positionIds: draft.positionIds },
          options,
        ),
      };

    case 'cash_account_update':
      return {
        family: 'cash_account',
        plan: await resolveUpdateCashAccountIn(
          tx,
          ctx,
          {
            positionId: draft.positionId,
            expectedVersion: draft.expectedVersion,
            name: draft.name,
            accountType: draft.accountType,
            institution: draft.institution,
            notes: draft.notes,
            isDormant: draft.isDormant,
          },
          options,
        ),
      };

    case 'bulk_history':
      return { family: 'bulk_history', plan: await resolveBulkHistoryIn(tx, ctx, draft, options) };
  }
}

/**
 * Apply what was resolved, through the families' own apply functions.
 *
 * Reached only after the consent fingerprint has matched, and never from a
 * caller that skipped it: the ordinary entry points are the guarded ones, and
 * this one is not exported beyond the correction service.
 */
export async function applyCorrectionIn(
  tx: Transaction,
  ctx: RequestContext,
  resolved: CorrectionPlan,
  reason?: string,
): Promise<void> {
  switch (resolved.family) {
    case 'valuation':
      await applyValuationPlanIn(tx, ctx, resolved.plan, reason);
      return;
    case 'quick_update':
      await applyQuickUpdatePlanIn(tx, ctx, resolved.plan, reason);
      return;
    case 'income':
      await applyIncomePlanIn(tx, ctx, resolved.plan, reason);
      return;
    case 'expense':
      await applyExpensePlanIn(tx, ctx, resolved.plan, reason);
      return;
    case 'transfer':
      await applyTransferPlanIn(tx, ctx, resolved.plan, reason);
      return;
    case 'accept':
      await applyAcceptPlanIn(tx, ctx, resolved.plan, reason);
      return;
    case 'skip':
      await applyUnskipPlanIn(tx, ctx, resolved.plan, reason);
      return;
    case 'confirm_unchanged':
      await applyConfirmUnchangedPlanIn(tx, ctx, resolved.plan, reason);
      return;
    case 'cash_account':
      await applyCashAccountPlanIn(tx, ctx, resolved.plan, reason);
      return;
    case 'bulk_history':
      await applyBulkHistoryPlanIn(tx, ctx, resolved.plan, reason);
      return;
  }
}
