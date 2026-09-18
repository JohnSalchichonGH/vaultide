import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/decimal';
import { monthKeyOf, plainDate, type MonthKey, type PlainDate } from '../src/dates/plain-date';
import { currencyCode } from '../src/money/types';
import type { TransferFlow } from '../src/flows/types';
import type { ValuationRecord } from '../src/positions/types';
import { completedMonthCompleteness } from '../src/completeness/index';
import {
  findSpans,
  reconcileCompletedMonth,
  reconcileMonthToDate,
  type CashAccountInput,
} from '../src/reconciliation/index';
import { monthEnd, position, valuation } from './helpers/records';

/**
 * A dormant episode has a start, and the engines read the start (blueprint 8.1,
 * 8.6, 8.7, 8.8, 12.6, v2.1.17 30.20).
 *
 * `is_dormant` says an account is dormant now. Read as history it let an action
 * taken today close an earlier month at zero that had held money — a `reliable`
 * month reporting a balance as spending, a vanished span, a changed
 * completeness. These are the engines that read it, asked about dates on both
 * sides of `dormant_from`, and about an account that went dormant twice.
 */

const EUR = currencyCode('EUR');
const M = (month: number, year = 2026): MonthKey => monthKeyOf(year, month);

const transfer = (id: string, on: string, from: string, to: string, amount: string): TransferFlow => ({
  id,
  kind: 'cash_transfer',
  occurredOn: plainDate(on),
  fromPositionId: from,
  fromCurrency: EUR,
  fromAmount: new Decimal(amount),
  toPositionId: to,
  toCurrency: EUR,
  toAmount: new Decimal(amount),
});

const cash = (
  id: string,
  name: string,
  valuations: readonly ValuationRecord[],
  dormantFrom?: string,
): CashAccountInput => ({
  position: position(name, { id, ...(dormantFrom === undefined ? {} : { dormantFrom }) }),
  valuations,
  accountType: 'checking',
});

/** What one completed month says, reduced to the facts a dormant flag could move. */
function read(
  month: MonthKey,
  today: PlainDate,
  cashAccounts: readonly CashAccountInput[],
  transfers: readonly TransferFlow[],
  id: string,
) {
  const result = reconcileCompletedMonth({
    month,
    today,
    cashAccounts,
    income: [],
    expenses: [],
    transfers,
    templates: [],
    resolvedOccurrences: new Set(),
  });
  const bucket = result.buckets[0];
  const account = bucket?.accounts.find((entry) => entry.positionId === id);
  const completeness = completedMonthCompleteness({
    month,
    today,
    positions: cashAccounts,
    templates: [],
    resolvedOccurrences: new Set(),
  });
  return {
    status: result.monthStatus,
    open: account?.opening.state,
    close: account?.closing.state,
    dormant: account?.dormant,
    tracked: bucket?.totals.trackedTotalSpending?.toString(),
    issues: bucket?.issues.map((issue) => issue.key),
    completeness: `${completeness.state} ${String(completeness.satisfied)}/${String(completeness.required)}`,
  };
}

describe('a month before the episode is not rewritten by it', () => {
  /**
   * Checking has every statement. Savings held 5,000 through January, has no
   * February statement, sent the 5,000 to Checking on 10 March, reads zero on 31
   * March and is dormant from that balance.
   */
  const today = plainDate('2026-09-18');
  const checking = cash('checking', 'Checking', [
    monthEnd('checking', '2025-12-31', '1000'),
    monthEnd('checking', '2026-01-31', '1000'),
    monthEnd('checking', '2026-02-28', '1000'),
    monthEnd('checking', '2026-03-31', '6000'),
    monthEnd('checking', '2026-04-30', '6000'),
  ]);
  const savingsRows = [
    monthEnd('savings', '2025-12-31', '5000'),
    monthEnd('savings', '2026-01-31', '5000'),
    monthEnd('savings', '2026-03-31', '0'),
  ];
  const moved = [transfer('t1', '2026-03-10', 'savings', 'checking', '5000')];
  const awake = [checking, cash('savings', 'Savings', savingsRows)];
  const dormant = [checking, cash('savings', 'Savings', savingsRows, '2026-03-31')];

  it('keeps February unavailable instead of reporting the balance as spending', () => {
    const february = read(M(2), today, dormant, moved, 'savings');
    expect(february).toMatchObject({
      status: 'unavailable',
      open: 'month_end',
      close: 'carried',
      dormant: false,
      issues: ['missing_month_end'],
      completeness: 'incomplete 1/2',
    });
    expect(february.tracked).toBeUndefined();
  });

  it('reads every month before the episode exactly as it read before the account went dormant', () => {
    for (const month of [M(1), M(2)]) {
      expect(read(month, today, dormant, moved, 'savings')).toEqual(
        read(month, today, awake, moved, 'savings'),
      );
    }
  });

  it('covers the month that ends on the zero balance, without moving any figure of it', () => {
    // 31 March is `dormant_from`, so March's end is inside the episode: the
    // account is dormant there and outside the completeness count. Its opening
    // is still February's close, which is still not a value.
    const before = read(M(3), today, awake, moved, 'savings');
    const after = read(M(3), today, dormant, moved, 'savings');
    expect(after).toMatchObject({ status: 'unavailable', open: 'carried', close: 'month_end' });
    expect({ ...after, dormant: before.dormant, completeness: before.completeness }).toEqual(before);
    expect(after).toMatchObject({ dormant: true, completeness: 'sufficient 1/1' });
  });

  it('carries the account from the episode on, which is all the flag was ever for', () => {
    expect(read(M(4), today, awake, moved, 'savings')).toMatchObject({
      status: 'unavailable',
      close: 'carried',
    });
    expect(read(M(4), today, dormant, moved, 'savings')).toMatchObject({
      status: 'reliable',
      open: 'month_end',
      close: 'dormant_zero',
      dormant: true,
      tracked: '0',
      completeness: 'sufficient 1/1',
    });
  });

  it('keeps the honest span across the gap, which a completed February end would have removed', () => {
    const spans = (accounts: readonly CashAccountInput[]) =>
      findSpans({ today, cashAccounts: accounts, income: [], expenses: [], transfers: moved }).map(
        (span) => ({
          from: span.from,
          to: span.to,
          cashDelta: span.totals.cashDelta.toString(),
          tracked: span.trackedTotalSpending.toString(),
          status: span.status,
        }),
      );
    // The 5,000 moved between the user's own accounts: nothing was spent.
    const expected = [
      { from: '2026-02-01', to: '2026-03-31', cashDelta: '0', tracked: '0', status: 'reliable' },
    ];
    expect(spans(awake)).toEqual(expected);
    expect(spans(dormant)).toEqual(expected);
  });
});

describe('zero → dormant → active → zero → dormant', () => {
  /**
   * Checking has every statement, September to August. Holiday reads zero on 31
   * October (episode one), receives 800 on 20 February (which wakes it), has no
   * February or March statement, reads 800 at the end of April and May, sends
   * the 800 back on 10 June and reads zero on 30 June (episode two). It has no
   * July or August statement.
   */
  const monthEnds = [
    '2025-09-30', '2025-10-31', '2025-11-30', '2025-12-31', '2026-01-31', '2026-02-28',
    '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31',
  ];
  const checkingRows = monthEnds.map((on) =>
    monthEnd('checking', on, on >= '2026-02-28' && on <= '2026-05-31' ? '2200' : '3000'),
  );
  const holidayRows = [
    monthEnd('holiday', '2025-10-31', '0'),
    monthEnd('holiday', '2026-04-30', '800'),
    monthEnd('holiday', '2026-05-31', '800'),
    monthEnd('holiday', '2026-06-30', '0'),
  ];
  const flows = [
    transfer('in', '2026-02-20', 'checking', 'holiday', '800'),
    transfer('out', '2026-06-10', 'holiday', 'checking', '800'),
  ];

  /** The records that existed by `today`, with Holiday's dormancy as it stood then. */
  const world = (today: string, dormantFrom?: string) => {
    const by = plainDate(today);
    return {
      today: by,
      accounts: [
        cash('checking', 'Checking', checkingRows.filter((row) => row.valuedOn <= by)),
        cash('holiday', 'Holiday', holidayRows.filter((row) => row.valuedOn <= by), dormantFrom),
      ],
      transfers: flows.filter((flow) => flow.occurredOn <= by),
    };
  };
  const at = (w: ReturnType<typeof world>, month: MonthKey) =>
    read(month, w.today, w.accounts, w.transfers, 'holiday');

  const first = world('2026-01-15', '2025-10-31');
  const active = world('2026-09-18');
  const second = world('2026-09-18', '2026-06-30');

  it('carries the first episode while it is current', () => {
    expect(at(first, M(11, 2025))).toMatchObject({ status: 'reliable', open: 'month_end', close: 'dormant_zero' });
    expect(at(first, M(12, 2025))).toMatchObject({ status: 'reliable', open: 'dormant_zero', close: 'dormant_zero', tracked: '0' });
  });

  it('forgets an ended episode when the account wakes: its months fall back to their own evidence', () => {
    // Only the current episode is stored. December was carried; it now asks for
    // a statement — an unavailable month, never an invented figure.
    expect(at(active, M(12, 2025))).toMatchObject({ status: 'unavailable', close: 'carried', dormant: false });
  });

  it('never lets the second episode reach back into the active period', () => {
    // February is the month the 800 arrived. Carried at zero it would report
    // 800 of spending that was a transfer between the user's own accounts.
    for (const month of [M(2), M(3)]) {
      expect(at(second, month)).toMatchObject({ status: 'unavailable', close: 'carried', dormant: false });
      expect(at(second, month).tracked).toBeUndefined();
    }
    expect(at(second, M(5))).toMatchObject({ status: 'reliable', open: 'month_end', close: 'month_end', tracked: '0' });
  });

  it('starts the second episode at its own zero balance, and not a day earlier', () => {
    expect(at(second, M(6))).toMatchObject({ status: 'reliable', close: 'month_end', dormant: true });
    expect(at(second, M(7))).toMatchObject({ status: 'reliable', open: 'month_end', close: 'dormant_zero', tracked: '0' });
    expect(at(second, M(8))).toMatchObject({ status: 'reliable', open: 'dormant_zero', close: 'dormant_zero', tracked: '0' });
  });

  it('changes nothing before its own start: every earlier month reads as it did the day before', () => {
    for (const month of [M(11, 2025), M(12, 2025), M(1), M(2), M(3), M(4), M(5)]) {
      expect(at(second, month)).toEqual(at(active, month));
    }
  });

  it('leaves the span across the active gap where it was, and exact', () => {
    const spans = (w: ReturnType<typeof world>) =>
      findSpans({ today: w.today, cashAccounts: w.accounts, income: [], expenses: [], transfers: w.transfers }).map(
        (span) => [span.from, span.to, span.totals.cashDelta.toString(), span.trackedTotalSpending.toString()],
      );
    expect(spans(active)).toEqual([['2025-11-01', '2026-04-30', '0', '0']]);
    expect(spans(second)).toEqual(spans(active));
  });
});

describe('month to date reads dormancy at D, not at today', () => {
  const today = plainDate('2026-09-18');
  const other = cash('other', 'Other', [
    monthEnd('other', '2026-08-31', '100'),
    valuation('other', '2026-09-03', '100'),
  ]);
  // 500 on the 3rd, emptied on the 10th and dormant from that balance.
  const emptied = cash(
    'emptied',
    'Emptied',
    [
      monthEnd('emptied', '2026-08-31', '500'),
      valuation('emptied', '2026-09-03', '500'),
      valuation('emptied', '2026-09-10', '0'),
    ],
    '2026-09-10',
  );

  it('uses the snapshot when D falls before the episode, rather than a zero that came later', () => {
    const result = reconcileMonthToDate({
      today,
      cashAccounts: [other, emptied],
      income: [],
      expenses: [],
      transfers: [],
    });
    // Other's only September balance is the 3rd, so that is D — a week before
    // Emptied held nothing.
    expect(result.asOf).toBe('2026-09-03');
    if (result.asOf === null) throw new Error('expected a common date');
    const account = result.buckets[0]?.accounts.find((entry) => entry.positionId === 'emptied');
    expect(account).toMatchObject({
      atAsOf: { state: 'snapshot' },
      snapshotRequired: true,
      dormant: false,
    });
    expect(account?.atAsOf.amount?.toString()).toBe('500');
    expect(result.buckets[0]?.totals.trackedTotalSpending?.toString()).toBe('0');
  });

  it('still needs no snapshot from the account once D is inside the episode', () => {
    const result = reconcileMonthToDate({
      today,
      cashAccounts: [
        cash('other', 'Other', [monthEnd('other', '2026-08-31', '100'), valuation('other', '2026-09-18', '100')]),
        emptied,
      ],
      income: [],
      expenses: [],
      transfers: [],
    });
    expect(result.asOf).toBe('2026-09-18');
    if (result.asOf === null) throw new Error('expected a common date');
    const account = result.buckets[0]?.accounts.find((entry) => entry.positionId === 'emptied');
    expect(account).toMatchObject({ atAsOf: { state: 'dormant_zero' }, snapshotRequired: false, dormant: true });
  });
});
