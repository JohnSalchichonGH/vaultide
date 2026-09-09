import type { Decimal } from '../decimal';
import { endOfMonthKey } from '../dates/plain-date';
import { convert } from '../fx/convert';
import type { FxTable } from '../fx/types';
import type { CurrencyCode } from '../money/types';
import { isUnavailable, unavailable, type Unavailable } from '../unavailable';
import {
  addAmounts,
  missingAmount,
  statedAmount,
  subtractAmounts,
  sumAmountsOf,
  type FxProvenance,
  type MissingReportingContribution,
  type ReportingAmount,
} from './aggregate';
import type {
  MissingContributionInput,
  ReportingContribution,
  ReportingField,
  UntrackedReportingContribution,
} from './contributions';

/**
 * A month's cash flow and savings in the reporting currency (12.3, 12.5, 8.11,
 * v2.1.13 30.16).
 *
 * Every figure here is built the same way: convert the contributions, then apply
 * 12.5's formula to what came back. Nothing converts a native composite — there
 * is no rate for one, and 8.11 says the difference between component-wise
 * conversion and a closing-rate one belongs in the cash FX residual, not in a
 * spending figure.
 *
 * The layer is downstream of everything: it reads reconciliation's own scoped
 * facts and native residual, and reconciliation knows nothing about it. It reads
 * no clock, holds no rates of its own, and rounds nothing — 7.3 puts rounding at
 * the display boundary, so the savings rate leaves as an exact ratio.
 */

export interface ReportingCashFlowInput {
  readonly reportingCurrency: CurrencyCode;
  readonly fx: FxTable;
  /** Every contribution, from every native currency, already scoped by 8.1. */
  readonly contributions: readonly ReportingContribution[];
  /** Residuals no bucket could state, which are missing rather than zero. */
  readonly missing: readonly MissingContributionInput[];
  /** The user's current setting; 6.2 defaults it on and does not version it. */
  readonly countAdditionalSpending: boolean;
}

/** The nine primitives and the six figures 12.5 derives from them. */
export interface ReportingCashFlow {
  readonly reportingCurrency: CurrencyCode;

  readonly externalIncome: ReportingAmount;
  readonly knownConsumption: ReportingAmount;
  readonly propertyOperatingCosts: ReportingAmount;
  readonly interestAndFees: ReportingAmount;
  readonly transactionCosts: ReportingAmount;
  readonly externalOutflows: ReportingAmount;
  readonly unclassified: ReportingAmount;
  readonly additionalSpending: ReportingAmount;
  readonly thirdPartyPaid: ReportingAmount;

  readonly consumption: ReportingAmount;
  readonly trackedTotalSpending: ReportingAmount;
  readonly trackedSavingsFromIncome: ReportingAmount;
  readonly personalSavings: ReportingAmount;
  readonly totalSpending: ReportingAmount;

  /**
   * `PersonalSavings / ExternalIncome`, exact and unrounded, or unavailable —
   * **never partial**. A ratio of partial aggregates is not the user's savings
   * rate (12.5, 30.15 item 2).
   */
  readonly savingsRate: Decimal | Unavailable;
  /** Whether the rate counts additional spending, so a reader can label it. */
  readonly countsAdditionalSpending: boolean;
}

/** One converted contribution, or the reason it could not be converted. */
function convertContribution(
  contribution: ReportingContribution,
  reporting: CurrencyCode,
  fx: FxTable,
): ReportingAmount {
  const { amount, basis } = contribution;

  const on = basis.kind === 'dated' ? basis.on : (basis.through ?? endOfMonthKey(basis.month));
  const converted = convert(amount, reporting, on, fx, {
    mode: basis.kind === 'dated' ? 'dated' : 'monthly_average',
    ...(basis.kind === 'average' && basis.through !== undefined
      ? { through: basis.through }
      : {}),
  });

  if (isUnavailable(converted)) {
    return missingAmount(reporting, {
      currency: amount.currency,
      reason: converted.reason,
      ...(converted.detail === undefined ? {} : { detail: converted.detail }),
    });
  }

  // An average-rate conversion is estimated by convention, whether or not the
  // average itself had to fall back (8.11). A dated fallback is not: landing on
  // an earlier observation is how `rateOn` has always worked.
  const provenance: FxProvenance = {
    estimatedConversion: basis.kind === 'average' && amount.currency !== reporting,
    approximate: converted.approximate,
    exact: converted.exact,
  };

  return statedAmount(converted.amount, provenance, contribution.quality);
}

/**
 * Convert every contribution, group the results by the figure they feed, and
 * hand back a lookup over the primitive sums.
 *
 * A field nobody contributed to sums to an exact zero, which is an answer and
 * not an absence: the caller decides whether that field exists to be asked
 * about at all.
 */
function convertedFields(
  contributions: readonly ReportingContribution[],
  missing: readonly MissingContributionInput[],
  reporting: CurrencyCode,
  fx: FxTable,
): (name: ReportingField) => ReportingAmount {
  const byField = new Map<ReportingField, ReportingAmount[]>();
  const push = (field: ReportingField, amount: ReportingAmount): void => {
    const list = byField.get(field);
    if (list === undefined) byField.set(field, [amount]);
    else list.push(amount);
  };

  for (const contribution of contributions) {
    push(contribution.field, convertContribution(contribution, reporting, fx));
  }

  for (const gap of missing) {
    const item: MissingReportingContribution = {
      currency: gap.currency,
      reason: gap.reason,
      ...(gap.detail === undefined ? {} : { detail: gap.detail }),
    };
    push(gap.field, missingAmount(reporting, item));
  }

  return (name) => sumAmountsOf(byField.get(name) ?? [], reporting);
}

/**
 * What a month can still say when it has **no tracked interval at all** (8.6,
 * 30.15 item 3, 30.16 item 6).
 *
 * Two figures and no more. Neither settlement carries a cash role, so neither
 * was ever scoped and neither needed an interval to be summed over; every other
 * figure in 12.3 and 12.5 is defined over one and cannot be stated without it.
 *
 * A separate result rather than a `ReportingCashFlow` full of zeroes, because a
 * zero is an answer. `TrackedTotalSpending = 0` says the month tracked no
 * spending; a month with no interval has not said that and must not appear to.
 * There is nothing here to read as zero.
 */
export interface SourceOnlyReportingFigures {
  readonly reportingCurrency: CurrencyCode;
  readonly additionalSpending: ReportingAmount;
  readonly thirdPartyPaid: ReportingAmount;
}

export interface SourceOnlyReportingInput {
  readonly reportingCurrency: CurrencyCode;
  readonly fx: FxTable;
  /**
   * Untracked settlements only, and the type says so: no tracked contribution
   * can be passed in, and no averaged one either, so no residual rate is
   * reachable from here.
   */
  readonly contributions: readonly UntrackedReportingContribution[];
}

/** The two settlements, converted at their own dates and summed. Nothing else. */
export function reportSourceOnly(
  input: SourceOnlyReportingInput,
): SourceOnlyReportingFigures {
  const field = convertedFields(input.contributions, [], input.reportingCurrency, input.fx);
  return {
    reportingCurrency: input.reportingCurrency,
    additionalSpending: field('additionalSpending'),
    thirdPartyPaid: field('thirdPartyPaid'),
  };
}

/**
 * The reporting-currency month.
 *
 * Contributions are grouped by the figure they feed, converted, and summed;
 * then the derived figures are 12.5's formulas over those sums. A residual no
 * bucket could state arrives as a missing dependency instead, so the figures
 * that need it degrade and the ones that do not are untouched.
 */
export function reportCashFlow(input: ReportingCashFlowInput): ReportingCashFlow {
  const reporting = input.reportingCurrency;
  const field = convertedFields(input.contributions, input.missing, reporting, input.fx);

  const externalIncome = field('externalIncome');
  const knownConsumption = field('knownConsumption');
  const propertyOperatingCosts = field('propertyOperatingCosts');
  const interestAndFees = field('interestAndFees');
  const transactionCosts = field('transactionCosts');
  const externalOutflows = field('externalOutflows');
  const unclassified = field('unclassified');
  const additionalSpending = field('additionalSpending');
  const thirdPartyPaid = field('thirdPartyPaid');

  const consumption = addAmounts(knownConsumption, unclassified);

  const trackedTotalSpending = [
    propertyOperatingCosts,
    interestAndFees,
    transactionCosts,
    externalOutflows,
  ].reduce(addAmounts, consumption);

  // 12.5 subtracts four of the five buckets and not `ExternalOutflows`: that one
  // is settled in the allocation identity instead, so subtracting it here would
  // take the same cost out twice — and it is why a missing rate for an external
  // outflow leaves the savings alone.
  const trackedSavingsFromIncome = [
    consumption,
    propertyOperatingCosts,
    interestAndFees,
    transactionCosts,
  ].reduce(subtractAmounts, externalIncome);

  const personalSavings = input.countAdditionalSpending
    ? subtractAmounts(trackedSavingsFromIncome, additionalSpending)
    : trackedSavingsFromIncome;

  const totalSpending = addAmounts(trackedTotalSpending, additionalSpending);

  return {
    reportingCurrency: reporting,
    externalIncome,
    knownConsumption,
    propertyOperatingCosts,
    interestAndFees,
    transactionCosts,
    externalOutflows,
    unclassified,
    additionalSpending,
    thirdPartyPaid,
    consumption,
    trackedTotalSpending,
    trackedSavingsFromIncome,
    personalSavings,
    totalSpending,
    savingsRate: rateOf(personalSavings, externalIncome),
    countsAdditionalSpending: input.countAdditionalSpending,
  };
}

/**
 * The aggregate savings rate, or nothing.
 *
 * A quotient is never partial. Either both aggregates are complete and the
 * denominator is not zero, or there is no rate — a ratio of partial sums is not
 * the ratio of the totals, and presenting one would be the misleading
 * percentage 12.5 refuses.
 *
 * A zero denominator is `divide_by_zero`, which is its own fact and not a
 * missing input.
 *
 * An incomplete input is `not_applicable`: the repository's generic fallback for
 * a derived result whose prerequisite aggregate is incomplete — the same use as
 * `networth`'s `contribution.unavailableReason ?? 'not_applicable'` — and not a
 * claim that the savings concept does not apply here. It says only that no more
 * specific reason belongs to the quotient itself. The authoritative causes stay
 * where they were observed, on `personalSavings.missing` and
 * `externalIncome.missing`, each naming its own currency and reason; the
 * `detail` here names the side, so a reader knows which list to open. Promoting
 * one missing item onto the rate would let it speak for all the others.
 */
function rateOf(
  personalSavings: ReportingAmount,
  externalIncome: ReportingAmount,
): Decimal | Unavailable {
  if (personalSavings.availability !== 'available') {
    return unavailable('not_applicable', 'personal savings could not be stated in full');
  }
  /* v8 ignore start -- unreachable: `PersonalSavings` is derived from
     `ExternalIncome` by 12.5's formula, so an incomplete income makes the
     savings incomplete and the check above has already returned. The guard
     stays because the rate's contract is stated over both aggregates, and it is
     what would catch a later phase deriving the savings some other way. */
  if (externalIncome.availability !== 'available') {
    return unavailable('not_applicable', 'external income could not be stated in full');
  }
  /* v8 ignore stop */
  if (externalIncome.value.amount.equals(0)) {
    return unavailable('divide_by_zero', 'External income is zero.');
  }
  return personalSavings.value.amount.dividedBy(externalIncome.value.amount);
}
