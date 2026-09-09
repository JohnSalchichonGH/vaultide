import type { Decimal } from '../decimal';
import type { MonthKey, PlainDate } from '../dates/plain-date';
import type { CurrencyCode, Money } from '../money/types';
import { money } from '../money/money';
import type { UnavailableReason } from '../unavailable';
import type { FlowFact } from '../reconciliation/scope';
import { costBucket, isExternalIncomeKind } from '../savings/classify';

/**
 * What a source record contributes to a reporting-currency figure (12.3, 12.5,
 * v2.1.13 30.16).
 *
 * The reporting layer converts **contributions**, never composites. A month's
 * `TrackedSavingsFromIncome` in the reporting currency is its 12.5 formula over
 * already-converted parts; there is no rate anywhere in 10.3 for a native
 * composite, and converting one at a single month-end rate gives a different
 * number that 8.11 explicitly parks in the cash FX residual. Keeping the only
 * convertible thing a dated contribution is what makes the wrong shape hard to
 * write.
 *
 * Economic classification is not repeated here. `costBucket` and
 * `isExternalIncomeKind` are Slice 9's, unchanged, so a category kind means the
 * same thing to the native decomposition and to this one — and an account
 * excluded as `first_balance` is absent from both, because both start from the
 * same scoped facts.
 */

/** The nine primitive figures a source record can feed. Everything else is derived. */
export type ReportingField =
  | 'externalIncome'
  | 'knownConsumption'
  | 'propertyOperatingCosts'
  | 'interestAndFees'
  | 'transactionCosts'
  | 'externalOutflows'
  | 'unclassified'
  | 'additionalSpending'
  | 'thirdPartyPaid';

/**
 * The two figures a record with no cash role can feed (7.4).
 *
 * Named as a type because it is the whole of what a month with no tracked
 * interval can say: neither settlement was ever scoped, so neither needed the
 * interval, and no other figure can be reached from them.
 */
export type UntrackedReportingField = 'additionalSpending' | 'thirdPartyPaid';

/**
 * How one contribution converts.
 *
 * `dated` is a source row at its own financial date (10.3). `average` is the
 * inferred residual, which has no date of its own — `through` carries `D` for a
 * month-to-date figure so no rate later than `D` can reach it (30.16 item 3).
 */
export type ConversionBasis =
  | { readonly kind: 'dated'; readonly on: PlainDate }
  | { readonly kind: 'average'; readonly month: MonthKey; readonly through?: PlainDate };

/** The calculation quality a native derived contribution carries with it (12.5). */
export type ContributionQuality = 'reliable' | 'estimated' | 'provisional';

export interface ReportingContribution {
  readonly field: ReportingField;
  /** Native amount and currency; the reporting layer never sees a converted one. */
  readonly amount: Money;
  readonly basis: ConversionBasis;
  /**
   * Set only on a residual, which is the one contribution derived from balance
   * evidence rather than read off a record. A source sum stays exact whatever
   * the bucket's status did (30.16 item 8), so it carries no quality.
   */
  readonly quality?: ContributionQuality;
  readonly sourceId?: string;
}

/**
 * An untracked settlement, narrowed so the compiler knows two things about it:
 * which figures it can feed, and that it converts at its own date.
 *
 * That is not decoration. The source-only path is defined as the one a month
 * with no interval may still take, and this type is what makes "no tracked
 * figure, and no average rate" a fact about the shape rather than a promise in
 * a comment.
 */
export interface UntrackedReportingContribution extends ReportingContribution {
  readonly field: UntrackedReportingField;
  readonly basis: { readonly kind: 'dated'; readonly on: PlainDate };
}

/**
 * A dependency that cannot be stated at all — an `unresolved` bucket's residual,
 * or an `unavailable` one's.
 *
 * Not the same as a conversion that failed: this one has no native amount to
 * convert. Both end up as missing contributions to the figures that need them,
 * and both name the currency they came from.
 *
 * The reason comes from the caller because the caller is what knows it: an
 * unavailable bucket already carries its own — a missing month end, a missing
 * opening — and no reason is invented here to stand in for it.
 */
export interface MissingContributionInput {
  readonly field: ReportingField;
  readonly currency: CurrencyCode;
  readonly reason: UnavailableReason;
  readonly detail?: string;
}

/**
 * The reporting contribution one scoped fact makes, or none.
 *
 * Only `I` and `K` legs say anything about income or cost; `Nin` and `Nout` move
 * cash without being either, and 12.5 has no term for them. A pre-classified leg
 * carries no source record and therefore no economic meaning — it is counted by
 * reconciliation and classified by nobody here, exactly as in Slice 9, and a
 * caller that needs one classified must say so itself.
 */
export function contributionOfFact(fact: FlowFact): ReportingContribution | undefined {
  if (fact.kind === 'income' && fact.leg.role === 'I') {
    if (!isExternalIncomeKind(fact.income.kind)) return undefined;
    return {
      field: 'externalIncome',
      amount: money(fact.leg.amount, fact.leg.currency),
      basis: { kind: 'dated', on: fact.leg.on },
      sourceId: fact.leg.sourceId,
    };
  }

  if (fact.kind === 'expense' && fact.leg.role === 'K') {
    return {
      field: FIELD_OF_COST[costBucket(fact.expense.categoryKind)],
      amount: money(fact.leg.amount, fact.leg.currency),
      basis: { kind: 'dated', on: fact.leg.on },
      sourceId: fact.leg.sourceId,
    };
  }

  return undefined;
}

const FIELD_OF_COST: Readonly<Record<ReturnType<typeof costBucket>, ReportingField>> = {
  consumption: 'knownConsumption',
  property_operating: 'propertyOperatingCosts',
  interest_and_fees: 'interestAndFees',
  transaction_costs: 'transactionCosts',
  external_outflows: 'externalOutflows',
};

/** The residual, which converts at its interval's average rate (8.11). */
export function residualContribution(
  amount: Decimal,
  currency: CurrencyCode,
  month: MonthKey,
  quality: ContributionQuality,
  through?: PlainDate,
): ReportingContribution {
  return {
    field: 'unclassified',
    amount: money(amount, currency),
    basis:
      through === undefined
        ? { kind: 'average', month }
        : { kind: 'average', month, through },
    quality,
  };
}

/**
 * An untracked expense row, which has no cash role and so was never scoped
 * (7.4). It is summed from source records over the interval its neighbours used
 * (30.15 item 3), and converts at its own date like any other dated row.
 */
export function untrackedContribution(
  field: UntrackedReportingField,
  amount: Decimal,
  currency: CurrencyCode,
  on: PlainDate,
  sourceId: string,
): UntrackedReportingContribution {
  return { field, amount: money(amount, currency), basis: { kind: 'dated', on }, sourceId };
}
