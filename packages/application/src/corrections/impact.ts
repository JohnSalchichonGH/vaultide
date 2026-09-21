import {
  addDays,
  classifyBucketInterval,
  completedMonthCompleteness,
  endOfMonthKey,
  findSpanIntervals,
  isMonthCompleted,
  isUnavailable,
  monthKey,
  monthLabel,
  reconcileCompletedMonth,
  reconcileMonthToDate,
  reconcileSavings,
  startOfMonthKey,
  type BucketResult,
  type CurrencyCode,
  type Decimal,
  type Issue,
  type MonthKey,
  type MonthToDateResult,
  type MtdBucketResult,
  type PlainDate,
} from '@vaultide/finance';
import type { ResolvedWrite } from '../write-plan';
import { monthKeyOfPeriod } from './classify';
import {
  completedFamiliesOf,
  currentFamiliesOf,
  movedFamilies,
  type CorrectionScope,
  type FamilyFigures,
} from './families';
import {
  completedInputOf,
  completenessInputOf,
  monthToDateInputOf,
  spanAccountsOf,
  type CorrectionEvidence,
  type CorrectionWindow,
} from './evidence';
import {
  type CompletedBucketImpact,
  type CompletedPeriodState,
  type CompletenessImpact,
  type CurrentBucketState,
  type CurrentPeriodState,
  type IssueIdentity,
  type PeriodImpact,
  type SavingsImpactState,
  type StructuralChange,
} from './types';

/**
 * What a correction changes, derived from the existing engines (§6, §34–§48 of
 * the slice prompt).
 *
 * Nothing here calculates a financial figure. Every state below is what
 * `reconcileCompletedMonth`, `reconcileMonthToDate`, `completedMonthCompleteness`,
 * `findSpanIntervals` and `reconcileSavings` already say, asked twice over the
 * same loaded evidence with only the overlay different. A correction preview
 * that computed its own version of any of them would be a second implementation
 * of the product, free to disagree with the one the user sees afterwards.
 *
 * ## Which engine layers are asked, and which are not
 *
 * The month's own reconciliation is asked; the two **advisories** layered on
 * top of it are not. `large_unclassified` is judged against the six months
 * before the target (30.15 item 4) and `possible_missing_conversion` against
 * stored exchange rates (30.17) — one is rolling baseline noise that a
 * correction has no business asking a user to re-confirm (§45), and the other
 * would make historical consent depend on the rate publisher being reachable
 * (§78). Both are advisory metadata that move no status, total or residual, so
 * leaving them out changes no structural fact.
 */

/**
 * One period, derived once: the state the preview publishes and the family
 * figures the tags come from.
 */
export interface PeriodAnalysis<T> {
  readonly state: T;
  readonly families: FamilyFigures;
}

/* -------------------------------------------------------------------------- */
/* Issue identity                                                              */
/* -------------------------------------------------------------------------- */

function issueIdentity(issue: Issue, fallbackCurrency: string | null): IssueIdentity {
  return {
    key: issue.key,
    currency: (issue.currency as string | undefined) ?? fallbackCurrency,
    positionId: issue.positionId ?? null,
    templateId: issue.templateId ?? null,
    occurrenceDate: (issue.occurrenceDate as string | undefined) ?? null,
    source:
      issue.source === undefined
        ? null
        : { kind: issue.source.kind, id: issue.source.id, on: issue.source.on },
  };
}

/** One canonical string per issue, for comparison and for ordering. */
export function issueKeyOf(issue: IssueIdentity): string {
  return [
    issue.key,
    issue.currency ?? '-',
    issue.positionId ?? '-',
    issue.templateId ?? '-',
    issue.occurrenceDate ?? '-',
    issue.source === null ? '-' : `${issue.source.kind}:${issue.source.id}:${issue.source.on}`,
  ].join('|');
}

const byIssueKey = (a: IssueIdentity, b: IssueIdentity): number => {
  const left = issueKeyOf(a);
  const right = issueKeyOf(b);
  return left < right ? -1 : left > right ? 1 : 0;
};

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/* -------------------------------------------------------------------------- */
/* Savings                                                                     */
/* -------------------------------------------------------------------------- */

interface SavingsBucketInput {
  readonly currency: string;
  readonly status: BucketResult['status'];
  readonly accounts: readonly { readonly positionId: string; readonly excludedFirstBalance: boolean }[];
  readonly totals: {
    readonly knownTrackedExpenses: Decimal;
    readonly trackedTotalSpending?: Decimal | undefined;
    readonly unclassified?: Decimal | undefined;
  };
}

/**
 * One bucket's savings state, over the interval its own figures used (12.5,
 * 30.15 item 3).
 *
 * The four fields are structural, not monetary: whether the five derived
 * figures exist, the quality they inherit, whether the rate has a denominator,
 * and whether the `count_additional_spending` preference actually decides
 * anything here. The last one is the reason a correction whose personal savings
 * genuinely depend on untracked-self spending has to be reviewed again when the
 * preference is flipped, and one that does not is left alone (§98).
 */
function savingsStateOf(
  evidence: CorrectionEvidence,
  bucket: SavingsBucketInput,
  from: PlainDate,
  to: PlainDate,
): SavingsImpactState {
  const currency = bucket.currency as CurrencyCode;
  const classified = classifyBucketInterval(
    { income: evidence.income, expenses: evidence.expenses, transfers: evidence.transfers },
    evidence.expenses,
    currency,
    bucket.accounts,
    from,
    to,
  );
  const result = reconcileSavings({
    currency,
    reconciliation: {
      status: bucket.status,
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
    availability: result.derived.kind === 'available' ? 'available' : 'unavailable',
    quality: result.derived.kind === 'available' ? result.derived.quality : null,
    rate:
      result.derived.kind === 'available' && !isUnavailable(result.derived.savingsRate)
        ? 'ratio'
        : 'unavailable',
    // The preference only decides something where there is untracked-self
    // spending for it to count, which is exactly when flipping it moves this
    // bucket's personal savings.
    additionalSpendingCounts:
      evidence.countAdditionalSpending && !classified.additionalSpending.isZero(),
  };
}

/* -------------------------------------------------------------------------- */
/* Completed months                                                            */
/* -------------------------------------------------------------------------- */

function completedBucketImpact(
  evidence: CorrectionEvidence,
  month: MonthKey,
  bucket: BucketResult,
): CompletedBucketImpact {
  return {
    currency: bucket.currency,
    status: bucket.status,
    balanceEvidence: bucket.totals.cashDelta === undefined ? 'missing' : 'complete',
    accounts: [...bucket.accounts]
      .map((account) => ({
        positionId: account.positionId,
        opening: account.opening.state,
        closing: account.closing.state,
        included: account.included,
        excludedFirstBalance: account.excludedFirstBalance,
        dormant: account.dormant,
      }))
      .sort((a, b) => byText(a.positionId, b.positionId)),
    issues: bucket.issues
      .map((issue) => issueIdentity(issue, bucket.currency))
      .sort(byIssueKey),
    savings: savingsStateOf(
      evidence,
      bucket,
      startOfMonthKey(month),
      endOfMonthKey(month),
    ),
  };
}

/**
 * One completed month, asked once: the structural state the preview publishes,
 * and the family figures the tags are derived from.
 *
 * Both come out of the same two engine calls. Deriving them separately would
 * reconcile the month twice per side, and the second answer could only ever
 * agree with the first.
 */
export function completedAnalysisOf(
  evidence: CorrectionEvidence,
  month: MonthKey,
  scope: CorrectionScope,
): PeriodAnalysis<CompletedPeriodState> {
  const reconciliation = reconcileCompletedMonth(completedInputOf(evidence, month));
  const completeness = completedMonthCompleteness(completenessInputOf(evidence, month));
  const completenessImpact: CompletenessImpact = {
    state: completeness.state,
    satisfied: completeness.satisfied,
    required: completeness.required,
  };

  return {
    state: {
      status: reconciliation.monthStatus,
      buckets: [...reconciliation.buckets]
        .map((bucket) => completedBucketImpact(evidence, month, bucket))
        .sort((a, b) => byText(a.currency, b.currency)),
      completeness: completenessImpact,
    },
    families: completedFamiliesOf(
      evidence,
      month,
      reconciliation.buckets,
      reconciliation.monthStatus,
      completenessImpact,
      scope,
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* The current month                                                           */
/* -------------------------------------------------------------------------- */

function currentBucketState(
  evidence: CorrectionEvidence,
  bucket: MtdBucketResult,
  asOf: PlainDate,
): CurrentBucketState {
  return {
    currency: bucket.currency,
    status: bucket.status,
    reason: bucket.reason ?? null,
    accounts: [...bucket.accounts]
      .map((account) => ({
        positionId: account.positionId,
        opening: account.opening.state,
        atAsOf: account.atAsOf.state,
        included: account.included,
        excludedFirstBalance: account.excludedFirstBalance,
        dormant: account.dormant,
        snapshotRequired: account.snapshotRequired,
      }))
      .sort((a, b) => byText(a.positionId, b.positionId)),
    issues: bucket.issues.map((issue) => issueIdentity(issue, bucket.currency)).sort(byIssueKey),
    savings: savingsStateOf(
      evidence,
      bucket,
      startOfMonthKey(monthKey(evidence.today)),
      asOf,
    ),
  };
}

/**
 * The current month, in the two shapes the reporting contract already has
 * (8.6, 30.15 item 3, 30.16 item 6).
 *
 * `sourceOnlyThrough` is not a free choice here. `monthToDateReportingOf` and
 * `monthToDateSavingsFrom` already answer it — `asOf ?? today` — and a preview
 * that answered it differently would tell a user their source-only figures run
 * through a date the pages they are about to look at never used. With a `D`
 * everything stops at `D`, the two untracked settlements included; without one
 * there is no interval at all and those two, which never needed it, run to
 * today.
 */
export function currentAnalysisOf(
  evidence: CorrectionEvidence,
  scope: CorrectionScope,
): PeriodAnalysis<CurrentPeriodState> {
  const result: MonthToDateResult = reconcileMonthToDate(monthToDateInputOf(evidence));

  if (result.asOf === null) {
    return {
      state: {
        kind: 'no_tracked_interval',
        asOf: null,
        status: 'unavailable',
        reason: 'mtd_no_common_date',
        sourceOnlyThrough: evidence.today,
      },
      families: currentFamiliesOf(evidence, null, result.status, null, scope),
    };
  }

  const asOf = result.asOf;
  return {
    state: {
      kind: 'tracked_interval',
      asOf,
      status: result.status as 'provisional' | 'unresolved' | 'unavailable',
      sourceOnlyThrough: asOf,
      buckets: [...result.buckets]
        .map((bucket) => currentBucketState(evidence, bucket, asOf))
        .sort((a, b) => byText(a.currency, b.currency)),
    },
    families: currentFamiliesOf(evidence, asOf, result.status, result.buckets, scope),
  };
}

/* -------------------------------------------------------------------------- */
/* Structural changes                                                          */
/* -------------------------------------------------------------------------- */

function spanChanges(
  before: CorrectionEvidence,
  after: CorrectionEvidence,
): StructuralChange[] {
  const intervalsOf = (evidence: CorrectionEvidence): Map<string, { currency: string; from: string; to: string }> => {
    const map = new Map<string, { currency: string; from: string; to: string }>();
    for (const span of findSpanIntervals({
      today: evidence.today,
      cashAccounts: spanAccountsOf(evidence),
    })) {
      map.set(`${span.currency}|${span.from}|${span.to}`, {
        currency: span.currency,
        from: span.from,
        to: span.to,
      });
    }
    return map;
  };

  const left = intervalsOf(before);
  const right = intervalsOf(after);
  const changes: StructuralChange[] = [];

  for (const [key, span] of left) {
    if (right.has(key)) continue;
    changes.push({ kind: 'span', change: 'disappeared', ...span });
  }
  for (const [key, span] of right) {
    if (left.has(key)) continue;
    changes.push({ kind: 'span', change: 'appeared', ...span });
  }
  return changes;
}

/**
 * A balance's carry interval: the stretch it is the account's value over (8.1).
 *
 * From its own date to the day **before** the next authoritative balance, or
 * open when nothing follows it. A balance dated `d` already owns `d`, so a
 * successor on the 10th ends its predecessor on the 9th; naming the 10th would
 * have the two of them both owning that day. Derived from the evidence rather
 * than assumed over a fixed horizon, because that is the real consequence of
 * moving or removing a historical balance (§46).
 */
function carryIntervalOf(
  evidence: CorrectionEvidence,
  positionId: string,
  valuedOn: string,
): { from: string; to: string | null } | null {
  const records = evidence.valuations.get(positionId) ?? [];
  if (!records.some((record) => record.valuedOn === valuedOn)) return null;
  const next = records
    .filter((record) => record.valuedOn > valuedOn)
    .map((record) => record.valuedOn)
    .sort(byText)[0];
  return { from: valuedOn, to: next === undefined ? null : addDays(next, -1) };
}

function carryChanges(
  write: ResolvedWrite,
  before: CorrectionEvidence,
  after: CorrectionEvidence,
): StructuralChange[] {
  const changes: StructuralChange[] = [];
  for (const change of write.changes) {
    const facts = change.after ?? change.before;
    if (facts.kind !== 'valuation') continue;
    const positionId = facts.positionId;
    const beforeDate = change.before?.kind === 'valuation' ? change.before.valuedOn : null;
    const afterDate = change.after?.kind === 'valuation' ? change.after.valuedOn : null;

    const left = beforeDate === null ? null : carryIntervalOf(before, positionId, beforeDate);
    const right = afterDate === null ? null : carryIntervalOf(after, positionId, afterDate);
    if (JSON.stringify(left) === JSON.stringify(right)) continue;
    changes.push({ kind: 'valuation_carry', positionId, before: left, after: right });
  }
  return changes;
}

function dormancyChanges(write: ResolvedWrite): StructuralChange[] {
  return write.dormancy
    .filter(
      (effect) =>
        effect.before.isDormant !== effect.after.isDormant ||
        effect.before.dormantFrom !== effect.after.dormantFrom,
    )
    .map((effect) => ({
      kind: 'dormancy_episode' as const,
      positionId: effect.positionId,
      before: effect.before.dormantFrom,
      after: effect.after.dormantFrom,
    }));
}

function issueChanges(
  month: string,
  before: readonly IssueIdentity[],
  after: readonly IssueIdentity[],
): StructuralChange[] {
  const left = new Map(before.map((issue) => [issueKeyOf(issue), issue]));
  const right = new Map(after.map((issue) => [issueKeyOf(issue), issue]));
  const changes: StructuralChange[] = [];

  for (const [key, issue] of left) {
    if (right.has(key)) continue;
    changes.push({ kind: 'issue', change: 'cleared', month, issue });
  }
  for (const [key, issue] of right) {
    if (left.has(key)) continue;
    changes.push({ kind: 'issue', change: 'appeared', month, issue });
  }
  return changes;
}

/* -------------------------------------------------------------------------- */
/* The whole impact                                                            */
/* -------------------------------------------------------------------------- */

export interface CorrectionImpact {
  readonly periods: readonly PeriodImpact[];
  readonly structuralChanges: readonly StructuralChange[];
}

const structuralOrder = (change: StructuralChange): string =>
  JSON.stringify([change.kind, change]);

/**
 * Derive one correction's whole impact from two views of the same evidence.
 *
 * A candidate period is **reported** when its structural state differs, when
 * one of its output families moves, or when it is one of the correction's own
 * source periods — a user editing an August record needs to see August named
 * whether or not anything about August moved. Every other candidate is
 * dropped, which is what keeps the result compact when a correction reaches a
 * long way forward.
 */
export function deriveImpact(
  write: ResolvedWrite,
  before: CorrectionEvidence,
  after: CorrectionEvidence,
  sourcePeriods: readonly string[],
  window: CorrectionWindow,
): CorrectionImpact {
  const today = before.today;
  const current = monthLabel(monthKey(today));
  const sources = new Set(sourcePeriods);
  const periods: PeriodImpact[] = [];
  const structural: StructuralChange[] = [...spanChanges(before, after), ...dormancyChanges(write), ...carryChanges(write, before, after)];
  const scopeOf = (side: 'before' | 'after', period: string): CorrectionScope => ({
    side,
    changes: write.changes,
    period,
  });

  for (const period of window.periods) {
    const month = monthKeyOfPeriod(period);

    if (period === current && !isMonthCompleted(month, today)) {
      const left = currentAnalysisOf(before, scopeOf('before', period));
      const right = currentAnalysisOf(after, scopeOf('after', period));
      const tags = movedFamilies(left.families, right.families);
      const differs = JSON.stringify(left.state) !== JSON.stringify(right.state);
      if (!differs && tags.length === 0 && !sources.has(period)) continue;

      periods.push({
        kind: 'current',
        month: period,
        before: left.state,
        after: right.state,
        tags,
      });
      if (left.state.kind === 'tracked_interval' && right.state.kind === 'tracked_interval') {
        structural.push(...currentStructural(period, left.state, right.state));
      }
      continue;
    }

    if (!isMonthCompleted(month, today)) continue;

    const left = completedAnalysisOf(before, month, scopeOf('before', period));
    const right = completedAnalysisOf(after, month, scopeOf('after', period));
    const tags = movedFamilies(left.families, right.families);
    const differs = JSON.stringify(left.state) !== JSON.stringify(right.state);
    if (!differs && tags.length === 0 && !sources.has(period)) continue;

    periods.push({
      kind: 'completed',
      month: period,
      before: left.state,
      after: right.state,
      tags,
    });
    structural.push(...completedStructural(period, left.state, right.state));
  }

  return {
    periods,
    structuralChanges: [...structural].sort((a, b) => byText(structuralOrder(a), structuralOrder(b))),
  };
}

function completedStructural(
  month: string,
  before: CompletedPeriodState,
  after: CompletedPeriodState,
): StructuralChange[] {
  const changes: StructuralChange[] = [];
  if (before.status !== after.status) {
    changes.push({ kind: 'month_status', month, before: before.status, after: after.status });
  }
  if (!sameCompleteness(before.completeness, after.completeness)) {
    changes.push({
      kind: 'completeness',
      month,
      before: before.completeness,
      after: after.completeness,
    });
  }

  const currencies = new Set([
    ...before.buckets.map((bucket) => bucket.currency),
    ...after.buckets.map((bucket) => bucket.currency),
  ]);
  for (const currency of [...currencies].sort(byText)) {
    const left = before.buckets.find((bucket) => bucket.currency === currency) ?? null;
    const right = after.buckets.find((bucket) => bucket.currency === currency) ?? null;
    if ((left?.status ?? null) !== (right?.status ?? null)) {
      changes.push({
        kind: 'bucket_status',
        month,
        currency,
        before: left?.status ?? null,
        after: right?.status ?? null,
      });
    }
    changes.push(...issueChanges(month, left?.issues ?? [], right?.issues ?? []));
  }
  return changes;
}

function currentStructural(
  month: string,
  before: Extract<CurrentPeriodState, { kind: 'tracked_interval' }>,
  after: Extract<CurrentPeriodState, { kind: 'tracked_interval' }>,
): StructuralChange[] {
  const changes: StructuralChange[] = [];
  const currencies = new Set([
    ...before.buckets.map((bucket) => bucket.currency),
    ...after.buckets.map((bucket) => bucket.currency),
  ]);
  for (const currency of [...currencies].sort(byText)) {
    const left = before.buckets.find((bucket) => bucket.currency === currency) ?? null;
    const right = after.buckets.find((bucket) => bucket.currency === currency) ?? null;
    if ((left?.status ?? null) !== (right?.status ?? null)) {
      changes.push({
        kind: 'bucket_status',
        month,
        currency,
        before: left?.status ?? null,
        after: right?.status ?? null,
      });
    }
    changes.push(...issueChanges(month, left?.issues ?? [], right?.issues ?? []));
  }
  return changes;
}

function sameCompleteness(a: CompletenessImpact | null, b: CompletenessImpact | null): boolean {
  if (a === null || b === null) return a === b;
  return a.state === b.state && a.satisfied === b.satisfied && a.required === b.required;
}
