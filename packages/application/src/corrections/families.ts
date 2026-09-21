import {
  classifyBucketInterval,
  endOfMonthKey,
  isUnavailable,
  monthKey,
  reconcileSavings,
  startOfMonthKey,
  untrackedSpendingOf,
  type BucketResult,
  type CurrencyCode,
  type Decimal,
  type Issue,
  type MonthKey,
  type MtdBucketResult,
  type PlainDate,
  type UntrackedSpending,
} from '@vaultide/finance';
import type { IdentifiedSourceChange, SourceFacts } from '../write-plan';
import { identityKey } from '../write-plan';
import { periodOf } from './classify';
import type { CorrectionEvidence } from './evidence';
import { canonicalJson } from './fingerprint';
import { IMPACT_TAG_ORDER, type CompletenessImpact, type ImpactTag } from './types';

/**
 * Which families of output a correction actually moves (§36, §44, §45).
 *
 * A tag is a promise: "your August spending figures will read differently
 * afterwards". The only honest way to make that promise is to work out what
 * each family's figures are before and after and see whether they moved. Two
 * cheaper rules were tried first and both lied:
 *
 *  - **by record type** — "this row is an income row, so tag income". It tags
 *    a description-only edit as an income, reconciliation and savings change,
 *    and it tags the current month for a record dated after `D`, where by
 *    construction nothing month-to-date has moved yet.
 *  - **by structural difference** — "the engine's status DTO differs, so tag
 *    reconciliation, spending, savings and categories". It misses a corrected
 *    balance that moves the residual without moving a single status, and it
 *    claims a category effect for any completed month that changed at all.
 *
 * So each family is projected onto the figures it is actually derived from,
 * over the interval that family's own contract uses, and a tag appears exactly
 * when its projection differs. The projections never leave this module: they
 * hold native monetary values, and `CorrectionPreview` deliberately carries
 * none (§35, §51). What reaches the preview is the six-tag conclusion.
 *
 * ## The interval is the contract's, not the month's
 *
 * Every figure in the current month stops where the reporting contract already
 * stops it: at `D` when there is one, and at today for the two settlements
 * that never needed one (30.15 item 3, 30.16 item 6). That is what keeps a
 * record dated after `D` from claiming an effect on figures bounded at `D`.
 */

export type FamilyFigures = Readonly<Record<ImpactTag, string>>;

/** The families whose projections differ, in the canonical display order. */
export function movedFamilies(
  before: FamilyFigures,
  after: FamilyFigures,
): readonly ImpactTag[] {
  return IMPACT_TAG_ORDER.filter((tag) => before[tag] !== after[tag]);
}

/* -------------------------------------------------------------------------- */
/* The shared shape of a reconciled bucket                                     */
/* -------------------------------------------------------------------------- */

/**
 * What both reconciliation engines report per currency, as the families read it.
 *
 * `BucketResult` and `MtdBucketResult` differ only in their account shape and
 * in the residuals the current month deliberately does not compute (30.13 item
 * 10); everything the families project is common to both.
 */
interface BucketFigures {
  readonly currency: CurrencyCode;
  readonly status: string;
  readonly totals: BucketResult['totals'];
  readonly additionalSpending: Decimal;
  readonly thirdPartyPaid: Decimal;
  readonly issues: readonly Issue[];
  readonly accounts: readonly { readonly positionId: string; readonly excludedFirstBalance: boolean }[];
}

const bucketFiguresOf = (bucket: BucketResult | MtdBucketResult): BucketFigures => ({
  currency: bucket.currency,
  status: bucket.status,
  totals: bucket.totals,
  additionalSpending: bucket.additionalSpending,
  thirdPartyPaid: bucket.thirdPartyPaid,
  issues: bucket.issues,
  accounts: bucket.accounts.map((account) => ({
    positionId: account.positionId,
    excludedFirstBalance: account.excludedFirstBalance,
  })),
});

/** An exact decimal as its own value, or absent — never a stand-in zero (30.12). */
const money = (value: Decimal | undefined): string | null =>
  value === undefined ? null : value.toString();

const issueOf = (issue: Issue): unknown => ({
  key: issue.key,
  currency: issue.currency ?? null,
  positionId: issue.positionId ?? null,
  templateId: issue.templateId ?? null,
  occurrenceDate: issue.occurrenceDate ?? null,
  source: issue.source === undefined ? null : issue.source,
});

/* -------------------------------------------------------------------------- */
/* One period's inputs                                                         */
/* -------------------------------------------------------------------------- */

/**
 * One period as the families see it: an interval, and whatever the engines
 * reconciled over it.
 *
 * `buckets` is `null` for a current month with no `D`. That is not "no
 * currencies": it is the absence of a tracked interval altogether, and the
 * families that depend on one have nothing to report while the two untracked
 * settlements still do (8.6, 30.13 item 3).
 */
interface PeriodFigures {
  readonly from: PlainDate;
  /** Where every figure in this period stops: `D`, today, or the month end. */
  readonly through: PlainDate;
  readonly buckets: readonly BucketFigures[] | null;
  readonly monthStatus: string | null;
  readonly completeness: CompletenessImpact | null;
}

/** Every currency this period could report a figure in. */
function currenciesOf(evidence: CorrectionEvidence, period: PeriodFigures): CurrencyCode[] {
  const within = (on: PlainDate): boolean => on >= period.from && on <= period.through;
  const found = new Set<string>(period.buckets?.map((bucket) => bucket.currency) ?? []);
  for (const flow of evidence.expenses) if (within(flow.incurredOn)) found.add(flow.currency);
  for (const flow of evidence.income) if (within(flow.receivedOn)) found.add(flow.currency);
  for (const flow of evidence.transfers) {
    if (!within(flow.occurredOn)) continue;
    found.add(flow.fromCurrency);
    found.add(flow.toCurrency);
  }
  return [...found].sort().map((code) => code as CurrencyCode);
}

/* -------------------------------------------------------------------------- */
/* The six projections                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Reconciliation: the identity, the evidence it rests on, and what it flagged.
 *
 * The four exact role sums and `Δ` are here because the reconciliation card
 * shows them, so a corrected balance that leaves every status alone still moves
 * this family (8.2–8.4, 30.12). The statuses, the account endpoints, the issues
 * and 12.6's completeness are here for the same reason: they are all on the
 * same card.
 */
function reconciliationOf(period: PeriodFigures): unknown {
  return {
    monthStatus: period.monthStatus,
    completeness: period.completeness,
    buckets:
      period.buckets === null
        ? null
        : period.buckets.map((bucket) => ({
            currency: bucket.currency,
            status: bucket.status,
            externalInflows: bucket.totals.externalInflows.toString(),
            nonIncomeInflows: bucket.totals.nonIncomeInflows.toString(),
            nonExpenseOutflows: bucket.totals.nonExpenseOutflows.toString(),
            knownTrackedExpenses: bucket.totals.knownTrackedExpenses.toString(),
            cashDelta: money(bucket.totals.cashDelta),
            accounts: bucket.accounts,
            issues: bucket.issues.map(issueOf),
          })),
  };
}

/**
 * Spending: 8.4's tracked figures and 7.4's untracked-self one.
 *
 * `third_party` is deliberately not here — it is in no total at all (7.4) and
 * belongs to `memo`.
 */
function spendingOf(evidence: CorrectionEvidence, period: PeriodFigures): unknown {
  return currenciesOf(evidence, period).map((currency) => {
    const bucket = period.buckets?.find((item) => item.currency === currency) ?? null;
    return {
      currency,
      knownTrackedExpenses: bucket === null ? null : bucket.totals.knownTrackedExpenses.toString(),
      trackedTotalSpending: bucket === null ? null : money(bucket.totals.trackedTotalSpending),
      unclassified: bucket === null ? null : money(bucket.totals.unclassified),
      // Untracked-self is summed from source rows over the same interval, so it
      // exists in a currency with no cash account at all (30.15 item 3).
      additionalSpending: untrackedOf(evidence, currency, period).additionalSpending.toString(),
    };
  });
}

/** Income: 8.2's `ΣI` and 12.5's `ExternalIncome`, over this period's interval. */
function incomeOf(evidence: CorrectionEvidence, period: PeriodFigures): unknown {
  if (period.buckets === null) return null;
  return period.buckets.map((bucket) => ({
    currency: bucket.currency,
    externalInflows: bucket.totals.externalInflows.toString(),
    externalIncome: classificationOf(evidence, bucket, period).externalIncome.toString(),
  }));
}

/** Savings: everything 12.5 derives, and the source figures it derives them from. */
function savingsOf(evidence: CorrectionEvidence, period: PeriodFigures): unknown {
  if (period.buckets === null) {
    // No interval, so no derived figure exists — but the savings page still
    // reports the settlements that never needed one (30.15 item 3).
    return currenciesOf(evidence, period).map((currency) => ({
      currency,
      derived: null,
      additionalSpending: untrackedOf(evidence, currency, period).additionalSpending.toString(),
    }));
  }

  return period.buckets.map((bucket) => {
    const classified = classificationOf(evidence, bucket, period);
    const result = reconcileSavings({
      currency: bucket.currency,
      reconciliation: {
        status: bucket.status as BucketResult['status'],
        knownTrackedExpenses: bucket.totals.knownTrackedExpenses,
        trackedTotalSpending: bucket.totals.trackedTotalSpending,
        unclassified: bucket.totals.unclassified,
      },
      externalIncome: classified.externalIncome,
      nonConsumptionCosts: classified.nonConsumptionCosts,
      additionalSpending: classified.additionalSpending,
      thirdPartyPaid: classified.thirdPartyPaid,
      countAdditionalSpending: evidence.countAdditionalSpending,
    });

    return {
      currency: bucket.currency,
      externalIncome: classified.externalIncome.toString(),
      nonConsumptionCosts: {
        propertyOperatingCosts: classified.nonConsumptionCosts.propertyOperatingCosts.toString(),
        interestAndFees: classified.nonConsumptionCosts.interestAndFees.toString(),
        transactionCosts: classified.nonConsumptionCosts.transactionCosts.toString(),
        externalOutflows: classified.nonConsumptionCosts.externalOutflows.toString(),
      },
      additionalSpending: classified.additionalSpending.toString(),
      derived:
        result.derived.kind === 'unavailable'
          ? { available: false, because: result.derived.because }
          : {
              available: true,
              quality: result.derived.quality,
              consumption: result.derived.consumption.toString(),
              trackedSavingsFromIncome: result.derived.trackedSavingsFromIncome.toString(),
              personalSavings: result.derived.personalSavings.toString(),
              totalSpending: result.derived.totalSpending.toString(),
              savingsRate: isUnavailable(result.derived.savingsRate)
                ? null
                : result.derived.savingsRate.toString(),
              countsAdditionalSpending: result.derived.countsAdditionalSpending,
            },
    };
  });
}

/**
 * Categories: the by-category decomposition of known spending (30.14).
 *
 * Keyed on the category itself, not its kind: moving an expense from Groceries
 * to Restaurants leaves every kind-derived figure alone and still rewrites the
 * two rows the Spending page shows. Tracked-known and additional are kept
 * apart because the breakdown reports them in separate columns.
 *
 * With no tracked interval the breakdown has no tracked-known rows to show at
 * all — the items come from the buckets, and there are none — so only the
 * untracked-self settlement counts there.
 */
function categoriesOf(evidence: CorrectionEvidence, period: PeriodFigures): unknown {
  const totals = new Map<string, Decimal>();
  for (const flow of evidence.expenses) {
    if (flow.incurredOn < period.from || flow.incurredOn > period.through) continue;
    const group =
      flow.settlement === 'tracked_cash' && period.buckets !== null
        ? 'tracked'
        : flow.settlement === 'untracked_self'
          ? 'additional'
          : null;
    // `third_party` is in no spending total, so it is in no breakdown row.
    if (group === null) continue;
    const key = `${flow.currency}|${evidence.categoryIds.get(flow.id) ?? '-'}|${group}`;
    const running = totals.get(key);
    totals.set(key, running === undefined ? flow.amount : running.plus(flow.amount));
  }
  return [...totals]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, total]) => [key, total.toString()]);
}

/**
 * Memo: the informational figures and the words on the records themselves.
 *
 * `third_party` is spending somebody else paid for — in no total, reported for
 * information (7.4). A description or a balance's note is the same kind of
 * fact: it is on the page, it is not in any figure, and a correction that
 * changes only one of them has changed only this.
 */
function memoOf(
  evidence: CorrectionEvidence,
  period: PeriodFigures,
  scope: CorrectionScope,
): unknown {
  return {
    thirdPartyPaid: currenciesOf(evidence, period).map((currency) => [
      currency,
      untrackedOf(evidence, currency, period).thirdPartyPaid.toString(),
    ]),
    // This side's words, on the records this correction touches. Every other
    // row is identical on both sides by construction, so there is nothing to
    // learn from projecting them; what matters is that the before side reads
    // the before-image and the after side reads the after-image.
    notes: scope.changes
      .map((change) => [
        identityKey(change.identity),
        noteIn(scope.side === 'before' ? change.before : change.after, scope.period),
      ])
      .filter(([, note]) => note !== null)
      .sort(),
  };
}

/**
 * A record's own words, when the record belongs to this period.
 *
 * Not bounded by `D`: a description is on the month's own list of records, not
 * in a figure that stops at a common date.
 */
function noteIn(facts: SourceFacts | null, period: string): string | null {
  if (facts === null) return null;
  switch (facts.kind) {
    case 'income':
      return periodOf(facts.receivedOn) === period ? facts.description : null;
    case 'expense':
      return periodOf(facts.incurredOn) === period ? facts.description : null;
    case 'transfer':
      return periodOf(facts.occurredOn) === period ? facts.description : null;
    case 'valuation':
      return periodOf(facts.valuedOn) === period ? facts.note : null;
    case 'cash_dormancy':
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Shared sub-derivations                                                      */
/* -------------------------------------------------------------------------- */

const untrackedOf = (
  evidence: CorrectionEvidence,
  currency: CurrencyCode,
  period: PeriodFigures,
): UntrackedSpending =>
  untrackedSpendingOf(evidence.expenses, currency, period.from, period.through);

const classificationOf = (
  evidence: CorrectionEvidence,
  bucket: BucketFigures,
  period: PeriodFigures,
): ReturnType<typeof classifyBucketInterval> =>
  classifyBucketInterval(
    { income: evidence.income, expenses: evidence.expenses, transfers: evidence.transfers },
    evidence.expenses,
    bucket.currency,
    bucket.accounts,
    period.from,
    period.through,
  );

/* -------------------------------------------------------------------------- */
/* Assembly                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Which side of the correction is being projected, and over which records.
 *
 * Only `memo` needs it: every other family is a function of the evidence
 * alone, which the overlay has already turned into the after-world.
 */
export interface CorrectionScope {
  readonly side: 'before' | 'after';
  readonly changes: readonly IdentifiedSourceChange[];
  readonly period: string;
}

function familiesOf(
  evidence: CorrectionEvidence,
  period: PeriodFigures,
  scope: CorrectionScope,
): FamilyFigures {
  return {
    reconciliation: canonicalJson(reconciliationOf(period)),
    spending: canonicalJson(spendingOf(evidence, period)),
    savings: canonicalJson(savingsOf(evidence, period)),
    income: canonicalJson(incomeOf(evidence, period)),
    categories: canonicalJson(categoriesOf(evidence, period)),
    memo: canonicalJson(memoOf(evidence, period, scope)),
  };
}

/** One completed month's families, over `[start(M), end(M)]`. */
export function completedFamiliesOf(
  evidence: CorrectionEvidence,
  month: MonthKey,
  buckets: readonly BucketResult[],
  monthStatus: string,
  completeness: CompletenessImpact | null,
  scope: CorrectionScope,
): FamilyFigures {
  return familiesOf(
    evidence,
    {
      from: startOfMonthKey(month),
      through: endOfMonthKey(month),
      buckets: buckets.map(bucketFiguresOf),
      monthStatus,
      completeness,
    },
    scope,
  );
}

/**
 * The current month's families, over `[start(M), D]` — or, with no `D`, over
 * `[start(M), today]` for the two families that still have something to say.
 */
export function currentFamiliesOf(
  evidence: CorrectionEvidence,
  asOf: PlainDate | null,
  status: string,
  buckets: readonly MtdBucketResult[] | null,
  scope: CorrectionScope,
): FamilyFigures {
  return familiesOf(
    evidence,
    {
      from: startOfMonthKey(monthKey(evidence.today)),
      through: asOf ?? evidence.today,
      buckets: buckets === null ? null : buckets.map(bucketFiguresOf),
      monthStatus: status,
      completeness: null,
    },
    scope,
  );
}
