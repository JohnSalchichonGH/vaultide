import {
  clearCashDormancyIn,
  deleteValuationIn,
  findLatestValuationIn,
  findPosition,
  findPositionIn,
  findValuationIn,
  findValuationOnIn,
  insertValuationIn,
  isUniqueViolation,
  listPositionsIn,
  listValuations,
  lockCashPositionsIn,
  quickUpdateValuationsIn,
  updateValuationIn,
  QuickUpdateConflictError,
  type AuditContext,
  type PositionRecord as PositionRow,
  type Transaction,
  type ValuationRow,
} from '@vaultide/db';
import {
  Decimal,
  addMonths,
  endOfMonthKey,
  isDormantZeroAt,
  isMonthClosable,
  monthKey,
  monthKeyOf,
  plainDate,
  startOfMonth,
  type MonthKey,
} from '@vaultide/finance';
import type { RequestContext } from '../context';
import { withUserWrite } from '../coordination';
import {
  DuplicateConflictError,
  ImpossibleOperationError,
  IncompleteDataError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
} from '../errors';
import { auditContextOf } from '../flows/shared';
import { toPositionRecord, toValuationRecord } from './mapping';
import type { PositionDependencies } from './service';

/**
 * Valuation services (blueprint 6.2, 8.1, 15.3, 20.3, 30.22, M1, M5, R15, R22).
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
 *
 * ## A balance and its dormancy consequence are one fact
 *
 * Four of these mutations have a second half: a non-zero balance wakes a
 * dormant account (6.2, R22), and removing or re-dating the balance an episode
 * starts from ends it (8.8, 30.20 item 6). Each of those pairs used to be two
 * transactions, so a crash or a refusal between them could leave an account
 * flagged dormant over money it was holding, or awake with an anchor that no
 * longer existed — and nothing would have reported it, because each half
 * succeeded. Each is now one `withUserWrite` (ADR 0010 §15): the reads the
 * decision rests on, the valuation write, the dormancy write and the audit rows
 * commit together or not at all.
 *
 * The only work left outside is `ensureHistory`, which warms exchange-rate
 * support data after the financial truth is committed and decides nothing about
 * it (10.4, ADR 0010 §7).
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

/** A valuation together with what the post-commit FX warming needs from it. */
interface WrittenValuation {
  readonly valuation: ValuationRow;
  readonly currency: string;
}

async function requirePositionIn(tx: Transaction, positionId: string): Promise<PositionRow> {
  const row = await findPositionIn(tx, positionId);
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
 * balance turns the flag off rather than leaving the two facts in conflict —
 * inside the same transaction as the balance, so the two cannot come apart.
 */
async function clearDormantIfNonZeroIn(
  tx: Transaction,
  ctx: RequestContext,
  position: PositionRow,
  amount: string,
): Promise<void> {
  if (position.kind !== 'cash' || position.isDormant !== true) return;
  if (new Decimal(amount).isZero()) return;
  await clearCashDormancyIn(tx, { userId: ctx.userId, requestId: ctx.requestId }, position.id);
}

/**
 * Removing or re-dating the balance a dormant episode starts from ends the
 * episode (8.8, v2.1.17 30.20 item 6).
 *
 * `dormant_from` is that balance's date, so once the row is gone from it the
 * episode rests on a record that no longer exists. The account wakes, exactly
 * as it does for any other conflicting record: no other zero is searched for
 * and nothing is re-anchored, because only the user can say the account is
 * dormant again — and marking it re-reads the evidence when they do.
 */
async function wakeIfAnchorRemovedIn(
  tx: Transaction,
  ctx: RequestContext,
  position: PositionRow,
  removedFrom: string,
): Promise<void> {
  if (position.kind !== 'cash' || position.dormantFrom !== removedFrom) return;
  await clearCashDormancyIn(tx, { userId: ctx.userId, requestId: ctx.requestId }, position.id);
}

/**
 * Does the account's dormant episode already carry `end` at zero (8.1)?
 *
 * Finance's own rule, asked with the one row it consults — the latest balance
 * on or before the date — so "confirm unchanged" and the month's closing state
 * can never disagree about whether a month needs a confirmation at all.
 */
function carriedByDormancy(
  position: PositionRow,
  latest: ValuationRow | undefined,
  end: string,
): boolean {
  return isDormantZeroAt(
    toPositionRecord(position),
    latest === undefined ? [] : [toValuationRecord(latest)],
    plainDate(end),
  );
}

const dormantCarryMessage = (name: string): string =>
  `${name} is dormant over this month, so it carries at zero without a monthly confirmation. Nothing was confirmed.`;

async function recordValuationIn(
  tx: Transaction,
  ctx: RequestContext,
  args: ValuationArgs,
): Promise<WrittenValuation> {
  const position = await requirePositionIn(tx, args.positionId);
  assertDateRules(ctx, args.valuedOn, args.datePrecision);
  assertSign(position, args.amount);
  assertWithinPositionWindow(position, args.valuedOn);

  const existing = await findValuationOnIn(tx, args.positionId, args.valuedOn);
  if (existing !== undefined) {
    // M1: one valuation per position per date. A second one is not a
    // correction, it is an ambiguity — the editor offers to correct instead.
    throw new DuplicateConflictError(
      `There is already a balance for ${args.valuedOn}. Edit it instead of adding another.`,
    );
  }

  const created = await insertValuationIn(tx, auditContextOf(ctx), {
    positionId: args.positionId,
    valuedOn: args.valuedOn,
    amount: args.amount,
    source: 'entered',
    datePrecision: args.datePrecision,
    note: args.note ?? null,
  });

  await clearDormantIfNonZeroIn(tx, ctx, position, args.amount);
  return { valuation: created, currency: position.currency };
}

export async function recordValuation(
  deps: PositionDependencies,
  ctx: RequestContext,
  args: ValuationArgs,
): Promise<ValuationRow> {
  const written = await withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    recordValuationIn(tx, ctx, args),
  );

  await deps.fx.ensureHistory(written.currency, args.valuedOn);
  return written.valuation;
}

export interface CorrectValuationArgs {
  readonly valuationId: string;
  readonly expectedVersion: number;
  readonly valuedOn: string;
  readonly amount: string;
  readonly datePrecision: 'exact' | 'month_end';
  readonly note?: string | null | undefined;
  /** The user's own explanation, kept for the audit row (18.1, 30.22 item 10). */
  readonly reason?: string | undefined;
}

async function correctValuationIn(
  tx: Transaction,
  ctx: RequestContext,
  args: CorrectValuationArgs,
): Promise<WrittenValuation> {
  const existing = await findValuationIn(tx, args.valuationId, { lock: 'update' });
  if (existing === undefined) throw new NotFoundError('That balance no longer exists.');

  const position = await requirePositionIn(tx, existing.positionId);
  assertDateRules(ctx, args.valuedOn, args.datePrecision);
  assertSign(position, args.amount);
  assertWithinPositionWindow(position, args.valuedOn);

  if (args.valuedOn !== existing.valuedOn) {
    const clash = await findValuationOnIn(tx, existing.positionId, args.valuedOn);
    if (clash !== undefined) {
      throw new DuplicateConflictError(`There is already a balance for ${args.valuedOn}.`);
    }
  }

  const updated = await updateValuationIn(
    tx,
    auditContextOf(ctx, args.reason),
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

  await clearDormantIfNonZeroIn(tx, ctx, position, args.amount);
  if (args.valuedOn !== existing.valuedOn) {
    await wakeIfAnchorRemovedIn(tx, ctx, position, existing.valuedOn);
  }
  return { valuation: updated, currency: position.currency };
}

/**
 * Correct a valuation in place (2.6 "edit a balance 6 months back").
 *
 * The row is updated with a version check and a before-image; every derived
 * figure — net worth at every later date, the series, freshness — simply reads
 * differently afterwards, because none of them was stored.
 *
 * The correction, the dormancy it clears and the episode a re-dating ends are
 * one transaction: a correction that woke an account and then failed to record
 * the balance would leave the flag and the evidence disagreeing (30.22 item 5).
 */
export async function correctValuation(
  deps: PositionDependencies,
  ctx: RequestContext,
  args: CorrectValuationArgs,
): Promise<ValuationRow> {
  const written = await withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    correctValuationIn(tx, ctx, args),
  );

  await deps.fx.ensureHistory(written.currency, args.valuedOn);
  return written.valuation;
}

export interface RemoveValuationArgs {
  readonly valuationId: string;
  /** The version the client rendered (6.3, 20.3, 30.22 item 10). */
  readonly expectedVersion: number;
  readonly reason?: string | undefined;
}

async function removeValuationIn(
  tx: Transaction,
  ctx: RequestContext,
  args: RemoveValuationArgs,
): Promise<ValuationRow> {
  const existing = await findValuationIn(tx, args.valuationId, { lock: 'update' });
  if (existing === undefined) throw new NotFoundError('That balance no longer exists.');

  const position = await requirePositionIn(tx, existing.positionId);
  if (position.status === 'closed' && existing.valuedOn === position.closedOn) {
    // Answered before the version, because it is true of the row at every
    // version: the closing balance of a closed account is not deletable here
    // whatever the caller last saw.
    throw new ImpossibleOperationError(
      'This is the closing balance of a closed account. Reopen the account first if you need to change it.',
    );
  }

  if (existing.version !== args.expectedVersion) {
    // The row moved since the user looked at it. Deleting the newest version
    // would remove a balance nobody meant to remove (30.22 item 10).
    throw new VersionConflictError(
      'This balance changed after you opened it. Reload to see what it says now.',
    );
  }

  const deleted = await deleteValuationIn(tx, auditContextOf(ctx, args.reason), args.valuationId);
  /* v8 ignore next -- the row is held under FOR UPDATE in this transaction. */
  if (deleted === undefined) throw new NotFoundError('That balance no longer exists.');

  await wakeIfAnchorRemovedIn(tx, ctx, position, existing.valuedOn);
  return deleted;
}

/**
 * Hard delete with a before-image (R12, T7), at the version the client saw.
 *
 * The delete and the dormant episode it ends are one transaction: `dormant_from`
 * names this row's date, so a deleted anchor with the flag left standing would
 * carry an account at zero on evidence that no longer exists (30.20 item 6).
 */
export async function removeValuation(
  deps: PositionDependencies,
  ctx: RequestContext,
  args: RemoveValuationArgs,
): Promise<ValuationRow> {
  return withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    removeValuationIn(tx, ctx, args),
  );
}

async function confirmMonthEndIn(
  tx: Transaction,
  ctx: RequestContext,
  args: { valuationId: string; expectedVersion: number },
): Promise<ValuationRow> {
  const existing = await findValuationIn(tx, args.valuationId, { lock: 'update' });
  if (existing === undefined) throw new NotFoundError('That balance no longer exists.');

  if (existing.datePrecision === 'month_end') {
    throw new ImpossibleOperationError('That balance is already the statement balance.');
  }

  assertDateRules(ctx, existing.valuedOn, 'month_end');

  const updated = await updateValuationIn(
    tx,
    auditContextOf(ctx),
    args.valuationId,
    args.expectedVersion,
    { datePrecision: 'month_end' },
  );
  if (updated === undefined) throw new VersionConflictError();
  return updated;
}

/**
 * Confirm an ordinary snapshot dated the last day of a month as that month's
 * **statement** balance (8.1, 8.8, R15).
 *
 * It upgrades the row's precision and nothing else: the amount is the user's
 * own figure and is untouched. Until this happens, a snapshot dated 30
 * September is just a snapshot, and September stays open.
 *
 * There is no dormancy consequence here and none is invented: the amount does
 * not move, so nothing about the account's episode changes. The mutex is taken
 * because the precision it reads and the precision it writes must be the same
 * row's (30.22 item 5).
 */
export async function confirmMonthEnd(
  deps: PositionDependencies,
  ctx: RequestContext,
  args: { valuationId: string; expectedVersion: number },
): Promise<ValuationRow> {
  return withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    confirmMonthEndIn(tx, ctx, args),
  );
}

async function confirmUnchangedIn(
  tx: Transaction,
  ctx: RequestContext,
  args: { positionId: string; month: string },
): Promise<ValuationRow> {
  const position = await requirePositionIn(tx, args.positionId);

  const parts = args.month.split('-');
  const month = monthKeyOf(Number(parts[0]), Number(parts[1]));
  const end = endOfMonthKey(month);

  if (!isMonthClosable(month, ctx.today)) {
    throw new ValidationError(
      'This month has not ended yet. Confirm it from the first day of the next month.',
      { month: ['This month has not ended yet.'] },
    );
  }

  // 30.20 item 8: a month the account's dormant episode covers carries at zero
  // and needs no confirmation — and writing one could put a non-zero statement
  // inside the episode. A month **before** `dormant_from` is an ordinary month:
  // the flag is present-tense and says nothing about it.
  const latest = await findLatestValuationIn(tx, args.positionId, end);
  if (carriedByDormancy(position, latest, end)) {
    throw new ImpossibleOperationError(dormantCarryMessage(position.name));
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
   *
   * Held `FOR SHARE`, as the batch has always held it: the figure carried
   * forward is still that statement when the confirmation commits.
   */
  const previous = await findValuationOnIn(tx, args.positionId, previousEnd, { lock: 'share' });
  if (previous === undefined || previous.datePrecision !== 'month_end') {
    throw new IncompleteDataError(
      `${monthName(previousMonth)} has no month-end balance, so there is nothing to carry forward. Close ${monthName(previousMonth)} first, or enter ${monthName(month)}’s statement balance instead.`,
    );
  }

  const existing = await findValuationOnIn(tx, args.positionId, end);
  if (existing !== undefined) {
    throw new DuplicateConflictError(`There is already a balance for ${end}.`);
  }

  assertWithinPositionWindow(position, end);

  return insertValuationIn(tx, auditContextOf(ctx), {
    positionId: args.positionId,
    valuedOn: end,
    amount: previous.amount,
    source: 'confirmed_unchanged',
    datePrecision: 'month_end',
  });
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
 *
 * Every eligibility read — the account, the dormant carry, the previous
 * statement, an existing balance on `end(M)` — now happens inside the write's
 * own transaction, so the month it judged is the month it writes into. The
 * batch below has held its own locks since it was written; this is the single
 * account catching up (30.22 item 5).
 */
export async function confirmUnchanged(
  deps: PositionDependencies,
  ctx: RequestContext,
  args: { positionId: string; month: string },
): Promise<ValuationRow> {
  return withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    confirmUnchangedIn(tx, ctx, args),
  );
}

export interface ConfirmUnchangedBatchArgs {
  /** The month being closed, as `YYYY-MM`. */
  readonly month: string;
  readonly positionIds: readonly string[];
}

export interface ConfirmUnchangedBatchSummary {
  readonly month: string;
  readonly valuedOn: string;
  readonly confirmed: number;
  readonly positionIds: readonly string[];
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/u;

async function confirmUnchangedBatchIn(
  tx: Transaction,
  ctx: RequestContext,
  args: {
    readonly requested: readonly string[];
    readonly month: MonthKey;
    readonly end: string;
    readonly previousMonth: MonthKey;
    readonly previousEnd: string;
  },
): Promise<void> {
  const audit: AuditContext = auditContextOf(ctx);

  // Locked first, in id order, and held until this transaction ends.
  const locked = await lockCashPositionsIn(tx, args.requested);
  const byId = new Map(locked.map((position) => [position.id, position]));

  for (const positionId of args.requested) {
    const position = byId.get(positionId);
    if (position === undefined) throw new NotFoundError('That account no longer exists.');
    if (carriedByDormancy(position, await findLatestValuationIn(tx, position.id, args.end), args.end)) {
      throw new ImpossibleOperationError(dormantCarryMessage(position.name));
    }
    if (position.openedOn !== null && position.openedOn > args.end) {
      throw new ValidationError(
        `${position.name} opened after ${monthName(args.month)}. Nothing was confirmed.`,
      );
    }
    if (position.closedOn !== null && position.closedOn <= args.end) {
      throw new ImpossibleOperationError(
        `${position.name} closed by the end of ${monthName(args.month)}, so its balance then is zero by definition. Nothing was confirmed.`,
      );
    }
  }

  for (const position of locked) {
    const previous = await findValuationOnIn(tx, position.id, args.previousEnd, { lock: 'share' });
    if (previous === undefined || previous.datePrecision !== 'month_end') {
      throw new IncompleteDataError(
        `${position.name}: ${monthName(args.previousMonth)} has no month-end balance, so there is nothing to carry forward. Nothing was confirmed.`,
      );
    }

    const existing = await findValuationOnIn(tx, position.id, args.end);
    if (existing !== undefined) {
      throw new DuplicateConflictError(
        `${position.name} already has a balance for ${args.end}, so nothing was confirmed. Reload to see it.`,
      );
    }

    await insertValuationIn(tx, audit, {
      positionId: position.id,
      valuedOn: args.end,
      amount: previous.amount,
      source: 'confirmed_unchanged',
      datePrecision: 'month_end',
    });
  }
}

/**
 * "Confirm all untouched as unchanged" (15.3, R22): `confirmUnchanged` for
 * several accounts of one month, as one act.
 *
 * Each account gets exactly what the single action writes — a `month_end`
 * valuation dated `end(M)`, source `confirmed_unchanged`, equal to its own
 * **previous month's statement balance** — and under the same rules. The
 * request names accounts, never amounts: every figure is read here.
 *
 * Everything the database decides happens in **one transaction** (20.3), and
 * that is the point rather than a detail. Eligibility is read from rows this
 * transaction has locked — `lockCashPositionsIn` holds each account's
 * `positions` and `cash_accounts` row for its whole length — so an account
 * cannot be closed or marked dormant between being judged eligible and being
 * confirmed. A preliminary read outside the transaction would have been a
 * snapshot of a state somebody else was free to change.
 *
 * Within it:
 *
 *  - every requested id must resolve to a cash account of this user. Another
 *    user's id, a nonexistent one and a position of another kind are all simply
 *    absent from the locked set and read the same (17.2, 17.3);
 *  - an account whose dormant episode covers `end(M)`, or that is not yet open
 *    by then or closed by then, is refused rather than skipped: dormancy carries
 *    at zero without a confirmation (R22), and a request naming one was not
 *    built from this page. A month before `dormant_from` is an ordinary month
 *    (v2.1.17 30.20 item 8);
 *  - the previous statement is read and held (`FOR SHARE`), so the figure
 *    carried forward is still that statement when the confirmation commits;
 *  - an existing balance on `end(M)` is never rewritten, whatever it is. A
 *    statement is corrected through its own editor, and an ordinary snapshot on
 *    the last day is confirmed, not replaced;
 *  - any of those fails the whole request and nothing is written, because a
 *    half-confirmed month is exactly the state that makes a total quietly wrong.
 *
 * Accounts are locked and written in id order, so two overlapping requests
 * queue rather than deadlock, and the unique `(position_id, valued_on)`
 * constraint settles a race with any other write on `end(M)`. Every audit row
 * carries the one request id.
 *
 * The transaction is now the per-user write mutex's (30.22 item 5). The row
 * locks stay: they encode local invariants and are the defence against
 * anything this service does not own.
 */
export async function confirmUnchangedBatch(
  deps: PositionDependencies,
  ctx: RequestContext,
  args: ConfirmUnchangedBatchArgs,
): Promise<ConfirmUnchangedBatchSummary> {
  // Everything that needs no database state is settled first, so a malformed
  // request never opens a transaction.
  if (!MONTH_PATTERN.test(args.month)) {
    throw new ValidationError('That is not a month.', { month: ['Expected YYYY-MM.'] });
  }
  const parts = args.month.split('-');
  const month = monthKeyOf(Number(parts[0]), Number(parts[1]));
  const end = endOfMonthKey(month);

  if (!isMonthClosable(month, ctx.today)) {
    throw new ValidationError(
      'This month has not ended yet. Confirm it from the first day of the next month.',
      { month: ['This month has not ended yet.'] },
    );
  }
  if (args.positionIds.length === 0) {
    throw new ValidationError('Choose at least one account.', { positionIds: ['Choose at least one account.'] });
  }
  if (new Set(args.positionIds).size !== args.positionIds.length) {
    throw new ValidationError('Each account may appear only once.', {
      positionIds: ['Each account may appear only once.'],
    });
  }

  const previousMonth = monthKey(addMonths(startOfMonth(end), -1));
  const previousEnd = endOfMonthKey(previousMonth);
  const requested = [...args.positionIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  try {
    await withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
      confirmUnchangedBatchIn(tx, ctx, { requested, month, end, previousMonth, previousEnd }),
    );
  } catch (error) {
    // A balance written on `end(M)` by another request after the check above.
    if (isUniqueViolation(error)) {
      throw new DuplicateConflictError(
        'One of these accounts got a balance for the month in the meantime, so nothing was confirmed. Reload and try again.',
      );
    }
    throw error;
  }

  return {
    month: (month as string).slice(0, 7),
    valuedOn: end,
    confirmed: args.positionIds.length,
    positionIds: [...args.positionIds],
  };
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

interface QuickUpdateWritten {
  readonly summary: QuickUpdateSummary;
  /** The currencies whose rate history the commit made worth warming (10.4). */
  readonly currencies: readonly string[];
}

async function quickUpdateIn(
  tx: Transaction,
  ctx: RequestContext,
  args: QuickUpdateArgs,
): Promise<QuickUpdateWritten> {
  const positions = await listPositionsIn(tx);
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

  const result = await quickUpdateValuationsIn(
    tx,
    auditContextOf(ctx),
    ctx.today,
    args.entries.map((item) => ({
      positionId: item.positionId,
      amount: item.amount,
      ...(item.expectedVersion === undefined ? {} : { expectedVersion: item.expectedVersion }),
    })),
  );

  // Every dormancy consequence of this batch, in the batch's own transaction.
  // Before, each clear was a further user write transaction *after* the
  // balances had already committed, so a failure in the middle left some
  // accounts holding money and still flagged dormant (ADR 0010 §15).
  const currencies = new Set<string>();
  for (const item of args.entries) {
    const position = byId.get(item.positionId);
    /* v8 ignore next -- validated in the loop above. */
    if (position === undefined) continue;
    await clearDormantIfNonZeroIn(tx, ctx, position, item.amount);
    currencies.add(position.currency);
  }

  return {
    summary: {
      valuedOn: ctx.today,
      inserted: result.inserted,
      corrected: result.corrected,
      positionIds: args.entries.map((item) => item.positionId),
    },
    currencies: [...currencies],
  };
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
 * The whole submission is one transaction — the balances, every dormancy clear
 * they cause, and the audit rows. 20.3 has a bulk save abort entirely on any
 * conflict, and a half-applied set of balances is precisely the state that
 * would make a net-worth figure quietly wrong.
 */
export async function quickUpdate(
  deps: PositionDependencies,
  ctx: RequestContext,
  args: QuickUpdateArgs,
): Promise<QuickUpdateSummary> {
  let written: QuickUpdateWritten;
  try {
    written = await withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
      quickUpdateIn(tx, ctx, args),
    );
  } catch (error) {
    if (error instanceof QuickUpdateConflictError) {
      throw new VersionConflictError(
        'One of these balances was changed elsewhere, so nothing was saved. Reload and try again.',
      );
    }
    throw error;
  }

  for (const currency of written.currencies) await deps.fx.ensureHistory(currency, ctx.today);
  return written.summary;
}

/**
 * Every valuation of a position, newest first — the account history.
 *
 * A read, not a mutation: it stays on the ordinary user-scoped read path
 * (ADR 0010 §8).
 */
export async function positionHistory(
  deps: PositionDependencies,
  ctx: RequestContext,
  positionId: string,
): Promise<ValuationRow[]> {
  const position = await findPosition(deps.db, ctx.userId, positionId);
  if (position === undefined) throw new NotFoundError('That account no longer exists.');
  return listValuations(deps.db, ctx.userId, positionId);
}
