import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/decimal';
import {
  addDays,
  addMonths,
  endOfMonth,
  endOfMonthKey,
  isMonthEnd,
  monthKey,
  plainDate,
  startOfMonth,
  startOfMonthKey,
  type MonthKey,
  type PlainDate,
} from '../../src/dates/plain-date';
import { money } from '../../src/money/money';
import { currencyCode, type CurrencyCode } from '../../src/money/types';
import { convert, createFxTable, type FxRateRecord, type FxTable } from '../../src/fx/index';
import { cashMonthState } from '../../src/positions/cash-state';
import type { PositionWithValuations, ValuationRecord } from '../../src/positions/types';
import { completedMonthEnds, netWorthAt, netWorthSeries } from '../../src/networth/index';
import type { ExpenseFlow, IncomeFlow, TransferFlow } from '../../src/flows/types';
import {
  bucketObservations,
  findSpanIntervals,
  findSpans,
  monthToDateOpening,
  occurrenceKey,
  reconcileCompletedMonth,
  reconcileMonthToDate,
  withLargeUnclassified,
  withPossibleMissingConversion,
  type CashAccountInput,
  type CompletedMonthInput,
  type CompletenessTemplate,
  type ReconciliationStatus,
} from '../../src/reconciliation/index';
import type { ScopeAccount } from '../../src/reconciliation/scope';
import { completedMonthCompleteness } from '../../src/completeness/index';
import {
  bucketContributions,
  buildRollingTrackedSpendingSeries,
  knownSpendingItems,
  reportCashFlow,
  type MissingContributionInput,
  type ReportingContribution,
} from '../../src/reporting/index';
import {
  incomeOverview,
  incomeSourceYear,
  missingIncomeInYear,
  type RecordedIncomeEntry,
} from '../../src/income/index';
import {
  nextUnresolvedOccurrence,
  occurrencesInRange,
  RECURRENCE_FREQUENCIES,
  type RecurrenceSchedule,
} from '../../src/recurring/index';
import { monthEnd, position, valuation } from '../helpers/records';

/**
 * Property 17, the engine half (blueprint 21.2 item 17; 25 Phase 3 "Testing"):
 * "No engine output ever carries a date after `today`".
 *
 * Every run draws a `today` anywhere from 2024 to 2027 and a history around it
 * that the validators would have let in: every actual record — a balance, an
 * income, an expense, a transfer and its fee — and every stored rate is dated on
 * or before `today`, and a `month_end` balance exists only for a month that has
 * ended. Keeping the records that way is the validators' half of the property,
 * proved in `packages/validation/test/no-future-dates.property.test.ts`.
 *
 * Each engine is then asked only what a caller may ask it: a completed-month
 * engine about a month that has ended, the month-to-date engine about the month
 * containing `today`, a conversion about a day or a month that has happened.
 * Its whole result is scanned rather than a list of its fields: every string in
 * it, at any depth, and every `YYYY-MM-DD` or `YYYY-MM` inside one — explanation
 * lines included — must be no later than `today` or `today`'s month. A date
 * field added to an output later is covered without anyone listing it here.
 *
 * One kind of date is exempt, and the exemption is tested rather than assumed: a
 * recurring schedule's occurrence date. It is the schedule's identity, not a
 * financial fact, and the blueprint puts it after `today` on purpose — an
 * upcoming occurrence, and the one "received today" may reach (30.9 item 2,
 * 30.10). The last block proves a date after `today` appears there only as such
 * an identity, and never as the date money moved.
 */

const BASE = plainDate('2024-01-01');
const HISTORY_DAYS = 420;
const EUR = currencyCode('EUR');
const USD = currencyCode('USD');
const RUNS = { numRuns: 200 };

/* -------------------------------------------------------------------------- */
/* The oracle                                                                  */
/* -------------------------------------------------------------------------- */

interface FoundDate {
  readonly path: string;
  readonly value: string;
}

const DATE_LIKE = /\d{4}-\d{2}(?:-\d{2})?/gu;

/** Every date or month written anywhere in a value, with where it was found. */
function datesIn(value: unknown, path = '$', found: FoundDate[] = []): FoundDate[] {
  if (typeof value === 'string') {
    for (const match of value.matchAll(DATE_LIKE)) found.push({ path, value: match[0] });
    return found;
  }
  if (value === null || typeof value !== 'object' || value instanceof Decimal) return found;
  if (value instanceof Map) {
    for (const [key, child] of value) {
      datesIn(key, `${path}<key>`, found);
      datesIn(child, `${path}[${String(key)}]`, found);
    }
    return found;
  }
  if (value instanceof Set || Array.isArray(value)) {
    [...(value as Iterable<unknown>)].forEach((child, index) => {
      datesIn(child, `${path}[${String(index)}]`, found);
    });
    return found;
  }
  for (const [key, child] of Object.entries(value)) datesIn(child, `${path}.${key}`, found);
  return found;
}

/** The dates in `output` after `today`, and the months after `today`'s month. */
function afterToday(output: unknown, today: PlainDate): FoundDate[] {
  const month = today.slice(0, 7);
  return datesIn(output).filter(({ value }) => (value.length === 10 ? value > today : value > month));
}

function expectNoneAfter(today: PlainDate, outputs: Record<string, unknown>): void {
  for (const [engine, output] of Object.entries(outputs)) {
    expect(afterToday(output, today), `${engine}, today ${today}`).toEqual([]);
  }
}

describe('the oracle', () => {
  it('finds a date at any depth, inside text, and in a month key', () => {
    const found = datesIn({
      asOf: '2026-09-06',
      buckets: [{ explanation: ['Through 2026-09-08, for 2026-09.'] }],
      nested: new Map([['k', { on: '2026-10-01' }]]),
      amount: new Decimal('2026.09'),
    });
    expect(found.map(({ value }) => value)).toEqual(['2026-09-06', '2026-09-08', '2026-09', '2026-10-01']);
    expect(afterToday(found.map(({ value }) => value), plainDate('2026-09-07')).map(({ value }) => value)).toEqual([
      '2026-09-08',
      '2026-10-01',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* A history the validators would have let in                                 */
/* -------------------------------------------------------------------------- */

const todayArb = fc.integer({ min: 0, max: 4 * 365 }).map((days) => addDays(BASE, days));

/** A day on or before `today`, inside the generated history. */
const pastDay = (today: PlainDate) =>
  fc.integer({ min: 0, max: HISTORY_DAYS }).map((back) => addDays(today, -back));

/** A month that has ended, `back` months before `today`'s. */
const endedMonth = (today: PlainDate, back: number): MonthKey =>
  monthKey(addMonths(startOfMonth(today), -back));

/** The last day of a month that has ended: `today > end(M)`. */
const endedMonthEnd = (today: PlainDate) =>
  fc.integer({ min: 1, max: 14 }).map((back) => endOfMonth(addMonths(startOfMonth(today), -back)));

const amountArb = fc
  .tuple(fc.integer({ min: 0, max: 20_000 }), fc.integer({ min: 0, max: 99 }))
  .map(([whole, cents]) => `${String(whole)}.${String(cents).padStart(2, '0')}`);
const positiveAmountArb = amountArb.filter((amount) => new Decimal(amount).gt(0));

/** One balance: an exact snapshot on any past day, or a statement of a month that has ended. */
const balanceArb = (today: PlainDate) =>
  fc.oneof(
    fc.record({ on: pastDay(today), statement: fc.constant(false), amount: amountArb }),
    fc.record({ on: endedMonthEnd(today), statement: fc.constant(true), amount: amountArb }),
    // A last-day snapshot of a month that has ended, not yet confirmed.
    fc.record({ on: endedMonthEnd(today), statement: fc.constant(false), amount: amountArb }),
  );

const ACCOUNT_IDS = ['acct-a', 'acct-b', 'acct-c'] as const;

function accountArb(today: PlainDate, id: string): fc.Arbitrary<CashAccountInput> {
  return fc
    .record({
      currency: fc.constantFrom(EUR, USD),
      savings: fc.boolean(),
      opened: fc.option(pastDay(today), { nil: null }),
      balances: fc.uniqueArray(balanceArb(today), { maxLength: 8, selector: (balance) => balance.on }),
      dormant: fc.boolean(),
    })
    .map(({ currency, savings, opened, balances, dormant }) => {
      const valuations: ValuationRecord[] = balances
        .filter((balance) => opened === null || balance.on >= opened)
        .sort((a, b) => (a.on < b.on ? -1 : 1))
        .map((balance) =>
          balance.statement ? monthEnd(id, balance.on, balance.amount) : valuation(id, balance.on, balance.amount),
        );
      // A dormant flag rests on a zero that is the account's latest balance (8.8).
      const latest = valuations.at(-1);
      const restsOnZero = dormant && latest !== undefined && latest.amount.isZero();
      return {
        position: position(`Account ${id}`, {
          id,
          currency,
          ...(opened === null ? {} : { openedOn: opened }),
          ...(restsOnZero ? { dormantFrom: latest.valuedOn } : {}),
        }),
        valuations,
        accountType: savings ? 'savings' : 'checking',
      };
    });
}

interface Flows {
  readonly income: IncomeFlow[];
  readonly expenses: ExpenseFlow[];
  readonly transfers: TransferFlow[];
}

function flowsArb(today: PlainDate, accounts: readonly CashAccountInput[]): fc.Arbitrary<Flows> {
  const ids = accounts.map((account) => account.position.id);
  const currencyOf = (id: string | null, fallback: CurrencyCode): CurrencyCode =>
    accounts.find((account) => account.position.id === id)?.position.currency ?? fallback;
  const legArb = fc.option(fc.constantFrom(...ids), { nil: null });

  const incomeArb = fc.record({
    account: legArb,
    currency: fc.constantFrom(EUR, USD),
    amount: amountArb,
    on: pastDay(today),
  });
  const expenseArb = fc.record({
    account: legArb,
    currency: fc.constantFrom(EUR, USD),
    amount: positiveAmountArb,
    on: pastDay(today),
    settlement: fc.constantFrom('tracked_cash' as const, 'untracked_self' as const, 'third_party' as const),
    kind: fc.constantFrom('food' as const, 'insurance' as const, 'investment_fee' as const, 'external_outflow' as const),
  });
  // A transfer needs two different accounts, so a one-account world has none.
  const transferArb = fc.record({
    endpoints: fc.uniqueArray(fc.constantFrom(...ids), { minLength: 2, maxLength: 2 }),
    sent: positiveAmountArb,
    received: positiveAmountArb,
    on: pastDay(today),
    fee: fc.option(fc.record({ amount: positiveAmountArb, on: pastDay(today), paidByTarget: fc.boolean() }), {
      nil: null,
    }),
  });

  return fc
    .tuple(
      fc.array(incomeArb, { maxLength: 6 }),
      fc.array(expenseArb, { maxLength: 6 }),
      ids.length < 2 ? fc.constant([]) : fc.array(transferArb, { maxLength: 3 }),
    )
    .map(([incomeRows, expenseRows, transferRows]) => {
      const income = incomeRows.map(
        (row, index): IncomeFlow => ({
          id: `income-${String(index)}`,
          kind: 'employment',
          receivedOn: row.on,
          netAmount: new Decimal(row.amount),
          currency: currencyOf(row.account, row.currency),
          settlement: 'tracked_cash',
          cashPositionId: row.account,
        }),
      );
      const expenses = expenseRows.map((row, index): ExpenseFlow => {
        const tracked = row.settlement === 'tracked_cash';
        return {
          id: `expense-${String(index)}`,
          categoryKind: row.kind,
          incurredOn: row.on,
          amount: new Decimal(row.amount),
          currency: tracked ? currencyOf(row.account, row.currency) : row.currency,
          settlement: row.settlement,
          cashPositionId: tracked ? row.account : null,
        };
      });
      const transfers: TransferFlow[] = [];
      transferRows.forEach((row, index) => {
        const id = `transfer-${String(index)}`;
        const [from = '', to = ''] = row.endpoints;
        const fromCurrency = currencyOf(from, EUR);
        const toCurrency = currencyOf(to, EUR);
        transfers.push({
          id,
          kind: 'cash_transfer',
          occurredOn: row.on,
          fromPositionId: from,
          fromCurrency,
          fromAmount: new Decimal(row.sent),
          toPositionId: to,
          toCurrency,
          toAmount: new Decimal(fromCurrency === toCurrency ? row.sent : row.received),
        });
        if (row.fee !== null) {
          // The fee's own financial date, bound by today like any other (M14).
          const payer = row.fee.paidByTarget ? to : from;
          expenses.push({
            id: `fee-${String(index)}`,
            categoryKind: 'transfer_fee',
            incurredOn: row.fee.on,
            amount: new Decimal(row.fee.amount),
            currency: currencyOf(payer, EUR),
            settlement: 'tracked_cash',
            cashPositionId: payer,
            transferId: id,
          });
        }
      });
      return { income, expenses, transfers };
    });
}

/** A schedule may start in the past or the future: it is not an observation (6.2). */
const scheduleArb = (today: PlainDate): fc.Arbitrary<RecurrenceSchedule> =>
  fc
    .record({
      frequency: fc.constantFrom(...RECURRENCE_FREQUENCIES),
      dayOfMonth: fc.option(fc.integer({ min: 1, max: 31 }), { nil: null }),
      start: fc.integer({ min: -HISTORY_DAYS, max: 120 }).map((offset) => addDays(today, offset)),
      length: fc.option(fc.integer({ min: 0, max: 600 }), { nil: null }),
    })
    .map(({ frequency, dayOfMonth, start, length }) => ({
      frequency,
      dayOfMonth,
      startDate: start,
      endDate: length === null ? null : addDays(start, length),
    }));

/** Stored EUR→USD rates, each published on a day that has happened. */
const ratesArb = (today: PlainDate): fc.Arbitrary<FxRateRecord[]> =>
  fc.uniqueArray(fc.tuple(pastDay(today), fc.integer({ min: 9_000, max: 13_000 })), {
    maxLength: 40,
    selector: ([day]) => day,
  }).map((rows) =>
    rows.map(([day, value]) => ({ quote: USD, rateDate: day, rate: new Decimal(value).dividedBy(10_000), source: 'ecb' })),
  );

interface World extends Flows {
  readonly today: PlainDate;
  readonly accounts: CashAccountInput[];
  readonly positions: PositionWithValuations[];
  readonly templates: CompletenessTemplate[];
  readonly resolved: ReadonlySet<string>;
  readonly fx: FxTable;
}

const worldArb: fc.Arbitrary<World> = todayArb.chain((today) =>
  fc
    .integer({ min: 1, max: ACCOUNT_IDS.length })
    .chain((count) => fc.tuple(...ACCOUNT_IDS.slice(0, count).map((id) => accountArb(today, id))))
    .chain((accounts) =>
      fc.tuple(
        fc.constant([...accounts]),
        flowsArb(today, accounts),
        fc.array(scheduleArb(today), { maxLength: 2 }),
        ratesArb(today),
      ),
    )
    .chain(([accounts, flows, schedules, rates]) => {
      const templates = schedules.map(
        (schedule, index): CompletenessTemplate => ({
          templateId: `template-${String(index)}`,
          name: `Source ${String(index)}`,
          kind: 'income',
          currency: EUR,
          incomeKind: 'employment',
          schedule,
        }),
      );
      // What a recording or a skip has resolved. A future occurrence can be
      // among them: "received today" resolves the next one early (30.10).
      const candidates = templates.flatMap((template) =>
        occurrencesInRange(template.schedule, addDays(today, -HISTORY_DAYS), addDays(today, 90)).map((date) =>
          occurrenceKey(template.templateId, date),
        ),
      );
      return fc.subarray(candidates).map(
        (resolved): World => ({
          today,
          accounts: [...accounts],
          positions: accounts.map(({ position: record, valuations }) => ({ position: record, valuations })),
          ...flows,
          templates,
          resolved: new Set(resolved),
          fx: createFxTable(rates, { today }),
        }),
      );
    }),
);

const recordsOf = (world: World): Pick<CompletedMonthInput, 'income' | 'expenses' | 'transfers'> => ({
  income: world.income,
  expenses: world.expenses,
  transfers: world.transfers,
});

interface ReportableBucket {
  readonly currency: CurrencyCode;
  readonly status: ReconciliationStatus;
  readonly accounts: readonly ScopeAccount[];
  readonly totals: { readonly unclassified?: Decimal | undefined };
}

/** One interval's reporting figures and known-spending rows, composed as the application composes them. */
function reportingOf(
  world: World,
  month: MonthKey,
  buckets: readonly ReportableBucket[],
  from: PlainDate,
  to: PlainDate,
) {
  const contributions: ReportingContribution[] = [];
  const missing: MissingContributionInput[] = [];
  for (const bucket of buckets) {
    const built = bucketContributions({
      records: recordsOf(world),
      expenses: world.expenses,
      currency: bucket.currency,
      accounts: bucket.accounts,
      month,
      from,
      to,
      status: bucket.status,
      unclassified: bucket.totals.unclassified,
      ...(bucket.totals.unclassified === undefined
        ? { residualReason: 'not_applicable' as const, residualDetail: 'no residual' }
        : {}),
    });
    contributions.push(...built.contributions);
    missing.push(...built.missing);
  }
  return {
    contributions,
    known: knownSpendingItems({
      records: recordsOf(world),
      buckets,
      from,
      to,
      reportingCurrency: EUR,
      fx: world.fx,
    }),
    cashFlow: reportCashFlow({
      reportingCurrency: EUR,
      fx: world.fx,
      contributions,
      missing,
      countAdditionalSpending: true,
    }),
  };
}

it('generates only a history the validators would have let in', () => {
  fc.assert(
    fc.property(worldArb, (world) => {
      for (const account of world.accounts) {
        for (const row of account.valuations) {
          expect(row.valuedOn <= world.today).toBe(true);
          if (row.datePrecision === 'month_end') {
            expect(isMonthEnd(row.valuedOn) && row.valuedOn < world.today).toBe(true);
          }
        }
      }
      const dates = [
        ...world.income.map((row) => row.receivedOn),
        ...world.expenses.map((row) => row.incurredOn),
        ...world.transfers.map((row) => row.occurredOn),
      ];
      expect(dates.every((date) => date <= world.today)).toBe(true);
    }),
    { numRuns: 50 },
  );
});

/* -------------------------------------------------------------------------- */
/* The engines                                                                 */
/* -------------------------------------------------------------------------- */

describe('property 17: no engine output carries a date after today', () => {
  it('holds for the balance sheet: net worth, its series, and each cash month state', () => {
    fc.assert(
      fc.property(
        worldArb,
        fc.integer({ min: 1, max: 24 }),
        fc.integer({ min: 0, max: HISTORY_DAYS }),
        fc.integer({ min: 0, max: 14 }),
        fc.constantFrom(EUR, USD),
        (world, months, back, monthsBack, reporting) => {
          const month = endedMonth(world.today, monthsBack);
          expectNoneAfter(world.today, {
            completedMonthEnds: completedMonthEnds(world.today, months),
            netWorthSeries: netWorthSeries({
              positions: world.positions,
              reportingCurrency: reporting,
              fx: world.fx,
              today: world.today,
              months,
            }),
            netWorthAt: netWorthAt({
              positions: world.positions,
              asOf: addDays(world.today, -back),
              reportingCurrency: reporting,
              fx: world.fx,
            }),
            // The current month (monthsBack 0) included: its close is never a statement.
            cashMonthState: world.positions.map((entry) => cashMonthState(entry.position, entry.valuations, month)),
          });
        },
      ),
      RUNS,
    );
  });

  it('holds for a completed month: reconciliation, its diagnostics, completeness and reporting', () => {
    fc.assert(
      fc.property(worldArb, fc.integer({ min: 1, max: 13 }), (world, back) => {
        const month = endedMonth(world.today, back);
        const inputOf = (m: MonthKey): CompletedMonthInput => ({
          month: m,
          today: world.today,
          cashAccounts: world.accounts,
          ...recordsOf(world),
          templates: world.templates,
          resolvedOccurrences: world.resolved,
        });
        // large_unclassified's six-month baseline, as the application reads it.
        const baseline = [1, 2, 3, 4, 5, 6].flatMap((offset) =>
          bucketObservations(reconcileCompletedMonth(inputOf(monthKey(addMonths(startOfMonthKey(month), -offset))))),
        );
        const reconciliation = withLargeUnclassified(
          withPossibleMissingConversion(reconcileCompletedMonth(inputOf(month)), world.fx),
          baseline,
        );
        expectNoneAfter(world.today, {
          reconcileCompletedMonth: reconciliation,
          completedMonthCompleteness: completedMonthCompleteness({
            month,
            today: world.today,
            positions: world.positions,
            templates: world.templates,
            resolvedOccurrences: world.resolved,
          }),
          reporting: reportingOf(world, month, reconciliation.buckets, startOfMonthKey(month), endOfMonthKey(month)),
        });
      }),
      RUNS,
    );
  });

  it('holds for the current month: month to date, each opening, and reporting through D', () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        const current = monthKey(world.today);
        const result = reconcileMonthToDate({ today: world.today, cashAccounts: world.accounts, ...recordsOf(world) });
        expectNoneAfter(world.today, {
          reconcileMonthToDate: result,
          monthToDateOpening: world.accounts.map((account) => monthToDateOpening(account, current, world.today)),
          reporting:
            result.asOf === null
              ? null
              : reportingOf(world, current, result.buckets, startOfMonthKey(current), result.asOf),
        });
      }),
      RUNS,
    );
  });

  it('holds for spans, which close on the end of a month that has ended', () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        expectNoneAfter(world.today, {
          findSpanIntervals: findSpanIntervals({ today: world.today, cashAccounts: world.accounts }),
          findSpans: findSpans({ today: world.today, cashAccounts: world.accounts, ...recordsOf(world) }),
        });
      }),
      RUNS,
    );
  });

  it('holds for income recorded: the year view and its missing occurrences', () => {
    fc.assert(
      fc.property(worldArb, fc.constantFrom(0, 1), (world, yearsBack) => {
        const year = Number.parseInt(world.today.slice(0, 4), 10) - yearsBack;
        const entries = world.income.map(
          (flow, index): RecordedIncomeEntry => ({
            id: flow.id,
            kind: flow.kind,
            settlement: flow.settlement,
            receivedOn: flow.receivedOn,
            net: money(flow.netAmount, flow.currency),
            gross: null,
            templateId: world.templates[index % 2]?.templateId ?? null,
          }),
        );
        expectNoneAfter(world.today, {
          incomeOverview: incomeOverview({
            year,
            today: world.today,
            reportingCurrency: EUR,
            fx: world.fx,
            entries,
            templates: world.templates,
            resolvedOccurrences: world.resolved,
          }),
          missingIncomeInYear: missingIncomeInYear(world.templates, world.resolved, year, world.today),
        });
      }),
      RUNS,
    );
  });

  it('holds for conversion, in every mode, about a day or a month that has happened', () => {
    fc.assert(
      fc.property(
        worldArb,
        fc.integer({ min: 0, max: HISTORY_DAYS }),
        fc.integer({ min: 1, max: 13 }),
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 0, max: 30 }),
        fc.constantFrom<[CurrencyCode, CurrencyCode]>([EUR, USD], [USD, EUR], [USD, USD], [EUR, EUR]),
        (world, back, monthsBack, spanLength, intoMonth, [from, to]) => {
          const amount = money(new Decimal('100'), from);
          const ended = endedMonth(world.today, monthsBack);
          const spanFrom = endedMonth(world.today, monthsBack + spanLength);
          // The current month's average exists only through some D on or
          // before today (10.2); any day of the month up to today is one.
          const monthStart = startOfMonthKey(monthKey(world.today));
          const through = [addDays(monthStart, intoMonth), world.today].sort()[0] as PlainDate;
          expectNoneAfter(world.today, {
            dated: convert(amount, to, addDays(world.today, -back), world.fx),
            completedAverage: convert(amount, to, endOfMonthKey(ended), world.fx, { mode: 'monthly_average' }),
            currentAverage: convert(amount, to, through, world.fx, { mode: 'monthly_average', through }),
            spanAverage: convert(amount, to, endOfMonthKey(ended), world.fx, {
              mode: 'span_average',
              span: { from: spanFrom, to: ended },
            }),
          });
        },
      ),
      RUNS,
    );
  });

  it('holds for the rolling windows, over the completed months they are given', () => {
    fc.assert(
      fc.property(
        todayArb,
        fc.integer({ min: 1, max: 24 }),
        fc.array(fc.boolean(), { maxLength: 24 }),
        (today, length, reliable) => {
          const last = endedMonth(today, 1);
          const first = monthKey(addMonths(startOfMonthKey(last), -(length - 1)));
          const observations = reliable.map((ok, index) => ({
            month: monthKey(addMonths(startOfMonthKey(last), -index)),
            monthStatus: ok ? ('reliable' as const) : ('unavailable' as const),
            trackedTotalSpending: { value: money(new Decimal(index), EUR), availability: 'available' as const },
          }));
          expectNoneAfter(today, {
            rolling: buildRollingTrackedSpendingSeries(observations, { from: first, to: last }),
          });
        },
      ),
      RUNS,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The one exemption: a schedule's identity                                    */
/* -------------------------------------------------------------------------- */

describe('property 17: only a schedule identity may lie after today', () => {
  const sourceArb = todayArb.chain((today) =>
    fc.record({
      today: fc.constant(today),
      schedule: scheduleArb(today),
      yearsAhead: fc.constantFrom(-1, 0, 1),
      resolve: fc.array(fc.constantFrom('paid' as const, 'skipped' as const, 'open' as const), { maxLength: 40 }),
    }),
  );

  it('lets a source’s year show future occurrences, but never money dated after today', () => {
    fc.assert(
      fc.property(sourceArb, ({ today, schedule, yearsAhead, resolve }) => {
        const year = Number.parseInt(today.slice(0, 4), 10) + yearsAhead;
        const template: CompletenessTemplate = {
          templateId: 'source',
          name: 'Source',
          kind: 'income',
          currency: EUR,
          incomeKind: 'employment',
          schedule,
        };
        const scheduled = occurrencesInRange(schedule, plainDate(`${String(year)}-01-01`), plainDate(`${String(year)}-12-31`));
        // What the validators allow: money dated on or before today, recording
        // any occurrence. A payment for a future occurrence is an early receipt,
        // dated today (30.10).
        const payments = scheduled.flatMap((occurrenceDate, index) =>
          resolve[index] === 'paid'
            ? [
                {
                  id: `payment-${String(index)}`,
                  occurrenceDate,
                  receivedOn: occurrenceDate <= today ? occurrenceDate : today,
                  net: money(new Decimal('100'), EUR),
                  gross: null,
                },
              ]
            : [],
        );
        const skips = scheduled.flatMap((occurrenceDate, index) =>
          resolve[index] === 'skipped'
            ? [{ id: `skip-${String(index)}`, occurrenceDate, reason: 'skipped', note: null }]
            : [],
        );

        const result = incomeSourceYear({ template, payments, skips, year, today });

        for (const { path } of afterToday(result, today)) {
          // A schedule identity, nothing else: the occurrence itself, or the
          // occurrence a payment or a skip records.
          expect(path, `${path}, today ${today}`).toMatch(
            /^\$\.occurrences\[\d+\]\.(?:occurrenceDate|state\.payment\.occurrenceDate|state\.skip\.occurrenceDate)$/u,
          );
        }
        for (const occurrence of result.occurrences) {
          if (occurrence.state.kind === 'received') expect(occurrence.state.payment.receivedOn <= today).toBe(true);
          if (occurrence.state.kind === 'missing') expect(occurrence.occurrenceDate < today).toBe(true);
        }
        expect(result.missing.every((date) => date < today)).toBe(true);
      }),
      RUNS,
    );
  });

  it('puts "received today" on the next unresolved occurrence after today, and on nothing earlier', () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        for (const template of world.templates) {
          const resolvedDates = new Set(
            [...world.resolved]
              .filter((key) => key.startsWith(`${template.templateId}#`))
              .map((key) => key.slice(template.templateId.length + 1)),
          );
          const next = nextUnresolvedOccurrence(template.schedule, world.today, resolvedDates);
          // 30.10: strictly after today by design. It is an occurrence date, and
          // the acceptance it allows is dated today.
          if (next !== undefined) expect(next > world.today).toBe(true);
        }
      }),
      RUNS,
    );
  });
});
