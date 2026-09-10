import {
  completedMonthCompleteness,
  isMonthCompleted,
  type CashAccountRequirement,
  type MonthKey,
} from '@vaultide/finance';
import type { RequestContext } from '../context';
import { ValidationError } from '../errors';
import { loadCompletedMonth, type LoadedCompletedMonth, type MonthDataDependencies } from './loader';
import type { CashAccountRequirementDto, MonthCompletenessDto } from './types';

/**
 * Completed-month completeness, read from the database (blueprint 12.6, 23.2,
 * v2.1.15 30.18).
 *
 * Load, run the pure engine, serialize — and nothing else. The loader is the
 * completed-month one, so the templates arrive archived or not (30.10), the
 * valuations arrive with no lower bound (ADR 0004 §3), and the read opens the
 * loader's user-scoped repository transactions (`withUser`) and no others — a
 * bounded count fixed by the loader rather than by the data, though one
 * transaction may run several SQL statements. The `stale` rule is answered
 * from valuations that window already holds, not from a query of its own.
 *
 * A read beside reconciliation, never inside it: this changes no bucket
 * status, figure or issue, and the reconciliation DTO does not carry it.
 * Neither does anything about `month_reviews` enter: a review mark or a
 * dismissed advisory satisfies no requirement. Nothing is stored (5.3).
 */

export type CompletenessDependencies = MonthDataDependencies;

function cashAccountDto(item: CashAccountRequirement): CashAccountRequirementDto {
  const base = { positionId: item.positionId, name: item.name, currency: item.currency };
  return item.satisfied
    ? { ...base, satisfied: true, closeState: item.closeState }
    : { ...base, satisfied: false, closeState: item.closeState };
}

/**
 * A completed month's completeness from rows already loaded.
 *
 * Exported so a later composite read — the Monthly Overview — can have the
 * reconciliation, the savings and the completeness from one window instead of
 * loading the month three times.
 */
export function monthCompletenessFrom(data: LoadedCompletedMonth): MonthCompletenessDto {
  const result = completedMonthCompleteness({
    month: data.input.month,
    today: data.input.today,
    positions: data.positionsWithValuations,
    templates: data.input.templates,
    resolvedOccurrences: data.input.resolvedOccurrences,
  });

  return {
    month: (result.month as string).slice(0, 7),
    state: result.state,
    satisfied: result.satisfied,
    required: result.required,
    ratio: result.ratio === null ? null : result.ratio.toString(),
    cashAccounts: result.cashAccounts.map(cashAccountDto),
    recurringOccurrences: result.recurringOccurrences.map((item) => ({
      templateId: item.templateId,
      templateName: item.templateName,
      templateKind: item.templateKind,
      currency: item.currency,
      occurrenceDate: item.occurrenceDate,
      satisfied: item.satisfied,
    })),
  };
}

/**
 * Judge one completed month for the authenticated user.
 *
 * The month must be over. 12.6 defines completeness for completed months only;
 * the current month's surface is "in progress", which is a different question,
 * so asking about it is a client error rather than a quietly different answer.
 */
export async function getMonthCompleteness(
  deps: CompletenessDependencies,
  ctx: RequestContext,
  month: MonthKey,
): Promise<MonthCompletenessDto> {
  if (!isMonthCompleted(month, ctx.today)) {
    throw new ValidationError('That month is not over yet.', {
      month: ['Completeness is only judged once a month has ended.'],
    });
  }

  return monthCompletenessFrom(await loadCompletedMonth(deps, ctx.userId, month, ctx.today));
}
