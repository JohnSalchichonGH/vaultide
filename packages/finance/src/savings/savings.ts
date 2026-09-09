import { Decimal } from '../decimal';
import type { CurrencyCode } from '../money/types';
import { unavailable, type Unavailable } from '../unavailable';
import type { ReconciliationStatus } from '../reconciliation/types';
import type { NonConsumptionCosts } from './classify';

/**
 * Savings, savings rate and the spending decomposition (blueprint 12.5, 12.3,
 * v2.1.12 30.15).
 *
 * A separate calculation from reconciliation, deliberately. Reconciliation asks
 * what happened to tracked cash; this asks how the amounts it already
 * established classify economically. Keeping them apart is what lets a bucket
 * whose balances are missing still report exactly what its records say, and
 * what stops a savings figure from ever being the thing that decides whether a
 * month reconciled.
 *
 * Nothing here is stored (5.3), nothing here converts a currency — reporting-
 * currency aggregation is a later slice and this module never sees a rate — and
 * nothing here rounds: 7.3 puts rounding at the display boundary, so the
 * savings rate leaves as an exact ratio and becomes "58.24 %" somewhere else.
 */

/** `ΣK` may only be classified, never added to (30.15 item 10). */
export class CostClassificationExceedsKnownError extends Error {
  constructor(
    readonly classified: string,
    readonly knownTrackedExpenses: string,
  ) {
    super(
      `Non-consumption cost classification ${classified} exceeds known tracked expenses ${knownTrackedExpenses}.`,
    );
    this.name = 'CostClassificationExceedsKnownError';
  }
}

/**
 * What reconciliation already established for this bucket.
 *
 * `knownTrackedExpenses` is exact in every status (8.2, 30.12), which is why
 * the cost decomposition survives a bucket whose balances are missing. The
 * other two are absent exactly when the balance evidence was not there, and
 * their absence is what makes the derived figures unavailable rather than zero.
 */
export interface ReconciledBucketFigures {
  readonly status: ReconciliationStatus;
  readonly knownTrackedExpenses: Decimal;
  readonly trackedTotalSpending?: Decimal | undefined;
  readonly unclassified?: Decimal | undefined;
}

/**
 * One bucket's savings inputs.
 *
 * `externalIncome` and `nonConsumptionCosts` are **classifications supplied by
 * the caller** of amounts reconciliation already counted, not new money. There
 * is one such breakdown and no second channel to merge with it: a later phase
 * that knows part of `ΣK` is mortgage interest adds it to `interestAndFees`
 * while building this one object, so no portion of `ΣK` can be owned twice
 * (30.15 item 10).
 */
export interface SavingsInput {
  readonly currency: CurrencyCode;
  readonly reconciliation: ReconciledBucketFigures;
  readonly externalIncome: Decimal;
  readonly nonConsumptionCosts: NonConsumptionCosts;
  /** `untracked_self`, over the interval the bucket's figures used (30.15 item 3). */
  readonly additionalSpending: Decimal;
  /** `third_party`, over the same interval. In no total at all. */
  readonly thirdPartyPaid: Decimal;
  /** The user's current setting; 6.2 defaults it on and does not version it. */
  readonly countAdditionalSpending: boolean;
}

/**
 * The classifications that hold whatever the balances did.
 *
 * All eight are sums or partitions of source records, so 30.12's rule applies
 * to them exactly as it does to the role sums: they need no balance evidence,
 * they are exact in every status, and a zero among them is a measured zero.
 */
export interface SavingsSourceFigures {
  readonly externalIncome: Decimal;
  readonly knownConsumption: Decimal;
  readonly propertyOperatingCosts: Decimal;
  readonly interestAndFees: Decimal;
  readonly transactionCosts: Decimal;
  readonly externalOutflows: Decimal;
  readonly additionalSpending: Decimal;
  readonly thirdPartyPaid: Decimal;
}

/** The five figures 12.5 derives, present together or absent together. */
export interface DerivedSavings {
  readonly kind: 'available';
  /** The reconciliation quality they inherit (12.5); never a second status order. */
  readonly quality: 'reliable' | 'estimated' | 'provisional';
  readonly consumption: Decimal;
  readonly trackedSavingsFromIncome: Decimal;
  readonly personalSavings: Decimal;
  readonly totalSpending: Decimal;
  /**
   * `PersonalSavings / ExternalIncome`, exact and unrounded, or unavailable on
   * its own when `ExternalIncome = 0` — which takes the rate and nothing else
   * (12.5).
   */
  readonly savingsRate: Decimal | Unavailable;
  /** Whether the rate counts additional spending, so a reader can label it. */
  readonly countsAdditionalSpending: boolean;
}

/**
 * Why the five derived figures do not exist.
 *
 * Two reasons and not one: an `unresolved` bucket computed an identity that
 * contradicts itself, an `unavailable` one never reached the identity at all.
 * Flattening them would tell a user the same thing about two different
 * problems, and 12.5 keeps them apart.
 */
export interface UnavailableSavings {
  readonly kind: 'unavailable';
  readonly because: 'unresolved' | 'reconciliation_unavailable';
}

/**
 * One native-currency savings result.
 *
 * The source figures always exist; the derived ones are a discriminated union,
 * so there is no shape in which `personalSavings` is readable without
 * `consumption`, and no shape in which an `unresolved` bucket carries a total
 * spending figure.
 */
export interface SavingsResult {
  readonly currency: CurrencyCode;
  readonly reconciliationStatus: ReconciliationStatus;
  readonly source: SavingsSourceFigures;
  readonly derived: DerivedSavings | UnavailableSavings;
}

/** The `quality` a status carries into the derived figures, or nothing. */
function qualityOf(status: ReconciliationStatus): DerivedSavings['quality'] | undefined {
  switch (status) {
    case 'reliable':
    case 'estimated':
    case 'provisional':
      return status;
    case 'unresolved':
    case 'unavailable':
      return undefined;
  }
}

/**
 * 12.5 for one native-currency bucket.
 *
 * Throws only for the one input that cannot be interpreted at all: a
 * non-consumption classification larger than the `ΣK` it claims to partition.
 * That would make the consumption remainder negative — money the engine would
 * be inventing — so it fails closed rather than reporting it. Exact `Decimal`
 * comparison, no tolerance: 7.3 puts no rounding inside an engine, and a
 * partition that is off by a hundredth is still a partition of something else.
 */
export function reconcileSavings(input: SavingsInput): SavingsResult {
  const { knownTrackedExpenses, trackedTotalSpending, unclassified } = input.reconciliation;
  const costs = input.nonConsumptionCosts;

  const classifiedNonConsumption = costs.propertyOperatingCosts
    .plus(costs.interestAndFees)
    .plus(costs.transactionCosts)
    .plus(costs.externalOutflows);

  if (classifiedNonConsumption.greaterThan(knownTrackedExpenses)) {
    throw new CostClassificationExceedsKnownError(
      classifiedNonConsumption.toString(),
      knownTrackedExpenses.toString(),
    );
  }

  // Consumption is the remainder and never an independent input, which is what
  // makes the partition sum to `ΣK` by construction rather than by agreement.
  const knownConsumption = knownTrackedExpenses.minus(classifiedNonConsumption);

  const source: SavingsSourceFigures = {
    externalIncome: input.externalIncome,
    knownConsumption,
    propertyOperatingCosts: costs.propertyOperatingCosts,
    interestAndFees: costs.interestAndFees,
    transactionCosts: costs.transactionCosts,
    externalOutflows: costs.externalOutflows,
    additionalSpending: input.additionalSpending,
    thirdPartyPaid: input.thirdPartyPaid,
  };

  const quality = qualityOf(input.reconciliation.status);
  if (quality === undefined || trackedTotalSpending === undefined || unclassified === undefined) {
    return {
      currency: input.currency,
      reconciliationStatus: input.reconciliation.status,
      source,
      derived: {
        kind: 'unavailable',
        because:
          input.reconciliation.status === 'unresolved'
            ? 'unresolved'
            : 'reconciliation_unavailable',
      },
    };
  }

  const consumption = knownConsumption.plus(unclassified);

  // 12.5 subtracts four of the five buckets and not `ExternalOutflows`: that
  // one is settled in the allocation identity instead, so subtracting it here
  // would take the same cost out twice.
  const trackedSavingsFromIncome = input.externalIncome
    .minus(consumption)
    .minus(costs.propertyOperatingCosts)
    .minus(costs.interestAndFees)
    .minus(costs.transactionCosts);

  const counted = input.countAdditionalSpending ? input.additionalSpending : new Decimal(0);
  const personalSavings = trackedSavingsFromIncome.minus(counted);
  const totalSpending = trackedTotalSpending.plus(input.additionalSpending);

  // Compared against zero explicitly: decimal.js reads the sign bit, so a
  // negative zero would be "not zero" under a naive `isZero` alternative and a
  // zero income would divide anyway.
  const savingsRate: Decimal | Unavailable = input.externalIncome.equals(0)
    ? unavailable('divide_by_zero', 'External income is zero.')
    : personalSavings.dividedBy(input.externalIncome);

  return {
    currency: input.currency,
    reconciliationStatus: input.reconciliation.status,
    source,
    derived: {
      kind: 'available',
      quality,
      consumption,
      trackedSavingsFromIncome,
      personalSavings,
      totalSpending,
      savingsRate,
      countsAdditionalSpending: input.countAdditionalSpending,
    },
  };
}
