import {
  deleteExpenseEntryIn as deleteExpenseEntryRowIn,
  findCategoryIn,
  findExpenseEntryIn,
  insertExpenseEntryIn,
  lockCategoryIn,
  updateExpenseEntryIn as updateExpenseEntryRowIn,
  type CategoryRecord,
  type ExpenseEntryRow,
  type OccurrenceRef,
  type Transaction,
} from '@vaultide/db';
import { phase3ExpenseSettlements, type ExpenseSettlement } from '@vaultide/validation';
import type { RequestContext } from '../context';
import { withUserWrite } from '../coordination';
import { assertNoHistoricalReview } from '../corrections/guard';
import { NotFoundError, ValidationError, VersionConflictError } from '../errors';
import {
  canonicalAmount,
  created,
  deleted,
  dormancyChange,
  mergeSupport,
  realDormancyEffects,
  updated,
  type ExpenseSourceFacts,
  type ResolvedWrite,
  type ResolveOptions,
} from '../write-plan';
import {
  applyDormancyClearsIn,
  assertNotFuture,
  auditContextOf,
  clearDormancyEffect,
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
  options: ResolveOptions = { lock: true },
): Promise<CategoryRecord> {
  // The correction preview asks the same question in a `READ ONLY`
  // transaction, where PostgreSQL refuses `FOR SHARE` outright. It reads the
  // row without the lock and refuses an archived category exactly as a write
  // does; Confirm then takes the lock for real before it applies anything, so
  // the liveness guarantee is never weakened — only the preview's copy of it
  // is advisory (§21, §62 of the slice prompt).
  const category = options.lock
    ? await lockCategoryIn(tx, categoryId)
    : await findCategoryIn(tx, categoryId);
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

/** The columns an expense write sets. */
export interface ExpenseColumns {
  readonly categoryId: string;
  readonly incurredOn: string;
  readonly amount: string;
  readonly currency: string;
  readonly settlement: ExpenseSettlement;
  readonly cashPositionId: string | null;
  readonly description: string | null;
  readonly tags: string[] | undefined;
  readonly isOneOff: boolean | undefined;
  readonly transferId: string | null;
}

/** A resolved expense write (ADR 0010 §1; §20 of the slice prompt). */
export interface ExpenseWritePlan extends ResolvedWrite {
  readonly operation: 'create' | 'update' | 'delete';
  readonly existing: ExpenseEntryRow | null;
  readonly expectedVersion: number | null;
  readonly columns: ExpenseColumns | null;
  readonly occurrence: OccurrenceRef | undefined;
}

export function expenseFacts(row: ExpenseEntryRow, categoryKind: string): ExpenseSourceFacts {
  return {
    kind: 'expense',
    categoryId: row.categoryId,
    categoryKind,
    incurredOn: row.incurredOn,
    amount: canonicalAmount(row.amount),
    currency: row.currency,
    settlement: row.settlement,
    cashPositionId: row.cashPositionId,
    description: row.description,
    transferId: row.transferId,
    templateId: row.templateId,
    occurrenceDate: row.occurrenceDate,
  };
}

export function expenseFactsOf(
  columns: ExpenseColumns,
  categoryKind: string,
  occurrence: OccurrenceRef | undefined,
): ExpenseSourceFacts {
  return {
    kind: 'expense',
    categoryId: columns.categoryId,
    categoryKind,
    incurredOn: columns.incurredOn,
    amount: canonicalAmount(columns.amount),
    currency: columns.currency,
    settlement: columns.settlement,
    cashPositionId: columns.cashPositionId,
    description: columns.description,
    transferId: columns.transferId,
    templateId: occurrence?.templateId ?? null,
    occurrenceDate: occurrence?.occurrenceDate ?? null,
  };
}

/**
 * The kind of a category a write is **carrying**, not choosing.
 *
 * Archived rows included and no lock taken: an archived category's `kind` still
 * says what its historic expenses were (7.4, R12), and requiring liveness here
 * would let tidying up rewrite the past (30.22 item 9).
 */
async function carriedCategoryIn(tx: Transaction, categoryId: string): Promise<CategoryRecord> {
  const category = await findCategoryIn(tx, categoryId);
  /* v8 ignore next 2 -- `category_id` is NOT NULL with a composite FK to the
     user's own categories, so a row without one cannot exist. */
  if (category === undefined) throw new NotFoundError('That category no longer exists.');
  return category;
}

async function categoryKindIn(tx: Transaction, categoryId: string): Promise<string> {
  return (await carriedCategoryIn(tx, categoryId)).kind;
}

/** How an expense creation reaches its category and its occurrence. */
export interface ExpenseCreateOptions extends ResolveOptions {
  /** The scheduled occurrence this creation materializes, when it does (30.9). */
  readonly occurrence?: OccurrenceRef;
  /**
   * The category is **carried** from a recurring template rather than chosen
   * afresh, so its liveness is not required (30.22 item 9): archiving a
   * category must never stop an occurrence that was scheduled while it was
   * live from being recorded. Its `kind` still disqualifies it.
   */
  readonly carryCategory?: boolean;
}

export async function resolveExpenseCreateIn(
  tx: Transaction,
  ctx: RequestContext,
  args: ExpenseEntryArgs,
  options: ExpenseCreateOptions = { lock: true },
): Promise<ExpenseWritePlan> {
  const occurrence = options.occurrence;
  assertNotFuture(ctx, args.incurredOn, 'incurredOn');
  assertExpenseSettlementAllowed(args.settlement);

  const category =
    options.carryCategory === true
      ? await carriedCategoryIn(tx, args.categoryId)
      : await requireLiveCategoryIn(tx, args.categoryId, options);
  assertCategoryUsableInPhase3(category);

  // 6.2 domain rule: an untracked settlement never carries a cash position.
  const cashPositionId = args.settlement === 'tracked_cash' ? (args.cashPositionId ?? null) : null;

  const leg =
    args.settlement === 'tracked_cash'
      ? await resolveTrackedCashLegIn(tx, {
          cashPositionId,
          currency: args.currency,
          on: args.incurredOn,
          dateField: 'incurredOn',
        })
      : null;

  const columns: ExpenseColumns = {
    categoryId: args.categoryId,
    incurredOn: args.incurredOn,
    amount: args.amount,
    currency: args.currency,
    settlement: args.settlement,
    cashPositionId,
    description: args.description ?? null,
    tags: args.tags,
    isOneOff: args.isOneOff,
    transferId: null,
  };
  const dormancy = realDormancyEffects(leg === null ? [] : [clearDormancyEffect(leg)]);

  return {
    operation: 'create',
    existing: null,
    expectedVersion: null,
    columns,
    occurrence,
    revision: false,
    changes: [
      created(
        {
          scope: 'prospective',
          kind: 'expense',
          role: occurrence === undefined ? 'entry' : 'occurrence',
          owner:
            occurrence === undefined
              ? null
              : `${occurrence.templateId}#${occurrence.occurrenceDate}`,
        },
        expenseFactsOf(columns, category.kind, occurrence),
      ),
      ...dormancy.map(dormancyChange),
    ],
    dormancy,
    support: [{ currency: args.currency, from: args.incurredOn }],
  };
}

export async function resolveExpenseUpdateIn(
  tx: Transaction,
  ctx: RequestContext,
  args: UpdateExpenseEntryArgs,
  options: ResolveOptions = { lock: true },
): Promise<ExpenseWritePlan> {
  const existing = await findExpenseEntryIn(
    tx,
    args.entryId,
    options.lock ? { lock: 'update' } : {},
  );
  if (existing === undefined) throw new NotFoundError('That expense no longer exists.');

  if (existing.transferId !== null) {
    // A transfer's fee is edited through the transfer, so the pair stays
    // consistent and neither is rewritten as a side effect (M14).
    throw new ValidationError(
      'This is a transfer’s fee. Edit it on the transfer, so the two stay consistent.',
      { entryId: ['Edit this fee from its transfer.'] },
    );
  }
  if (existing.version !== args.expectedVersion) {
    throw new VersionConflictError('This expense changed while you were editing it.');
  }

  const settlement = args.settlement ?? existing.settlement;
  const incurredOn = args.incurredOn ?? existing.incurredOn;

  assertNotFuture(ctx, incurredOn, 'incurredOn');
  assertExpenseSettlementAllowed(settlement);

  const beforeKind = await categoryKindIn(tx, existing.categoryId);

  // A category is judged for liveness **only** when the request states one. A
  // correction that leaves the category alone is carrying history, not choosing
  // afresh, so it must not start requiring the category to be live (30.22
  // item 9).
  let afterKind = beforeKind;
  if (args.categoryId !== undefined) {
    const chosen = await requireLiveCategoryIn(tx, args.categoryId, options);
    assertCategoryUsableInPhase3(chosen);
    afterKind = chosen.kind;
  }

  const requestedCash =
    args.cashPositionId === undefined ? existing.cashPositionId : args.cashPositionId;
  const cashPositionId = settlement === 'tracked_cash' ? requestedCash : null;

  const leg =
    settlement === 'tracked_cash'
      ? await resolveTrackedCashLegIn(tx, {
          cashPositionId,
          currency: existing.currency,
          on: incurredOn,
          dateField: 'incurredOn',
        })
      : null;

  const columns: ExpenseColumns = {
    categoryId: args.categoryId ?? existing.categoryId,
    incurredOn,
    amount: args.amount ?? existing.amount,
    currency: existing.currency,
    settlement,
    cashPositionId,
    description: args.description === undefined ? existing.description : args.description,
    tags: args.tags,
    isOneOff: args.isOneOff,
    transferId: null,
  };
  const dormancy = realDormancyEffects(leg === null ? [] : [clearDormancyEffect(leg)]);
  const occurrence =
    existing.templateId === null || existing.occurrenceDate === null
      ? undefined
      : { templateId: existing.templateId, occurrenceDate: existing.occurrenceDate };

  return {
    operation: 'update',
    existing,
    expectedVersion: args.expectedVersion,
    columns,
    occurrence,
    revision: true,
    changes: [
      updated(
        { scope: 'existing', kind: 'expense', id: existing.id },
        expenseFacts(existing, beforeKind),
        expenseFactsOf(columns, afterKind, occurrence),
      ),
      ...dormancy.map(dormancyChange),
    ],
    dormancy,
    support: mergeSupport([
      { currency: existing.currency, from: incurredOn },
      { currency: existing.currency, from: existing.incurredOn },
    ]),
  };
}

export async function resolveExpenseDeleteIn(
  tx: Transaction,
  args: DeleteExpenseEntryArgs,
  options: ResolveOptions = { lock: true },
): Promise<ExpenseWritePlan> {
  const existing = await findExpenseEntryIn(
    tx,
    args.entryId,
    options.lock ? { lock: 'update' } : {},
  );
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

  return {
    operation: 'delete',
    existing,
    expectedVersion: args.expectedVersion,
    columns: null,
    occurrence: undefined,
    revision: true,
    changes: [
      deleted(
        { scope: 'existing', kind: 'expense', id: existing.id },
        expenseFacts(existing, await categoryKindIn(tx, existing.categoryId)),
      ),
    ],
    dormancy: [],
    support: [],
  };
}

/** The one writer for all three expense operations, and for both callers. */
export async function applyExpensePlanIn(
  tx: Transaction,
  ctx: RequestContext,
  plan: ExpenseWritePlan,
  reason?: string,
): Promise<ExpenseEntryRow> {
  const audit = auditContextOf(ctx, reason);

  const written = await (async (): Promise<ExpenseEntryRow> => {
    if (plan.operation === 'delete') {
      /* v8 ignore next 2 -- a delete plan always carries the row it removes. */
      if (plan.existing === null) throw new NotFoundError('That expense no longer exists.');
      const removed = await deleteExpenseEntryRowIn(tx, audit, plan.existing.id);
      /* v8 ignore next -- the row is held under FOR UPDATE in this transaction. */
      if (removed === undefined) throw new NotFoundError('That expense no longer exists.');
      return removed;
    }

    /* v8 ignore next 2 -- create and update plans always carry their columns. */
    if (plan.columns === null) throw new NotFoundError('That expense no longer exists.');
    const columns = plan.columns;

    if (plan.operation === 'create') {
      return insertExpenseEntryIn(tx, audit, {
        categoryId: columns.categoryId,
        incurredOn: columns.incurredOn,
        amount: columns.amount,
        currency: columns.currency,
        settlement: columns.settlement,
        cashPositionId: columns.cashPositionId,
        description: columns.description,
        tags: columns.tags ?? [],
        isOneOff: columns.isOneOff ?? false,
        ...(plan.occurrence === undefined ? {} : { occurrence: plan.occurrence }),
      });
    }

    /* v8 ignore next 2 -- an update plan always carries a row and a version. */
    if (plan.existing === null || plan.expectedVersion === null) throw new VersionConflictError();
    const row = await updateExpenseEntryRowIn(tx, audit, plan.existing.id, plan.expectedVersion, {
      incurredOn: columns.incurredOn,
      settlement: columns.settlement,
      cashPositionId: columns.cashPositionId,
      categoryId: columns.categoryId,
      amount: columns.amount,
      description: columns.description,
      ...(columns.tags === undefined ? {} : { tags: columns.tags }),
      ...(columns.isOneOff === undefined ? {} : { isOneOff: columns.isOneOff }),
    });
    if (row === undefined) {
      throw new VersionConflictError('This expense changed while you were editing it.');
    }
    return row;
  })();

  await applyDormancyClearsIn(tx, ctx, plan.dormancy);
  return written;
}

async function createExpenseEntryIn(
  tx: Transaction,
  ctx: RequestContext,
  args: ExpenseEntryArgs,
): Promise<ExpenseEntryRow> {
  const plan = await resolveExpenseCreateIn(tx, ctx, args);
  assertNoHistoricalReview(plan, ctx.today);
  return applyExpensePlanIn(tx, ctx, plan);
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
): Promise<ExpenseEntryRow> {
  const plan = await resolveExpenseUpdateIn(tx, ctx, args);
  assertNoHistoricalReview(plan, ctx.today);
  return applyExpensePlanIn(tx, ctx, plan, args.reason);
}

/**
 * Correct an expense entry.
 *
 * One scope, as creation already does — see the note on the income twin. The
 * row it was judged from, the corrected row, its audit entry, the category it
 * holds live and the dormancy the correction clears commit together or not at
 * all (ADR 0005 §2, ADR 0010 §5).
 *
 * A correction whose before or after date lands in a completed month, or whose
 * dormancy consequence reaches one, is a Historical Correction and is refused
 * here: it goes through Preview → Confirm instead (30.22 item 1).
 */
export async function updateExpenseEntry(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: UpdateExpenseEntryArgs,
): Promise<ExpenseEntryRow> {
  return withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    updateExpenseEntryIn(tx, ctx, args),
  );
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
  const plan = await resolveExpenseDeleteIn(tx, args);
  assertNoHistoricalReview(plan, ctx.today);
  return applyExpensePlanIn(tx, ctx, plan, args.reason);
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
