import { and, eq, sql } from 'drizzle-orm';
import { monthReviews, type MonthReviewRow } from '../schema/month-reviews';
import { withUser, type Database, type Transaction } from '../client';
import { recordAudit, type AuditContext } from './audited';

/**
 * `month_reviews` reads and writes (blueprint 5.1, 6.2, 20.3, D47).
 *
 * A month review is the user's own state about a month — that they looked at
 * it, and which advisory keys they want out of sight — and never a financial
 * fact. Nothing here is read by an engine.
 *
 * Three rules shape every write:
 *
 *  - **Last write wins** (20.3). There is no `expectedVersion`: the row is locked
 *    for the length of the transaction instead, so two writes serialize rather
 *    than one of them being refused.
 *  - **Each write changes one field.** The row is read under that lock and only
 *    the field the caller named is written, so marking a month reviewed keeps its
 *    dismissals and its note, and a dismissal keeps the review and the note.
 *  - **Audited like any other source row** (5.2): an insert or an update writes
 *    its `audit_entries` row in the same transaction. A write that would change
 *    nothing writes nothing — neither the row nor an audit entry.
 *
 * `dismissed_issues` is handled as a set of opaque strings (6.1). Keys this
 * code does not recognise are kept exactly, because a later phase's advisory
 * key is still somebody's dismissal. A value that is not an array of strings
 * cannot have been written here, so it is refused rather than guessed at.
 */

/** Raised when `dismissed_issues` holds something other than an array of strings. */
export class MalformedMonthReviewError extends Error {
  readonly code = 'MALFORMED_MONTH_REVIEW';
  constructor(readonly reviewId: string) {
    super(`month review ${reviewId} holds a dismissed_issues value that is not an array of strings`);
    this.name = 'MalformedMonthReviewError';
  }
}

/**
 * The stored dismissal keys, as a sorted set.
 *
 * Sorted so the serialized value — and so every audit image — is the same
 * whatever order the keys were added in.
 */
export function dismissedKeysOf(row: Pick<MonthReviewRow, 'id' | 'dismissedIssues'>): string[] {
  const value = row.dismissedIssues;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new MalformedMonthReviewError(row.id);
  }
  return [...new Set(value as string[])].sort();
}

export async function findMonthReview(
  db: Database,
  userId: string,
  month: string,
): Promise<MonthReviewRow | undefined> {
  const [row] = await withUser(db, { userId }, async (tx) =>
    tx
      .select()
      .from(monthReviews)
      .where(and(eq(monthReviews.userId, userId), eq(monthReviews.month, month)))
      .limit(1),
  );
  return row;
}

/** The one field a write changes; the other is left exactly as stored. */
type ReviewChange =
  | { readonly field: 'reviewedAt' }
  | { readonly field: 'dismissedIssues'; readonly dismissedIssues: readonly string[] };

function changeValues(change: ReviewChange) {
  return change.field === 'reviewedAt'
    ? { reviewedAt: sql`now()` }
    : { dismissedIssues: [...change.dismissedIssues] };
}

/**
 * Apply one change to one month's row, creating the row if it does not exist.
 *
 * `next` sees the current state — or the empty state, for a month with no row —
 * and returns the one change it wants, or `undefined` for "nothing to change".
 * The row is locked first; if it does not exist it is inserted, and an insert
 * that loses a race to a concurrent one falls back to locking the row that won.
 */
async function applyChange(
  tx: Transaction,
  ctx: AuditContext,
  month: string,
  next: (current: {
    readonly reviewed: boolean;
    readonly dismissedIssues: readonly string[];
  }) => ReviewChange | undefined,
): Promise<MonthReviewRow | undefined> {
  const lock = async (): Promise<MonthReviewRow | undefined> => {
    const [row] = await tx
      .select()
      .from(monthReviews)
      .where(and(eq(monthReviews.userId, ctx.userId), eq(monthReviews.month, month)))
      .limit(1)
      .for('update');
    return row;
  };

  const update = async (before: MonthReviewRow): Promise<MonthReviewRow> => {
    const wanted = next({
      reviewed: before.reviewedAt !== null,
      dismissedIssues: dismissedKeysOf(before),
    });
    if (wanted === undefined) return before;

    // `updated_at` is maintained by the table's trigger (6.1).
    const [after] = await tx
      .update(monthReviews)
      .set({ ...changeValues(wanted), version: sql`${monthReviews.version} + 1` })
      .where(eq(monthReviews.id, before.id))
      .returning();

    const updated = after as MonthReviewRow;
    await recordAudit(tx, ctx, {
      entityTable: 'month_reviews',
      entityId: updated.id,
      action: 'update',
      before,
      after: updated,
    });
    return updated;
  };

  const existing = await lock();
  if (existing !== undefined) return update(existing);

  const wanted = next({ reviewed: false, dismissedIssues: [] });
  if (wanted === undefined) return undefined;

  const [inserted] = await tx
    .insert(monthReviews)
    .values({ userId: ctx.userId, month, ...changeValues(wanted) })
    .onConflictDoNothing({ target: [monthReviews.userId, monthReviews.month] })
    .returning();

  if (inserted !== undefined) {
    await recordAudit(tx, ctx, {
      entityTable: 'month_reviews',
      entityId: inserted.id,
      action: 'insert',
      after: inserted,
    });
    return inserted;
  }

  // A concurrent write created the row between our lock and our insert. Lock
  // the one that won and apply this change to it.
  const raced = await lock();
  /* v8 ignore next -- the conflicting row was committed before our insert returned. */
  if (raced === undefined) throw new Error(`month review for ${month} vanished during a write`);
  return update(raced);
}

/**
 * Record that the user reviewed this month.
 *
 * Idempotent: a month already marked keeps its original `reviewed_at`, and a
 * repeated request writes nothing. The timestamp is the database's own.
 * Whether the month is over is a service rule about the moving present, and is
 * checked by the caller (6.2, M5).
 */
export async function recordMonthReviewed(
  db: Database,
  ctx: AuditContext,
  month: string,
): Promise<MonthReviewRow> {
  const row = await withUser(db, { userId: ctx.userId }, async (tx) =>
    applyChange(tx, ctx, month, (current) =>
      current.reviewed ? undefined : { field: 'reviewedAt' },
    ),
  );
  /* v8 ignore next -- marking always either finds, updates or inserts a row. */
  if (row === undefined) throw new Error(`month review for ${month} was not written`);
  return row;
}

/** Add one key to the month's dismissed set. Adding a key already there writes nothing. */
export async function addDismissedIssue(
  db: Database,
  ctx: AuditContext,
  month: string,
  key: string,
): Promise<MonthReviewRow> {
  const row = await withUser(db, { userId: ctx.userId }, async (tx) =>
    applyChange(tx, ctx, month, (current) =>
      current.dismissedIssues.includes(key)
        ? undefined
        : { field: 'dismissedIssues', dismissedIssues: [...current.dismissedIssues, key].sort() },
    ),
  );
  /* v8 ignore next -- a new key always either updates or inserts a row. */
  if (row === undefined) throw new Error(`month review for ${month} was not written`);
  return row;
}

/**
 * Remove one key from the month's dismissed set.
 *
 * Removing a key that is not there — including from a month with no row at
 * all — writes nothing and creates no row. Every other stored key stays.
 */
export async function removeDismissedIssue(
  db: Database,
  ctx: AuditContext,
  month: string,
  key: string,
): Promise<MonthReviewRow | undefined> {
  return withUser(db, { userId: ctx.userId }, async (tx) =>
    applyChange(tx, ctx, month, (current) =>
      current.dismissedIssues.includes(key)
        ? {
            field: 'dismissedIssues',
            dismissedIssues: current.dismissedIssues.filter((item) => item !== key),
          }
        : undefined,
    ),
  );
}
