import type {
  CategoryRecord,
  ExpenseEntryRow,
  PositionRecord as PositionRow,
  TransferRow,
} from '@vaultide/db';
import { Decimal } from '@vaultide/finance';
import { moneyDto } from '../positions/mapping';
import type {
  MonthlyTransferDto,
  MonthlyTransfersDto,
  TransferFeeDto,
  TransferFeeStateDto,
  TransferLegDto,
  TransferProblemDto,
  TransferReadOnlyReasonDto,
} from './types';

/**
 * Monthly's transfer maintenance, from rows already loaded (blueprint 7.5, 8.1,
 * 15.3 section 4, M14; ADR 0006 §1, §5–§7).
 *
 * Nothing here queries and nothing here decides a figure. The transfers are the
 * rows the reconciliation loaders already read, kept to the month on their
 * financial date; their linked rows come from the one read keyed on the
 * transfers' dates rather than on the rows' own. What this adds is what a
 * transfer editor needs beside each one: the accounts' names, the fee as none,
 * one or several, whether a correction may be saved at all, and what a
 * correction would have to repair — reported as found, never repaired on read.
 */

export interface MonthlyTransfersInput {
  /** The month's first day. */
  readonly from: string;
  /** The month's last day, or today for the current month. */
  readonly to: string;
  /** Transfers the loader read, of any kind and over any window; kept to the month here. */
  readonly transfers: readonly TransferRow[];
  /** Every expense row linked to a transfer dated in `[from, to]`, whatever its own date. */
  readonly linkedRows: readonly ExpenseEntryRow[];
  /** Every category of the user's, archived included, which gives a linked row its kind. */
  readonly categories: readonly CategoryRecord[];
  readonly positions: readonly PositionRow[];
}

type AccountsById = ReadonlyMap<string, PositionRow>;

const monthOf = (date: string): string => date.slice(0, 7);

/** 8.1's participation window, on one day. */
const openOn = (account: PositionRow, on: string): boolean =>
  (account.openedOn === null || account.openedOn <= on) &&
  (account.closedOn === null || account.closedOn >= on);

const byDateThenId = (a: TransferRow, b: TransferRow): number => {
  if (a.occurredOn !== b.occurredOn) return a.occurredOn < b.occurredOn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

function legOf(
  positionId: string | null,
  currency: string,
  amount: string,
  accounts: AccountsById,
): TransferLegDto {
  const account = positionId === null ? undefined : accounts.get(positionId);
  return {
    positionId,
    accountName: account?.name ?? null,
    currency,
    amount: moneyDto(amount, currency),
  };
}

function feeOf(row: ExpenseEntryRow, transfer: TransferRow, accounts: AccountsById): TransferFeeDto {
  const account = row.cashPositionId === null ? undefined : accounts.get(row.cashPositionId);
  const paidBy =
    row.cashPositionId === null
      ? null
      : row.cashPositionId === transfer.fromPositionId
        ? 'from'
        : row.cashPositionId === transfer.toPositionId
          ? 'to'
          : null;
  return {
    feeId: row.id,
    version: row.version,
    amount: moneyDto(row.amount, row.currency),
    currency: row.currency,
    incurredOn: row.incurredOn,
    incurredMonth: monthOf(row.incurredOn),
    cashPositionId: row.cashPositionId,
    cashAccountName: account?.name ?? null,
    paidBy,
  };
}

/**
 * The same refusals, in the same order, as the correction service's own check
 * of a transfer's linked rows, so the page never offers a Save the server must
 * refuse for them.
 */
function readOnlyReasonOf(
  linked: readonly ExpenseEntryRow[],
  kindOf: ReadonlyMap<string, string>,
): TransferReadOnlyReasonDto | null {
  if (linked.length > 1) return 'multiple_fees';
  const row = linked[0];
  if (row === undefined) return null;
  if (kindOf.get(row.categoryId) !== 'transfer_fee') return 'fee_not_transfer_fee';
  if (row.settlement !== 'tracked_cash') return 'fee_not_tracked_cash';
  return null;
}

/**
 * What a correction of this transfer would have to repair (8.1; ADR 0006 §3,
 * §6). The fee is judged only when the transfer may be corrected at all: a
 * read-only aggregate is not going to be saved.
 */
function problemsOf(
  transfer: TransferRow,
  fee: TransferFeeDto | null,
  accounts: AccountsById,
): TransferProblemDto[] {
  const problems: TransferProblemDto[] = [];

  for (const side of ['from', 'to'] as const) {
    const positionId = side === 'from' ? transfer.fromPositionId : transfer.toPositionId;
    const currency = side === 'from' ? transfer.fromCurrency : transfer.toCurrency;
    const account = positionId === null ? undefined : accounts.get(positionId);
    if (account === undefined || account.currency !== currency) {
      problems.push({ kind: 'endpoint_unavailable', side });
    } else if (!openOn(account, transfer.occurredOn)) {
      problems.push({ kind: 'endpoint_not_open', side });
    }
  }

  if (fee !== null) {
    if (fee.paidBy === null) {
      problems.push({ kind: 'fee_payer_not_endpoint' });
    } else {
      // A payer that is no cash account at all is already its side's problem.
      const payer = fee.cashPositionId === null ? undefined : accounts.get(fee.cashPositionId);
      if (payer !== undefined && payer.currency !== fee.currency) problems.push({ kind: 'fee_currency' });
      if (payer !== undefined && !openOn(payer, fee.incurredOn)) problems.push({ kind: 'fee_payer_not_open' });
    }
  }

  return problems;
}

function transferOf(
  row: TransferRow,
  linked: readonly ExpenseEntryRow[],
  accounts: AccountsById,
  kindOf: ReadonlyMap<string, string>,
): MonthlyTransferDto {
  const fees = linked.map((fee) => feeOf(fee, row, accounts));
  const fee: TransferFeeStateDto =
    fees.length === 0
      ? { kind: 'none' }
      : fees.length === 1 && fees[0] !== undefined
        ? { kind: 'one', fee: fees[0] }
        : { kind: 'multiple', fees };
  const readOnly = readOnlyReasonOf(linked, kindOf);

  return {
    transferId: row.id,
    version: row.version,
    occurredOn: row.occurredOn,
    from: legOf(row.fromPositionId, row.fromCurrency, row.fromAmount, accounts),
    to: legOf(row.toPositionId, row.toCurrency, row.toAmount, accounts),
    description: row.description,
    // Both amounts are stored facts (7.5), so this is arithmetic on them and not
    // a quote: exact, and never passed to the browser as a number.
    achievedRate:
      row.fromCurrency === row.toCurrency
        ? null
        : {
            rate: new Decimal(row.toAmount).dividedBy(new Decimal(row.fromAmount)).toString(),
            from: row.fromCurrency,
            to: row.toCurrency,
          },
    fee,
    readOnly,
    problems: problemsOf(row, readOnly === null && fee.kind === 'one' ? fee.fee : null, accounts),
  };
}

export function monthlyTransfersOf(input: MonthlyTransfersInput): MonthlyTransfersDto {
  const cash = input.positions.filter((row) => row.kind === 'cash');
  const accounts: AccountsById = new Map(cash.map((row) => [row.id, row]));
  const kindOf = new Map(input.categories.map((row) => [row.id, row.kind]));

  const linkedByTransfer = new Map<string, ExpenseEntryRow[]>();
  for (const row of input.linkedRows) {
    if (row.transferId === null) continue;
    const list = linkedByTransfer.get(row.transferId);
    if (list === undefined) linkedByTransfer.set(row.transferId, [row]);
    else list.push(row);
  }

  const transfers = input.transfers
    // Phase 3 maintains `cash_transfer` alone; any other kind is not this
    // section's to show, and the services refuse to edit or delete it here.
    .filter(
      (row) =>
        row.kind === 'cash_transfer' && row.occurredOn >= input.from && row.occurredOn <= input.to,
    )
    .sort(byDateThenId)
    .map((row) => transferOf(row, linkedByTransfer.get(row.id) ?? [], accounts, kindOf));

  return {
    transfers,
    cashAccounts: cash
      .filter(
        (row) =>
          (row.openedOn === null || row.openedOn <= input.to) &&
          (row.closedOn === null || row.closedOn >= input.from),
      )
      .map((row) => ({
        positionId: row.id,
        name: row.name,
        currency: row.currency,
        openedOn: row.openedOn,
        closedOn: row.closedOn,
        dormant: row.isDormant === true,
      })),
  };
}
