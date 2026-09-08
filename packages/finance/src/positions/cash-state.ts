import {
  addMonths,
  endOfMonthKey,
  monthKey,
  startOfMonthKey,
  type MonthKey,
  type PlainDate,
} from '../dates/plain-date';
import { latestOnOrBefore, valuationOn } from './valuation';
import type { PositionRecord, ValuationRecord } from './types';

/**
 * Cash-account month states (blueprint 8.1).
 *
 * These are the states the whole reconciliation model rests on, and they are
 * the answer to the specification's most dangerous ambiguity: what a month
 * means when a balance is missing, stale, or dated mid-month (C7, F1). Phase 2
 * builds and tests them; Phase 3's inferred-spending engine consumes them.
 *
 * The rule that makes the difference is that only a `month_end` valuation —
 * "the balance at the end of M, as read from a statement" — closes a month. An
 * ordinary snapshot dated the last day of the month is still an ordinary
 * snapshot until it is confirmed as the statement balance (8.8, R15), and a
 * month that has only ordinary snapshots is `carried`, not closed.
 */

export type CashCloseState =
  /** A statement balance dated the last day of M exists. */
  | 'month_end'
  /** The account closed inside M: its balance is zero by definition. */
  | 'closed_zero'
  /** Flagged dormant with no month-end balance: carried at zero (R22). */
  | 'dormant_zero'
  /** A valuation ≤ end(M) exists, but it is not M's statement balance. */
  | 'carried'
  /** No valuation at all on or before end(M). */
  | 'missing';

export type CashOpenState =
  | CashCloseState
  /** The account opened inside M, so it opened the month at zero. */
  | 'opened_zero'
  /**
   * A pre-existing account whose first balance lands in M. Its earlier
   * movements are unknown, so it is **excluded** from M's bucket rather than
   * being allowed to look like a month of spending (8.1, R5 `estimated`).
   */
  | 'first_balance';

/** `true` when the row is M's statement month-end balance (R15). */
function isMonthEndBalanceFor(valuation: ValuationRecord, month: MonthKey): boolean {
  return valuation.datePrecision === 'month_end' && valuation.valuedOn === endOfMonthKey(month);
}

export function monthEndBalance(
  valuations: readonly ValuationRecord[],
  month: MonthKey,
): ValuationRecord | undefined {
  const candidate = valuationOn(valuations, endOfMonthKey(month));
  return candidate !== undefined && isMonthEndBalanceFor(candidate, month) ? candidate : undefined;
}

/**
 * An ordinary snapshot dated the last day of M, which the month editor offers
 * to confirm as the statement balance once the month has ended (8.1, 8.8).
 */
export function lastDaySnapshot(
  valuations: readonly ValuationRecord[],
  month: MonthKey,
): ValuationRecord | undefined {
  const candidate = valuationOn(valuations, endOfMonthKey(month));
  return candidate !== undefined && candidate.datePrecision === 'exact' ? candidate : undefined;
}

/** `close(a, M)` exactly as 8.1 defines it, in the order 8.1 defines it. */
export function cashCloseState(
  position: PositionRecord,
  valuations: readonly ValuationRecord[],
  month: MonthKey,
): CashCloseState {
  const end = endOfMonthKey(month);

  if (monthEndBalance(valuations, month) !== undefined) return 'month_end';

  const closedOn = position.closedOn;
  if (closedOn !== null && closedOn >= startOfMonthKey(month) && closedOn <= end) {
    return 'closed_zero';
  }

  if (position.isDormant === true) return 'dormant_zero';

  return latestOnOrBefore(valuations, end) === undefined ? 'missing' : 'carried';
}

/**
 * `open(a, M)` = `close(a, M−1)`, with the two exceptions of 8.1.
 *
 * The exceptions are not cosmetic. `opened_zero` says the account genuinely
 * started at nothing, so its whole balance change is explainable. And
 * `first_balance` says the opposite — the account existed and moved before we
 * were watching — which is why such an account is excluded from the month
 * rather than treated as a month's worth of activity.
 */
export function cashOpenState(
  position: PositionRecord,
  valuations: readonly ValuationRecord[],
  month: MonthKey,
): CashOpenState {
  const start = startOfMonthKey(month);
  const end = endOfMonthKey(month);

  const openedOn = position.openedOn;
  if (openedOn !== null && openedOn >= start && openedOn <= end) return 'opened_zero';

  const hasEarlierValuation = valuations.some((valuation) => valuation.valuedOn < start);
  if (!hasEarlierValuation && monthEndBalance(valuations, month) !== undefined) {
    return 'first_balance';
  }

  const previous = monthKey(addMonths(start, -1));
  return cashCloseState(position, valuations, previous);
}

/** `true` when the account participates in bucket (M, C) at all (8.1). */
export function participatesIn(position: PositionRecord, month: MonthKey): boolean {
  const start = startOfMonthKey(month);
  const end = endOfMonthKey(month);
  const openedOk = position.openedOn === null || position.openedOn <= end;
  const closedOk = position.closedOn === null || position.closedOn >= start;
  return openedOk && closedOk;
}

export interface CashMonthState {
  readonly position: PositionRecord;
  readonly month: MonthKey;
  readonly open: CashOpenState;
  readonly close: CashCloseState;
  /**
   * `true` when the account's opening **and** closing are both settled, which
   * is what 8.1 calls an included account. Phase 3's reconciliation needs the
   * whole bucket to be included before it will infer anything.
   */
  readonly included: boolean;
  /** `true` when the account is excluded because its first balance lands here. */
  readonly excludedFirstBalance: boolean;
  /** The statement balance, when one exists. */
  readonly monthEnd?: ValuationRecord;
  /** An unconfirmed snapshot on the last day, offered for confirmation. */
  readonly confirmableSnapshot?: ValuationRecord;
}

const SETTLED: readonly string[] = ['month_end', 'opened_zero', 'closed_zero', 'dormant_zero'];

export function cashMonthState(
  position: PositionRecord,
  valuations: readonly ValuationRecord[],
  month: MonthKey,
): CashMonthState {
  const open = cashOpenState(position, valuations, month);
  const close = cashCloseState(position, valuations, month);
  const monthEnd = monthEndBalance(valuations, month);
  const snapshot = monthEnd === undefined ? lastDaySnapshot(valuations, month) : undefined;

  return {
    position,
    month,
    open,
    close,
    included: SETTLED.includes(open) && SETTLED.includes(close),
    excludedFirstBalance: open === 'first_balance',
    ...(monthEnd === undefined ? {} : { monthEnd }),
    ...(snapshot === undefined ? {} : { confirmableSnapshot: snapshot }),
  };
}

/**
 * `true` when month M is over on `today` — the gate on writing a month-end
 * balance at all (M5, R15). On 30 September a September statement balance does
 * not exist yet; on 1 October it does.
 *
 * Stated here as well as in `validation` because the engines answer "may this
 * month be closed?" for the UI, and the server answers it again for the write.
 * Neither trusts the other, and neither reads a clock: `today` is passed in.
 */
export function isMonthClosable(month: MonthKey, today: PlainDate): boolean {
  return today > endOfMonthKey(month);
}
