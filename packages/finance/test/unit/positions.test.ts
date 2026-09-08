import { describe, expect, it } from 'vitest';
import { monthKeyOf, plainDate } from '../../src/dates/plain-date';
import { serialize } from '../../src/money/money';
import { isUnavailable } from '../../src/unavailable';
import {
  cashCloseState,
  cashMonthState,
  cashOpenState,
  firstValuation,
  isMonthClosable,
  lastDaySnapshot,
  latestOnOrBefore,
  monthEndBalance,
  netWorthSign,
  participatesIn,
  sortValuations,
  trackingStartsOn,
  valuationOn,
  valueAt,
} from '../../src/index';
import { monthEnd, position, valuation } from '../helpers/records';

/**
 * Position values and cash month states (blueprint 8.1, 12.1, 21.1
 * "positions / freshness / sign").
 *
 * The distinctions here are the ones the specification kept blurring, and every
 * one of them changes a number a user sees: an exact balance is not a carried
 * one, a carried one is not a statement month-end, and none of them is zero.
 */

const on = (value: string) => plainDate(value);
const amountOf = (value: ReturnType<typeof valueAt>): string => {
  if (isUnavailable(value.native)) throw new Error('expected an available value');
  return serialize(value.native).amount;
};

describe('selecting the valuation that applies at a date', () => {
  const account = position('BBVA', { id: 'p1' });
  const rows = [
    valuation('p1', '2026-08-31', '8055.00'),
    valuation('p1', '2026-06-30', '7905.00'),
    valuation('p1', '2026-07-31', '8010.00'),
  ];

  it('takes the latest valuation on or before the date', () => {
    expect(latestOnOrBefore(rows, on('2026-08-31'))?.valuedOn).toBe('2026-08-31');
    expect(latestOnOrBefore(rows, on('2026-08-30'))?.valuedOn).toBe('2026-07-31');
    expect(latestOnOrBefore(rows, on('2026-07-31'))?.valuedOn).toBe('2026-07-31');
    expect(latestOnOrBefore(rows, on('2026-06-29'))).toBeUndefined();
  });

  it('does not depend on the order the rows arrive in', () => {
    const shuffled = [...rows].reverse();
    expect(latestOnOrBefore(shuffled, on('2026-08-15'))?.valuedOn).toBe('2026-07-31');
    expect(sortValuations(shuffled).map((row) => row.valuedOn)).toEqual([
      '2026-06-30',
      '2026-07-31',
      '2026-08-31',
    ]);
    expect(sortValuations(rows).map((row) => row.valuedOn)).toEqual(
      sortValuations(shuffled).map((row) => row.valuedOn),
    );
  });

  it('finds an exact date and the first row', () => {
    expect(valuationOn(rows, on('2026-07-31'))?.valuedOn).toBe('2026-07-31');
    expect(valuationOn(rows, on('2026-07-30'))).toBeUndefined();
    expect(firstValuation(rows)?.valuedOn).toBe('2026-06-30');
    expect(firstValuation([])).toBeUndefined();
  });

  it('is boundary-exact: the day of a valuation already reflects it', () => {
    // 8.1 same-day rule: a valuation dated d reflects everything dated <= d.
    const value = valueAt(account, rows, on('2026-07-31'));
    expect(value.state).toBe('exact');
    expect(amountOf(value)).toBe('8010');

    const dayBefore = valueAt(account, rows, on('2026-07-30'));
    expect(dayBefore.state).toBe('carried');
    expect(amountOf(dayBefore)).toBe('7905');
    expect(dayBefore.ageDays).toBe(30);
  });
});

describe('what a value means when there is not one', () => {
  it('is missing — never zero — for a tracked position nobody has valued', () => {
    const car = position('Car', { kind: 'other_asset' });
    const value = valueAt(car, [], on('2026-09-06'));

    expect(value.state).toBe('missing');
    expect(value.contributes).toBe(true);
    expect(isUnavailable(value.native)).toBe(true);
    if (isUnavailable(value.native)) expect(value.native.reason).toBe('no_valuation');
  });

  it('is zero — a stated fact — for an account that opened empty', () => {
    const account = position('New account', { openedOn: '2026-09-01' });
    const value = valueAt(account, [], on('2026-09-06'));

    expect(value.state).toBe('opened_zero');
    expect(amountOf(value)).toBe('0');
    expect(value.ageDays).toBe(5);
  });

  it('is not on the balance sheet at all before tracking started', () => {
    const account = position('BBVA', { id: 'p2' });
    const rows = [valuation('p2', '2026-08-31', '8055.00')];

    const before = valueAt(account, rows, on('2026-07-31'));
    expect(before.state).toBe('not_yet_tracked');
    expect(before.contributes).toBe(false);

    const opened = position('Later', { id: 'p3', openedOn: '2026-08-01' });
    expect(valueAt(opened, [], on('2026-07-31')).state).toBe('not_yet_tracked');
    expect(trackingStartsOn(opened, [])).toBe('2026-08-01');
    expect(trackingStartsOn(account, rows)).toBe('2026-08-31');
    expect(trackingStartsOn(account, [])).toBeUndefined();
  });

  it('contributes nothing once the position is closed', () => {
    const account = position('Closed', {
      id: 'p4',
      status: 'closed',
      closedOn: '2026-08-20',
    });
    const rows = [
      valuation('p4', '2026-07-31', '1000.00'),
      valuation('p4', '2026-08-20', '0.00'),
    ];

    const after = valueAt(account, rows, on('2026-08-31'));
    expect(after.state).toBe('closed');
    expect(amountOf(after)).toBe('0');

    // …and before it closed it was worth what it was worth.
    expect(amountOf(valueAt(account, rows, on('2026-08-01')))).toBe('1000');
  });
});

describe('freshness carries its evidence', () => {
  const account = position('BBVA', { id: 'p5' });
  const rows = [monthEnd('p5', '2026-08-31', '8055.00')];

  it('reports the source date, its age and whether it is a statement balance', () => {
    const value = valueAt(account, rows, on('2026-09-06'));
    expect(value.state).toBe('carried');
    expect(value.valuedOn).toBe('2026-08-31');
    expect(value.ageDays).toBe(6);
    expect(value.ageMonths).toBe(0);
    expect(value.fromMonthEnd).toBe(true);

    const older = valueAt(account, rows, on('2026-11-30'));
    expect(older.ageMonths).toBe(2);
  });
});

describe('cash month states (8.1)', () => {
  const august = monthKeyOf(2026, 8);
  const july = monthKeyOf(2026, 7);

  it('closes a month only on a statement month-end balance', () => {
    const account = position('BBVA', { id: 'c1' });

    // An ordinary snapshot dated the last day of the month is still an ordinary
    // snapshot: it does not close the month (8.8, R15).
    const snapshotOnly = [valuation('c1', '2026-08-31', '8055.00')];
    expect(cashCloseState(account, snapshotOnly, august)).toBe('carried');
    expect(monthEndBalance(snapshotOnly, august)).toBeUndefined();
    expect(lastDaySnapshot(snapshotOnly, august)?.valuedOn).toBe('2026-08-31');

    // Confirmed as the statement balance, it does.
    const confirmed = [monthEnd('c1', '2026-08-31', '8055.00', 'entered')];
    expect(cashCloseState(account, confirmed, august)).toBe('month_end');
    expect(lastDaySnapshot(confirmed, august)).toBeUndefined();
  });

  it('reports missing when nothing at all is on record by month end', () => {
    const account = position('BBVA', { id: 'c2' });
    expect(cashCloseState(account, [], august)).toBe('missing');
    expect(
      cashCloseState(account, [valuation('c2', '2026-09-15', '10.00')], august),
    ).toBe('missing');
  });

  it('carries a dormant account at zero, and only a dormant one', () => {
    const dormant = position('Old bank', { id: 'c3', isDormant: true });
    const ordinary = position('Old bank', { id: 'c4' });
    expect(cashCloseState(dormant, [], august)).toBe('dormant_zero');
    expect(cashCloseState(ordinary, [], august)).toBe('missing');
  });

  it('closes at zero for an account closed inside the month', () => {
    const account = position('Closed', { id: 'c5', status: 'closed', closedOn: '2026-08-20' });
    expect(cashCloseState(account, [], august)).toBe('closed_zero');
    // …and in a later month it is simply gone: no statement, nothing carried.
    expect(cashCloseState(account, [], monthKeyOf(2026, 9))).toBe('missing');
  });

  it('opens at zero for an account opened inside the month', () => {
    const account = position('New', { id: 'c6', openedOn: '2026-08-10' });
    expect(cashOpenState(account, [], august)).toBe('opened_zero');
  });

  it('marks a pre-existing account first tracked this month as first_balance', () => {
    const account = position('BBVA', { id: 'c7' });
    const rows = [monthEnd('c7', '2026-08-31', '8055.00')];

    // No valuation before 1 August, and August's statement balance exists: its
    // earlier movements are unknown, so August is not a month of activity (8.1).
    expect(cashOpenState(account, rows, august)).toBe('first_balance');

    const state = cashMonthState(account, rows, august);
    expect(state.excludedFirstBalance).toBe(true);
    expect(state.included).toBe(false);
    expect(state.monthEnd?.valuedOn).toBe('2026-08-31');
  });

  it("takes an ordinary month's opening from the previous month's close", () => {
    const account = position('BBVA', { id: 'c8' });
    const rows = [
      monthEnd('c8', '2026-06-30', '7905.00'),
      monthEnd('c8', '2026-07-31', '8010.00'),
      monthEnd('c8', '2026-08-31', '8055.00'),
    ];
    expect(cashOpenState(account, rows, august)).toBe('month_end');
    expect(cashCloseState(account, rows, july)).toBe('month_end');

    const state = cashMonthState(account, rows, august);
    expect(state.included).toBe(true);
    expect(state.confirmableSnapshot).toBeUndefined();
  });

  it('knows which accounts participate in a month at all', () => {
    const openedLater = position('Later', { openedOn: '2026-09-01' });
    const closedEarlier = position('Earlier', { status: 'closed', closedOn: '2026-07-15' });
    const live = position('Live');

    expect(participatesIn(openedLater, august)).toBe(false);
    expect(participatesIn(closedEarlier, august)).toBe(false);
    expect(participatesIn(live, august)).toBe(true);
  });
});

describe('the month-end clock (M5, R15)', () => {
  const september = monthKeyOf(2026, 9);

  it('refuses to call September closable on any day of September', () => {
    expect(isMonthClosable(september, on('2026-09-06'))).toBe(false);
    // Including its very last day: the month is not over until it is over.
    expect(isMonthClosable(september, on('2026-09-30'))).toBe(false);
  });

  it('allows it from the first day of October', () => {
    expect(isMonthClosable(september, on('2026-10-01'))).toBe(true);
  });
});

describe('the sign convention (7.8)', () => {
  it('is the only thing that makes a debt subtract', () => {
    expect(netWorthSign('cash')).toBe(1);
    expect(netWorthSign('other_asset')).toBe(1);
    expect(netWorthSign('investment')).toBe(1);
    expect(netWorthSign('property')).toBe(1);
    expect(netWorthSign('liability')).toBe(-1);
  });
});

describe('deterministic ordering and confirmable snapshots', () => {
  it('breaks a same-date tie by id, so a merged list still sorts stably', () => {
    // Two positions' rows handed in together can share a date; M1 only forbids
    // two rows for the *same* position on one day.
    const rows = [
      valuation('z2', '2026-08-31', '2.00', { id: 'val-b' }),
      valuation('z1', '2026-08-31', '1.00', { id: 'val-a' }),
    ];
    expect(sortValuations(rows).map((row) => row.id)).toEqual(['val-a', 'val-b']);
    expect(sortValuations([...rows].reverse()).map((row) => row.id)).toEqual(['val-a', 'val-b']);
  });

  it('offers an unconfirmed last-day snapshot for confirmation, and only then', () => {
    const account = position('BBVA', { id: 'k1' });
    const august = monthKeyOf(2026, 8);

    const snapshotOnly = cashMonthState(
      account,
      [valuation('k1', '2026-08-31', '8055.00')],
      august,
    );
    expect(snapshotOnly.close).toBe('carried');
    expect(snapshotOnly.confirmableSnapshot?.valuedOn).toBe('2026-08-31');
    expect(snapshotOnly.monthEnd).toBeUndefined();

    // A mid-month snapshot is not a candidate: only the last day can become a
    // statement month-end balance (R15).
    const midMonth = cashMonthState(account, [valuation('k1', '2026-08-20', '8055.00')], august);
    expect(midMonth.confirmableSnapshot).toBeUndefined();
    expect(midMonth.close).toBe('carried');
  });
});
