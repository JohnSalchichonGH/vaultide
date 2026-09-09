import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/decimal';
import { monthKey, plainDate } from '../src/dates/plain-date';
import { currencyCode } from '../src/money/types';
import { monthEnd, position, valuation } from './helpers/records';
import type { ExpenseFlow, IncomeFlow, TransferFlow } from '../src/flows/types';
import { findSpans, type CashAccountInput, type SpanInput } from '../src/reconciliation/index';

/**
 * Multi-month reconciliation spans (blueprint 8.7, v2.1.11 30.14).
 *
 * Every fixture was written from 8.7 and 30.14 before the engine ran against
 * it. "Today" is 1 December 2026 unless a case needs otherwise, so September,
 * October and November are all completed months and December is not.
 */

const EUR = currencyCode('EUR');
const USD = currencyCode('USD');
const TODAY = plainDate('2026-12-01');

const A = 'account-a';
const B = 'account-b';

function account(
  id: string,
  name: string,
  valuations: CashAccountInput['valuations'],
  options: { currency?: string; openedOn?: string; closedOn?: string; isDormant?: boolean } = {},
): CashAccountInput {
  return {
    position: position(name, {
      id,
      currency: options.currency ?? 'EUR',
      ...(options.openedOn === undefined ? {} : { openedOn: options.openedOn }),
      ...(options.closedOn === undefined ? {} : { closedOn: options.closedOn, status: 'closed' }),
      ...(options.isDormant === undefined ? {} : { isDormant: options.isDormant }),
    }),
    valuations,
    accountType: 'checking',
  };
}

let sequence = 0;
const nextId = (prefix: string): string => `${prefix}-${String((sequence += 1))}`;

function income(over: Partial<IncomeFlow> = {}): IncomeFlow {
  return {
    id: nextId('income'),
    kind: 'employment',
    receivedOn: plainDate('2026-09-25'),
    netAmount: new Decimal('100'),
    currency: EUR,
    settlement: 'tracked_cash',
    cashPositionId: A,
    ...over,
  };
}

function expense(over: Partial<ExpenseFlow> = {}): ExpenseFlow {
  return {
    id: nextId('expense'),
    categoryKind: 'food',
    incurredOn: plainDate('2026-09-12'),
    amount: new Decimal('100'),
    currency: EUR,
    settlement: 'tracked_cash',
    cashPositionId: A,
    ...over,
  };
}

function transfer(over: Partial<TransferFlow> = {}): TransferFlow {
  return {
    id: nextId('transfer'),
    kind: 'cash_transfer',
    occurredOn: plainDate('2026-09-05'),
    fromPositionId: A,
    fromCurrency: EUR,
    fromAmount: new Decimal('200'),
    toPositionId: B,
    toCurrency: EUR,
    toAmount: new Decimal('200'),
    ...over,
  };
}

function input(over: Partial<SpanInput> = {}): SpanInput {
  return {
    today: TODAY,
    cashAccounts: [],
    income: [],
    expenses: [],
    transfers: [],
    ...over,
  };
}

/* -------------------------------------------------------------------------- */
/* A — the 8.10 span golden                                                   */
/* -------------------------------------------------------------------------- */

describe('A — the §8.10 span golden', () => {
  /**
   * 8.10's `reconciliation/span-sep-oct`. The same two accounts as the
   * completed golden; September's month-end balances are missing and October's
   * are BBVA 7,700.00 and Savings 8,900.00.
   *
   * The mortgage payments arrive through the pre-classified seam, as they do in
   * the completed golden: Phase 3 has no `liability_payments` table, and the
   * payment's principal is `Nout` while its interest is `K`.
   */
  const BBVA = 'golden-span-bbva';
  const SAVINGS = 'golden-span-savings';
  const SP500 = 'golden-span-sp500';

  const goldenInput = (): SpanInput => ({
    today: plainDate('2026-11-01'),
    cashAccounts: [
      account(BBVA, 'BBVA', [
        monthEnd(BBVA, '2026-08-31', '8055.00'),
        monthEnd(BBVA, '2026-10-31', '7700.00'),
      ]),
      account(SAVINGS, 'Savings', [
        monthEnd(SAVINGS, '2026-08-31', '8509.00'),
        monthEnd(SAVINGS, '2026-10-31', '8900.00'),
      ]),
    ],
    income: [
      income({ receivedOn: plainDate('2026-09-25'), netAmount: new Decimal('2100.00'), cashPositionId: BBVA }),
      income({ receivedOn: plainDate('2026-10-25'), netAmount: new Decimal('2100.00'), cashPositionId: BBVA }),
    ],
    expenses: [
      expense({ categoryKind: 'insurance', incurredOn: plainDate('2026-09-12'), amount: new Decimal('300.00'), cashPositionId: BBVA }),
      expense({ categoryKind: 'maintenance', incurredOn: plainDate('2026-10-14'), amount: new Decimal('450.00'), cashPositionId: BBVA }),
    ],
    transfers: [
      transfer({ occurredOn: plainDate('2026-09-05'), fromPositionId: BBVA, toPositionId: SAVINGS }),
      transfer({ occurredOn: plainDate('2026-10-05'), fromPositionId: BBVA, toPositionId: SAVINGS }),
      transfer({ kind: 'contribution', occurredOn: plainDate('2026-09-10'), fromPositionId: BBVA, toPositionId: SP500, fromAmount: new Decimal('1000.00'), toAmount: new Decimal('1000.00') }),
      transfer({ kind: 'contribution', occurredOn: plainDate('2026-10-10'), fromPositionId: BBVA, toPositionId: SP500, fromAmount: new Decimal('1000.00'), toAmount: new Decimal('1000.00') }),
    ],
    preClassifiedLegs: [
      { role: 'Nout', currency: EUR, amount: new Decimal('235.00'), cashPositionId: BBVA, on: plainDate('2026-09-01'), sourceId: 'mortgage-sep' },
      { role: 'K', currency: EUR, amount: new Decimal('111.00'), cashPositionId: BBVA, on: plainDate('2026-09-01'), sourceId: 'mortgage-sep' },
      { role: 'Nout', currency: EUR, amount: new Decimal('235.00'), cashPositionId: BBVA, on: plainDate('2026-10-01'), sourceId: 'mortgage-oct' },
      { role: 'K', currency: EUR, amount: new Decimal('111.00'), cashPositionId: BBVA, on: plainDate('2026-10-01'), sourceId: 'mortgage-oct' },
    ],
  });

  const spans = findSpans(goldenInput());
  const span = spans[0];

  it('finds exactly one span, 1 Sep – 31 Oct', () => {
    expect(spans).toHaveLength(1);
    expect(span?.from).toBe('2026-09-01');
    expect(span?.to).toBe('2026-10-31');
    expect(span?.months).toEqual(['2026-09-01', '2026-10-01']);
  });

  it('reproduces 8.10 exactly', () => {
    // Δ = (7,700 − 8,055) + (8,900 − 8,509) = −355 + 391
    expect(span?.totals.cashDelta.toString()).toBe('36');
    expect(span?.totals.externalInflows.toString()).toBe('4200');
    expect(span?.totals.nonIncomeInflows.toString()).toBe('400');
    // 400 transferred + 2,000 contributed + 470 principal
    expect(span?.totals.nonExpenseOutflows.toString()).toBe('2870');
    // 300 insurance + 450 car repair + 222 mortgage interest
    expect(span?.totals.knownTrackedExpenses.toString()).toBe('972');
    expect(span?.trackedTotalSpending.toString()).toBe('1694');
    expect(span?.unclassified.toString()).toBe('722');
    expect(span?.status).toBe('reliable');
  });

  it('carries no per-month figure and no issues', () => {
    // 30.14 items 6 and 8. The presentation is a total and a month count.
    const keys = Object.keys(span ?? {});
    expect(keys).not.toContain('perMonthAverageInformational');
    expect(keys).not.toContain('issues');
    expect(keys).not.toContain('residuals');
    expect(JSON.stringify(span)).not.toContain('average');
  });
});

/* -------------------------------------------------------------------------- */
/* Discovery                                                                   */
/* -------------------------------------------------------------------------- */

/** Month-end balances at the named month ends, and nowhere else. */
const withEnds = (id: string, name: string, ends: [string, string][], options = {}) =>
  account(id, name, ends.map(([on, amount]) => monthEnd(id, on, amount)), options);

describe('B — one missing intermediate month end', () => {
  const spans = findSpans(
    input({
      cashAccounts: [
        withEnds(A, 'BBVA', [
          ['2026-08-31', '1000'],
          ['2026-10-31', '900'],
          ['2026-11-30', '900'],
        ]),
      ],
    }),
  );

  it('produces one two-month span', () => {
    expect(spans).toHaveLength(1);
    expect(spans[0]?.from).toBe('2026-09-01');
    expect(spans[0]?.to).toBe('2026-10-31');
    expect(spans[0]?.months).toHaveLength(2);
    expect(spans[0]?.totals.cashDelta.toString()).toBe('-100');
    expect(spans[0]?.trackedTotalSpending.toString()).toBe('100');
  });
});

describe('C — two consecutive missing month ends', () => {
  it('produces one three-month maximal span', () => {
    const spans = findSpans(
      input({
        cashAccounts: [
          withEnds(A, 'BBVA', [
            ['2026-08-31', '1000'],
            ['2026-11-30', '700'],
          ]),
        ],
      }),
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]?.from).toBe('2026-09-01');
    expect(spans[0]?.to).toBe('2026-11-30');
    expect(spans[0]?.months).toEqual(['2026-09-01', '2026-10-01', '2026-11-01']);
  });
});

describe('D — repairing an interior endpoint', () => {
  it('splits the span deterministically, leaving nothing stale', () => {
    const ends: [string, string][] = [
      ['2026-06-30', '1000'],
      ['2026-09-30', '940'],
      ['2026-11-30', '900'],
    ];
    // Before: 1 Jul – 30 Sep and 1 Oct – 30 Nov are already two spans.
    const before = findSpans(input({ cashAccounts: [withEnds(A, 'BBVA', ends)] }));
    expect(before.map((s) => `${s.from}..${s.to}`)).toEqual([
      '2026-07-01..2026-09-30',
      '2026-10-01..2026-11-30',
    ]);

    // Entering 31 August splits the first: July–August, then September alone,
    // which is a single month and so no longer a span.
    const after = findSpans(
      input({
        cashAccounts: [withEnds(A, 'BBVA', [...ends, ['2026-08-31', '960']])],
      }),
    );
    expect(after.map((s) => `${s.from}..${s.to}`)).toEqual([
      '2026-07-01..2026-08-31',
      '2026-10-01..2026-11-30',
    ]);
  });
});

describe('U — a one-month gap', () => {
  it('is not a span', () => {
    const spans = findSpans(
      input({
        cashAccounts: [
          withEnds(A, 'BBVA', [
            ['2026-09-30', '1000'],
            ['2026-10-31', '900'],
          ]),
        ],
      }),
    );
    expect(spans).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Accounts inside the interval                                                */
/* -------------------------------------------------------------------------- */

describe('E — an account opened inside the span', () => {
  it('opens at zero and owes the opening anchor nothing', () => {
    const spans = findSpans(
      input({
        cashAccounts: [
          withEnds(A, 'BBVA', [
            ['2026-08-31', '1000'],
            ['2026-11-30', '600'],
          ]),
          withEnds(B, 'New', [['2026-11-30', '300']], { openedOn: '2026-10-05' }),
        ],
        transfers: [
          transfer({
            occurredOn: plainDate('2026-10-06'),
            fromAmount: new Decimal('300'),
            toAmount: new Decimal('300'),
          }),
        ],
      }),
    );
    expect(spans).toHaveLength(1);
    const opened = spans[0]?.accounts.find((a) => a.positionId === B);
    expect(opened?.openingState).toBe('opened_zero');
    expect(opened?.opening.toString()).toBe('0');
    expect(opened?.closing.toString()).toBe('300');
    // −400 on BBVA and +300 on the new account.
    expect(spans[0]?.totals.cashDelta.toString()).toBe('-100');
    expect(spans[0]?.trackedTotalSpending.toString()).toBe('100');
  });
});

describe('F — an account closed inside the span', () => {
  it('closes at zero and needs no later statement', () => {
    const spans = findSpans(
      input({
        cashAccounts: [
          withEnds(A, 'BBVA', [
            ['2026-08-31', '1000'],
            ['2026-11-30', '1000'],
          ]),
          withEnds(B, 'Closed', [['2026-08-31', '80']], { closedOn: '2026-10-04' }),
        ],
      }),
    );
    expect(spans).toHaveLength(1);
    const closed = spans[0]?.accounts.find((a) => a.positionId === B);
    expect(closed?.closingState).toBe('closed_zero');
    expect(closed?.closing.toString()).toBe('0');
    expect(spans[0]?.totals.cashDelta.toString()).toBe('-80');
  });
});

describe('G — an account opened and closed inside the span', () => {
  it('runs from zero to zero and keeps its flows', () => {
    const spans = findSpans(
      input({
        cashAccounts: [
          withEnds(A, 'BBVA', [
            ['2026-08-31', '1000'],
            ['2026-11-30', '1000'],
          ]),
          account(B, 'Brief', [valuation(B, '2026-10-20', '0')], {
            openedOn: '2026-10-01',
            closedOn: '2026-10-20',
          }),
        ],
        expenses: [
          expense({ incurredOn: plainDate('2026-10-10'), amount: new Decimal('25'), cashPositionId: B }),
        ],
      }),
    );
    expect(spans).toHaveLength(1);
    const brief = spans[0]?.accounts.find((a) => a.positionId === B);
    expect(brief?.openingState).toBe('opened_zero');
    expect(brief?.closingState).toBe('closed_zero');
    // Its expense is attributed and counted.
    expect(spans[0]?.totals.knownTrackedExpenses.toString()).toBe('25');
  });
});

describe('H — a pre-existing account with no evidence at the anchor', () => {
  it('leaves that anchor incomplete, so nothing is anchored there', () => {
    // 30.14 item 5: not a span-level `first_balance` exclusion — the anchor
    // simply is not complete, so no span starts from it.
    const spans = findSpans(
      input({
        cashAccounts: [
          withEnds(A, 'BBVA', [
            ['2026-08-31', '1000'],
            ['2026-11-30', '900'],
          ]),
          // Existed all along; first evidence is 30 November.
          withEnds(B, 'Newly tracked', [['2026-11-30', '5000']]),
        ],
      }),
    );
    expect(spans).toEqual([]);
  });
});

describe('I and J — structural zeros at an anchor', () => {
  it('a dormant account does not block a span', () => {
    const spans = findSpans(
      input({
        cashAccounts: [
          withEnds(A, 'BBVA', [
            ['2026-08-31', '1000'],
            ['2026-11-30', '900'],
          ]),
          account(B, 'Old account', [valuation(B, '2026-01-01', '0')], { isDormant: true }),
        ],
      }),
    );
    expect(spans).toHaveLength(1);
    const dormant = spans[0]?.accounts.find((a) => a.positionId === B);
    expect(dormant?.openingState).toBe('dormant_zero');
    expect(dormant?.closingState).toBe('dormant_zero');
    expect(spans[0]?.totals.cashDelta.toString()).toBe('-100');
  });

  it('an account closed before the span does not block it', () => {
    const spans = findSpans(
      input({
        cashAccounts: [
          withEnds(A, 'BBVA', [
            ['2026-08-31', '1000'],
            ['2026-11-30', '900'],
          ]),
          withEnds(B, 'Long closed', [['2026-05-31', '0']], { closedOn: '2026-06-15' }),
        ],
      }),
    );
    expect(spans).toHaveLength(1);
    // Closed before the interval began, so it does not participate at all.
    expect(spans[0]?.accounts.map((a) => a.positionId)).toEqual([A]);
  });
});

describe('K — the first account opens after an empty anchor', () => {
  it('uses the empty anchor and opens the account at zero', () => {
    // 30.14 item 3: a month end before the user's first account of that
    // currency is complete, vacuously — which is exactly what lets this work.
    const spans = findSpans(
      input({
        cashAccounts: [
          withEnds(A, 'First account', [['2026-11-30', '400']], { openedOn: '2026-09-05' }),
        ],
        from: monthKey(plainDate('2026-08-01')),
      }),
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]?.from).toBe('2026-09-01');
    expect(spans[0]?.accounts[0]?.openingState).toBe('opened_zero');
    // 400 arrived and nothing says from where.
    expect(spans[0]?.totals.cashDelta.toString()).toBe('400');
    expect(spans[0]?.trackedTotalSpending.toString()).toBe('-400');
    expect(spans[0]?.status).toBe('unresolved');
  });
});

describe('L — an interval with no included account', () => {
  it('produces no span, and certainly not a zero one', () => {
    // Every account of the currency closed before the interval starts.
    const spans = findSpans(
      input({
        cashAccounts: [
          withEnds(A, 'Closed long ago', [['2026-05-31', '0']], { closedOn: '2026-06-10' }),
        ],
        from: monthKey(plainDate('2026-06-01')),
      }),
    );
    expect(spans).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Flows                                                                       */
/* -------------------------------------------------------------------------- */

describe('M and N — transfers', () => {
  it('a same-currency transfer inside the span is neutral', () => {
    const spans = findSpans(
      input({
        cashAccounts: [
          withEnds(A, 'BBVA', [
            ['2026-08-31', '1000'],
            ['2026-11-30', '800'],
          ]),
          withEnds(B, 'Savings', [
            ['2026-08-31', '0'],
            ['2026-11-30', '200'],
          ]),
        ],
        transfers: [transfer({ occurredOn: plainDate('2026-10-05') })],
      }),
    );
    expect(spans[0]?.totals.nonIncomeInflows.toString()).toBe('200');
    expect(spans[0]?.totals.nonExpenseOutflows.toString()).toBe('200');
    expect(spans[0]?.totals.cashDelta.toString()).toBe('0');
    expect(spans[0]?.trackedTotalSpending.toString()).toBe('0');
  });

  it('a cross-currency transfer contributes one native leg to each span', () => {
    const spans = findSpans(
      input({
        cashAccounts: [
          withEnds(A, 'BBVA', [
            ['2026-08-31', '1000'],
            ['2026-11-30', '800'],
          ]),
          withEnds(B, 'USD account', [
            ['2026-08-31', '0'],
            ['2026-11-30', '216.45'],
          ], { currency: 'USD' }),
        ],
        transfers: [
          transfer({
            occurredOn: plainDate('2026-10-05'),
            toCurrency: USD,
            toAmount: new Decimal('216.45'),
          }),
        ],
      }),
    );
    expect(spans.map((s) => s.currency)).toEqual(['EUR', 'USD']);
    expect(spans.find((s) => s.currency === 'EUR')?.totals.nonExpenseOutflows.toString()).toBe('200');
    expect(spans.find((s) => s.currency === 'USD')?.totals.nonIncomeInflows.toString()).toBe('216.45');
    // Neither span sees an FX effect.
    for (const span of spans) expect(span.trackedTotalSpending.toString()).toBe('0');
  });
});

describe('O, P and Q — flows with no account named', () => {
  const anchors = (): CashAccountInput =>
    withEnds(A, 'BBVA', [
      ['2026-08-31', '1000'],
      ['2026-11-30', '1100'],
    ]);

  it('O — a supported null leg enters the role sums', () => {
    const spans = findSpans(
      input({
        cashAccounts: [anchors()],
        income: [income({ cashPositionId: null, receivedOn: plainDate('2026-10-04') })],
      }),
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]?.totals.externalInflows.toString()).toBe('100');
    expect(spans[0]?.trackedTotalSpending.toString()).toBe('0');
  });

  it('is supported by an account with an explicit opening date too', () => {
    // The support predicate reads `opened_on` as well as `closed_on`, and an
    // account opened before the month supports a leg inside it.
    //
    // Two spans come back, not one: an account with a recorded opening date did
    // not exist before it, so `end(Dec 2025)` is a vacuous anchor and the
    // stretch from the account's first day to its first balance reconciles too
    // (W5). The leg under test is dated October, and belongs to the later span.
    const spans = findSpans(
      input({
        cashAccounts: [
          withEnds(A, 'BBVA', [
            ['2026-08-31', '1000'],
            ['2026-11-30', '1100'],
          ], { openedOn: '2026-01-15' }),
        ],
        income: [income({ cashPositionId: null, receivedOn: plainDate('2026-10-04') })],
      }),
    );
    expect(spans.map((span) => span.from)).toEqual([
      plainDate('2026-01-01'),
      plainDate('2026-09-01'),
    ]);
    const october = spans.find((span) => span.from === plainDate('2026-09-01'));
    expect(october?.totals.externalInflows.toString()).toBe('100');
    // The opening stretch saw no flow at all, and says so rather than borrowing
    // the later one.
    expect(spans[0]?.totals.externalInflows.toString()).toBe('0');
  });

  it('supports a null leg in every month a candidate span covers', () => {
    // 30.14 item 9 makes support a **month** predicate, and 8.7's suppression
    // rule (item 10) exists for a leg that fails it. Within a candidate span
    // that combination cannot arise, and the reason is structural rather than
    // lucky:
    //
    //   every interior month end of a candidate is incomplete — otherwise it
    //   would itself be an anchor and the pair would not be consecutive — and
    //   an end is incomplete only because some account existed then without a
    //   value there. That account is therefore open across that month, so the
    //   month has a participating account. An account that closed earlier makes
    //   the end `closed_zero`, and one that opened later owes it nothing; either
    //   way it is not what created the gap.
    //
    // So the suppression is a rule the engine keeps and a state a valid
    // candidate cannot reach. This test pins the reachable half: the account
    // whose missing November evidence creates the gap supports a leg in each of
    // the months the gap covers.
    const spans = findSpans(
      input({
        cashAccounts: [
          withEnds(A, 'BBVA', [
            ['2026-08-31', '1000'],
            ['2026-11-30', '1300'],
          ]),
        ],
        income: [
          income({ cashPositionId: null, receivedOn: plainDate('2026-09-02') }),
          income({ cashPositionId: null, receivedOn: plainDate('2026-10-02') }),
          income({ cashPositionId: null, receivedOn: plainDate('2026-11-02') }),
        ],
      }),
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]?.totals.externalInflows.toString()).toBe('300');
    expect(spans[0]?.trackedTotalSpending.toString()).toBe('0');
  });

  it('is supported by an account that closes after the leg', () => {
    // The other half of the support predicate: the account is still open when
    // the money moved, and closes later inside the interval.
    const spans = findSpans(
      input({
        cashAccounts: [
          withEnds(A, 'BBVA', [['2026-08-31', '1000']], { closedOn: '2026-11-30' }),
        ],
        income: [income({ cashPositionId: null, receivedOn: plainDate('2026-10-04') })],
      }),
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]?.totals.externalInflows.toString()).toBe('100');
    expect(spans[0]?.accounts[0]?.closingState).toBe('closed_zero');
  });

  it('P — an account that only ever closes leaves no gap to span', () => {
    // The near miss worth recording. Once an account closes, every later month
    // end is `closed_zero` and therefore complete, so the anchors are
    // consecutive and there is no candidate at all — not a suppressed one.
    const spans = findSpans(
      input({
        cashAccounts: [
          withEnds(A, 'BBVA', [['2026-08-31', '1000']], { closedOn: '2026-09-05' }),
        ],
        income: [income({ cashPositionId: null, receivedOn: plainDate('2026-10-04') })],
      }),
    );
    expect(spans).toEqual([]);
  });
});

describe('AB — discovery never widens past a consecutive pair', () => {
  it('reports the two adjacent gaps rather than one span across the anchor between them', () => {
    // Anchors at 30 Jun, 30 Sep and 30 Nov. The engine takes (Jun, Sep) and
    // (Sep, Nov) — never (Jun, Nov), which would swallow a complete month end
    // (30.14 item 10). `E_C` is evidence topology, not a search space.
    const spans = findSpans(
      input({
        cashAccounts: [
          withEnds(A, 'BBVA', [
            ['2026-06-30', '1000'],
            ['2026-09-30', '940'],
            ['2026-11-30', '900'],
          ]),
        ],
      }),
    );
    expect(spans.map((s) => `${s.from}..${s.to}`)).toEqual([
      '2026-07-01..2026-09-30',
      '2026-10-01..2026-11-30',
    ]);
    // And no returned span contains a complete month end in its interior.
    for (const span of spans) {
      const interior = span.months.slice(0, -1);
      expect(interior.every((m) => m !== '2026-09-01' || span.to === '2026-09-30')).toBe(true);
    }
  });
});

describe('V, W and X — the flow boundaries', () => {
  const twoMonthSpan = (expenses: ExpenseFlow[]) =>
    findSpans(
      input({
        cashAccounts: [
          withEnds(A, 'BBVA', [
            ['2026-08-31', '1000'],
            ['2026-10-31', '900'],
            ['2026-11-30', '900'],
          ]),
        ],
        expenses,
      }),
    )[0];

  it('V — a flow on the first day is included', () => {
    const span = twoMonthSpan([expense({ incurredOn: plainDate('2026-09-01') })]);
    expect(span?.totals.knownTrackedExpenses.toString()).toBe('100');
    expect(span?.unclassified.toString()).toBe('0');
  });

  it('W — a flow on the last day is included', () => {
    const span = twoMonthSpan([expense({ incurredOn: plainDate('2026-10-31') })]);
    expect(span?.totals.knownTrackedExpenses.toString()).toBe('100');
  });

  it('X — a flow on either side is excluded', () => {
    const span = twoMonthSpan([
      expense({ incurredOn: plainDate('2026-08-31') }),
      expense({ incurredOn: plainDate('2026-11-01') }),
    ]);
    expect(span?.totals.knownTrackedExpenses.toString()).toBe('0');
    expect(span?.unclassified.toString()).toBe('100');
  });
});

/* -------------------------------------------------------------------------- */
/* Status, currency and the current month                                      */
/* -------------------------------------------------------------------------- */

describe('R and S — the status boundary', () => {
  it('R — a negative unclassified is unresolved', () => {
    const spans = findSpans(
      input({
        cashAccounts: [
          withEnds(A, 'BBVA', [
            ['2026-08-31', '1000'],
            ['2026-11-30', '1300'],
          ]),
        ],
      }),
    );
    expect(spans[0]?.unclassified.toString()).toBe('-300');
    expect(spans[0]?.status).toBe('unresolved');
  });

  it('S — an exactly reconciled span is reliable, negative zero included', () => {
    const spans = findSpans(
      input({
        cashAccounts: [
          withEnds(A, 'BBVA', [
            ['2026-08-31', '1000'],
            ['2026-11-30', '900'],
          ]),
        ],
        expenses: [expense({ incurredOn: plainDate('2026-10-10') })],
      }),
    );
    expect(spans[0]?.unclassified.toString()).toBe('0');
    expect(spans[0]?.status).toBe('reliable');
  });
});

describe('T — two currencies with different endpoint topology', () => {
  it('discovers each currency on its own evidence', () => {
    const spans = findSpans(
      input({
        cashAccounts: [
          // EUR: complete at 31 Aug and 30 Nov only.
          withEnds(A, 'BBVA', [
            ['2026-08-31', '1000'],
            ['2026-11-30', '900'],
          ]),
          // USD: complete at 31 Aug, 31 Oct and 30 Nov.
          withEnds(B, 'USD account', [
            ['2026-08-31', '500'],
            ['2026-10-31', '480'],
            ['2026-11-30', '480'],
          ], { currency: 'USD' }),
        ],
      }),
    );
    expect(spans.map((s) => `${s.currency} ${s.from}..${s.to}`)).toEqual([
      'EUR 2026-09-01..2026-11-30',
      'USD 2026-09-01..2026-10-31',
    ]);
  });
});

describe('Z — the current month', () => {
  it('never enters a span', () => {
    // Today is 1 December; November is the last completed month. December has
    // no month end yet, and that is not a gap (30.14 item 4).
    const spans = findSpans(
      input({
        cashAccounts: [
          withEnds(A, 'BBVA', [
            ['2026-08-31', '1000'],
            ['2026-11-30', '900'],
          ]),
        ],
      }),
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]?.to).toBe('2026-11-30');
    for (const month of spans[0]?.months ?? []) expect(month < '2026-12-01').toBe(true);
  });

  it('is not reached even when it holds a balance', () => {
    const spans = findSpans(
      input({
        today: plainDate('2026-12-20'),
        cashAccounts: [
          account(A, 'BBVA', [
            monthEnd(A, '2026-08-31', '1000'),
            monthEnd(A, '2026-11-30', '900'),
            valuation(A, '2026-12-15', '880'),
          ]),
        ],
      }),
    );
    expect(spans[0]?.to).toBe('2026-11-30');
  });
});

describe('Y — a month-relative first_balance inside a span', () => {
  it('is not transplanted: the account opened inside and opens at zero', () => {
    // The account opened 5 October and its first balance is 30 November, so
    // November alone would call it `first_balance`. The span works from its own
    // interval facts (30.14 item 5).
    const spans = findSpans(
      input({
        cashAccounts: [
          withEnds(A, 'BBVA', [
            ['2026-08-31', '1000'],
            ['2026-11-30', '700'],
          ]),
          withEnds(B, 'Opened in October', [['2026-11-30', '300']], { openedOn: '2026-10-05' }),
        ],
      }),
    );
    expect(spans).toHaveLength(1);
    const opened = spans[0]?.accounts.find((a) => a.positionId === B);
    expect(opened?.openingState).toBe('opened_zero');
    expect(JSON.stringify(spans[0])).not.toContain('first_balance');
  });
});

describe('AA — no averaged or per-month field survives anywhere', () => {
  it('exposes an interval total and a month list, and nothing derived from them', () => {
    const spans = findSpans(
      input({
        cashAccounts: [
          withEnds(A, 'BBVA', [
            ['2026-08-31', '1000'],
            ['2026-11-30', '700'],
          ]),
        ],
      }),
    );
    const keys = Object.keys(spans[0] ?? {}).sort();
    expect(keys).toEqual([
      'accounts',
      'currency',
      'explanation',
      'from',
      'months',
      'status',
      'to',
      'totals',
      'trackedTotalSpending',
      'unclassified',
    ]);
  });
});

describe('untracked spending is not a span figure', () => {
  /**
   * A month's bucket states both settlements; 8.7's span does not, and this
   * fixture is what stops one creeping back. Neither figure is part of the
   * identity, so beside `trackedTotalSpending` they only invite a sum that
   * means nothing.
   */
  it('leaves both settlements out of the result and out of every total', () => {
    const spans = findSpans(
      input({
        cashAccounts: [
          withEnds(A, 'BBVA', [
            ['2026-08-31', '1000'],
            ['2026-11-30', '1000'],
          ]),
        ],
        expenses: [
          expense({ incurredOn: plainDate('2026-10-02'), settlement: 'untracked_self', cashPositionId: null, amount: new Decimal('50') }),
          expense({ incurredOn: plainDate('2026-10-03'), settlement: 'third_party', cashPositionId: null, amount: new Decimal('80') }),
        ],
      }),
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]?.totals.knownTrackedExpenses.toString()).toBe('0');
    expect(spans[0]?.trackedTotalSpending.toString()).toBe('0');
    expect(spans[0]?.unclassified.toString()).toBe('0');
    const serialised = JSON.stringify(spans[0]);
    expect(serialised).not.toContain('additionalSpending');
    expect(serialised).not.toContain('thirdPartyPaid');
  });
});

describe('W — the requested window bounds the answer, never the search', () => {
  /**
   * `from` is the earliest month a caller wants **returned**. It is not
   * permission to forget earlier evidence, and it is not a clip: a span's
   * opening anchor is a complete month end wherever it happens to fall, and
   * moving `to`/`from` inwards would report an interval whose endpoints nobody
   * measured.
   */

  it('W1 — finds a span whose opening anchor lies before the requested window', () => {
    // August is the anchor, the caller asks from October, and the answer is
    // still the September–November span with September's spending inside it.
    const cashAccounts = [
      withEnds(A, 'BBVA', [
        ['2026-08-31', '1000'],
        ['2026-11-30', '700'],
      ]),
    ];
    const expenses = [
      expense({ incurredOn: plainDate('2026-09-15'), amount: new Decimal('100') }),
    ];

    const spans = findSpans(
      input({ cashAccounts, expenses, from: monthKey(plainDate('2026-10-01')) }),
    );

    expect(spans).toHaveLength(1);
    expect(spans[0]?.from).toBe(plainDate('2026-09-01'));
    expect(spans[0]?.to).toBe(plainDate('2026-11-30'));
    expect(spans[0]?.months).toEqual(['2026-09-01', '2026-10-01', '2026-11-01']);
    expect(spans[0]?.totals.knownTrackedExpenses.toString()).toBe('100');
    expect(spans[0]?.totals.cashDelta.toString()).toBe('-300');
    expect(spans[0]?.unclassified.toString()).toBe('200');
  });

  it('W2 — looks back as far as the evidence goes, with no fixed depth', () => {
    // The anchor is more than three years before the requested window: any
    // lookback constant, however generous, would eventually be too short.
    const spans = findSpans(
      input({
        cashAccounts: [
          withEnds(A, 'BBVA', [
            ['2023-04-30', '5000'],
            ['2026-11-30', '4000'],
          ]),
        ],
        from: monthKey(plainDate('2026-11-01')),
      }),
    );

    expect(spans).toHaveLength(1);
    expect(spans[0]?.from).toBe(plainDate('2023-05-01'));
    expect(spans[0]?.months).toHaveLength(43);
    expect(spans[0]?.totals.cashDelta.toString()).toBe('-1000');
  });

  it('W3 — excludes a span that ended before the window began', () => {
    // Two spans exist: February–May and September–November. A window opening
    // in September keeps the second and drops the first entirely.
    const cashAccounts = [
      withEnds(A, 'BBVA', [
        ['2026-01-31', '1000'],
        ['2026-05-31', '900'],
        ['2026-08-31', '800'],
        ['2026-11-30', '700'],
      ]),
    ];

    expect(findSpans(input({ cashAccounts })).map((span) => span.from)).toEqual([
      plainDate('2026-02-01'),
      plainDate('2026-06-01'),
      plainDate('2026-09-01'),
    ]);

    const windowed = findSpans(
      input({ cashAccounts, from: monthKey(plainDate('2026-09-01')) }),
    );
    expect(windowed.map((span) => span.from)).toEqual([plainDate('2026-09-01')]);
  });

  it('W4 — returns an overlapping span whole, never clipped to the window', () => {
    // The window opens in November; the span runs September to November. All
    // three months, both endpoints and every total are the unwindowed answer.
    const cashAccounts = [
      withEnds(A, 'BBVA', [
        ['2026-08-31', '1000'],
        ['2026-11-30', '700'],
      ]),
    ];
    const expenses = [
      expense({ incurredOn: plainDate('2026-09-15'), amount: new Decimal('100') }),
      expense({ incurredOn: plainDate('2026-11-15'), amount: new Decimal('50') }),
    ];

    const whole = findSpans(input({ cashAccounts, expenses }));
    const windowed = findSpans(
      input({ cashAccounts, expenses, from: monthKey(plainDate('2026-11-01')) }),
    );

    expect(windowed).toHaveLength(1);
    expect(windowed[0]?.months).toEqual(['2026-09-01', '2026-10-01', '2026-11-01']);
    expect(JSON.stringify(windowed)).toBe(JSON.stringify(whole));
  });

  it('W5 — opens a span at the vacuous month end before the first account', () => {
    // The account opens in March and is first measured in June. The March–June
    // stretch is reconcilable because February owed nothing: no account of this
    // currency existed then, so `end(Feb)` is a complete anchor and the account
    // opens at exactly zero.
    const spans = findSpans(
      input({
        cashAccounts: [
          account(A, 'BBVA', [monthEnd(A, '2026-06-30', '400')], { openedOn: '2026-03-10' }),
        ],
        income: [
          income({ receivedOn: plainDate('2026-04-10'), netAmount: new Decimal('500') }),
        ],
      }),
    );

    expect(spans).toHaveLength(1);
    expect(spans[0]?.from).toBe(plainDate('2026-03-01'));
    expect(spans[0]?.to).toBe(plainDate('2026-06-30'));
    expect(spans[0]?.accounts[0]?.openingState).toBe('opened_zero');
    expect(spans[0]?.accounts[0]?.opening.toString()).toBe('0');
    expect(spans[0]?.totals.cashDelta.toString()).toBe('400');
    expect(spans[0]?.unclassified.toString()).toBe('100');
  });

  it('W5 — but an account with no recorded opening date gets no such anchor', () => {
    // The contrast that keeps W5 honest. "We do not know when this account
    // opened" is not "it did not exist": an account with a null opening date
    // existed at every month end, owes a value at each of them, and so leaves
    // every end before its first balance **incomplete**. Treating the two the
    // same would invent a change from zero that nobody measured.
    const spans = findSpans(
      input({
        cashAccounts: [account(A, 'BBVA', [monthEnd(A, '2026-06-30', '400')])],
        income: [
          income({ receivedOn: plainDate('2026-04-10'), netAmount: new Decimal('500') }),
        ],
      }),
    );

    expect(spans).toEqual([]);
  });

  it('W6 — a window only ever selects from the answer it would give without one', () => {
    // The invariant behind W1 to W4: `from` cannot create a span, cannot change
    // one, and cannot reorder them. It can only leave some out.
    const cashAccounts = [
      withEnds(A, 'BBVA', [
        ['2026-01-31', '1000'],
        ['2026-05-31', '900'],
        ['2026-08-31', '800'],
        ['2026-11-30', '700'],
      ]),
      account(B, 'Dollars', [monthEnd(B, '2026-02-28', '50'), monthEnd(B, '2026-11-30', '20')], {
        currency: 'USD',
      }),
    ];

    const whole = findSpans(input({ cashAccounts }));
    expect(whole).toHaveLength(4);

    for (const month of ['2026-01', '2026-03', '2026-06', '2026-09', '2026-12'] as const) {
      const windowed = findSpans(
        input({ cashAccounts, from: monthKey(plainDate(`${month}-01`)) }),
      );
      const expected = whole.filter((span) => span.to >= plainDate(`${month}-01`));
      expect(JSON.stringify(windowed)).toBe(JSON.stringify(expected));
    }
  });
});

describe('nothing to discover', () => {
  it('returns no spans when there is no evidence at all', () => {
    expect(findSpans(input())).toEqual([]);
  });

  it('returns no spans when the window starts after the last completed month', () => {
    // Today is 1 December, so November is the last month a span may close on.
    expect(
      findSpans(
        input({
          cashAccounts: [
            withEnds(A, 'BBVA', [
              ['2026-08-31', '1000'],
              ['2026-11-30', '900'],
            ]),
          ],
          from: monthKey(plainDate('2026-12-01')),
        }),
      ),
    ).toEqual([]);
  });
});

describe('determinism', () => {
  it('does not depend on the order accounts or flows arrive in', () => {
    const accounts = [
      withEnds(A, 'BBVA', [
        ['2026-08-31', '1000'],
        ['2026-11-30', '700'],
      ]),
      withEnds(B, 'Savings', [
        ['2026-08-31', '500'],
        ['2026-11-30', '500'],
      ]),
    ];
    const expenses = [
      expense({ incurredOn: plainDate('2026-09-11') }),
      expense({ incurredOn: plainDate('2026-10-11') }),
    ];

    const forward = findSpans(input({ cashAccounts: accounts, expenses }));
    const reversed = findSpans(
      input({ cashAccounts: [...accounts].reverse(), expenses: [...expenses].reverse() }),
    );

    expect(forward.map((s) => s.unclassified.toString())).toEqual(
      reversed.map((s) => s.unclassified.toString()),
    );
    expect(forward[0]?.accounts.map((a) => a.positionId)).toEqual(
      reversed[0]?.accounts.map((a) => a.positionId),
    );
  });
});
