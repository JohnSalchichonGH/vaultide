import { describe, expect, it } from 'vitest';
import {
  createFxTable,
  currencyCode,
  Decimal,
  monthKeyOf,
  plainDate,
  reconcileCompletedMonth,
  type CashAccountInput,
  type CompletedMonthInput,
  type ExpenseFlow,
  type PositionRecord,
  type ValuationRecord,
} from '@vaultide/finance';
import { monthReportingFrom } from '../../src/index';

/**
 * The cause a reporting figure names when a bucket could not be reconciled
 * (8.4, 8.5, 12.5).
 *
 * Everything here is the real completed-month engine and the real reporting
 * service; the database is the only thing left out, because what is under test
 * is which of a bucket's own causes wins, and that is decided before any row is
 * loaded. The integration suite covers the same mapping from real rows.
 */

const EUR = currencyCode('EUR');
const SEPTEMBER = monthKeyOf(2026, 9);
const emptyFx = createFxTable([], { today: plainDate('2026-10-01') });

function position(id: string, name: string): PositionRecord {
  return {
    id,
    kind: 'cash',
    name,
    currency: EUR,
    status: 'active',
    openedOn: null,
    closedOn: null,
  };
}

function monthEnd(positionId: string, valuedOn: string, amount: string): ValuationRecord {
  return {
    id: `val-${positionId}-${valuedOn}`,
    positionId,
    valuedOn: plainDate(valuedOn),
    amount: new Decimal(amount),
    source: 'entered',
    datePrecision: 'month_end',
  };
}

function account(id: string, name: string, valuations: readonly ValuationRecord[]): CashAccountInput {
  return { position: position(id, name), valuations, accountType: 'checking' };
}

function expense(cashPositionId: string): ExpenseFlow {
  return {
    id: `exp-${cashPositionId}`,
    categoryKind: 'food',
    incurredOn: plainDate('2026-09-12'),
    amount: new Decimal('40'),
    currency: EUR,
    settlement: 'tracked_cash',
    cashPositionId,
  };
}

/**
 * One month with two euro accounts: `unusableId` has an August statement and no
 * September one, `excludedId` has its first balance inside September.
 *
 * The engine walks its accounts in position-id order, so which of them raises
 * its issue first is decided by the ids — which is exactly the knob these two
 * cases turn.
 */
function twoCauseMonth(unusableId: string, excludedId: string): CompletedMonthInput {
  return {
    month: SEPTEMBER,
    today: plainDate('2026-10-01'),
    cashAccounts: [
      account(unusableId, 'Unusable', [monthEnd(unusableId, '2026-08-31', '1000')]),
      account(excludedId, 'Excluded', [monthEnd(excludedId, '2026-09-30', '500')]),
    ],
    income: [],
    expenses: [expense(unusableId)],
    transfers: [],
    templates: [],
    resolvedOccurrences: new Set<string>(),
  };
}

const report = (input: CompletedMonthInput) =>
  monthReportingFrom(
    { input, positions: [], categories: [], templates: [], terms: [] },
    emptyFx,
    EUR,
    true,
  );

describe('a bucket with more than one cause', () => {
  it('names the most specific one, whichever order the engine raised them in', () => {
    // `a-…` sorts first, so the first fixture raises `missing_month_end` before
    // `first_balance` and the second raises them the other way round.
    const first = report(twoCauseMonth('a-unusable', 'b-excluded'));
    const second = report(twoCauseMonth('b-unusable', 'a-excluded'));

    const expected = [
      { currency: 'EUR', reason: 'missing_month_end', detail: 'reconciliation_unavailable' },
    ];
    expect(first.unclassified.missing).toEqual(expected);
    expect(second.unclassified.missing).toEqual(expected);
  });

  it('really does reach the mapping with both causes, in both orders', () => {
    // Without this, the test above would pass on a month that only ever had one
    // cause to choose from.
    const keys = (input: CompletedMonthInput): string[] => {
      const bucket = reconcileCompletedMonth(input).buckets[0];
      if (bucket === undefined) throw new Error('expected a EUR bucket');
      return bucket.issues.map((issue) => issue.key);
    };

    expect(keys(twoCauseMonth('a-unusable', 'b-excluded'))).toEqual([
      'missing_month_end',
      'first_balance',
    ]);
    expect(keys(twoCauseMonth('b-unusable', 'a-excluded'))).toEqual([
      'first_balance',
      'missing_month_end',
    ]);
  });
});
