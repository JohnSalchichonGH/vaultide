import {
  Decimal,
  endOfMonthKey,
  isMonthCompleted,
  monthKey,
  reconcileCompletedMonth,
  reconcileMonthToDate,
  type MonthKey,
  type PlainDate,
} from '@vaultide/finance';
import type { IncomeEntryRow } from '@vaultide/db';
import type { RequestContext } from '../context';
import { ValidationError, VersionConflictError } from '../errors';
import { loadCompletedMonth } from '../reconciliation/loader';
import { loadMonthToDate } from '../reconciliation/mtd-loader';
import { createIncomeEntry } from './income';
import type { FlowDependencies } from './shared';

/**
 * "Accept as adjustment" (blueprint 8.5, 30.21; ADR 0009 §5–§9).
 *
 * The fallback for `unexplained_inflow`, and the one corrective action whose
 * justification is a **derived** figure rather than a fact the user is
 * asserting. Everything else a corrective action records — an income entry, a
 * transfer, an expense — is something the user knows happened and can edit. An
 * adjustment is the opposite: "I cannot identify the real record; accept the
 * difference as it stands".
 *
 * So the browser sends which bucket it was looking at and the amount it
 * displayed, and this service derives the row:
 *
 *  - it recomputes the month's authoritative reconciliation through the same
 *    engines every read uses, and finds that currency's `unexplained_inflow`;
 *  - it refuses when the issue has gone or its amount has moved, so a page left
 *    open while the month changed elsewhere cannot record a discrepancy the
 *    month no longer has — which would satisfy the identity twice and leave a
 *    `reliable` month holding spending nobody spent;
 *  - it takes the amount from **its own** result, never from the request;
 *  - it writes no cash account: the residual is a bucket-level fact (8.2) and
 *    naming an account would invent an attribution, move that account's
 *    residual and clear its dormancy (8.3, 8.8);
 *  - it dates the row at the interval's endpoint — `end(M)` for a completed
 *    month, `D` for the current one — because that is where the discrepancy was
 *    measured, and no other date is evidenced.
 *
 * The row itself is an ordinary `income_entries` row written through
 * `createIncomeEntry`, so the null-leg rule, the future-date rule, dormancy,
 * audit and the transaction boundary are the ones every flow already gets. 7.4
 * gives `adjustment` the `I` cash role and 12.5 keeps it out of income, so
 * nothing here reclassifies anything.
 *
 * The precondition is read before the write's transaction: it closes the stale
 * view, which is the failure the interaction actually produces, and not a
 * simultaneous double submit, which the disabled control covers. A database
 * constraint for that race would be schema invented for a case the product does
 * not create, and would refuse a second, legitimate adjustment in a month a
 * user really corrected twice.
 */

export interface AcceptAdjustmentArgs {
  readonly month: MonthKey;
  readonly currency: string;
  /** The unexplained amount the browser displayed, for stale detection alone. */
  readonly expectedAmount: string;
  readonly note?: string | undefined;
}

/** What the month currently says is unexplained, and where the evidence ends. */
interface Discrepancy {
  readonly amount: Decimal;
  readonly on: PlainDate;
}

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

/** "September 2026" from a month key, for a description a person can recognize. */
function monthLabel(month: MonthKey): string {
  const [year, index] = (month as string).slice(0, 7).split('-');
  const name = MONTH_NAMES[Number.parseInt(index as string, 10) - 1];
  return name === undefined || year === undefined ? month : `${name} ${year}`;
}

/**
 * What the row says it is, in Income and in history.
 *
 * The default names the month, so an adjustment is recognizable months later
 * beside the ordinary income of that month; a note the user added follows it.
 * Neither is a financial fact — the kind is — but a row nobody can identify is
 * a row nobody will ever correct.
 */
function descriptionOf(month: MonthKey, note: string | undefined): string {
  const base = `Reconciliation adjustment — ${monthLabel(month)}`;
  const trimmed = note?.trim() ?? '';
  return trimmed === '' ? base : `${base}: ${trimmed}`;
}

function stale(currency: string, month: MonthKey): VersionConflictError {
  return new VersionConflictError(
    `The ${currency} reconciliation for ${monthLabel(month)} has changed since you opened it. Reload the month and look at what it says now.`,
  );
}

/** The current unexplained inflow of one bucket, from the authoritative engine. */
async function discrepancyOf(
  deps: FlowDependencies,
  ctx: RequestContext,
  month: MonthKey,
  currency: string,
): Promise<Discrepancy> {
  const current = monthKey(ctx.today);
  if (month > current) {
    throw new ValidationError('That month has not started yet.', {
      month: ['Choose this month or an earlier one.'],
    });
  }

  if (isMonthCompleted(month, ctx.today)) {
    const loaded = await loadCompletedMonth(deps, ctx.userId, month, ctx.today);
    const result = reconcileCompletedMonth(loaded.input);
    const bucket = result.buckets.find((row) => row.currency === currency);
    const issue = bucket?.issues.find((row) => row.key === 'unexplained_inflow');
    if (issue?.amount === undefined) throw stale(currency, month);
    return { amount: issue.amount, on: endOfMonthKey(month) };
  }

  // The current month: month-to-date reconciles through `D`, so that is where
  // the discrepancy is measured and where the adjustment belongs (8.6, 30.21
  // items 5–7). Without a `D` there is no interval and no such issue at all.
  const data = await loadMonthToDate(deps, ctx.userId, ctx.today);
  const result = reconcileMonthToDate(data.input);
  if (result.asOf === null) throw stale(currency, month);
  const bucket = result.buckets.find((row) => row.currency === currency);
  const issue = bucket?.issues.find((row) => row.key === 'unexplained_inflow');
  if (issue?.amount === undefined) throw stale(currency, month);
  return { amount: issue.amount, on: result.asOf };
}

/**
 * Record the month's current unexplained inflow as a reconciliation adjustment.
 *
 * Returns the row it wrote, which is an ordinary income entry from that moment
 * on: visible in Income, correctable and deletable through the usual editors.
 */
export async function acceptUnexplainedInflowAsAdjustment(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: AcceptAdjustmentArgs,
): Promise<IncomeEntryRow> {
  const currency = args.currency.trim().toUpperCase();
  const discrepancy = await discrepancyOf(deps, ctx, args.month, currency);

  // Exact decimals, never their spelling: "1702.00" and "1702" are the same
  // discrepancy, and a cent of difference is a different one.
  if (!discrepancy.amount.equals(new Decimal(args.expectedAmount))) {
    throw stale(currency, args.month);
  }

  return createIncomeEntry(deps, ctx, {
    kind: 'adjustment',
    receivedOn: discrepancy.on,
    // The server's own figure. The request's copy decided only whether this
    // acceptance was still about the discrepancy the user saw.
    netAmount: discrepancy.amount.toString(),
    currency,
    settlement: 'tracked_cash',
    // 8.2's residual belongs to the bucket, not to an account (ADR 0009 §6).
    cashPositionId: null,
    description: descriptionOf(args.month, args.note),
  });
}
