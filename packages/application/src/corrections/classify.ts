import {
  addDays,
  isMonthCompleted,
  monthKey,
  monthLabel,
  occurrencesInRange,
  plainDate,
  startOfMonth,
  type MonthKey,
  type PlainDate,
} from '@vaultide/finance';
import {
  dormancyChanged,
  type IdentifiedSourceChange,
  type ResolvedWrite,
  type SourceFacts,
  type TemplateScheduleSourceFacts,
} from '../write-plan';

/**
 * What a Historical Correction is (blueprint 30.22 items 1 and 2; ADR 0010 §1).
 *
 * Two rules, and nothing else decides it:
 *
 *  1. a **revision** — an update or a delete — of a source financial fact whose
 *     financial period is completed on its before side or its after side. So
 *     moving a record out of a completed month, into one, or between two is a
 *     correction whichever direction it goes, and a current → current edit is
 *     not one;
 *  2. a **dormancy transition whose dated episode reaches completed history**.
 *     `cash_accounts.dormant_from` is a zero balance's own date (8.8, 30.20),
 *     so starting, moving or clearing an episode anchored in a closed month
 *     reinterprets months already closed — whatever the write that caused it
 *     was otherwise doing.
 *
 * A single historical **creation** is deliberately outside rule 1. Not because
 * it has no historical consequence — recording a September expense in October
 * plainly changes September — but because it is a first assertion rather than a
 * revision: there is no before-image, and the before → after confirmation 15.3
 * asks for would have an empty left-hand side. Rule 2 still applies to it,
 * because the episode it clears is somebody's earlier assertion.
 *
 * This module is pure and knows nothing about transactions, rows or services:
 * the mutations resolve, and this judges what they resolved. That is what makes
 * the ordinary write guard and the correction preview one rule rather than two.
 */

export type HistoricalReviewReason =
  /** Rule 1: a revision touching a completed financial period. */
  | 'completed_source_revision'
  /** Rule 2: a dated dormant episode reaching completed history. */
  | 'historical_dormancy';

export interface HistoricalReview {
  readonly required: boolean;
  /** Why, in a fixed order, so a message and a test can both name it. */
  readonly reasons: readonly HistoricalReviewReason[];
  /** The completed periods that made it one, `YYYY-MM`, ascending. */
  readonly completedPeriods: readonly string[];
}

/**
 * The financial period one source fact belongs to (§31 of the slice prompt).
 *
 * Derived from the fact's own financial date and never from anything else. A
 * materialized recurring flow's `occurrence_date` is scheduling identity, not a
 * financial period, so it is deliberately absent here (§30.9 item 2).
 *
 * A skip is the exception that proves the rule: it has no other date. Its
 * `occurrence_date` is the month whose expectation it excuses, so that month is
 * its financial period (ADR 0013 §1).
 *
 * A template's schedule has no single date at all, so it has none here: its
 * periods are what two schedules disagree about, and only `periodsOfChange`,
 * which sees both, can say which months those are (ADR 0013 §2).
 */
export function financialDateOf(facts: SourceFacts): string | null {
  switch (facts.kind) {
    case 'income':
      return facts.receivedOn;
    case 'expense':
      return facts.incurredOn;
    case 'transfer':
      return facts.occurredOn;
    case 'valuation':
      return facts.valuedOn;
    case 'cash_dormancy':
      // A cleared episode has no anchor left; the side that had one supplies
      // the period, which is why both sides are always asked.
      return facts.dormantFrom;
    case 'skip':
      return facts.occurrenceDate;
    case 'template_schedule':
      return null;
  }
}

/** `2026-08-31` → `2026-08`. */
export function periodOf(date: string): string {
  return monthLabel(monthKey(plainDate(date)));
}

/** `2026-08` → the month key the engines speak. */
export function monthKeyOfPeriod(period: string): MonthKey {
  return monthKey(plainDate(`${period}-01`));
}

export function isCompletedPeriod(period: string, today: PlainDate): boolean {
  return isMonthCompleted(monthKeyOfPeriod(period), today);
}

/** Every occurrence one side's schedule places on or before `through`. */
function scheduledThrough(
  facts: TemplateScheduleSourceFacts | null,
  through: PlainDate,
): readonly string[] {
  if (facts === null) return [];
  const startDate = plainDate(facts.startDate);
  return occurrencesInRange(
    {
      frequency: facts.frequency,
      dayOfMonth: facts.dayOfMonth,
      startDate,
      endDate: facts.endDate === null ? null : plainDate(facts.endDate),
    },
    startDate,
    through,
  );
}

/**
 * The finished months a schedule change reaches (ADR 0013 §2).
 *
 * A month is reached when it holds an occurrence one schedule has and the
 * other does not. It is found from the occurrences themselves, never from the
 * two end dates: with a schedule on the 25th, moving the end from 20 August to
 * 22 August reaches no month, and moving it to 26 August reaches August.
 *
 * Only finished months are its periods. A month still running, or one ahead,
 * is reached as well, but a change that reaches nothing else stays ordinary,
 * so the comparison stops at the last day of the month before `today`'s — which
 * is also what bounds a schedule that has no end on one side.
 */
function schedulePeriodsOf(change: IdentifiedSourceChange, today: PlainDate): readonly string[] {
  const side = (facts: SourceFacts | null): TemplateScheduleSourceFacts | null =>
    facts?.kind === 'template_schedule' ? facts : null;
  const through = addDays(startOfMonth(today), -1);
  const before = new Set(scheduledThrough(side(change.before), through));
  const after = new Set(scheduledThrough(side(change.after), through));
  const differ = [
    ...[...before].filter((date) => !after.has(date)),
    ...[...after].filter((date) => !before.has(date)),
  ];
  return [...new Set(differ.map(periodOf))].sort();
}

/**
 * Both sides of one change, as periods; deduplicated, ascending.
 *
 * For a fact with a financial date, the months of that date before and after.
 * For a template's schedule, which has none, the finished months the two
 * schedules disagree about (`schedulePeriodsOf`) — the one kind whose periods
 * depend on `today`, because a month only becomes one of them once it ends.
 */
export function periodsOfChange(
  change: IdentifiedSourceChange,
  today: PlainDate,
): readonly string[] {
  if (change.before?.kind === 'template_schedule' || change.after?.kind === 'template_schedule') {
    return schedulePeriodsOf(change, today);
  }
  const dates = [
    change.before === null ? null : financialDateOf(change.before),
    change.after === null ? null : financialDateOf(change.after),
  ].filter((date): date is string => date !== null);
  return [...new Set(dates.map(periodOf))].sort();
}

/**
 * Every financial period the resolved write's source facts touch, ascending.
 *
 * A transfer aggregate legitimately contributes more than one: the transfer's
 * `occurred_on` and its fee's `incurred_on` are independent facts and may fall
 * in different months (ADR 0006 §5; §14 of the slice prompt). Deriving the
 * period from `occurred_on` alone would classify a September transfer carrying
 * an August fee as an ordinary current edit.
 */
export function sourcePeriodsOf(write: ResolvedWrite, today: PlainDate): readonly string[] {
  const periods = new Set<string>();
  for (const change of write.changes) {
    for (const period of periodsOfChange(change, today)) periods.add(period);
  }
  return [...periods].sort();
}

/**
 * Judge a resolved write.
 *
 * The dormancy rule reads `write.dormancy` rather than the dormancy entries in
 * `write.changes`, because it must hold for an operation whose primary source
 * write is an ordinary creation: `acceptSuggestion` materializing a flow onto a
 * dormant account is a first assertion **and** a rewrite of somebody's earlier
 * dormancy assertion, and only the second of those needs review.
 */
export function classifyHistorical(write: ResolvedWrite, today: PlainDate): HistoricalReview {
  const reasons: HistoricalReviewReason[] = [];
  const completed = new Set<string>();

  if (write.revision) {
    for (const change of write.changes) {
      if (change.before !== null && change.before.kind === 'cash_dormancy') continue;
      if (change.after !== null && change.after.kind === 'cash_dormancy') continue;
      for (const period of periodsOfChange(change, today)) {
        if (!isCompletedPeriod(period, today)) continue;
        completed.add(period);
        if (!reasons.includes('completed_source_revision')) {
          reasons.push('completed_source_revision');
        }
      }
    }
  }

  for (const effect of write.dormancy) {
    if (!dormancyChanged(effect)) continue;
    for (const anchor of [effect.before.dormantFrom, effect.after.dormantFrom]) {
      if (anchor === null) continue;
      const period = periodOf(anchor);
      if (!isCompletedPeriod(period, today)) continue;
      completed.add(period);
      if (!reasons.includes('historical_dormancy')) reasons.push('historical_dormancy');
    }
  }

  return {
    required: reasons.length > 0,
    reasons,
    completedPeriods: [...completed].sort(),
  };
}
