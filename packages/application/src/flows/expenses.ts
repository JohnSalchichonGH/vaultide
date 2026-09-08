import {
  deleteExpenseEntry as deleteExpenseEntryRow,
  findExpenseEntry,
  insertExpenseEntryIn,
  listCategoryRecords,
  updateExpenseEntry as updateExpenseEntryRow,
  withUser,
  type CategoryRecord,
  type Database,
  type ExpenseEntryRow,
} from '@vaultide/db';
import { phase3ExpenseSettlements, type ExpenseSettlement } from '@vaultide/validation';
import type { RequestContext } from '../context';
import { NotFoundError, ValidationError, VersionConflictError } from '../errors';
import {
  assertNotFuture,
  auditContextOf,
  clearDormancyForFlowIn,
  resolveTrackedCashLeg,
  type FlowDependencies,
} from './shared';

/**
 * Expense entries (blueprint 6.2, 7.4, 12.5, R24).
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

/** The category must be the user's, and live (6.2, 6.3). */
export async function requireCategory(
  db: Database,
  ctx: RequestContext,
  categoryId: string,
): Promise<CategoryRecord> {
  const categories = await listCategoryRecords(db, ctx.userId, { includeArchived: true });
  const category = categories.find((row) => row.id === categoryId);
  if (category === undefined) throw new NotFoundError('That category no longer exists.');
  if (category.archivedAt !== null) {
    throw new ValidationError('That category is archived. Choose another one.', {
      categoryId: ['This category is archived.'],
    });
  }
  return category;
}

/**
 * `capital_improvement` links an asset (6.2 domain rule), and Phase 3 has no
 * properties or other-asset flows to link, so the category is refused here
 * rather than written without its link.
 */
function assertCategoryUsableInPhase3(category: CategoryRecord): void {
  if (category.kind === 'capital_improvement') {
    throw new ValidationError(
      'A capital improvement has to be linked to the property or asset it improves, which arrives with properties.',
      { categoryId: ['Choose another category.'] },
    );
  }
}

export async function createExpenseEntry(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: ExpenseEntryArgs,
): Promise<ExpenseEntryRow> {
  assertNotFuture(ctx, args.incurredOn, 'incurredOn');
  assertExpenseSettlementAllowed(args.settlement);

  const category = await requireCategory(deps.db, ctx, args.categoryId);
  assertCategoryUsableInPhase3(category);

  // 6.2 domain rule: an untracked settlement never carries a cash position.
  const cashPositionId = args.settlement === 'tracked_cash' ? (args.cashPositionId ?? null) : null;

  if (args.settlement === 'tracked_cash') {
    await resolveTrackedCashLeg(deps, ctx, {
      cashPositionId,
      currency: args.currency,
      on: args.incurredOn,
      dateField: 'incurredOn',
    });
  }

  const audit = auditContextOf(ctx);
  const created = await withUser(deps.db, { userId: ctx.userId }, async (tx) => {
    const row = await insertExpenseEntryIn(tx, audit, {
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
  });

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

export async function updateExpenseEntry(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: UpdateExpenseEntryArgs,
): Promise<ExpenseEntryRow> {
  const existing = await findExpenseEntry(deps.db, ctx.userId, args.entryId);
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

  if (args.categoryId !== undefined) {
    assertCategoryUsableInPhase3(await requireCategory(deps.db, ctx, args.categoryId));
  }

  const requestedCash =
    args.cashPositionId === undefined ? existing.cashPositionId : args.cashPositionId;
  const cashPositionId = settlement === 'tracked_cash' ? requestedCash : null;

  if (settlement === 'tracked_cash') {
    await resolveTrackedCashLeg(deps, ctx, {
      cashPositionId,
      currency: existing.currency,
      on: incurredOn,
      dateField: 'incurredOn',
    });
  }

  const updated = await updateExpenseEntryRow(
    deps.db,
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

  if (updated === undefined) {
    throw new VersionConflictError('This expense changed while you were editing it.');
  }

  if (cashPositionId !== null) {
    await withUser(deps.db, { userId: ctx.userId }, async (tx) =>
      clearDormancyForFlowIn(tx, ctx, [cashPositionId]),
    );
  }

  return updated;
}

export async function deleteExpenseEntry(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: { entryId: string; reason?: string | undefined },
): Promise<ExpenseEntryRow> {
  const existing = await findExpenseEntry(deps.db, ctx.userId, args.entryId);
  if (existing === undefined) throw new NotFoundError('That expense no longer exists.');
  if (existing.transferId !== null) {
    throw new ValidationError(
      'This is a transfer’s fee. Remove it from the transfer, so the transfer does not keep a fee that no longer exists.',
      { entryId: ['Remove this fee from its transfer.'] },
    );
  }

  const removed = await deleteExpenseEntryRow(
    deps.db,
    auditContextOf(ctx, args.reason),
    args.entryId,
  );
  /* v8 ignore next -- the row was read a statement ago inside the same session. */
  if (removed === undefined) throw new NotFoundError('That expense no longer exists.');
  return removed;
}
