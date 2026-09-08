import {
  deleteExpenseEntryIn,
  deleteTransferIn,
  findTransfer,
  findTransferFeesIn,
  insertExpenseEntryIn,
  insertTransferIn,
  updateExpenseEntryIn,
  updateTransferIn,
  withUser,
  type ExpenseEntryRow,
  type TransferRow,
} from '@vaultide/db';
import type { RequestContext } from '../context';
import {
  ImpossibleOperationError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
} from '../errors';
import { requireCategory } from './expenses';
import {
  assertNotFuture,
  auditContextOf,
  clearDormancyForFlowIn,
  requireCashAccount,
  assertAccountParticipates,
  type FlowDependencies,
} from './shared';

/**
 * Cash transfers and their fee (blueprint 6.2, 7.5, 8.8, M13, M14).
 *
 * A transfer is value the user already owned, moving. It is never income and
 * never spending: `Nout` on the source, `Nin` on the destination, cancelling
 * exactly inside one currency bucket and reconciling independently across two.
 *
 * Phase 3 exposes `cash_transfer` only, and always writes `template_id` and
 * `occurrence_date` as NULL — the columns exist for the contribution workflow
 * Phase 4 owns.
 *
 * ## The fee is one row, and it is its own row
 *
 * M14: a fee is an `expense_entries` row of a `transfer_fee` category linked by
 * `transfer_id`. There is no fee column on the transfer, because two
 * representations of one fact is how a fee gets counted twice.
 *
 * Creation and deletion are one transaction over both rows. **Editing is not
 * symmetrical**: the fee is a source financial record, so a transfer edit never
 * silently rewrites the fee's account, currency, amount or date. An edit that
 * would leave the fee incompatible either carries the fee's new values in the
 * same mutation or is refused with an actionable error.
 *
 * ## Why deletion does not lean on the cascade
 *
 * `expense_entries.transfer_id` is `ON DELETE CASCADE`, which would remove the
 * fee without any application code running — and therefore without its audit
 * before-image. So the ordinary path deletes the fee explicitly first, with its
 * own audit row, and the cascade finds nothing left to do. The constraint stays
 * because it is the right behaviour for account deletion, where the audit rows
 * are being removed in the same cascade anyway.
 */

export interface TransferFeeArgs {
  readonly amount: string;
  readonly categoryId: string;
  /** Which side paid it. Must be one of the transfer's own endpoints. */
  readonly cashPositionId: string;
  readonly currency: string;
  readonly description?: string | undefined;
}

export interface CreateTransferArgs {
  readonly occurredOn: string;
  readonly fromPositionId: string;
  readonly toPositionId: string;
  readonly fromAmount: string;
  readonly toAmount: string;
  readonly description?: string | undefined;
  readonly tags?: string[] | undefined;
  readonly fee?: TransferFeeArgs | undefined;
}

export interface TransferWithFee {
  readonly transfer: TransferRow;
  readonly fee: ExpenseEntryRow | null;
}

/** M13: within one currency a transfer moves one amount, not two. */
function assertAmountsAgree(
  fromCurrency: string,
  toCurrency: string,
  fromAmount: string,
  toAmount: string,
): void {
  if (fromCurrency !== toCurrency) return;
  if (fromAmount === toAmount) return;
  throw new ValidationError(
    'A transfer within one currency moves the same amount out and in.',
    { toAmount: ['This must match the amount sent.'] },
  );
}

/**
 * The fee must be payable from one of the transfer's own endpoints, in that
 * account's currency, and filed under a `transfer_fee` category (7.4, M14).
 */
async function validateFee(
  deps: FlowDependencies,
  ctx: RequestContext,
  fee: TransferFeeArgs,
  endpoints: { fromPositionId: string; toPositionId: string },
  occurredOn: string,
): Promise<void> {
  if (fee.cashPositionId !== endpoints.fromPositionId && fee.cashPositionId !== endpoints.toPositionId) {
    throw new ValidationError(
      'The fee has to come out of one of the two accounts this transfer touches.',
      { fee: ['Choose the account that paid the fee.'] },
    );
  }

  const category = await requireCategory(deps.db, ctx, fee.categoryId);
  if (category.kind !== 'transfer_fee') {
    throw new ValidationError(
      'A transfer fee is filed under your transfer-fee category, so it lands in "Interest & fees" rather than in your spending.',
      { fee: ['Choose the transfer-fee category.'] },
    );
  }

  const account = await requireCashAccount(deps.db, ctx, fee.cashPositionId);
  if (account.currency !== fee.currency) {
    throw new ValidationError(
      `The fee is charged in ${account.currency} when it comes out of ${account.name}.`,
      { fee: [`Use ${account.currency}.`] },
    );
  }
  assertAccountParticipates(account, occurredOn, 'occurredOn');
}

export async function createCashTransfer(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: CreateTransferArgs,
): Promise<TransferWithFee> {
  assertNotFuture(ctx, args.occurredOn, 'occurredOn');

  if (args.fromPositionId === args.toPositionId) {
    throw new ValidationError('A transfer needs two different accounts.', {
      toPositionId: ['Choose a different account.'],
    });
  }

  const from = await requireCashAccount(deps.db, ctx, args.fromPositionId);
  const to = await requireCashAccount(deps.db, ctx, args.toPositionId);
  assertAccountParticipates(from, args.occurredOn, 'occurredOn');
  assertAccountParticipates(to, args.occurredOn, 'occurredOn');
  assertAmountsAgree(from.currency, to.currency, args.fromAmount, args.toAmount);

  if (args.fee !== undefined) {
    await validateFee(deps, ctx, args.fee, args, args.occurredOn);
  }

  const audit = auditContextOf(ctx);
  const created = await withUser(deps.db, { userId: ctx.userId }, async (tx) => {
    const transfer = await insertTransferIn(tx, audit, {
      kind: 'cash_transfer',
      occurredOn: args.occurredOn,
      fromPositionId: args.fromPositionId,
      fromCurrency: from.currency,
      fromAmount: args.fromAmount,
      toPositionId: args.toPositionId,
      toCurrency: to.currency,
      toAmount: args.toAmount,
      description: args.description ?? null,
      tags: args.tags ?? [],
      // Phase 3 materializes no recurring transfer occurrence.
    });

    const fee =
      args.fee === undefined
        ? null
        : await insertExpenseEntryIn(tx, audit, {
            categoryId: args.fee.categoryId,
            incurredOn: args.occurredOn,
            amount: args.fee.amount,
            currency: args.fee.currency,
            settlement: 'tracked_cash',
            cashPositionId: args.fee.cashPositionId,
            transferId: transfer.id,
            description: args.fee.description ?? null,
          });

    await clearDormancyForFlowIn(tx, ctx, [args.fromPositionId, args.toPositionId]);
    return { transfer, fee };
  });

  await deps.fx.ensureHistory(from.currency, args.occurredOn);
  if (to.currency !== from.currency) await deps.fx.ensureHistory(to.currency, args.occurredOn);
  return created;
}

export interface UpdateTransferArgs {
  readonly transferId: string;
  readonly expectedVersion: number;
  readonly occurredOn?: string | undefined;
  readonly fromAmount?: string | undefined;
  readonly toAmount?: string | undefined;
  readonly description?: string | null | undefined;
  readonly tags?: string[] | undefined;
  /**
   * The fee's new values, when the edit changes them. Absent means "leave the
   * fee exactly as it is" — and if the edit would make the untouched fee
   * incompatible, the whole mutation is refused rather than the fee silently
   * rewritten.
   */
  readonly fee?:
    | { expectedVersion: number; amount?: string | undefined; incurredOn?: string | undefined }
    | undefined;
  readonly reason?: string | undefined;
}

export async function updateCashTransfer(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: UpdateTransferArgs,
): Promise<TransferWithFee> {
  const existing = await findTransfer(deps.db, ctx.userId, args.transferId);
  if (existing === undefined) throw new NotFoundError('That transfer no longer exists.');
  if (existing.kind !== 'cash_transfer') {
    throw new ImpossibleOperationError('Only cash transfers can be edited here.');
  }

  const occurredOn = args.occurredOn ?? existing.occurredOn;
  assertNotFuture(ctx, occurredOn, 'occurredOn');

  const fromAmount = args.fromAmount ?? existing.fromAmount;
  const toAmount = args.toAmount ?? existing.toAmount;
  assertAmountsAgree(existing.fromCurrency, existing.toCurrency, fromAmount, toAmount);

  if (existing.fromPositionId !== null) {
    assertAccountParticipates(
      await requireCashAccount(deps.db, ctx, existing.fromPositionId),
      occurredOn,
      'occurredOn',
    );
  }
  if (existing.toPositionId !== null) {
    assertAccountParticipates(
      await requireCashAccount(deps.db, ctx, existing.toPositionId),
      occurredOn,
      'occurredOn',
    );
  }

  const audit = auditContextOf(ctx, args.reason);
  return withUser(deps.db, { userId: ctx.userId }, async (tx) => {
    const fees = await findTransferFeesIn(tx, args.transferId);

    // The fee's date follows the transfer's only when the caller says so. A
    // date change that would leave the fee on the old day is refused, because
    // rewriting a source financial record as a side effect of editing another
    // one is exactly what M14 keeps apart.
    const dateMoved = occurredOn !== existing.occurredOn;
    if (dateMoved && fees.length > 0 && args.fee === undefined) {
      throw new ValidationError(
        'This transfer has a fee dated with it. Move the fee to the new date in the same edit, or leave the date alone.',
        { occurredOn: ['The linked fee would be left on the old date.'] },
      );
    }

    const transfer = await updateTransferIn(tx, audit, args.transferId, args.expectedVersion, {
      occurredOn,
      fromAmount,
      toAmount,
      ...(args.description === undefined ? {} : { description: args.description }),
      ...(args.tags === undefined ? {} : { tags: args.tags }),
    });
    if (transfer === undefined) {
      throw new VersionConflictError('This transfer changed while you were editing it.');
    }

    let fee: ExpenseEntryRow | null = fees[0] ?? null;
    if (args.fee !== undefined) {
      const target = fees[0];
      if (target === undefined) {
        throw new ValidationError('This transfer has no fee to update.', {
          fee: ['There is no fee on this transfer.'],
        });
      }
      const updatedFee = await updateExpenseEntryIn(tx, audit, target.id, args.fee.expectedVersion, {
        ...(args.fee.amount === undefined ? {} : { amount: args.fee.amount }),
        incurredOn: args.fee.incurredOn ?? occurredOn,
      });
      if (updatedFee === undefined) {
        throw new VersionConflictError('The fee changed while you were editing it.');
      }
      fee = updatedFee;
    }

    return { transfer, fee };
  });
}

/**
 * Delete a transfer and its fee, both audited (6.3, 18.1).
 *
 * The fee goes first and explicitly. Leaving it to `ON DELETE CASCADE` would
 * remove a financial record with no before-image — the one thing the audit
 * trail exists to prevent.
 */
export async function deleteCashTransfer(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: { transferId: string; reason?: string | undefined },
): Promise<{ transfer: TransferRow; fees: ExpenseEntryRow[] }> {
  const audit = auditContextOf(ctx, args.reason);

  return withUser(deps.db, { userId: ctx.userId }, async (tx) => {
    const fees = await findTransferFeesIn(tx, args.transferId);

    const removedFees: ExpenseEntryRow[] = [];
    for (const fee of fees) {
      const removed = await deleteExpenseEntryIn(tx, audit, fee.id);
      /* v8 ignore next -- the row is held under FOR UPDATE in this transaction. */
      if (removed !== undefined) removedFees.push(removed);
    }

    const transfer = await deleteTransferIn(tx, audit, args.transferId);
    if (transfer === undefined) throw new NotFoundError('That transfer no longer exists.');

    return { transfer, fees: removedFees };
  });
}
