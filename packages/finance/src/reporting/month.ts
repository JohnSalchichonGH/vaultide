import type { Decimal } from '../decimal';
import type { MonthKey, PlainDate } from '../dates/plain-date';
import type { CurrencyCode } from '../money/types';
import type { UnavailableReason } from '../unavailable';
import type { ExpenseFlow } from '../flows/types';
import {
  factsInRange,
  factsInScope,
  scopeAccountIds,
  type FlowRecords,
  type ScopeAccount,
} from '../reconciliation/scope';
import type { ReconciliationStatus } from '../reconciliation/types';
import {
  contributionOfFact,
  residualContribution,
  untrackedContribution,
  type ContributionQuality,
  type MissingContributionInput,
  type ReportingContribution,
} from './contributions';

/**
 * One bucket's reporting contributions, from the facts reconciliation already
 * scoped (8.1, 12.5, v2.1.13 30.16).
 *
 * The same `factsInScope` over the same `scopeAccountIds` the identity used, so
 * the set converted here is the set summed there. There is no second scan of the
 * month and no second inclusion rule: an account excluded as `first_balance`
 * contributes nothing to the reporting figures for exactly the reason it
 * contributed nothing to `ΣI`.
 */

export interface BucketContributionsInput {
  readonly records: FlowRecords;
  /** Source rows for the two settlements, which carry no cash role (7.4). */
  readonly expenses: readonly ExpenseFlow[];
  readonly currency: CurrencyCode;
  readonly accounts: readonly ScopeAccount[];
  readonly month: MonthKey;
  readonly from: PlainDate;
  /** `end(M)` for a completed month, `D` for a month-to-date one. */
  readonly to: PlainDate;
  readonly status: ReconciliationStatus;
  /** The native residual, when the bucket produced a usable one. */
  readonly unclassified?: Decimal | undefined;
  /**
   * Why the residual is absent, when it is. The caller knows — an unresolved
   * bucket contradicts itself, an unavailable one never reached the identity —
   * and no reason is invented here to stand in for it.
   */
  readonly residualReason?: UnavailableReason | undefined;
  readonly residualDetail?: string | undefined;
}

export interface BucketContributions {
  readonly contributions: readonly ReportingContribution[];
  readonly missing: readonly MissingContributionInput[];
}

/** The calculation quality a bucket's residual carries into what it feeds. */
function qualityOf(status: ReconciliationStatus): ContributionQuality | undefined {
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
 * The untracked rows of one currency over `[from, to]`.
 *
 * Summed from source records rather than from scoped legs, because neither
 * settlement has a cash role and neither was ever in the scoped set — which is
 * also why they exist in a currency with no cash account at all. They convert at
 * their own dates like any other row, and the interval is the one the figures
 * beside them used (30.15 item 3).
 */
export function untrackedContributions(
  expenses: readonly ExpenseFlow[],
  currency: CurrencyCode,
  from: PlainDate,
  to: PlainDate,
): ReportingContribution[] {
  const contributions: ReportingContribution[] = [];
  for (const expense of expenses) {
    if (expense.currency !== currency) continue;
    if (expense.incurredOn < from || expense.incurredOn > to) continue;
    if (expense.settlement === 'untracked_self') {
      contributions.push(
        untrackedContribution('additionalSpending', expense.amount, currency, expense.incurredOn, expense.id),
      );
    } else if (expense.settlement === 'third_party') {
      contributions.push(
        untrackedContribution('thirdPartyPaid', expense.amount, currency, expense.incurredOn, expense.id),
      );
    }
  }
  return contributions;
}

/**
 * Everything one native bucket contributes to the reporting month.
 *
 * The residual is the one contribution that is not read off a record, so it is
 * the only one that can be missing rather than unconvertible: a bucket that
 * contradicts itself has arithmetic evidence and not a spending figure (R6), and
 * a bucket that never reconciled has nothing at all. Either way the figures that
 * consume it degrade and the ones that do not are untouched.
 */
export function bucketContributions(input: BucketContributionsInput): BucketContributions {
  const facts = factsInScope(
    factsInRange(input.records, input.from, input.to),
    input.currency,
    scopeAccountIds(input.accounts),
  );

  const contributions: ReportingContribution[] = [];
  for (const fact of facts) {
    const contribution = contributionOfFact(fact);
    if (contribution !== undefined) contributions.push(contribution);
  }

  contributions.push(
    ...untrackedContributions(input.expenses, input.currency, input.from, input.to),
  );

  const missing: MissingContributionInput[] = [];
  const quality = qualityOf(input.status);

  if (input.unclassified !== undefined && quality !== undefined) {
    contributions.push(
      residualContribution(
        input.unclassified,
        input.currency,
        input.month,
        quality,
        // Only a month-to-date bucket cuts its own average short, and it does so
        // at the date its figures stop (30.16 item 3).
        input.status === 'provisional' ? input.to : undefined,
      ),
    );
  } else {
    missing.push({
      field: 'unclassified',
      currency: input.currency,
      reason: input.residualReason ?? 'not_applicable',
      ...(input.residualDetail === undefined ? {} : { detail: input.residualDetail }),
    });
  }

  return { contributions, missing };
}
