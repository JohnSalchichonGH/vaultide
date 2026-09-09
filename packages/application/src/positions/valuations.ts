import {
  deleteValuation,
  findPosition,
  findValuation,
  findValuationOn,
  insertValuation,
  listPositions,
  listValuations,
  quickUpdateValuations,
  updateCashDormantFlag,
  updateValuation,
  QuickUpdateConflictError,
  type Database,
  type PositionRecord as PositionRow,
  type ValuationRow,
} from '@vaultide/db';
import {
  Decimal,
  addMonths,
  endOfMonthKey,
  isMonthClosable,
  monthKey,
  monthKeyOf,
  plainDate,
  startOfMonth,
  type MonthKey,
} from '@vaultide/finance';
import type { RequestContext } from '../context';
import {
  DuplicateConflictError,
  ImpossibleOperationError,
  IncompleteDataError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
} from '../errors';
import type { PositionDependencies } from './service';

/**
 * Valuation services (blueprint 6.2, 8.1, 15.3, M1, M5, R15, R22).
 *
 * A valuation is a snapshot of what a position was worth on a date — nothing
 * more. Phase 2 writes them, corrects them and deletes them, and computes
 * everything else from them. There is no current-balance column to keep in
 * step and no flow inferred from a difference between two of them.
 *
 * Two date rules are enforced here as well as in the Zod schemas, because a
 * service is callable from anywhere and the rule belongs to the domain (20.1):
 *
 *  - no actual record may be dated after the user's local today (M5, R17);
 *  - a `month_end` balance may be written only once its month has ended (R15).
 */

/**
 * `2026-08-01` → `August 2026`, for the one message that reads better with a
 * name than with a date. English like every other domain message (18.2); the
 * locale-aware formatting lives in the interface.
 */
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function monthName(month: MonthKey): string {
  const [year, index] = (month as string).split('-');
  return `${MONTH_NAMES[Number(index) - 1] ?? String(index)} ${String(year)}`;
}

export interface ValuationArgs {
  readonly positionId: string;
  readonly valuedOn: string;
  readonly amount: string;
  readonly datePrecision: 'exact' | 'month_end';
  readonly note?: string | undefined;
}

async function requirePosition(
  db: Database,
  ctx: RequestContext,
  positionId: string,
): Promise<PositionRow> {
  const row = await findPosition(db, ctx.userId, positionId);
  if (row === undefined) throw new NotFoundError('That account no longer exists.');
  return row;
}

/** The two frozen date rules, applied to one valuation date. */
function assertDateRules(ctx: RequestContext, valuedOn: string, precision: 'exact' | 'month_end'): void {
  const date = plainDate(valuedOn);

  if (date > ctx.today) {
    throw new ValidationError(
      'This date is in the future. Balances can only be dated up to today.',
      { valuedOn: ['This date is in the future.'] },
    );
  }

  if (precision !== 'month_end') return;

  const month = monthKey(date);
  if (date !== endOfMonthKey(month)) {
    throw new ValidationError('A month-end balance must be dated the last day of its month.', {
      valuedOn: ['Use the last day of the month.'],
    });
  }
  if (!isMonthClosable(month, ctx.today)) {
    // The blueprint is explicit that the last day of the month is too early:
    // a statement balance for September exists from 1 October, not on the 30th
    // (R15, M5, C8). Enforced here so a request that bypasses the interface is
    // refused by the server.
    throw new ValidationError(
      'This month has not ended yet. Enter the end-of-month balance from the first day of the next month.',
      { datePrecision: ['This month has not ended yet.'] },
    );
  }
}

/** Only cash may go negative (6.2: "negative allowed only for cash"). */
function assertSign(position: PositionRow, amount: string): void {
  if (position.kind === 'cash') return;
  // Strictly below zero. A balance of "-0.00" is zero and is allowed on any
  // position; `isNegative()` reads the sign bit and would have rejected it with
  // a message about negative values that the user could not act on.
  if (new Decimal(amount).lessThan(0)) {
    throw new ValidationError('A value cannot be negative.', {
      amount: ['This value cannot be negative.'],
    });
  }
}

function assertWithinPositionWindow(position: PositionRow, valuedOn: string): void {
  // M4: no valuation before a position's `opened_on` or after its `closed_on`.
  if (position.openedOn !== null && valuedOn < position.openedOn) {
    throw new ValidationError('This date is before the account opened.', {
      valuedOn: [`The account opened on ${position.openedOn}.`],
    });
  }
  if (position.closedOn !== null && valuedOn > position.closedOn) {
    throw new ValidationError('This date is after the account closed.', {
      valuedOn: [`The account closed on ${position.closedOn}.`],
    });
  }
}

/**
 * A non-zero balance clears the dormant flag (6.2, R22).
 *
 * A dormant account carries at zero without a monthly confirmation. The moment
 * it holds money again that carry would be a lie, so recording a non-zero
 * balance turns the flag off rather than leaving the two facts in conflict.
 */
async function clearDormantIfNonZero(
  db: Database,
  ctx: RequestContext,
  position: PositionRow,
  amount: string,
): Promise<void> {
  if (position.kind !== 'cash' || position.isDormant !== true) return;
  if (new Decimal(amount).isZero()) return;
  await updateCashDormantFlag(db, { userId: ctx.userId, requestId: ctx.requestId }, position.id, false);
}

export async function recordValuation(
  deps: PositionDependencies,
  ctx: RequestContext,
  args: ValuationArgs,
): Promise<ValuationRow> {
  const position = await requirePosition(deps.db, ctx, args.positionId);
  assertDateRules(ctx, args.valuedOn, args.datePrecision);
  assertSign(position, args.amount);
  assertWithinPositionWindow(position, args.valuedOn);

  const existing = await findValuationOn(deps.db, ctx.userId, args.positionId, args.valuedOn);
  if (existing !== undefined) {
    // M1: one valuation per position per date. A second one is not a
    // correction, it is an ambiguity — the editor offers to correct instead.
    throw new DuplicateConflictError(
      `There is already a balance for ${args.valuedOn}. Edit it instead of adding another.`,
    );
  }

  const created = await insertValuation(
    deps.db,
    { userId: ctx.userId, requestId: ctx.requestId },
    {
      positionId: args.positionId,
      valuedOn: args.valuedOn,
      amount: args.amount,
      source: 'entered',
      datePrecision: args.datePrecision,
      note: args.note ?? null,
    },
  );

  await clearDormantIfNonZero(deps.db, ctx, position, args.amount);
  await deps.fx.ensureHistory(position.currency, args.valuedOn);
  return created;
}

export interface CorrectValuationArgs {
  readonly valuationId: string;
  readonly expectedVersion: number;
  readonly valuedOn: string;
  readonly amount: string;
  readonly datePrecision: 'exact' | 'month_end';
  readonly note?: string | null | undefined;
}

/**
 * Correct a valuation in place (2.6 "edit a balance 6 months back").
 *
 * The row is updated with a version check and a before-image; every derived
 * figure — net worth at every later date, the series, freshness — simply reads
 * differently afterwards, because none of them was stored.
 */
export async function correctValuation(
  deps: PositionDependencies,
  ctx: RequestContext,
  args: CorrectValuationArgs,
): Promise<ValuationRow> {
  const existing = await findValuation(deps.db, ctx.userId, args.valuationId);
  if (existing === undefined) throw new NotFoundError('That balance no longer exists.');

  const position = await requirePosition(deps.db, ctx, existing.positionId);
  assertDateRules(ctx, args.valuedOn, args.datePrecision);
  assertSign(position, args.amount);
  assertWithinPositionWindow(position, args.valuedOn);

  if (args.valuedOn !== existing.valuedOn) {
    const clash = await findValuationOn(deps.db, ctx.userId, existing.positionId, args.valuedOn);
    if (clash !== undefined) {
      throw new DuplicateConflictError(
        `There is already a balance for ${args.valuedOn}.`,
      );
    }
  }

  const updated = await updateValuation(
    deps.db,
    { userId: ctx.userId, requestId: ctx.requestId },
    args.valuationId,
    args.expectedVersion,
    {
      amount: args.amount,
      valuedOn: args.valuedOn,
      datePrecision: args.datePrecision,
      note: args.note ?? null,
    },
  );
  if (updated === undefined) throw new VersionConflictError();

  await clearDormantIfNonZero(deps.db, ctx, position, args.amount);
  await deps.fx.ensureHistory(position.currency, args.valuedOn);
  return updated;
}

/** Hard delete with a before-image (R12, T7). */
export async function removeValuation(
  deps: PositionDependencies,
  ctx: RequestContext,
  valuationId: string,
): Promise<ValuationRow> {
  const existing = await findValuation(deps.db, ctx.userId, valuationId);
  if (existing === undefined) throw new NotFoundError('That balance no longer exists.');

  const position = await requirePosition(deps.db, ctx, existing.positionId);
  if (position.status === 'closed' && existing.valuedOn === position.closedOn) {
    throw new ImpossibleOperationError(
      'This is the closing balance of a closed account. Reopen the account first if you need to change it.',
    );
  }

  const deleted = await deleteValuation(
    deps.db,
    { userId: ctx.userId, requestId: ctx.requestId },
    valuationId,
  );
  /* v8 ignore next -- the row was read a line above, inside the same session. */
  if (deleted === undefined) throw new NotFoundError('That balance no longer exists.');
  return deleted;
}

/**
 * Confirm an ordinary snapshot dated the last day of a month as that month's
 * **statement** balance (8.1, 8.8, R15).
 *
 * It upgrades the row's precision and nothing else: the amount is the user's
 * own figure and is untouched. Until this happens, a snapshot dated 30
 * September is just a snapshot, and September stays open.
 */
export async function confirmMonthEnd(
  deps: PositionDependencies,
  ctx: RequestContext,
  args: { valuationId: string; expectedVersion: number },
): Promise<ValuationRow> {
  const existing = await findValuation(deps.db, ctx.userId, args.valuationId);
  if (existing === undefined) throw new NotFoundError('That balance no longer exists.');

  if (existing.datePrecision === 'month_end') {
    throw new ImpossibleOperationError('That balance is already the statement balance.');
  }

  assertDateRules(ctx, existing.valuedOn, 'month_end');

  const updated = await updateValuation(
    deps.db,
    { userId: ctx.userId, requestId: ctx.requestId },
    args.valuationId,
    args.expectedVersion,
    { datePrecision: 'month_end' },
  );
  if (updated === undefined) throw new VersionConflictError();
  return updated;
}

/**
 * "Confirm unchanged for this month" (R22, C7).
 *
 * Writes a `month_end` valuation equal to the previous month-end balance, with
 * source `confirmed_unchanged`. This is deliberately an explicit action rather
 * than an assumption: the specification allowed carrying a last-known value
 * forward "when appropriate", and a carried non-zero balance treated as a
 * statement is exactly how a month's spending comes out equal to its income.
 * Only a dormant, zero-balance account carries automatically.
 */
export async function confirmUnchanged(
  deps: PositionDependencies,
  ctx: RequestContext,
  args: { positionId: string; month: string },
): Promise<ValuationRow> {
  const position = await requirePosition(deps.db, ctx, args.positionId);

  const parts = args.month.split('-');
  const month = monthKeyOf(Number(parts[0]), Number(parts[1]));
  const end = endOfMonthKey(month);

  if (!isMonthClosable(month, ctx.today)) {
    throw new ValidationError(
      'This month has not ended yet. Confirm it from the first day of the next month.',
      { month: ['This month has not ended yet.'] },
    );
  }

  const previousMonth = monthKey(addMonths(startOfMonth(end), -1));
  const previousEnd = endOfMonthKey(previousMonth);

  /*
   * The previous month's **statement** balance, and nothing else.
   *
   * 8.1 says this action writes a month-end valuation "equal to the previous
   * month-end balance". Reaching for the latest valuation on or before that
   * date instead would agree whenever the previous month is closed — and, when
   * it is not, would carry a figure across an unobserved month and stamp it as
   * a statement balance. The user asserted that *this* month did not change;
   * that says nothing about the month before it.
   *
   * The damage is not immediate — the confirmed month's own opening is still
   * `carried`, so it stays unavailable — but the month *after* it becomes
   * reconcilable against an opening nobody confirmed, and any movement in the
   * skipped month is then silently absorbed into its inferred spending. That is
   * the exact failure C7, F1 and R5 exist to prevent.
   *
   * Deliberately not widened to `closed_zero`, `dormant_zero` or `opened_zero`
   * (8.1): those are settled openings with their own semantics, and a dormant
   * account already carries automatically under R22. Reading them as a
   * "previous month-end balance" would be a wider definition than the blueprint
   * gives.
   */
  const previous = await findValuationOn(deps.db, ctx.userId, args.positionId, previousEnd);
  if (previous === undefined || previous.datePrecision !== 'month_end') {
    throw new IncompleteDataError(
      `${monthName(previousMonth)} has no month-end balance, so there is nothing to carry forward. Close ${monthName(previousMonth)} first, or enter ${monthName(month)}’s statement balance instead.`,
    );
  }

  const existing = await findValuationOn(deps.db, ctx.userId, args.positionId, end);
  if (existing !== undefined) {
    throw new DuplicateConflictError(`There is already a balance for ${end}.`);
  }

  assertWithinPositionWindow(position, end);

  return insertValuation(
    deps.db,
    { userId: ctx.userId, requestId: ctx.requestId },
    {
      positionId: args.positionId,
      valuedOn: end,
      amount: previous.amount,
      source: 'confirmed_unchanged',
      datePrecision: 'month_end',
    },
  );
}

export interface QuickUpdateArgs {
  readonly entries: readonly {
    readonly positionId: string;
    readonly amount: string;
    readonly expectedVersion?: number | undefined;
  }[];
}

export interface QuickUpdateSummary {
  readonly valuedOn: string;
  readonly inserted: number;
  readonly corrected: number;
  readonly positionIds: readonly string[];
}

/**
 * Quick update (15.3) — today's balances for several positions at once.
 *
 * Everything it writes is an ordinary `exact` valuation dated **today**; no
 * other date is offered, and none can be smuggled in, because the date is not
 * an input (M5). It writes canonical `position_valuations` rows through the
 * same repository as every other balance: there is no second source of truth,
 * no hidden current-balance field, and no reporting-currency value persisted
 * anywhere (T8, M10).
 *
 * The whole submission is one transaction. 20.3 has a bulk save abort entirely
 * on any conflict, and a half-applied set of balances is precisely the state
 * that would make a net-worth figure quietly wrong.
 */
export async function quickUpdate(
  deps: PositionDependencies,
  ctx: RequestContext,
  args: QuickUpdateArgs,
): Promise<QuickUpdateSummary> {
  const positions = await listPositions(deps.db, ctx.userId);
  const byId = new Map(positions.map((row) => [row.id, row]));

  for (const item of args.entries) {
    const position = byId.get(item.positionId);
    if (position === undefined) throw new NotFoundError('That account no longer exists.');
    if (position.status !== 'active') {
      throw new ImpossibleOperationError(
        `${position.name} is not active, so it cannot be updated.`,
      );
    }
    assertSign(position, item.amount);
    assertWithinPositionWindow(position, ctx.today);
  }

  try {
    const result = await quickUpdateValuations(
      deps.db,
      { userId: ctx.userId, requestId: ctx.requestId },
      ctx.today,
      args.entries.map((item) => ({
        positionId: item.positionId,
        amount: item.amount,
        ...(item.expectedVersion === undefined ? {} : { expectedVersion: item.expectedVersion }),
      })),
    );

    for (const item of args.entries) {
      const position = byId.get(item.positionId);
      /* v8 ignore next -- validated in the loop above. */
      if (position === undefined) continue;
      await clearDormantIfNonZero(deps.db, ctx, position, item.amount);
      await deps.fx.ensureHistory(position.currency, ctx.today);
    }

    return {
      valuedOn: ctx.today,
      inserted: result.inserted,
      corrected: result.corrected,
      positionIds: args.entries.map((item) => item.positionId),
    };
  } catch (error) {
    if (error instanceof QuickUpdateConflictError) {
      throw new VersionConflictError(
        'One of these balances was changed elsewhere, so nothing was saved. Reload and try again.',
      );
    }
    throw error;
  }
}

/** Every valuation of a position, newest first — the account history. */
export async function positionHistory(
  deps: PositionDependencies,
  ctx: RequestContext,
  positionId: string,
): Promise<ValuationRow[]> {
  await requirePosition(deps.db, ctx, positionId);
  return listValuations(deps.db, ctx.userId, positionId);
}
