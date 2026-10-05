import { Decimal } from '../../../src/decimal';
import { monthKey, plainDate } from '../../../src/dates/plain-date';
import { currencyCode } from '../../../src/money/types';
import { occurrenceKey } from '../../../src/reconciliation/completeness';
import type { IncomeFlow } from '../../../src/flows/types';
import type { PositionWithValuations } from '../../../src/positions/types';
import type {
  CashAccountInput,
  CompletedMonthInput,
  CompletenessTemplate,
  MonthToDateInput,
} from '../../../src/reconciliation/index';
import { entry, fxTable, monthEnd, position, valuation } from '../../helpers/records';

/**
 * Golden fixture `simple-user` (blueprint 21.6).
 *
 * Two EUR checking accounts, six completed months of statement month-end
 * balances, then a current month in which both accounts were snapshotted on the
 * 6th. Phase 2 asserts the balance sheet; Phase 3 adds the salary, the inferred
 * spending and savings of each completed month, and the month-to-date variants,
 * on top of the same balances. The August figures are the opening balances of
 * the worked example in blueprint 12.7.
 *
 * See README.md for the hand computation of every number the tests assert.
 */

export const TODAY = plainDate('2026-09-06');
export const REPORTING = 'EUR';

const bbva = position('BBVA checking', { id: 'simple-bbva', currency: 'EUR' });
const savings = position('Savings', { id: 'simple-savings', currency: 'EUR' });

export const positions = [
  entry(bbva, [
    monthEnd(bbva.id, '2026-03-31', '7200.00'),
    monthEnd(bbva.id, '2026-04-30', '7450.00'),
    monthEnd(bbva.id, '2026-05-31', '7610.00'),
    monthEnd(bbva.id, '2026-06-30', '7905.00'),
    monthEnd(bbva.id, '2026-07-31', '8010.00'),
    monthEnd(bbva.id, '2026-08-31', '8055.00'),
    // The current month: an ordinary snapshot, not a month end (8.8).
    valuation(bbva.id, '2026-09-06', '8120.00'),
  ]),
  entry(savings, [
    monthEnd(savings.id, '2026-03-31', '8000.00'),
    monthEnd(savings.id, '2026-04-30', '8100.00'),
    monthEnd(savings.id, '2026-05-31', '8200.00'),
    monthEnd(savings.id, '2026-06-30', '8300.00'),
    monthEnd(savings.id, '2026-07-31', '8400.00'),
    monthEnd(savings.id, '2026-08-31', '8509.00'),
    valuation(savings.id, '2026-09-06', '8509.00'),
  ]),
];

/** A single-currency user never needs a rate: EUR -> EUR is exactly 1 (10.1). */
export const fx = fxTable([], '2026-09-06');

export const ids = { bbva: bbva.id, savings: savings.id };

/* -------------------------------------------------------------------------- */
/* Phase 3                                                                     */
/* -------------------------------------------------------------------------- */

/*
 * Phase 3 layers its records on top of everything above, which stays exactly
 * as Phase 2 asserts it. The current month needs a second September snapshot
 * on the 8th, and that is not added to `positions`: Phase 2 reads the current
 * month on the 6th, and a balance it could never have seen does not belong in
 * its data. So the current month's accounts are built here from Phase 2's own
 * rows plus that one balance, and the no-common-date variant from Phase 2's
 * statements plus its own two snapshots.
 *
 * The salary is paid on the 1st. The 6 September snapshots above already show
 * BBVA 65.00 up on August with nothing recorded to explain it, and the one
 * salary is the only income this fixture has (21.6); paid on the 1st, it is
 * inside the month-to-date interval and explains the rise. Paid on the 25th,
 * as in 8.10, it would leave the month to date unresolved.
 */

const EUR = currencyCode('EUR');

/** On the 8th, two days after the last date both accounts share. */
export const PHASE3_TODAY = plainDate('2026-09-08');

export const SALARY_TEMPLATE = 'simple-salary';
const SALARY_DAYS = [
  '2026-03-01',
  '2026-04-01',
  '2026-05-01',
  '2026-06-01',
  '2026-07-01',
  '2026-08-01',
  '2026-09-01',
] as const;

/** 2,100.00 net into BBVA on the 1st of every month since tracking began. */
export const salaries: readonly IncomeFlow[] = SALARY_DAYS.map((receivedOn) => ({
  id: `simple-salary-${receivedOn}`,
  kind: 'employment',
  receivedOn: plainDate(receivedOn),
  netAmount: new Decimal('2100.00'),
  currency: EUR,
  settlement: 'tracked_cash',
  cashPositionId: bbva.id,
}));

/** The salary's schedule, so completeness sees the source every month expected. */
export const templates: readonly CompletenessTemplate[] = [
  {
    templateId: SALARY_TEMPLATE,
    name: 'Salary',
    kind: 'income',
    currency: EUR,
    incomeKind: 'employment',
    schedule: { frequency: 'monthly', dayOfMonth: 1, startDate: plainDate('2026-03-01'), endDate: null },
  },
];

/** Every occurrence was accepted, so each one is resolved by its own flow. */
const resolved = new Set(SALARY_DAYS.map((day) => occurrenceKey(SALARY_TEMPLATE, day)));

/** Both accounts are checking accounts (21.6), so no interest is ever suspected. */
const asCashAccounts = (entries: readonly PositionWithValuations[]): CashAccountInput[] =>
  entries.map(({ position: record, valuations }) => ({
    position: record,
    valuations,
    accountType: 'checking',
  }));

/** One completed month, March to August 2026, read on the 8th of September. */
export function completedMonth(month: string): CompletedMonthInput {
  return {
    month: monthKey(plainDate(`${month}-01`)),
    today: PHASE3_TODAY,
    cashAccounts: asCashAccounts(positions),
    income: salaries,
    expenses: [],
    transfers: [],
    templates,
    resolvedOccurrences: resolved,
  };
}

const [bbvaHistory, savingsHistory] = positions as [PositionWithValuations, PositionWithValuations];
const statementsOnly = (history: PositionWithValuations) =>
  history.valuations.filter((row) => row.datePrecision === 'month_end');

/**
 * September as it stands on the 8th: both accounts snapshotted on the 6th —
 * Phase 2's rows — and BBVA alone again on the 8th.
 */
export function currentMonth(): MonthToDateInput {
  return {
    today: PHASE3_TODAY,
    cashAccounts: asCashAccounts([
      entry(bbva, [...bbvaHistory.valuations, valuation(bbva.id, '2026-09-08', '8050.00')]),
      savingsHistory,
    ]),
    income: salaries,
    expenses: [],
    transfers: [],
  };
}

/**
 * The variant: the two accounts never share a September day. BBVA was
 * snapshotted only on the 6th and Savings only on the 3rd, as 8.6 and 21.1 put
 * it.
 */
export function currentMonthWithoutCommonDate(): MonthToDateInput {
  return {
    today: PHASE3_TODAY,
    cashAccounts: asCashAccounts([
      entry(bbva, [...statementsOnly(bbvaHistory), valuation(bbva.id, '2026-09-06', '8120.00')]),
      entry(savings, [...statementsOnly(savingsHistory), valuation(savings.id, '2026-09-03', '8509.00')]),
    ]),
    income: salaries,
    expenses: [],
    transfers: [],
  };
}
