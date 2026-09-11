import type { ValuationRow } from '@vaultide/db';
import {
  addMonths,
  cashMonthState,
  monthEndBalance,
  monthKey,
  money,
  serialize,
  startOfMonthKey,
  type MonthKey,
  type PositionWithValuations,
} from '@vaultide/finance';
import type { CashMonthStateDto } from './types';

/**
 * One cash account's month, as every page reads it (blueprint 8.1, R15, R22).
 *
 * Phase 2's `cashMonthState` in DTO form. The Accounts pages show it for the
 * last completed month and Monthly shows it for the month on screen, and both
 * call this function, so the two can never describe the same account-month
 * differently. `rows` are the loaded valuation rows the states were computed
 * from; they supply the version a correction must send.
 */
export function cashMonthStateDto(
  entry: PositionWithValuations,
  month: MonthKey,
  currency: string,
  rows: readonly ValuationRow[],
): CashMonthStateDto {
  const state = cashMonthState(entry.position, entry.valuations, month);
  const versionOf = (id: string): number =>
    rows.find((row) => row.id === id)?.version ?? 1;

  // "Unchanged this month" carries the previous month's statement balance, so
  // it is only available once that month is closed (8.1, R22).
  const previousMonth = monthKey(addMonths(startOfMonthKey(month), -1));
  const canConfirmUnchanged = monthEndBalance(entry.valuations, previousMonth) !== undefined;

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
