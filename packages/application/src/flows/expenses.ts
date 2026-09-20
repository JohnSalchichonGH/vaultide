import {
  deleteExpenseEntryIn as deleteExpenseEntryRowIn,
  findExpenseEntryIn,
  insertExpenseEntryIn,
  lockCategoryIn,
  updateExpenseEntryIn as updateExpenseEntryRowIn,
  type CategoryRecord,
  type ExpenseEntryRow,
  type Transaction,
} from '@vaultide/db';
import { phase3ExpenseSettlements, type ExpenseSettlement } from '@vaultide/validation';
import type { RequestContext } from '../context';
import { withUserWrite } from '../coordination';
import { NotFoundError, ValidationError, VersionConflictError } from '../errors';
import {
  assertNotFuture,
  auditContextOf,
  clearDormancyForFlowIn,
  resolveTrackedCashLegIn,
  type FlowDependencies,
} from './shared';

/**
 * Expense entries (blueprint 6.2, 7.4, 12.5, 20.3, 30.22, R24).
 *
 * The three Phase 3 settlements are three different facts, and the whole point
 * of keeping them apart is that two of them are not tracked spending:
 *
 *  - `tracked_cash` left a tracked account. It is the known outflow `K`, so it
 *    **decomposes** inferred spending rather than adding to it: recording one
 *    moves money out of the unclassified residual and into the named part, and
 *    the tracked total does not move (the §7 invariant).
 *  - `untracked_self` is the user's own money spent from outside tracked
 *    accounts. No cash leg, never in the identity, counted in
 *    `AdditionalSpending` and in total spending (12.5).
 *  - `third_party` was paid by somebody else. It enters no total, no savings
 *    figure and no projection baseline — it is information, not spending.
 *
 * `deducted_from_asset` needs an investment position and arrives with Phase 4.
 *
 * The category's **kind** decides the accounting bucket (7.4), so a category is
 * required and its kind is never editable afterwards. Phase 3 adds no way to
 * change one: an editor that could turn a consumption category into
 * `transfer_fee` would silently rewrite the meaning of every past expense
 * filed under it.
 */

export interface ExpenseEntryArgs {
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

export function assertExpenseSettlementAllowed(settlement: ExpenseSettlement): void {
  if ((phase3ExpenseSettlements as readonly string[]).includes(settlement)) return;
  throw new ValidationError(
    'An expense deducted from an investment’s value arrives with investments. Record how it was actually paid instead.',
    { settlement: ['Choose how this was paid.'] },
  );
}

/**
 * The category must be the user's, and **live until this write commits**
 * (6.2, 6.3, 30.22 item 8; ADR 0010 §9).
 *
 * Choosing a category afresh is the one place `categories.archived_at` decides
 * whether a financial write is allowed, so the row is read under `FOR SHARE`
 * and held for the rest of the transaction. Archiving is an `UPDATE`, which
 * `FOR SHARE` conflicts with: once this read has accepted the category as live,
 * an archive on another connection waits until the expense is committed, and an
 * archive that got there first makes this read see the archived row and refuse.
 *
 * Reading a category to classify an **existing** row is a different question
 * and takes no lock: an archived category's `kind` still says what its historic
 * expenses were (7.4, R12), and requiring liveness there would let tidying up
 * rewrite the past.
 */
export async function requireLiveCategoryIn(
  tx: Transaction,
  categoryId: string,
): Promise<CategoryRecord> {
  const category = await lockCategoryIn(tx, categoryId);
  if (category === undefined) throw new NotFoundError('That category no longer exists.');
  if (category.archivedAt !== null) {
    throw new ValidationError('That category is archived. Choose another one.', {
      categoryId: ['This category is archived.'],
    });
  }
  return category;
}

/**
 * The protected category kinds an ordinary expense may not be filed under
 * (7.4, 6.2).
 *
 * A category's **kind** is its accounting semantics, not a label, so two of the
 * seven system kinds cannot be chosen here:
 *
 *  - `capital_improvement` is defined by 7.4 only "(linked to a property/other
 *    asset)", and Phase 3 has neither to link. Writing one unlinked would put a
 *    capital expenditure in the ledger with nothing to capitalize against.
 *  - `transfer_fee` is defined by 7.4 only "(linked to a transfer)". A fee is
 *    one `expense_entries` row owned by the transfer aggregate (M14), created
 *    and deleted with its transfer; an unlinked row filed under the same kind
 *    would land in "Interest & fees" while belonging to no transfer, and is a
 *    fact the matrix does not define. The transfer service creates the real
 *    ones, and it does not come through here.
 *
 * The other five system kinds are ordinary tracked expenses that happen to
 * carry a non-consumption bucket, and are allowed.
 *
 * Exported because a recurring expense is an ordinary Phase 3 expense too: the
 * template that schedules one and the acceptance that materializes one both
 * reach this, so the rule has one statement rather than three copies that can
 * drift apart. It judges the category's **kind** and nothing else — whether the
 * category is live is a separate question, asked where it belongs.
 */
export function assertCategoryUsableInPhase3(category: CategoryRecord): void {
  if (category.kind === 'capital_improvement') {
    throw new ValidationError(
      'A capital improvement has to be linked to the property or asset it improves, which arrives with properties.',
      { categoryId: ['Choose another category.'] },
    );
  }
  if (category.kind === 'transfer_fee') {
    throw new ValidationError(
      'A transfer fee belongs to the transfer it was charged on. Add it on the transfer, so the two stay together and the fee is counted once.',
      { categoryId: ['Add this fee from its transfer.'] },
    );
  }
}

async function createExpenseEntryIn(
  tx: Transaction,
  ctx: RequestContext,
  args: ExpenseEntryArgs,
): Promise<ExpenseEntryRow> {
  assertNotFuture(ctx, args.incurredOn, 'incurredOn');
  assertExpenseSettlementAllowed(args.settlement);

  const category = await requireLiveCategoryIn(tx, args.categoryId);
  assertCategoryUsableInPhase3(category);

  // 6.2 domain rule: an untracked settlement never carries a cash position.
  const cashPositionId = args.settlement === 'tracked_cash' ? (args.cashPositionId ?? null) : null;

  if (args.settlement === 'tracked_cash') {
    await resolveTrackedCashLegIn(tx, {
      cashPositionId,
      currency: args.currency,
      on: args.incurredOn,
      dateField: 'incurredOn',
    });
  }

  const row = await insertExpenseEntryIn(tx, auditContextOf(ctx), {
    categoryId: args.categoryId,
    incurredOn: args.incurredOn,
    amount: args.amount,
    currency: args.currency,
    settlement: args.settlement,
    cashPositionId,
    description: args.description ?? null,
    tags: args.tags ?? [],
    isOneOff: args.isOneOff ?? false,
  });
  await clearDormancyForFlowIn(tx, ctx, [cashPositionId]);
  return row;
}

export async function createExpenseEntry(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: ExpenseEntryArgs,
): Promise<ExpenseEntryRow> {
  const created = await withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    createExpenseEntryIn(tx, ctx, args),
  );

  await deps.fx.ensureHistory(args.currency, args.incurredOn);
  return created;
}

export interface UpdateExpenseEntryArgs {
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
  readonly reason?: string | undefined;
}

async function updateExpenseEntryIn(
  tx: Transaction,
  ctx: RequestContext,
  args: UpdateExpenseEntryArgs,
): Promise<ExpenseEntryRow | undefined> {
  const existing = await findExpenseEntryIn(tx, args.entryId, { lock: 'update' });
  if (existing === undefined) throw new NotFoundError('That expense no longer exists.');

  if (existing.transferId !== null) {
    // A transfer's fee is edited through the transfer, so the pair stays
    // consistent and neither is rewritten as a side effect (M14).
    throw new ValidationError(
      'This is a transfer’s fee. Edit it on the transfer, so the two stay consistent.',
      { entryId: ['Edit this fee from its transfer.'] },
    );
  }

  const settlement = args.settlement ?? existing.settlement;
  const incurredOn = args.incurredOn ?? existing.incurredOn;

  assertNotFuture(ctx, incurredOn, 'incurredOn');
  assertExpenseSettlementAllowed(settlement);

  // Only when the request states a category. A correction that leaves the
  // category alone is carrying history, not choosing afresh, so it must not
  // start requiring the category to be live (30.22 item 9).
  if (args.categoryId !== undefined) {
    assertCategoryUsableInPhase3(await requireLiveCategoryIn(tx, args.categoryId));
  }

  const requestedCash =
    args.cashPositionId === undefined ? existing.cashPositionId : args.cashPositionId;
  const cashPositionId = settlement === 'tracked_cash' ? requestedCash : null;

  if (settlement === 'tracked_cash') {
    await resolveTrackedCashLegIn(tx, {
      cashPositionId,
      currency: existing.currency,
      on: incurredOn,
      dateField: 'incurredOn',
    });
  }

  const row = await updateExpenseEntryRowIn(
    tx,
    auditContextOf(ctx, args.reason),
    args.entryId,
    args.expectedVersion,
    {
      incurredOn,
      settlement,
      cashPositionId,
      ...(args.categoryId === undefined ? {} : { categoryId: args.categoryId }),
      ...(args.amount === undefined ? {} : { amount: args.amount }),
      ...(args.description === undefined ? {} : { description: args.description }),
      ...(args.tags === undefined ? {} : { tags: args.tags }),
      ...(args.isOneOff === undefined ? {} : { isOneOff: args.isOneOff }),
    },
  );
  if (row === undefined) return undefined;
  await clearDormancyForFlowIn(tx, ctx, [cashPositionId]);
  return row;
}

/**
 * Correct an expense entry.
 *
 * One scope, as creation already does — see the note on the income twin. The
 * row it was judged from, the corrected row, its audit entry, the category it
 * holds live and the dormancy the correction clears commit together or not at
 * all (ADR 0005 §2, ADR 0010 §5).
 */
export async function updateExpenseEntry(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: UpdateExpenseEntryArgs,
): Promise<ExpenseEntryRow> {
  const updated = await withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    updateExpenseEntryIn(tx, ctx, args),
  );

  if (updated === undefined) {
    throw new VersionConflictError('This expense changed while you were editing it.');
  }
  return updated;
}

export interface DeleteExpenseEntryArgs {
  readonly entryId: string;
  /** The version the client rendered (6.3, 20.3, 30.22 item 10). */
  readonly expectedVersion: number;
  readonly reason?: string | undefined;
}

async function deleteExpenseEntryIn(
  tx: Transaction,
  ctx: RequestContext,
  args: DeleteExpenseEntryArgs,
): Promise<ExpenseEntryRow> {
  const existing = await findExpenseEntryIn(tx, args.entryId, { lock: 'update' });
  if (existing === undefined) throw new NotFoundError('That expense no longer exists.');
  if (existing.transferId !== null) {
    // Answered before the version, because it is true of the row at every
    // version: a fee is not deletable here whatever the caller last saw.
    throw new ValidationError(
      'This is a transfer’s fee. Remove it from the transfer, so the transfer does not keep a fee that no longer exists.',
      { entryId: ['Remove this fee from its transfer.'] },
    );
  }
  if (existing.version !== args.expectedVersion) {
    throw new VersionConflictError(
      'This expense changed after you opened it. Reload to see what it says now.',
    );
  }

  const removed = await deleteExpenseEntryRowIn(tx, auditContextOf(ctx, args.reason), args.entryId);
  /* v8 ignore next -- the row is held under FOR UPDATE in this transaction. */
  if (removed === undefined) throw new NotFoundError('That expense no longer exists.');
  return removed;
}

/**
 * Delete an expense entry at the version the client saw (6.3, 30.22 item 10).
 *
 * A stale version refuses and deletes nothing, so an expense corrected
 * elsewhere is never removed by a request that was about the version before it.
 */
export async function deleteExpenseEntry(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: DeleteExpenseEntryArgs,
): Promise<ExpenseEntryRow> {
  return withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    deleteExpenseEntryIn(tx, ctx, args),
  );
}
