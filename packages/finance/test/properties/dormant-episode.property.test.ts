import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/decimal';
import { endOfMonthKey, monthKeyOf, plainDate, type MonthKey } from '../../src/dates/plain-date';
import { currencyCode } from '../../src/money/types';
import type { TransferFlow } from '../../src/flows/types';
import type { ValuationRecord } from '../../src/positions/types';
import { cashCloseState, isDormantZeroAt } from '../../src/positions/cash-state';
import {
  findSpans,
  reconcileCompletedMonth,
  type CashAccountInput,
} from '../../src/reconciliation/index';
import { position, valuation } from '../helpers/records';

/**
 * Invariants of the dormant episode (8.1, 8.7, 8.8, v2.1.17 30.20).
 *
 * The oracle is the same history with the account not dormant at all: whatever
 * that says about a month which ends before the episode starts, the dormant
 * account must say too. It is independent of the rule under test — it never
 * consults `dormantFrom` — which is what lets it catch a consumer reading the
 * present-tense flag again.
 */

const EUR = currencyCode('EUR');
const TODAY = plainDate('2026-10-05');
const MONTHS: MonthKey[] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((month) => monthKeyOf(2026, month));
const ENDS = MONTHS.map((month) => endOfMonthKey(month) as string);
const MID = MONTHS.map((month) => `${(month as string).slice(0, 7)}-15`);

/** A history: some month ends with statements, some mid-month snapshots, any amounts. */
const historyArb = (id: string): fc.Arbitrary<ValuationRecord[]> =>
  fc
    .uniqueArray(fc.constantFrom(...ENDS, ...MID), { minLength: 1, maxLength: 9 })
    .chain((dates) =>
      fc.tuple(
        ...dates.map((date) =>
          fc
            .record({ amount: fc.constantFrom('0', '0', '250', '800'), statement: fc.boolean() })
            .map(({ amount, statement }) =>
              valuation(id, date, amount, {
                precision: statement && ENDS.includes(date) ? 'month_end' : 'exact',
              }),
            ),
        ),
      ),
    );

const transfersArb: fc.Arbitrary<TransferFlow[]> = fc
  .array(
    fc.record({
      day: fc.constantFrom(...MID),
      into: fc.boolean(),
      amount: fc.constantFrom('250', '800'),
    }),
    { maxLength: 4 },
  )
  .map((rows) =>
    rows.map(
      ({ day, into, amount }, index): TransferFlow => ({
        id: `t-${String(index)}`,
        kind: 'cash_transfer',
        occurredOn: plainDate(day),
        fromPositionId: into ? 'steady' : 'sleeper',
        fromCurrency: EUR,
        fromAmount: new Decimal(amount),
        toPositionId: into ? 'sleeper' : 'steady',
        toCurrency: EUR,
        toAmount: new Decimal(amount),
      }),
    ),
  );

/** Two accounts and an anchor chosen among the sleeper's zero balances, when it has one. */
const scenarioArb = fc
  .record({ steady: historyArb('steady'), sleeper: historyArb('sleeper'), transfers: transfersArb, pick: fc.nat() })
  .map(({ steady, sleeper, transfers, pick }) => {
    const zeros = sleeper.filter((row) => row.amount.isZero()).map((row) => row.valuedOn as string);
    const anchor = zeros.length === 0 ? undefined : zeros[pick % zeros.length];
    const account = (id: string, rows: ValuationRecord[], dormantFrom?: string): CashAccountInput => ({
      position: position(id, { id, ...(dormantFrom === undefined ? {} : { dormantFrom }) }),
      valuations: rows,
      accountType: 'checking',
    });
    return {
      anchor,
      transfers,
      awake: [account('steady', steady), account('sleeper', sleeper)],
      dormant: [account('steady', steady), account('sleeper', sleeper, anchor)],
    };
  })
  .filter((scenario) => scenario.anchor !== undefined);

const month = (accounts: readonly CashAccountInput[], transfers: readonly TransferFlow[], m: MonthKey) =>
  reconcileCompletedMonth({
    month: m,
    today: TODAY,
    cashAccounts: accounts,
    income: [],
    expenses: [],
    transfers,
    templates: [],
    resolvedOccurrences: new Set(),
  });

describe('a dormant episode, for any history', () => {
  it('changes no completed month that ends before it starts', () => {
    fc.assert(
      fc.property(scenarioArb, ({ anchor, transfers, awake, dormant }) => {
        for (const m of MONTHS) {
          if ((endOfMonthKey(m) as string) >= (anchor as string)) continue;
          expect(month(dormant, transfers, m)).toEqual(month(awake, transfers, m));
        }
      }),
    );
  });

  it('removes no span that closes before it starts, and invents none there', () => {
    fc.assert(
      fc.property(scenarioArb, ({ anchor, transfers, awake, dormant }) => {
        const before = (accounts: readonly CashAccountInput[]) =>
          findSpans({ today: TODAY, cashAccounts: accounts, income: [], expenses: [], transfers }).filter(
            (span) => (span.to as string) < (anchor as string),
          );
        expect(before(dormant)).toEqual(before(awake));
      }),
    );
  });

  it('never carries a date at zero whose latest balance is missing or not zero', () => {
    fc.assert(
      fc.property(scenarioArb, ({ dormant }) => {
        const sleeper = dormant[1] as CashAccountInput;
        for (const m of MONTHS) {
          const end = endOfMonthKey(m);
          const latest = sleeper.valuations
            .filter((row) => row.valuedOn <= end)
            .sort((a, b) => (a.valuedOn < b.valuedOn ? 1 : -1))[0];
          if (latest === undefined || !latest.amount.isZero()) {
            expect(isDormantZeroAt(sleeper.position, sleeper.valuations, end)).toBe(false);
            expect(cashCloseState(sleeper.position, sleeper.valuations, m)).not.toBe('dormant_zero');
          }
        }
      }),
    );
  });
});
