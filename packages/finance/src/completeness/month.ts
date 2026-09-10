import { Decimal } from '../decimal';
import {
  endOfMonthKey,
  isMonthCompleted,
  startOfMonthKey,
  type MonthKey,
} from '../dates/plain-date';
import { cashCloseState, participatesIn } from '../positions/cash-state';
import type { PositionWithValuations } from '../positions/types';
import { scheduledOccurrences } from '../reconciliation/completeness';
import { MonthNotCompletedError } from '../reconciliation/types';
import type {
  CashAccountRequirement,
  CompletedMonthCompleteness,
  CompletedMonthCompletenessInput,
  CompletenessState,
  RecurringOccurrenceRequirement,
} from './types';

/**
 * Completeness and freshness of one completed month (blueprint 12.6, v2.1.15
 * 30.18).
 *
 * 12.6's table is the end-state definition, and each phase counts the rows whose
 * domain it has built. Phase 3 has two:
 *
 *  - **cash** — every cash account that participates in M under 8.1 and is not
 *    dormant, satisfied by a `month_end` or `closed_zero` closing. Participation
 *    and the closing state are 8.1's own functions, not a second definition of
 *    either; a dormant account is outside the count rather than a satisfied item;
 *  - **recurring** — every occurrence a template's schedule placed in M, of every
 *    kind, satisfied by a flow or a skip carrying its identity. Archive state and
 *    terms take no part (30.10).
 *
 * The investment, liability and property rows join when their phases build
 * those domains (25). They are additional requirement lists beside these two,
 * and the state rule already says where each lands: cash items decide
 * `incomplete`, every other item decides `partial`.
 *
 * The count is global for the month. A reconciliation bucket is per native
 * currency and exists only where a cash account or a null leg does; a template
 * in a currency with no bucket still expected its occurrence, so it is counted
 * here from the schedule rather than through any bucket.
 */

function cashRequirement(entry: PositionWithValuations, month: MonthKey): CashAccountRequirement {
  const { position } = entry;
  const base = { positionId: position.id, name: position.name, currency: position.currency };
  const closeState = cashCloseState(position, entry.valuations, month);

  if (closeState === 'month_end' || closeState === 'closed_zero') {
    return { ...base, satisfied: true, closeState };
  }
  /* v8 ignore next 3 -- unreachable: `dormant_zero` needs `is_dormant`, and a
     dormant account is never a requirement. */
  if (closeState === 'dormant_zero') {
    throw new Error(`cash account ${position.id} is dormant and cannot be a requirement`);
  }
  return { ...base, satisfied: false, closeState };
}

/**
 * 30.18 item 3: whether any valuation of any position is dated inside
 * `[start(M), end(M)]`. Any kind, any precision, any source — and nothing dated
 * before M, however recently, because a carried balance is exactly the evidence
 * a stale month lacks.
 */
function hasValuationInMonth(
  positions: readonly PositionWithValuations[],
  month: MonthKey,
): boolean {
  const from = startOfMonthKey(month);
  const to = endOfMonthKey(month);
  return positions.some((entry) =>
    entry.valuations.some((valuation) => valuation.valuedOn >= from && valuation.valuedOn <= to),
  );
}

/**
 * Judge one **completed** month.
 *
 * Throws for a month that is not over: completeness is defined for completed
 * months only (12.6), and the current month's surface is "in progress", which is
 * a different question with no state and no ratio.
 */
export function completedMonthCompleteness(
  input: CompletedMonthCompletenessInput,
): CompletedMonthCompleteness {
  const { month } = input;
  if (!isMonthCompleted(month, input.today)) {
    throw new MonthNotCompletedError(month);
  }

  const cashAccounts = input.positions
    .filter(
      (entry) =>
        entry.position.kind === 'cash' &&
        participatesIn(entry.position, month) &&
        entry.position.isDormant !== true,
    )
    .sort((a, b) => a.position.id.localeCompare(b.position.id))
    .map((entry) => cashRequirement(entry, month));

  const recurringOccurrences: RecurringOccurrenceRequirement[] = scheduledOccurrences(
    input.templates,
    input.resolvedOccurrences,
    month,
  ).map((occurrence) => ({
    templateId: occurrence.templateId,
    templateName: occurrence.templateName,
    templateKind: occurrence.templateKind,
    currency: occurrence.currency,
    occurrenceDate: occurrence.occurrenceDate,
    satisfied: occurrence.resolved,
  }));

  const required = cashAccounts.length + recurringOccurrences.length;
  const satisfied =
    cashAccounts.filter((item) => item.satisfied).length +
    recurringOccurrences.filter((item) => item.satisfied).length;

  // 30.18 item 2: `stale` > `incomplete` > `partial` > `sufficient`. A month with
  // nothing required and some in-month evidence is `sufficient`, because no
  // requirement is unsatisfied (item 5).
  const state: CompletenessState = !hasValuationInMonth(input.positions, month)
    ? 'stale'
    : cashAccounts.some((item) => !item.satisfied)
      ? 'incomplete'
      : recurringOccurrences.some((item) => !item.satisfied)
        ? 'partial'
        : 'sufficient';

  return {
    month,
    state,
    satisfied,
    required,
    // 30.18 item 4: nothing was expected, so neither 0 nor 1 would be true.
    ratio: required === 0 ? null : new Decimal(satisfied).dividedBy(required),
    cashAccounts,
    recurringOccurrences,
  };
}
