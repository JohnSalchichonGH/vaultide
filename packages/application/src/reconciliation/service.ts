import {
  addMonths,
  bucketObservations,
  conversionObservations,
  Decimal,
  endOfMonthKey,
  isMissingConversionDestination,
  isMissingConversionSource,
  isMonthCompleted,
  LARGE_UNCLASSIFIED_BASELINE_MONTHS,
  monthKey,
  plainDate,
  reconcileCompletedMonth,
  startOfMonthKey,
  termForOccurrence,
  withLargeUnclassified,
  withPossibleMissingConversion,
  type BucketResult,
  type ConversionCandidate,
  type Issue,
  type LargeUnclassifiedObservation,
  type MonthKey,
  type MonthReconciliation,
  type TemplateTerm,
} from '@vaultide/finance';
import type { RequestContext } from '../context';
import { ValidationError } from '../errors';
import type { FxService } from '../fx/service';
import { moneyDto } from '../positions/mapping';
import type { CompletedMonthData, MonthDataDependencies } from './loader';
import { loadCompletedRange } from './range-loader';
import type {
  ConversionCandidateDto,
  MonthReconciliationDto,
  ReconciliationBucketDto,
  ReconciliationIssueDto,
} from './types';

/**
 * The completed-month reconciliation read (blueprint 8.1–8.5, 8.9, 23.2).
 *
 * Load the month in a fixed number of queries, run the pure engine, serialize.
 * No arithmetic happens here and none happens in SQL: the interface and the
 * tests see the engine's answer or they see nothing (4.1).
 *
 * Nothing is written. A reconciliation is derived (5.3), so this service has no
 * counterpart that stores one — correcting an August balance in March changes
 * what August says the next time somebody looks, with no recomputation job and
 * nothing to invalidate.
 */

export interface ReconciliationDependencies extends MonthDataDependencies {
  /**
   * Read access to stored rates, for the month's average alone (10.2). Never
   * a provider: a completed month either has rate observations or it does not,
   * and this read fetches none (30.17).
   */
  readonly fx: Pick<FxService, 'loadTable'>;
}

/** `YYYY-MM` from the client, validated into a month key. */
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function parseMonth(value: string): MonthKey {
  if (!MONTH_PATTERN.test(value)) {
    throw new ValidationError('That is not a month.', { month: ['Expected YYYY-MM.'] });
  }
  return monthKey(plainDate(`${value}-01`));
}

function termsOf(data: CompletedMonthData, templateId: string): TemplateTerm[] {
  return data.terms
    .filter((term) => term.templateId === templateId)
    .map((term) => ({
      id: term.id,
      templateId: term.templateId,
      effectiveFrom: plainDate(term.effectiveFrom),
      amount: new Decimal(term.amount),
      grossAmount: term.grossAmount === null ? null : new Decimal(term.grossAmount),
    }));
}

function candidateDto(candidate: ConversionCandidate): ConversionCandidateDto {
  return {
    sourceCurrency: candidate.sourceCurrency,
    destinationCurrency: candidate.destinationCurrency,
    sourceAmount: moneyDto(candidate.sourceAmount.toString(), candidate.sourceCurrency),
    destinationAmount: moneyDto(candidate.destinationAmount.toString(), candidate.destinationCurrency),
    comparisonAmount: moneyDto(candidate.comparisonAmount.toString(), candidate.sourceCurrency),
    rate: candidate.rate.toString(),
    rateDate: candidate.rateDate,
    rateSource: candidate.rateSource,
  };
}

function issueDto(
  issue: Issue,
  data: CompletedMonthData,
  names: ReadonlyMap<string, string>,
  bucketCurrency: string,
): ReconciliationIssueDto {
  // Only the two `mtd_*` keys omit a currency, and the completed engine raises
  // neither; the bucket's own currency is the right fallback either way.
  const currency = issue.currency ?? bucketCurrency;
  // 30.9 item 4: the term of an occurrence is the greatest `effective_from ≤
  // occurrence_date`, and `loadTermsForRange` carries the latest term from
  // before the window for exactly this — a salary set two years ago is still
  // what September's occurrence was worth.
  const term =
    issue.templateId === undefined || issue.occurrenceDate === undefined
      ? undefined
      : termForOccurrence(termsOf(data, issue.templateId), issue.occurrenceDate);

  return {
    key: issue.key,
    class: issue.class,
    currency,
    positionId: issue.positionId ?? null,
    positionName: issue.positionId === undefined ? null : (names.get(issue.positionId) ?? null),
    amount: issue.amount === undefined ? null : moneyDto(issue.amount.toString(), currency),
    variant: issue.variant ?? null,
    templateId: issue.templateId ?? null,
    templateName: issue.templateName ?? null,
    occurrenceDate: issue.occurrenceDate ?? null,
    expectedAmount: term === undefined ? null : moneyDto(term.amount.toString(), currency),
    // Present on `possible_missing_conversion` alone, as on the engine's issue.
    ...(issue.candidates === undefined ? {} : { candidates: issue.candidates.map(candidateDto) }),
  };
}

/**
 * The currencies whose November average the advisory would read — or none,
 * when the month cannot show a missing conversion's signature at all.
 *
 * The signature needs a bucket that gained cash it cannot explain and another
 * that lost cash it cannot explain, in the same month (30.15 item 6). Absent
 * either, no rate can change the answer and none is read: a single-currency
 * month, and a multi-currency month whose buckets all reconcile, cost exactly
 * what they cost before this advisory existed.
 */
function conversionQuotes(result: MonthReconciliation): string[] {
  const observations = conversionObservations(result);
  const destinations = observations.filter(isMissingConversionDestination);
  const sources = observations.filter(isMissingConversionSource);
  if (destinations.length === 0 || sources.length === 0) return [];
  return [...new Set([...destinations, ...sources].map((observation) => observation.currency))];
}

function bucketDto(
  bucket: BucketResult,
  data: CompletedMonthData,
  names: ReadonlyMap<string, string>,
): ReconciliationBucketDto {
  const amount = (value: Decimal): ReturnType<typeof moneyDto> =>
    moneyDto(value.toString(), bucket.currency);

  return {
    currency: bucket.currency,
    status: bucket.status,
    accounts: bucket.accounts.map((account) => ({
      positionId: account.positionId,
      name: account.name,
      openState: account.opening.state,
      closeState: account.closing.state,
      opening: account.opening.amount === undefined ? null : amount(account.opening.amount),
      closing: account.closing.amount === undefined ? null : amount(account.closing.amount),
      included: account.included,
      excludedFirstBalance: account.excludedFirstBalance,
      dormant: account.dormant,
      residual: account.residual === undefined ? null : amount(account.residual),
    })),
    totals: {
      externalInflows: amount(bucket.totals.externalInflows),
      nonIncomeInflows: amount(bucket.totals.nonIncomeInflows),
      nonExpenseOutflows: amount(bucket.totals.nonExpenseOutflows),
      knownTrackedExpenses: amount(bucket.totals.knownTrackedExpenses),
      // Absent, not zero: a bucket the engine could not compute has no figure
      // and the interface must show the reason instead (8.4, 30.12).
      cashDelta: bucket.totals.cashDelta === undefined ? null : amount(bucket.totals.cashDelta),
      trackedTotalSpending:
        bucket.totals.trackedTotalSpending === undefined
          ? null
          : amount(bucket.totals.trackedTotalSpending),
      unclassified:
        bucket.totals.unclassified === undefined ? null : amount(bucket.totals.unclassified),
    },
    additionalSpending: amount(bucket.additionalSpending),
    thirdPartyPaid: amount(bucket.thirdPartyPaid),
    issues: bucket.issues.map((issue) => issueDto(issue, data, names, bucket.currency)),
    explanation: bucket.explanation,
  };
}

/**
 * Reconcile one completed month for the authenticated user.
 *
 * The month must be over: 8.1 defines a completed month as `today > end(M)`,
 * and the current month's figure is the month-to-date engine's, which is a
 * different question with a different status. Asking for a month that is not
 * over is a client error rather than a silently different answer.
 *
 * The read covers `M−6 … M` in one bounded load — the six calendar months the
 * `large_unclassified` advisory reads (30.15 item 4) and the month itself. Each
 * is reconciled in memory by the same engine, the six earlier ones only to
 * become baseline observations; the month's own figures are exactly what a
 * single-month load would have given, because the range loader slices the same
 * rows on the same bounds and keeps the earliest opening evidence intact.
 *
 * When the month shows a missing conversion's signature, one more read fetches
 * the stored rates dated inside `M` — the completed month's average draws on
 * nothing outside it (10.2, 30.17) — and the `possible_missing_conversion`
 * advisory is judged from them. Both advisories are metadata on top: they move
 * no status, total or residual.
 */
export async function getMonthReconciliation(
  deps: ReconciliationDependencies,
  ctx: RequestContext,
  month: MonthKey,
): Promise<MonthReconciliationDto> {
  if (!isMonthCompleted(month, ctx.today)) {
    throw new ValidationError('That month is not over yet.', {
      month: ['A month can only be reconciled once it has ended.'],
    });
  }

  const from = monthKey(addMonths(startOfMonthKey(month), -LARGE_UNCLASSIFIED_BASELINE_MONTHS));
  const range = await loadCompletedRange(deps, ctx.userId, from, month, ctx.today);

  const input = range.inputs.get(month);
  if (input === undefined) throw new Error(`no input for ${month}`);
  const data: CompletedMonthData = {
    input,
    positions: range.positions,
    categories: range.categories,
    templates: range.templates,
    terms: range.terms,
  };

  const history: LargeUnclassifiedObservation[] = [];
  for (const [historyMonth, historyInput] of range.inputs) {
    if (historyMonth === month) continue;
    history.push(...bucketObservations(reconcileCompletedMonth(historyInput)));
  }
  const judged: MonthReconciliation = withLargeUnclassified(reconcileCompletedMonth(input), history);
  const quotes = conversionQuotes(judged);
  const result: MonthReconciliation =
    quotes.length === 0
      ? judged
      : withPossibleMissingConversion(
          judged,
          await deps.fx.loadTable(quotes, startOfMonthKey(month), endOfMonthKey(month), ctx.today),
        );
  const names = new Map(data.positions.map((row) => [row.id, row.name]));

  return {
    month: (month as string).slice(0, 7),
    status: result.monthStatus,
    buckets: result.buckets.map((bucket) => bucketDto(bucket, data, names)),
  };
}
