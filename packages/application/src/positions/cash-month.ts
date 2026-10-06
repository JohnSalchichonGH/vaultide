import type { PositionRecord as PositionRow, ValuationRow } from '@vaultide/db';
import {
  addMonths,
  cashMonthState,
  endOfMonthKey,
  monthEndBalance,
  monthKey,
  money,
  serialize,
  startOfMonthKey,
  type MonthKey,
  type PositionWithValuations,
  type ValuationRecord,
} from '@vaultide/finance';
import type { CashMonthStateDto } from './types';
import { finalBalanceBreachOf } from './valuations';

/**
 * What the final-zero rule (M6, 5.2) reads to judge a month confirmed unchanged
 * on a closed account: the account, and its latest stored balance on or before
 * its closing day — `undefined` when it has none.
 */
export interface ClosedAccountFinal {
  readonly position: PositionRow;
  readonly latest: ValuationRow | undefined;
}

/**
 * An account's `ClosedAccountFinal`, from rows that reach its closing day: all
 * of its rows the caller holds up to that day, or the one row a read for it
 * returned. `null` for an account that is not closed, which the rule does not
 * judge and which needs nothing read.
 */
export function closedAccountFinalOf(
  position: PositionRow,
  rows: readonly ValuationRow[],
): ClosedAccountFinal | null {
  const closedOn = position.closedOn;
  if (position.status !== 'closed' || closedOn === null) return null;
  let latest: ValuationRow | undefined;
  for (const row of rows) {
    if (row.positionId !== position.id || row.valuedOn > closedOn) continue;
    if (latest === undefined || row.valuedOn > latest.valuedOn) latest = row;
  }
  return { position, latest };
}

/**
 * Whether confirming M unchanged — carrying `previous` to M's last day — would
 * leave a closed account's final balance non-zero. Both confirm-unchanged
 * resolvers ask it, and this asks the same rule they do (`finalBalanceBreachOf`).
 *
 * An account that is not closed is not judged, and neither is a month that ends
 * after the closing day: a balance there is outside the account's window (M4),
 * which is not this rule's question.
 */
function confirmationBreachesFinalZero(
  entry: PositionWithValuations,
  month: MonthKey,
  previous: ValuationRecord,
  closed: ClosedAccountFinal | null,
): boolean {
  if (entry.position.status !== 'closed') return false;
  if (closed === null || closed.position.id !== entry.position.id) {
    throw new Error('a closed account’s month was described without its final balance');
  }
  const end = endOfMonthKey(month);
  const closedOn = closed.position.closedOn;
  if (closedOn !== null && end > closedOn) return false;

  const breach = finalBalanceBreachOf(
    [
      {
        position: closed.position,
        existing: null,
        columns: { amount: previous.amount.toString(), valuedOn: end, datePrecision: 'month_end', note: null },
      },
    ],
    closed.latest === undefined ? [] : [closed.latest],
  );
  return breach !== undefined;
}

/**
 * One cash account's month, as every page reads it (blueprint 8.1, R15, R22).
 *
 * Phase 2's `cashMonthState` in DTO form. The Accounts pages show it for the
 * last completed month and Monthly shows it for the month on screen, and both
 * call this function, so the two can never describe the same account-month
 * differently. `rows` are the loaded valuation rows the states were computed
 * from; they supply the version a correction must send. `closed` is what the
 * final-zero rule reads for a closed account (`closedAccountFinalOf`), and
 * `null` for any other.
 */
export function cashMonthStateDto(
  entry: PositionWithValuations,
  month: MonthKey,
  currency: string,
  rows: readonly ValuationRow[],
  closed: ClosedAccountFinal | null,
): CashMonthStateDto {
  const state = cashMonthState(entry.position, entry.valuations, month);
  const versionOf = (id: string): number =>
    rows.find((row) => row.id === id)?.version ?? 1;

  // "Unchanged this month" carries the previous month's statement balance, so
  // it is only available once that month is closed (8.1, R22) — and on a
  // closed account, only while the figure carried keeps its final balance zero
  // (M6), which the server refuses otherwise.
  const previousMonth = monthKey(addMonths(startOfMonthKey(month), -1));
  const previous = monthEndBalance(entry.valuations, previousMonth);
  const canConfirmUnchanged =
    previous !== undefined && !confirmationBreachesFinalZero(entry, month, previous, closed);

  return {
    month: (month as string).slice(0, 7),
    open: state.open,
    close: state.close,
    included: state.included,
    firstBalance: state.excludedFirstBalance,
    monthEnd:
      state.monthEnd === undefined
        ? null
        : {
            valuationId: state.monthEnd.id,
            amount: serialize(money(state.monthEnd.amount, currency)),
          },
    confirmable:
      state.confirmableSnapshot === undefined
        ? null
        : {
            valuationId: state.confirmableSnapshot.id,
            amount: serialize(money(state.confirmableSnapshot.amount, currency)),
            version: versionOf(state.confirmableSnapshot.id),
          },
    canConfirmUnchanged,
  };
}
