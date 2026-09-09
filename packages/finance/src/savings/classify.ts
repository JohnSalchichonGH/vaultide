import { Decimal } from '../decimal';
import type { CurrencyCode } from '../money/types';
import type { CategoryKind, IncomeKind } from '../flows/types';
import type { PlainDate } from '../dates/plain-date';
import type { ExpenseFlow } from '../flows/types';
import type { FlowFact, FlowRecords, ScopeAccount } from '../reconciliation/scope';
import {
  factsInRange,
  factsInScope,
  scopeAccountIds,
  sumAmounts,
} from '../reconciliation/scope';

/**
 * Economic classification of already-scoped flows (blueprint 12.3, 12.5, 7.4).
 *
 * Reconciliation answers "what happened to tracked cash": a leg is `I`, `Nin`,
 * `Nout` or `K`. This answers a different question — "what kind of money was
 * that" — over the very same legs, and the two must not be confused. Several
 * `I` facts mean different things to 12.5 (a salary is income, an `adjustment`
 * is not), and several `K` facts land in different 12.3 buckets (a food expense
 * is consumption, a transfer fee is a fee).
 *
 * Nothing here decides membership. The facts arriving have already passed 8.1's
 * single inclusion predicate, so a flow this module never sees is a flow the
 * bucket does not contain — an income attributed to a `first_balance` account
 * cannot reappear here, because it was never in the set (30.15 item 3).
 */

/** 12.3's four non-consumption cost groups. Consumption is the remainder (30.15 item 10). */
export type CostBucket =
  | 'consumption'
  | 'property_operating'
  | 'interest_and_fees'
  | 'transaction_costs'
  | 'external_outflows';

/**
 * Which 12.3 group a tracked known expense belongs to, from its category
 * **kind** — never its name, which a user may set to anything (7.4, R12).
 *
 * Exhaustive by construction: the switch names every `CategoryKind`, so adding
 * a kind to the enum stops the build here rather than letting a new financial
 * category be silently absorbed into consumption.
 *
 * `capital_improvement` is absent because it never reaches this function: 7.4
 * gives it the `Nout` role, so it is capital expenditure outside `ΣK` and
 * outside the decomposition entirely.
 */
export function costBucket(kind: CategoryKind): CostBucket {
  switch (kind) {
    // Ordinary consumption, and `tax` with it (12.5 counts tax as consumption).
    case 'general':
    case 'housing':
    case 'transport':
    case 'food':
    case 'travel':
    case 'health':
    case 'insurance':
    case 'tax':
    case 'subscriptions':
    case 'maintenance':
    case 'major_purchase':
    case 'custom':
      return 'consumption';

    /**
     * 12.3 splits `property_operating` on whether the property is rented, and
     * Phase 3 has no property positions at all — only cash and other assets
     * exist — so no expense can name a rental property and every one of these
     * is the non-rental case, which 12.3 sends to Spending. The split arrives
     * with the properties, in Phase 6.
     */
    case 'property_operating':
      return 'consumption';

    case 'investment_fee':
    case 'transfer_fee':
      return 'interest_and_fees';

    case 'acquisition_cost':
    case 'disposal_cost':
      return 'transaction_costs';

    case 'external_outflow':
      return 'external_outflows';

    /**
     * Unreachable: 7.4 gives `capital_improvement` the `Nout` role, so it is
     * never a `K` fact. The case is written out rather than defaulted so the
     * switch stays exhaustive over the enum.
     */
    case 'capital_improvement':
      return 'consumption';
  }
}

/**
 * Does this income kind belong in `ExternalIncome` (12.5, F16)?
 *
 * The seven kinds 12.5 lists. `external_inflow` and `adjustment` are excluded
 * by name: both are tracked cash arriving that is not income — money moved in
 * from outside the tracked system, or a correction accepted against an
 * unexplained inflow — and counting either would inflate the savings rate with
 * money nobody earned.
 *
 * They do reach here. 7.4 gives every tracked-cash income row the `I` role,
 * including those two, because the identity needs them to explain the balance.
 * So the cash role and the income classification are deliberately different
 * questions, and this function is where the second one is answered.
 */
export function isExternalIncomeKind(kind: IncomeKind): boolean {
  switch (kind) {
    case 'employment':
    case 'freelance':
    case 'bonus':
    case 'rental':
    case 'other':
    case 'dividend':
    case 'interest':
      return true;
    case 'external_inflow':
    case 'adjustment':
      return false;
  }
}

/** 12.3's four non-consumption groups, as amounts. Consumption is never here. */
export interface NonConsumptionCosts {
  readonly propertyOperatingCosts: Decimal;
  readonly interestAndFees: Decimal;
  readonly transactionCosts: Decimal;
  readonly externalOutflows: Decimal;
}

export const NO_NON_CONSUMPTION_COSTS: NonConsumptionCosts = {
  propertyOperatingCosts: new Decimal(0),
  interestAndFees: new Decimal(0),
  transactionCosts: new Decimal(0),
  externalOutflows: new Decimal(0),
};

/** What one bucket's scoped facts classify to, before any savings arithmetic. */
export interface ScopedClassification {
  /** The part of the bucket's `ΣI` that 12.5 counts as income. */
  readonly externalIncome: Decimal;
  /** The part of the bucket's `ΣK` that is not consumption. */
  readonly nonConsumptionCosts: NonConsumptionCosts;
}

/**
 * Classify one bucket's scoped facts.
 *
 * Only `I` and `K` legs are read: `Nin` and `Nout` move cash without being
 * income or cost, and 12.5 has no term for them. A pre-classified leg carries
 * no source record, so it is counted by reconciliation and classified by
 * nobody here — the phase that owns those records classifies them where it
 * builds the breakdown, which is why the breakdown is an input to the
 * calculator rather than something the calculator derives.
 */
export function classifyScopedFacts(facts: readonly FlowFact[]): ScopedClassification {
  const income: Decimal[] = [];
  const byBucket = new Map<CostBucket, Decimal[]>();

  for (const fact of facts) {
    if (fact.kind === 'income' && fact.leg.role === 'I') {
      // The filter that does the work. Every tracked-cash income row is `I`
      // (7.4), so `external_inflow` and `adjustment` arrive here and are turned
      // away: the cash they explain is real, the income is not.
      if (isExternalIncomeKind(fact.income.kind)) income.push(fact.leg.amount);
      continue;
    }
    if (fact.kind === 'expense' && fact.leg.role === 'K') {
      const bucket = costBucket(fact.expense.categoryKind);
      const list = byBucket.get(bucket);
      if (list === undefined) byBucket.set(bucket, [fact.leg.amount]);
      else list.push(fact.leg.amount);
    }
  }

  const total = (bucket: CostBucket): Decimal => sumAmounts(byBucket.get(bucket) ?? []);

  return {
    externalIncome: sumAmounts(income),
    nonConsumptionCosts: {
      propertyOperatingCosts: total('property_operating'),
      interestAndFees: total('interest_and_fees'),
      transactionCosts: total('transaction_costs'),
      externalOutflows: total('external_outflows'),
    },
  };
}

/** `untracked_self` and `third_party` over one currency, from one interval's expenses. */
export interface UntrackedSpending {
  readonly additionalSpending: Decimal;
  readonly thirdPartyPaid: Decimal;
}

/**
 * The two settlements that carry no cash role (7.4, 30.15 item 3).
 *
 * They are not reconciliation quantities, so they are summed from source rows
 * rather than from scoped legs — which is also why they exist in a currency
 * with no cash account at all. The caller decides the interval; 30.15 item 3
 * decides which interval that is, and it is always the one the figure beside
 * them used.
 */
export function untrackedSpendingOf(
  expenses: readonly {
    readonly currency: CurrencyCode;
    readonly settlement: string;
    readonly incurredOn: string;
    readonly amount: Decimal;
  }[],
  currency: CurrencyCode,
  from: string,
  to: string,
): UntrackedSpending {
  const total = (settlement: string): Decimal =>
    sumAmounts(
      expenses
        .filter(
          (expense) =>
            expense.currency === currency &&
            expense.settlement === settlement &&
            expense.incurredOn >= from &&
            expense.incurredOn <= to,
        )
        .map((expense) => expense.amount),
    );

  return {
    additionalSpending: total('untracked_self'),
    thirdPartyPaid: total('third_party'),
  };
}

/** Everything one bucket's interval classifies to, tracked and untracked alike. */
export interface BucketClassification extends ScopedClassification, UntrackedSpending {}

/**
 * The Phase-3 classification of one bucket's interval.
 *
 * The whole adapter, and deliberately thin. It scopes the interval's facts with
 * 8.1's own predicate — the same `legInScope` the two reconciliation engines
 * use, reached through the same `factsInScope` — so the set it classifies is
 * the set the identity summed, and an account excluded as `first_balance`
 * cannot contribute income or cost here any more than it could contribute `ΣI`
 * there.
 *
 * The two untracked settlements are summed from source rows instead, over the
 * same interval, because they carry no cash role and so were never in the
 * scoped set at all (7.4, 30.15 item 3).
 *
 * A later phase builds a richer classification by adding what it knows to the
 * breakdown before calling `reconcileSavings` — it does not hand a second list
 * to the calculator, which is what keeps any part of `ΣK` from being owned
 * twice.
 */
export function classifyBucketInterval(
  records: FlowRecords,
  expenses: readonly ExpenseFlow[],
  currency: CurrencyCode,
  accounts: readonly ScopeAccount[],
  from: PlainDate,
  to: PlainDate,
): BucketClassification {
  const facts = factsInScope(factsInRange(records, from, to), currency, scopeAccountIds(accounts));
  return {
    ...classifyScopedFacts(facts),
    ...untrackedSpendingOf(expenses, currency, from, to),
  };
}
