import {
  addDismissedIssue,
  dismissedKeysOf,
  findMonthReview,
  recordMonthReviewed,
  removeDismissedIssue,
  type Database,
  type MonthReviewRow,
} from '@vaultide/db';
import {
  ISSUE_CLASS,
  isMonthCompleted,
  monthKey,
  type IssueKey,
  type MonthKey,
} from '@vaultide/finance';
import type { RequestContext } from '../context';
import { ValidationError } from '../errors';
import type { MonthReviewDto } from './types';

/**
 * A month's review state: the review mark and the dismissed advisories
 * (blueprint 5.1, 6.2, 8.5, 20.3).
 *
 * User state, not a financial fact, and every rule here follows from that:
 *
 *  - Marking a month reviewed records that somebody looked at it — nothing more.
 *    It is allowed for any **completed** month whatever its reconciliation status
 *    or completeness, it locks nothing, and it is not undone when the data
 *    behind the month changes later. A month that has not ended cannot have been
 *    reviewed (6.2: a service rule, never a constraint).
 *  - A dismissal hides one advisory **key** for one month. It is key-level
 *    because `dismissed_issues` stores keys (6.2, D47): dismissing
 *    `suggested_income_missing` hides every occurrence of it that month, and
 *    records no skip, satisfies no requirement and removes no issue from any
 *    result. Only a key the catalogue classes `advisory` may be dismissed — a
 *    blocking issue is resolved by the data, and an info issue is not a problem
 *    to dismiss (8.5). The class is looked up here, never taken from a request.
 *  - Dismissing is allowed for the current month too, because it is display
 *    state; nothing is ever recorded for a month that has not begun.
 */

export interface MonthReviewDependencies {
  readonly db: Database;
}

/** A month's stored review as the page reads it; no row is unreviewed with nothing dismissed. */
export function reviewDtoOf(row: MonthReviewRow | undefined): MonthReviewDto {
  if (row === undefined) return { reviewedAt: null, dismissedIssueKeys: [] };
  return {
    reviewedAt: row.reviewedAt === null ? null : row.reviewedAt.toISOString(),
    dismissedIssueKeys: dismissedKeysOf(row),
  };
}

const auditContextOf = (ctx: RequestContext) => ({ userId: ctx.userId, requestId: ctx.requestId });

/**
 * The advisory key a request names, from the authoritative catalogue.
 *
 * `Object.hasOwn` and not an index: `constructor` is a well-formed key and
 * `ISSUE_CLASS.constructor` is `Object`, which must read as unknown rather than
 * as a key of some other class.
 */
function advisoryKeyOf(key: string): IssueKey {
  if (!Object.hasOwn(ISSUE_CLASS, key)) {
    throw new ValidationError('That is not an issue Vaultide raises.', {
      key: ['Unknown issue.'],
    });
  }
  if (ISSUE_CLASS[key as IssueKey] !== 'advisory') {
    throw new ValidationError(
      'Only advisories can be hidden. A blocking issue is resolved by correcting the data, and an informational note is not a problem.',
      { key: ['This issue cannot be dismissed.'] },
    );
  }
  return key as IssueKey;
}

/** Dismissal state exists for completed months and the current month, never a later one. */
function assertNotFuture(ctx: RequestContext, month: MonthKey): void {
  if (month > monthKey(ctx.today)) {
    throw new ValidationError('That month has not started yet.', {
      month: ['Choose this month or an earlier one.'],
    });
  }
}

/** The month's review state; a month with no row is unreviewed with nothing dismissed. */
export async function readMonthReview(
  deps: MonthReviewDependencies,
  ctx: RequestContext,
  month: MonthKey,
): Promise<MonthReviewDto> {
  return reviewDtoOf(await findMonthReview(deps.db, ctx.userId, month));
}

/**
 * Mark a completed month reviewed.
 *
 * Idempotent: a month already reviewed keeps the time it was first marked, so
 * calling this again changes nothing.
 */
export async function markMonthReviewed(
  deps: MonthReviewDependencies,
  ctx: RequestContext,
  month: MonthKey,
): Promise<MonthReviewDto> {
  if (!isMonthCompleted(month, ctx.today)) {
    throw new ValidationError('A month can be marked reviewed once it has ended.', {
      month: ['This month is not over yet.'],
    });
  }
  return reviewDtoOf(await recordMonthReviewed(deps.db, auditContextOf(ctx), month));
}

/** Hide one advisory key for one month. Dismissing it again changes nothing. */
export async function dismissMonthAdvisory(
  deps: MonthReviewDependencies,
  ctx: RequestContext,
  month: MonthKey,
  key: string,
): Promise<MonthReviewDto> {
  assertNotFuture(ctx, month);
  const advisory = advisoryKeyOf(key);
  return reviewDtoOf(await addDismissedIssue(deps.db, auditContextOf(ctx), month, advisory));
}

/**
 * Show a dismissed advisory key again.
 *
 * Restoring a key that is not dismissed changes nothing and creates no row;
 * every other stored key is kept.
 */
export async function restoreMonthAdvisory(
  deps: MonthReviewDependencies,
  ctx: RequestContext,
  month: MonthKey,
  key: string,
): Promise<MonthReviewDto> {
  assertNotFuture(ctx, month);
  const advisory = advisoryKeyOf(key);
  // `undefined` means the month has no row at all: unreviewed, nothing dismissed.
  return reviewDtoOf(await removeDismissedIssue(deps.db, auditContextOf(ctx), month, advisory));
}
