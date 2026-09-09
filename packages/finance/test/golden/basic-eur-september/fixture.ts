import { Decimal } from '../../../src/decimal';
import { monthKeyOf, plainDate } from '../../../src/dates/plain-date';
import { currencyCode } from '../../../src/money/types';
import { monthEnd, position } from '../../helpers/records';
import type { RoleLeg } from '../../../src/flows/roles';
import type { ExpenseFlow, IncomeFlow, TransferFlow } from '../../../src/flows/types';
import type { CashAccountInput, CompletedMonthInput } from '../../../src/reconciliation/index';

/**
 * Golden fixture `reconciliation/basic-eur-september` — blueprint 8.10.
 *
 * The EUR bucket of September 2026, built record by record from the table in
 * 8.10. Its two accounts are the two of the `simple-user` fixture, and their
 * 31 August balances are the same rows: 8,055.00 and 8,509.00.
 *
 * See README.md for every figure computed by hand from these records.
 *
 * ## The mortgage payment, and why it is not dressed up as a Phase 3 record
 *
 * 8.10's example contains a liability payment and an investment contribution.
 * The contribution is a real Phase 3 `transfers` row (its destination is simply
 * a position this bucket does not include). The mortgage is not: Phase 3 has no
 * `liability_payments` table, and its two parts classify differently — 235
 * principal is `Nout`, 111 interest is `K` (7.4).
 *
 * So it is supplied through `preClassifiedLegs`, the seam the engine declares
 * for exactly this. The alternative — an expense row with a category that
 * happens to classify as `K` and a transfer that happens to classify as `Nout` —
 * would produce the same arithmetic while claiming the fixture contains records
 * it does not, and would go on being wrong once Phase 5 adds the real table.
 */

export const EUR = currencyCode('EUR');
export const SEPTEMBER = monthKeyOf(2026, 9);
/** 8.1: a month is completed when `today > end(M)`, so the 1st of October. */
export const TODAY = plainDate('2026-10-01');

export const ids = {
  bbva: 'golden-sep-bbva',
  savings: 'golden-sep-savings',
  sp500: 'golden-sep-sp500',
} as const;

const bbva = position('BBVA checking', { id: ids.bbva, currency: 'EUR' });
const savings = position('Savings', { id: ids.savings, currency: 'EUR' });

export function accounts(): CashAccountInput[] {
  return [
    {
      position: bbva,
      valuations: [
        monthEnd(ids.bbva, '2026-08-31', '8055.00'),
        monthEnd(ids.bbva, '2026-09-30', '7880.00'),
      ],
      accountType: 'checking',
    },
    {
      position: savings,
      valuations: [
        monthEnd(ids.savings, '2026-08-31', '8509.00'),
        monthEnd(ids.savings, '2026-09-30', '8740.00'),
      ],
      accountType: 'savings',
    },
  ];
}

/** 25 Sep net salary 2,100.00 → BBVA. */
const salary: IncomeFlow = {
  id: 'golden-sep-salary',
  kind: 'employment',
  receivedOn: plainDate('2026-09-25'),
  netAmount: new Decimal('2100.00'),
  currency: EUR,
  settlement: 'tracked_cash',
  cashPositionId: ids.bbva,
};

/** The €31 the Savings residual suspects. Recorded only in one variant. */
const interest: IncomeFlow = {
  id: 'golden-sep-interest',
  kind: 'interest',
  receivedOn: plainDate('2026-09-30'),
  netAmount: new Decimal('31.00'),
  currency: EUR,
  settlement: 'tracked_cash',
  cashPositionId: ids.savings,
};

const expenses: ExpenseFlow[] = [
  {
    id: 'golden-sep-insurance',
    categoryKind: 'insurance',
    incurredOn: plainDate('2026-09-12'),
    amount: new Decimal('300.00'),
    currency: EUR,
    settlement: 'tracked_cash',
    cashPositionId: ids.bbva,
  },
  // 20 Sep dinner, paid by a partner. Not the user's spending at all (7.4).
  {
    id: 'golden-sep-dinner',
    categoryKind: 'food',
    incurredOn: plainDate('2026-09-20'),
    amount: new Decimal('80.00'),
    currency: EUR,
    settlement: 'third_party',
    cashPositionId: null,
  },
  // 22 Sep coffee, from an old untracked account. Real spending that no tracked
  // balance moved for, so it sits beside the identity and never inside it.
  {
    id: 'golden-sep-coffee',
    categoryKind: 'food',
    incurredOn: plainDate('2026-09-22'),
    amount: new Decimal('50.00'),
    currency: EUR,
    settlement: 'untracked_self',
    cashPositionId: null,
  },
];

const transfers: TransferFlow[] = [
  {
    id: 'golden-sep-transfer',
    kind: 'cash_transfer',
    occurredOn: plainDate('2026-09-05'),
    fromPositionId: ids.bbva,
    fromCurrency: EUR,
    fromAmount: new Decimal('200.00'),
    toPositionId: ids.savings,
    toCurrency: EUR,
    toAmount: new Decimal('200.00'),
  },
  // 10 Sep contribution BBVA → S&P 500. The destination is an investment, so
  // only the BBVA leg belongs to this cash bucket.
  {
    id: 'golden-sep-contribution',
    kind: 'contribution',
    occurredOn: plainDate('2026-09-10'),
    fromPositionId: ids.bbva,
    fromCurrency: EUR,
    fromAmount: new Decimal('1000.00'),
    toPositionId: ids.sp500,
    toCurrency: EUR,
    toAmount: new Decimal('1000.00'),
  },
];

/** 1 Sep mortgage 346.00 = interest 111.00 (`K`) + principal 235.00 (`Nout`). */
const mortgage: RoleLeg[] = [
  {
    role: 'Nout',
    currency: EUR,
    amount: new Decimal('235.00'),
    cashPositionId: ids.bbva,
    on: plainDate('2026-09-01'),
    sourceId: 'golden-sep-mortgage',
  },
  {
    role: 'K',
    currency: EUR,
    amount: new Decimal('111.00'),
    cashPositionId: ids.bbva,
    on: plainDate('2026-09-01'),
    sourceId: 'golden-sep-mortgage',
  },
];

export interface Variant {
  /** The €31 savings interest is recorded as income. */
  readonly withInterest?: boolean;
  /** The salary was never entered. */
  readonly withoutSalary?: boolean;
}

export function input(variant: Variant = {}): CompletedMonthInput {
  return {
    month: SEPTEMBER,
    today: TODAY,
    cashAccounts: accounts(),
    income: [
      ...(variant.withoutSalary === true ? [] : [salary]),
      ...(variant.withInterest === true ? [interest] : []),
    ],
    expenses,
    transfers,
    templates: [],
    resolvedOccurrences: new Set<string>(),
    preClassifiedLegs: mortgage,
  };
}
