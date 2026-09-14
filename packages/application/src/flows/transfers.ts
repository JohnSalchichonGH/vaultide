import {
  deleteExpenseEntryIn,
  deleteTransferIn,
  findTransfer,
  findTransferFeesIn,
  insertExpenseEntryIn,
  insertTransferIn,
  listCategoryRecords,
  lockTransferIn,
  updateExpenseEntryIn,
  updateTransferIn,
  withUser,
  type AuditContext,
  type CategoryRecord,
  type ExpenseEntryRow,
  type PositionRecord as PositionRow,
  type Transaction,
  type TransferRow,
} from '@vaultide/db';
import { Decimal } from '@vaultide/finance';
import type { RequestContext } from '../context';
import {
  ImpossibleOperationError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
} from '../errors';
import {
  assertAccountParticipates,
  assertNotFuture,
  auditContextOf,
  clearDormancyForFlowIn,
  requireCashAccount,
  type FlowDependencies,
} from './shared';

/**
 * Cash transfers and their fee (blueprint 6.2, 7.4, 7.5, 8.8, M13, M14; ADR
 * 0006).
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
 * M14: a fee is an `expense_entries` row of the `transfer_fee` category linked
 * by `transfer_id`. There is no fee column on the transfer, because two
 * representations of one fact is how a fee gets counted twice.
 *
 * The fee is nonetheless its own source fact, with its own financial date (ADR
 * 0006 §4, §5). Its `incurred_on` may fall on another day than the transfer's
 * `occurred_on` — in another month included — and nothing here derives one from
 * the other: moving a transfer never moves its fee.
 *
 * What the caller does **not** choose is what a fee means. It is tracked cash
 * paid by one of the transfer's two endpoints, in that account's currency, and
 * filed under the user's `transfer_fee` category, which this module looks up
 * rather than accepting an identifier for (ADR 0006 §6).
 *
 * ## A correction is the whole aggregate
 *
 * An edit states the complete transfer it should become — its date, both
 * endpoints, both amounts, its description, and its fee or the absence of one —
 * and commits all of it or none of it (ADR 0006 §2). Beside the transfer's own
 * version it carries what the caller saw of the fee, so a fee added, changed or
 * removed elsewhere is a conflict rather than something to overwrite (20.3).
 *
 * Every mutation locks the transfer's row before its fee rows. A fee is only
 * ever written by a caller holding that lock, so a fee that appears after
 * another writer read the aggregate cannot slip past it, and the two orders that
 * could deadlock never meet.
 *
 * ## Why deletion does not lean on the cascade
 *
 * `expense_entries.transfer_id` is `ON DELETE CASCADE`, which would remove a
 * fee without any application code running — and therefore without its audit
 * before-image. So the ordinary path deletes every fee explicitly first, each
 * with its own audit row, and the cascade finds nothing left to do. The
 * constraint stays because it is the right behaviour for account deletion,
 * where the audit rows are being removed in the same cascade anyway.
 */

/** A transfer's fee, as its facts are stated: the amount, who paid it, and when. */
export interface TransferFeeArgs {
  readonly amount: string;
  /** Which side paid it. Must be one of the transfer's own endpoints. */
  readonly cashPositionId: string;
  /** The fee's own financial date (ADR 0006 §5), never derived from the transfer's. */
  readonly incurredOn: string;
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

/**
 * What the caller saw of the fee when it began the edit (20.3).
 *
 * `absent` is "there was no fee"; `version` is "there was this exact row". A
 * correction is judged against it, never against a read the server takes for
 * itself, so two people editing the same transfer cannot both succeed with the
 * later save silently undoing the earlier one.
 */
export type TransferFeeExpectation =
  | { readonly state: 'absent' }
  | { readonly state: 'version'; readonly version: number };

export interface UpdateTransferArgs {
  readonly transferId: string;
  readonly expectedVersion: number;
  readonly occurredOn: string;
  readonly fromPositionId: string;
  readonly toPositionId: string;
  readonly fromAmount: string;
  readonly toAmount: string;
  /** `null` clears it. */
  readonly description: string | null;
  /** Absent keeps the stored tags; Monthly does not edit them. */
  readonly tags?: string[] | undefined;
  /** The fee the transfer should carry once this lands, or `null` for none. */
  readonly fee: TransferFeeArgs | null;
  readonly expectedFee: TransferFeeExpectation;
  readonly reason?: string | undefined;
}

/** The facts of a transfer aggregate, as a create or a correction states them. */
interface TransferFacts {
  readonly occurredOn: string;
  readonly fromPositionId: string;
  readonly toPositionId: string;
  readonly fromAmount: string;
  readonly toAmount: string;
  readonly fee: TransferFeeArgs | null;
}

/** Those facts with the accounts they name, once every rule has passed. */
interface ResolvedFacts {
  readonly from: PositionRow;
  readonly to: PositionRow;
  /** The fee with the endpoint that pays it, or `null` for none. */
  readonly fee: { readonly facts: TransferFeeArgs; readonly payer: PositionRow } | null;
}

/** A fee about to be written, with the category it is filed under. */
interface FeeToSave {
  readonly facts: TransferFeeArgs;
  readonly payer: PositionRow;
  readonly category: CategoryRecord;
}

/** Two amounts compared as the exact decimals they are, never as their spelling. */
const sameAmount = (a: string, b: string): boolean => new Decimal(a).equals(new Decimal(b));

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
 * A corrected endpoint keeps its leg's stored currency (20.1; ADR 0006 §3).
 *
 * The amount on each side is a native fact in that side's currency. Pointing a
 * dollar leg at a euro account would turn 100 USD into 100 EUR without anybody
 * saying so, so a leg's currency is corrected by recording the right transfer,
 * never by moving an endpoint.
 */
function assertLegCurrency(
  account: PositionRow,
  currency: string,
  field: 'fromPositionId' | 'toPositionId',
): void {
  if (account.currency === currency) return;
  throw new ValidationError(
    `This side of the transfer was recorded in ${currency}, and ${account.name} holds ${account.currency}. To change a transfer’s currency, delete it and record the right one.`,
    { [field]: [`Choose a ${currency} account.`] },
  );
}

/**
 * Everything a transfer aggregate must satisfy that is not already decided by
 * its stored rows (7.5, 8.1, M5, M13; ADR 0006 §3, §5, §6).
 *
 * Judged on the facts as they would be saved, never on what is stored, so a
 * correction that repairs an inconsistent transfer succeeds and one that keeps
 * the inconsistency fails. `legCurrencies` is the stored pair when correcting:
 * an endpoint may move, a currency may not.
 */
async function resolveFacts(
  deps: FlowDependencies,
  ctx: RequestContext,
  facts: TransferFacts,
  legCurrencies?: { readonly from: string; readonly to: string },
): Promise<ResolvedFacts> {
  assertNotFuture(ctx, facts.occurredOn, 'occurredOn');
  if (facts.fee !== null) assertNotFuture(ctx, facts.fee.incurredOn, 'fee.incurredOn');

  if (facts.fromPositionId === facts.toPositionId) {
    throw new ValidationError('A transfer needs two different accounts.', {
      toPositionId: ['Choose a different account.'],
    });
  }

  const from = await requireCashAccount(deps.db, ctx, facts.fromPositionId);
  const to = await requireCashAccount(deps.db, ctx, facts.toPositionId);
  if (legCurrencies !== undefined) {
    assertLegCurrency(from, legCurrencies.from, 'fromPositionId');
    assertLegCurrency(to, legCurrencies.to, 'toPositionId');
  }
  assertAccountParticipates(from, facts.occurredOn, 'occurredOn');
  assertAccountParticipates(to, facts.occurredOn, 'occurredOn');
  assertAmountsAgree(from.currency, to.currency, facts.fromAmount, facts.toAmount);

  if (facts.fee === null) return { from, to, fee: null };

  const payer =
    facts.fee.cashPositionId === from.id ? from : facts.fee.cashPositionId === to.id ? to : null;
  if (payer === null) {
    throw new ValidationError(
      'The fee has to come out of one of the two accounts this transfer touches.',
      { 'fee.cashPositionId': ['Choose the account that paid the fee.'] },
    );
  }
  // 8.1 on the fee's own date: the day it was charged, whichever day the
  // transfer moved on.
  assertAccountParticipates(payer, facts.fee.incurredOn, 'fee.incurredOn');
  return { from, to, fee: { facts: facts.fee, payer } };
}

/**
 * The user's transfer-fee category, looked up rather than trusted (7.4; ADR
 * 0006 §6).
 *
 * One category of each system kind per user is an application invariant —
 * provisioned at sign-up, never created a second time, never archivable (6.2) —
 * and not a database constraint. So it is checked rather than assumed: exactly
 * one `transfer_fee` category, and live. Anything else refuses the write,
 * because choosing among several, or filing under an archived one, would be
 * guessing what a fee means.
 */
function transferFeeCategoryOf(categories: readonly CategoryRecord[]): CategoryRecord {
  const candidates = categories.filter((row) => row.kind === 'transfer_fee');
  const only = candidates[0];
  if (candidates.length !== 1 || only === undefined || only.archivedAt !== null) {
    throw new ImpossibleOperationError(
      'Your transfer-fee category is missing or not unique, so this fee cannot be filed. Nothing was saved.',
    );
  }
  return only;
}

/**
 * The fee a correction works from: none, or one row that is a transfer fee
 * (M14; ADR 0006 §6).
 *
 * The database can hold more than one: 6.2 gives `expense_entries.transfer_id`
 * a plain index, and M14 assigns cardinality to "schema (no duplicate columns)
 * + service design" rather than to a constraint. No application path creates a
 * second fee, so two rows mean the data was changed from outside the product.
 * Picking `fees[0]` would update one fee and leave the other, and report the
 * transfer as though it had one; that turns a visible inconsistency into a
 * wrong number. Failing here is deterministic, names the transfer, and leaves
 * every row intact for whoever has to look.
 *
 * A single linked row that is not tracked cash under the `transfer_fee` kind is
 * refused the same way: it is not a fee this aggregate may rewrite into one, and
 * saving around it would keep a transfer that reads as having a fee.
 *
 * Deletion is deliberately **not** guarded like this: it removes *every* linked
 * row, each with its own audit before-image, so it leaves nothing dangling and
 * nothing unrecorded.
 */
function editableFeeOf(
  transferId: string,
  fees: readonly ExpenseEntryRow[],
  kindOf: ReadonlyMap<string, string>,
): ExpenseEntryRow | null {
  if (fees.length > 1) {
    throw new ImpossibleOperationError(
      `Transfer ${transferId} has ${String(fees.length)} linked fees, and a transfer may have at most one. It cannot be edited until that is corrected.`,
    );
  }
  const fee = fees[0];
  if (fee === undefined) return null;
  if (kindOf.get(fee.categoryId) !== 'transfer_fee' || fee.settlement !== 'tracked_cash') {
    throw new ImpossibleOperationError(
      'The record linked to this transfer is not a transfer fee paid from a tracked account, so the transfer cannot be edited. It can still be deleted.',
    );
  }
  return fee;
}

function assertFeeAsExpected(
  expected: TransferFeeExpectation,
  stored: ExpenseEntryRow | null,
): void {
  if (expected.state === 'absent') {
    if (stored === null) return;
    throw new VersionConflictError(
      'A fee was added to this transfer while you were editing it. Reload to see it.',
    );
  }
  if (stored !== null && stored.version === expected.version) return;
  throw new VersionConflictError(
    'This transfer’s fee changed while you were editing it. Reload to see the current values.',
  );
}

/** Whether a correction changes anything the transfer's own row holds. */
function transferChanged(stored: TransferRow, args: UpdateTransferArgs): boolean {
  return (
    stored.occurredOn !== args.occurredOn ||
    stored.fromPositionId !== args.fromPositionId ||
    stored.toPositionId !== args.toPositionId ||
    !sameAmount(stored.fromAmount, args.fromAmount) ||
    !sameAmount(stored.toAmount, args.toAmount) ||
    stored.description !== args.description ||
    (args.tags !== undefined &&
      (args.tags.length !== stored.tags.length ||
        args.tags.some((tag, index) => tag !== stored.tags[index])))
  );
}

/** The columns a fee's facts decide: its payer's currency, never one it was sent. */
function feeColumnsOf(fee: FeeToSave) {
  return {
    amount: fee.facts.amount,
    currency: fee.payer.currency,
    cashPositionId: fee.payer.id,
    incurredOn: fee.facts.incurredOn,
  };
}

async function insertFeeIn(
  tx: Transaction,
  audit: AuditContext,
  transferId: string,
  fee: FeeToSave,
): Promise<ExpenseEntryRow> {
  return insertExpenseEntryIn(tx, audit, {
    ...feeColumnsOf(fee),
    categoryId: fee.category.id,
    settlement: 'tracked_cash',
    transferId,
    description: null,
  });
}

/**
 * The fee half of a correction: insert, update or delete, and only what changed.
 *
 * A fee whose facts are unchanged is not written at all, so correcting the
 * transfer alone neither consumes the fee's version nor adds to its audit trail.
 */
async function saveFeeIn(
  tx: Transaction,
  audit: AuditContext,
  transferId: string,
  stored: ExpenseEntryRow | null,
  desired: FeeToSave | null,
): Promise<ExpenseEntryRow | null> {
  if (desired === null) {
    // Removed explicitly, with its before-image, never left to the cascade.
    if (stored !== null) await deleteExpenseEntryIn(tx, audit, stored.id);
    return null;
  }
  if (stored === null) return insertFeeIn(tx, audit, transferId, desired);

  const columns = feeColumnsOf(desired);
  if (
    sameAmount(stored.amount, columns.amount) &&
    stored.currency === columns.currency &&
    stored.cashPositionId === columns.cashPositionId &&
    stored.incurredOn === columns.incurredOn
  ) {
    return stored;
  }

  const updated = await updateExpenseEntryIn(tx, audit, stored.id, stored.version, columns);
  /* v8 ignore next 3 -- the row is held under FOR UPDATE at the version just checked. */
  if (updated === undefined) {
    throw new VersionConflictError('The fee changed while you were editing it.');
  }
  return updated;
}

/**
 * Warm exchange-rate history for the dates the saved aggregate carries (10.4).
 *
 * Neither leg needs a rate — both amounts are native facts — so this is for the
 * reporting that reads them later, and a publisher being down never undoes a
 * committed transfer: `ensureHistory` swallows its own failure. Each currency is
 * fetched from the earliest date the aggregate gives it, which is the fee's
 * date for its payer's currency when the fee was charged before the transfer.
 */
async function warmHistory(
  deps: FlowDependencies,
  occurredOn: string,
  resolved: ResolvedFacts,
): Promise<void> {
  const earliest = new Map<string, string>();
  const need = (currency: string, date: string): void => {
    const known = earliest.get(currency);
    if (known === undefined || date < known) earliest.set(currency, date);
  };
  need(resolved.from.currency, occurredOn);
  need(resolved.to.currency, occurredOn);
  if (resolved.fee !== null) need(resolved.fee.payer.currency, resolved.fee.facts.incurredOn);

  for (const [currency, date] of earliest) await deps.fx.ensureHistory(currency, date);
}

export async function createCashTransfer(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: CreateTransferArgs,
): Promise<TransferWithFee> {
  const resolved = await resolveFacts(deps, ctx, { ...args, fee: args.fee ?? null });
  const fee: FeeToSave | null =
    resolved.fee === null
      ? null
      : {
          ...resolved.fee,
          category: transferFeeCategoryOf(
            await listCategoryRecords(deps.db, ctx.userId, { includeArchived: true }),
          ),
        };

  const audit = auditContextOf(ctx);
  const created = await withUser(deps.db, { userId: ctx.userId }, async (tx) => {
    const transfer = await insertTransferIn(tx, audit, {
      kind: 'cash_transfer',
      occurredOn: args.occurredOn,
      fromPositionId: resolved.from.id,
      fromCurrency: resolved.from.currency,
      fromAmount: args.fromAmount,
      toPositionId: resolved.to.id,
      toCurrency: resolved.to.currency,
      toAmount: args.toAmount,
      description: args.description ?? null,
      tags: args.tags ?? [],
      // Phase 3 materializes no recurring transfer occurrence.
    });

    const feeRow = fee === null ? null : await insertFeeIn(tx, audit, transfer.id, fee);

    await clearDormancyForFlowIn(tx, ctx, [resolved.from.id, resolved.to.id]);
    return { transfer, fee: feeRow };
  });

  await warmHistory(deps, args.occurredOn, resolved);
  return created;
}

/**
 * Correct a cash transfer as one aggregate (ADR 0006 §2–§6, §8).
 *
 * In one transaction, in this order: lock the transfer and check its version;
 * lock its fee rows and refuse any the aggregate cannot edit; check the fee
 * against what the caller saw; write the transfer and the fee where their facts
 * changed; and clear dormancy on both final endpoints. Any refusal on the way
 * leaves every row exactly as it was.
 */
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

  const resolved = await resolveFacts(deps, ctx, args, {
    from: existing.fromCurrency,
    to: existing.toCurrency,
  });
  // Every category, archived included: the stored fee's kind is checked from
  // the same read that resolves the one a fee is filed under.
  const categories = await listCategoryRecords(deps.db, ctx.userId, { includeArchived: true });
  const kindOf = new Map(categories.map((row) => [row.id, row.kind]));
  const desiredFee: FeeToSave | null =
    resolved.fee === null ? null : { ...resolved.fee, category: transferFeeCategoryOf(categories) };

  const audit = auditContextOf(ctx, args.reason);
  const saved = await withUser(deps.db, { userId: ctx.userId }, async (tx) => {
    const locked = await lockTransferIn(tx, args.transferId);
    if (locked === undefined) throw new NotFoundError('That transfer no longer exists.');
    if (locked.version !== args.expectedVersion) {
      throw new VersionConflictError(
        'This transfer changed while you were editing it. Reload to see the current values.',
      );
    }

    const stored = editableFeeOf(
      args.transferId,
      await findTransferFeesIn(tx, args.transferId),
      kindOf,
    );
    assertFeeAsExpected(args.expectedFee, stored);

    let transfer: TransferRow = locked;
    if (transferChanged(locked, args)) {
      const updated = await updateTransferIn(tx, audit, args.transferId, args.expectedVersion, {
        occurredOn: args.occurredOn,
        fromPositionId: resolved.from.id,
        fromAmount: args.fromAmount,
        toPositionId: resolved.to.id,
        toAmount: args.toAmount,
        description: args.description,
        ...(args.tags === undefined ? {} : { tags: args.tags }),
      });
      /* v8 ignore next 5 -- the row is held under FOR UPDATE at the version just checked. */
      if (updated === undefined) {
        throw new VersionConflictError(
          'This transfer changed while you were editing it. Reload to see the current values.',
        );
      }
      transfer = updated;
    }

    const fee = await saveFeeIn(tx, audit, args.transferId, stored, desiredFee);

    // 8.8 on the endpoints the transfer now has. An account the correction
    // moved away from keeps whatever flag it has: nothing restores dormancy.
    await clearDormancyForFlowIn(tx, ctx, [resolved.from.id, resolved.to.id]);
    return { transfer, fee };
  });

  await warmHistory(deps, args.occurredOn, resolved);
  return saved;
}

/**
 * Delete a cash transfer and every fee linked to it, all audited (6.3, 18.1).
 *
 * The fees go first and explicitly. Leaving them to `ON DELETE CASCADE` would
 * remove a financial record with no before-image — the one thing the audit
 * trail exists to prevent. Every linked row goes, whatever month it is dated in
 * and however many there are: deletion is how an inconsistent aggregate is
 * cleared, so it is not refused for being one. Deleting a transfer restores no
 * account's dormancy (8.8).
 */
export async function deleteCashTransfer(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: { transferId: string; reason?: string | undefined },
): Promise<{ transfer: TransferRow; fees: ExpenseEntryRow[] }> {
  const audit = auditContextOf(ctx, args.reason);

  return withUser(deps.db, { userId: ctx.userId }, async (tx) => {
    const locked = await lockTransferIn(tx, args.transferId);
    if (locked === undefined) throw new NotFoundError('That transfer no longer exists.');
    if (locked.kind !== 'cash_transfer') {
      throw new ImpossibleOperationError('Only cash transfers can be deleted here.');
    }

    const fees = await findTransferFeesIn(tx, args.transferId);
    const removedFees: ExpenseEntryRow[] = [];
    for (const fee of fees) {
      const removed = await deleteExpenseEntryIn(tx, audit, fee.id);
      /* v8 ignore next -- the row is held under FOR UPDATE in this transaction. */
      if (removed !== undefined) removedFees.push(removed);
    }

    const transfer = await deleteTransferIn(tx, audit, args.transferId);
    /* v8 ignore next -- the row is held under FOR UPDATE in this transaction. */
    if (transfer === undefined) throw new NotFoundError('That transfer no longer exists.');

    return { transfer, fees: removedFees };
  });
}
