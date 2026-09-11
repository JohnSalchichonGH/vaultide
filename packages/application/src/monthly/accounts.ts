import type { ValuationRow } from '@vaultide/db';
import {
  addDays,
  addMonths,
  endOfMonthKey,
  isUnavailable,
  latestOnOrBefore,
  monthEndBalance,
  monthKey,
  monthToDateOpening,
  participatesIn,
  serialize,
  startOfMonthKey,
  valueAt,
  type CashAccountInput,
  type CashOpenState,
  type Decimal,
  type MoneyDto,
  type MonthKey,
  type PlainDate,
  type PositionWithValuations,
  type ValuationRecord,
} from '@vaultide/finance';
import { cashMonthStateDto } from '../positions/cash-month';
import { moneyDto } from '../positions/mapping';
import type { CashMonthStateDto } from '../positions/types';
import type {
  AccountOpeningDto,
  CompletedAccountsDto,
  CompletedClosingDto,
  CurrentAccountsDto,
} from './types';

/**
 * The Monthly page's Accounts section, from rows already loaded (blueprint 8.1,
 * 8.6, 15.3 section 4, 23.2).
 *
 * Nothing here queries and nothing here decides a state. A completed month's
 * accounts are Phase 2's `cashMonthState` through the same helper the Accounts
 * pages use; the current month's openings are the month-to-date engine's own,
 * and their latest balances are Phase 2's `valueAt`. What this adds is the
 * evidence an edit needs beside each state — a row's id and version, the
 * previous statement, the latest snapshot as a hint — taken from the same
 * valuation rows the states were computed from.
 */

const label = (month: MonthKey): string => (month as string).slice(0, 7);

const previousMonthOf = (month: MonthKey): MonthKey =>
  monthKey(addMonths(startOfMonthKey(month), -1));

/** An opening state, with the statement it carries when it is one (8.1, 8.6). */
function openingDto(
  opening: { readonly state: CashOpenState; readonly amount?: Decimal; readonly valuedOn?: PlainDate },
  currency: string,
): AccountOpeningDto {
  switch (opening.state) {
    case 'month_end': {
      /* v8 ignore next 3 -- `month_end` is precisely the state whose statement row exists. */
      if (opening.amount === undefined || opening.valuedOn === undefined) {
        throw new Error('a month_end opening without its statement');
      }
      return {
        kind: 'statement',
        amount: moneyDto(opening.amount.toString(), currency),
        valuedOn: opening.valuedOn,
      };
    }
    case 'opened_zero':
      return { kind: 'opened_zero' };
    case 'dormant_zero':
      return { kind: 'dormant_zero' };
    case 'closed_zero':
      return { kind: 'closed_zero' };
    case 'first_balance':
      return { kind: 'first_balance' };
    case 'carried':
    case 'missing':
      return { kind: 'no_statement', state: opening.state };
  }
}

/** The latest ordinary snapshot dated inside M before its last day — a hint only (15.3). */
function latestSnapshotIn(
  valuations: readonly ValuationRecord[],
  month: MonthKey,
  currency: string,
): { amount: MoneyDto; valuedOn: string } | null {
  const start = startOfMonthKey(month);
  const lastDay = endOfMonthKey(month);
  const inMonth = valuations.filter(
    (valuation) =>
      valuation.datePrecision === 'exact' && valuation.valuedOn >= start && valuation.valuedOn < lastDay,
  );
  const latest = latestOnOrBefore(inMonth, lastDay);
  return latest === undefined
    ? null
    : { amount: moneyDto(latest.amount.toString(), currency), valuedOn: latest.valuedOn };
}

/** The Current cell of a completed month, from the month's own closing state. */
function closingDto(
  state: CashMonthStateDto,
  entry: PositionWithValuations,
  month: MonthKey,
  rowById: ReadonlyMap<string, ValuationRow>,
  currency: string,
): CompletedClosingDto {
  switch (state.close) {
    case 'month_end': {
      const monthEnd = state.monthEnd;
      const row = monthEnd === null ? undefined : rowById.get(monthEnd.valuationId);
      /* v8 ignore next 3 -- the state was computed from these very rows. */
      if (monthEnd === null || row === undefined) {
        throw new Error('a month_end close without its statement row');
      }
      return {
        kind: 'statement',
        valuationId: monthEnd.valuationId,
        version: row.version,
        amount: monthEnd.amount,
        confirmedUnchanged: row.source === 'confirmed_unchanged',
      };
    }
    case 'closed_zero':
      return { kind: 'closed_zero' };
    case 'dormant_zero':
      return { kind: 'dormant_zero' };
    case 'carried':
    case 'missing':
      return state.confirmable === null
        ? {
            kind: 'no_statement',
            state: state.close,
            latestSnapshot: latestSnapshotIn(entry.valuations, month, currency),
            canConfirmUnchanged: state.canConfirmUnchanged,
          }
        : { kind: 'last_day_snapshot', ...state.confirmable };
    /* v8 ignore next 2 -- `cashCloseState` has exactly the five states above. */
    default:
      throw new Error(`unknown closing state ${state.close}`);
  }
}

/**
 * A completed month's cash accounts: every one taking part in M (8.1), in the
 * order the window returned them — the user's own.
 */
export function completedAccountsOf(
  month: MonthKey,
  entries: readonly PositionWithValuations[],
  rows: readonly ValuationRow[],
): CompletedAccountsDto {
  const previousMonth = previousMonthOf(month);
  const rowById = new Map(rows.map((row) => [row.id, row]));

  const accounts = entries
    .filter((entry) => entry.position.kind === 'cash' && participatesIn(entry.position, month))
    .map((entry) => {
      const { position } = entry;
      const state = cashMonthStateDto(entry, month, position.currency, rows);
      // `open` is `close(a, M−1)` apart from its two exceptions, so a
      // `month_end` opening is exactly M−1's statement row (8.1).
      const previous =
        state.open === 'month_end' ? monthEndBalance(entry.valuations, previousMonth) : undefined;

      return {
        positionId: position.id,
        name: position.name,
        currency: position.currency,
        dormant: position.isDormant === true,
        state,
        opening: openingDto(
          {
            state: state.open as CashOpenState,
            ...(previous === undefined ? {} : { amount: previous.amount, valuedOn: previous.valuedOn }),
          },
          position.currency,
        ),
        closing: closingDto(state, entry, month, rowById, position.currency),
      };
    });

  return { previousMonth: label(previousMonth), accounts };
}

/**
 * The current month's cash accounts: every one taking part in the month (8.1),
 * with 8.6's opening and the latest balance on record at today.
 */
export function currentAccountsOf(
  today: PlainDate,
  cashAccounts: readonly CashAccountInput[],
  rows: readonly ValuationRow[],
): CurrentAccountsDto {
  const month = monthKey(today);
  // M1: one valuation per position per date, so a position has at most one.
  const todayRows = new Map(
    rows.filter((row) => row.valuedOn === today).map((row) => [row.positionId, row]),
  );

  const accounts = cashAccounts
    .filter((account) => participatesIn(account.position, month))
    .map((account) => {
      const { position } = account;
      const value = valueAt(position, account.valuations, today);
      const todayRow = todayRows.get(position.id);

      return {
        positionId: position.id,
        name: position.name,
        currency: position.currency,
        status: position.status,
        dormant: position.isDormant === true,
        opening: openingDto(monthToDateOpening(account, month, today), position.currency),
        latest: {
          state: value.state,
          amount: isUnavailable(value.native) ? null : serialize(value.native),
          valuedOn: value.valuedOn ?? null,
          statement: value.fromMonthEnd === true,
        },
        todaySnapshot:
          todayRow === undefined
            ? null
            : {
                valuationId: todayRow.id,
                version: todayRow.version,
                amount: moneyDto(todayRow.amount, position.currency),
              },
        // Quick update's own rule: active accounts, dormant ones left out (15.3).
        canUpdateToday: position.status === 'active' && position.isDormant !== true,
      };
    });

  return {
    previousMonth: label(previousMonthOf(month)),
    closableFrom: addDays(endOfMonthKey(month), 1),
    accounts,
  };
}
