import type {
  ActionResult,
  ConfirmCorrectionResult,
  CorrectionPreview,
  CurrentPeriodImpact,
  CurrentPeriodState,
  ImpactTag,
  PeriodImpact,
  SourceFacts,
  StructuralChange,
} from '@vaultide/application';
import { dayTitle, monthTitle } from '@/features/monthly/presentation';

/**
 * Turning a correction preview into something a person can read (blueprint
 * 15.3, 16.6; §68–§69 of the slice prompt).
 *
 * Pure, and deliberately so: every sentence here is a function of the server's
 * own semantic result, and none of it computes a financial fact. The browser
 * renders what the correction touches, which months are recalculated and which
 * structural facts move — it does not work out any of them for itself (§84).
 *
 * Names are resolved for readability and nothing else. A category or an account
 * is identified by its id everywhere that matters; the label is what the reader
 * sees, and renaming one changes no consent (§75).
 */

export interface CorrectionLabels {
  readonly accounts: Readonly<Record<string, string>>;
  readonly categories: Readonly<Record<string, string>>;
  readonly locale: string;
}

/* -------------------------------------------------------------------------- */
/* The source                                                                  */
/* -------------------------------------------------------------------------- */

/** One row of the before → after table: a field, and what it says either side. */
export interface FieldChange {
  readonly label: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly changed: boolean;
}

export interface SourceSummary {
  readonly title: string;
  readonly operation: 'create' | 'update' | 'delete';
  readonly fields: readonly FieldChange[];
}

const SETTLEMENT_LABEL: Readonly<Record<string, string>> = {
  tracked_cash: 'From a tracked account',
  untracked_self: 'Paid from outside tracked accounts',
  third_party: 'Paid by somebody else',
  external: 'Outside tracked accounts',
  reinvested: 'Reinvested',
  deducted_from_asset: 'Deducted from an asset',
};

const PRECISION_LABEL: Readonly<Record<string, string>> = {
  exact: 'Snapshot',
  month_end: 'Statement balance',
};

const KIND_TITLE: Readonly<Record<SourceFacts['kind'], string>> = {
  income: 'Income',
  expense: 'Expense',
  transfer: 'Transfer',
  valuation: 'Balance',
  cash_dormancy: 'Dormant period',
};

function accountName(labels: CorrectionLabels, id: string | null): string | null {
  if (id === null) return 'No account chosen yet';
  return labels.accounts[id] ?? 'An account';
}

function day(labels: CorrectionLabels, value: string | null): string | null {
  return value === null ? null : dayTitle(value, labels.locale);
}

/** The fields of one source fact, in the order a reader wants them. */
function fieldsOf(facts: SourceFacts, labels: CorrectionLabels): Record<string, string | null> {
  switch (facts.kind) {
    case 'income':
      return {
        Date: day(labels, facts.receivedOn),
        Amount: `${facts.netAmount} ${facts.currency}`,
        'Paid into': SETTLEMENT_LABEL[facts.settlement] ?? facts.settlement,
        Account: accountName(labels, facts.cashPositionId),
        Description: facts.description,
      };
    case 'expense':
      return {
        Date: day(labels, facts.incurredOn),
        Amount: `${facts.amount} ${facts.currency}`,
        Category: labels.categories[facts.categoryId] ?? 'A category',
        'Paid from': SETTLEMENT_LABEL[facts.settlement] ?? facts.settlement,
        Account: accountName(labels, facts.cashPositionId),
        Description: facts.description,
      };
    case 'transfer':
      return {
        Date: day(labels, facts.occurredOn),
        From: `${accountName(labels, facts.fromPositionId) ?? ''} · ${facts.fromAmount} ${facts.fromCurrency}`,
        To: `${accountName(labels, facts.toPositionId) ?? ''} · ${facts.toAmount} ${facts.toCurrency}`,
        Description: facts.description,
      };
    case 'valuation':
      return {
        Date: day(labels, facts.valuedOn),
        Balance: `${facts.amount} ${facts.currency}`,
        Kind: PRECISION_LABEL[facts.datePrecision] ?? facts.datePrecision,
        Note: facts.note,
      };
    case 'cash_dormancy':
      return {
        Account: accountName(labels, facts.positionId),
        Dormant: facts.isDormant ? 'Yes' : 'No',
        'Dormant from': day(labels, facts.dormantFrom),
      };
  }
}

/**
 * The correction's own source facts, before and after.
 *
 * Only the fields that mean something to a person: no database id, no version,
 * no timestamp and no fingerprint (§68).
 */
export function summarizeSources(
  preview: CorrectionPreview,
  labels: CorrectionLabels,
): readonly SourceSummary[] {
  return preview.sourceChanges.map((change) => {
    const facts = change.after ?? change.before;
    const before = change.before === null ? null : fieldsOf(change.before, labels);
    const after = change.after === null ? null : fieldsOf(change.after, labels);
    const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];

    const fields = keys
      .map((label) => ({
        label,
        before: before?.[label] ?? null,
        after: after?.[label] ?? null,
        changed: (before?.[label] ?? null) !== (after?.[label] ?? null),
      }))
      .filter((field) => field.before !== null || field.after !== null);

    return { title: KIND_TITLE[facts.kind], operation: change.operation, fields };
  });
}

/* -------------------------------------------------------------------------- */
/* Periods                                                                     */
/* -------------------------------------------------------------------------- */

export interface PeriodSummary {
  readonly month: string;
  readonly title: string;
  readonly kind: 'completed' | 'current';
  /** Whether the correction's own records belong to this month (§68). */
  readonly isSource: boolean;
  readonly tags: readonly ImpactTag[];
  /** One sentence about the month-to-date evidence date, for the current month. */
  readonly note: string | null;
}

export const IMPACT_TAG_LABEL: Readonly<Record<ImpactTag, string>> = {
  reconciliation: 'Reconciliation',
  spending: 'Spending',
  savings: 'Savings',
  income: 'Income',
  categories: 'Categories',
  memo: 'Information only',
};

/**
 * What to say about the current month's evidence date (§69).
 *
 * Four real transitions, and each says the thing the user needs rather than
 * naming the engine's states: the date moved, it went away, it appeared, or it
 * has not moved and the record they are editing lies past it.
 */
export function currentMonthNote(
  period: CurrentPeriodImpact,
  labels: CorrectionLabels,
  sourceIsAfterAsOf: boolean,
): string | null {
  const { before, after } = period;
  const named = (state: CurrentPeriodState): string | null =>
    state.kind === 'tracked_interval' ? dayTitle(state.asOf, labels.locale) : null;

  if (before.kind === 'tracked_interval' && after.kind === 'no_tracked_interval') {
    return `${monthTitle(period.month, labels.locale)} will no longer have a common month-to-date balance date, so tracked month-to-date figures will be unavailable until every account shares one again.`;
  }
  if (before.kind === 'no_tracked_interval' && after.kind === 'tracked_interval') {
    return `${monthTitle(period.month, labels.locale)} gets a common month-to-date balance date of ${named(after) ?? ''}.`;
  }
  if (
    before.kind === 'tracked_interval' &&
    after.kind === 'tracked_interval' &&
    before.asOf !== after.asOf
  ) {
    return `Month-to-date figures now reach ${named(after) ?? ''} instead of ${named(before) ?? ''}.`;
  }
  if (sourceIsAfterAsOf && after.kind === 'tracked_interval') {
    return `This record belongs to ${monthTitle(period.month, labels.locale)}, but its month-to-date figures currently reach only ${named(after) ?? ''}, so those figures do not change yet.`;
  }
  return null;
}

/** The financial date of a source fact, for the "after `D`" note above. */
function financialDateOf(facts: SourceFacts): string | null {
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
      return facts.dormantFrom;
  }
}

export function summarizePeriods(
  preview: CorrectionPreview,
  labels: CorrectionLabels,
): readonly PeriodSummary[] {
  const sources = new Set(preview.sourcePeriods);

  return preview.periods.map((period: PeriodImpact) => {
    const base = {
      month: period.month,
      title: monthTitle(period.month, labels.locale),
      isSource: sources.has(period.month),
      tags: period.tags,
    };
    if (period.kind === 'completed') return { ...base, kind: 'completed' as const, note: null };

    const asOf = period.after.kind === 'tracked_interval' ? period.after.asOf : null;
    const afterAsOf =
      asOf !== null &&
      preview.sourceChanges.some((change) => {
        const date = change.after === null ? null : financialDateOf(change.after);
        return date !== null && date > asOf && date.startsWith(period.month);
      });

    return {
      ...base,
      kind: 'current' as const,
      note: currentMonthNote(period, labels, afterAsOf),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Structural changes                                                          */
/* -------------------------------------------------------------------------- */

const STATUS_WORD: Readonly<Record<string, string>> = {
  reliable: 'reliable',
  estimated: 'estimated',
  provisional: 'provisional',
  unresolved: 'unresolved',
  unavailable: 'unavailable',
};

const COMPLETENESS_WORD: Readonly<Record<string, string>> = {
  sufficient: 'complete',
  partial: 'partly complete',
  incomplete: 'incomplete',
  stale: 'stale',
};

/** One sentence per structural consequence, from its canonical identity (§42). */
export function describeStructuralChange(
  change: StructuralChange,
  labels: CorrectionLabels,
): string {
  switch (change.kind) {
    case 'span':
      return change.change === 'appeared'
        ? `A combined ${change.currency} period from ${dayTitle(change.from, labels.locale)} to ${dayTitle(change.to, labels.locale)} appears.`
        : `The combined ${change.currency} period from ${dayTitle(change.from, labels.locale)} to ${dayTitle(change.to, labels.locale)} disappears.`;
    case 'month_status':
      return `${monthTitle(change.month, labels.locale)} becomes ${STATUS_WORD[change.after] ?? change.after} instead of ${STATUS_WORD[change.before] ?? change.before}.`;
    case 'bucket_status':
      return change.after === null
        ? `${change.currency} is no longer reconciled in ${monthTitle(change.month, labels.locale)}.`
        : change.before === null
          ? `${change.currency} starts being reconciled in ${monthTitle(change.month, labels.locale)}, as ${STATUS_WORD[change.after] ?? change.after}.`
          : `${change.currency} in ${monthTitle(change.month, labels.locale)} becomes ${STATUS_WORD[change.after] ?? change.after} instead of ${STATUS_WORD[change.before] ?? change.before}.`;
    case 'completeness':
      return change.after === null
        ? `${monthTitle(change.month, labels.locale)} no longer reports completeness.`
        : `${monthTitle(change.month, labels.locale)} becomes ${COMPLETENESS_WORD[change.after.state] ?? change.after.state} (${String(change.after.satisfied)} of ${String(change.after.required)}).`;
    case 'issue':
      return change.change === 'appeared'
        ? `${monthTitle(change.month, labels.locale)} raises a new reconciliation issue.`
        : `A reconciliation issue in ${monthTitle(change.month, labels.locale)} clears.`;
    case 'valuation_carry': {
      const name = labels.accounts[change.positionId] ?? 'This account';
      if (change.after === null) {
        return `${name} no longer carries a balance from ${dayTitle((change.before as { from: string }).from, labels.locale)}.`;
      }
      return `${name} carries this balance from ${dayTitle(change.after.from, labels.locale)}${
        change.after.to === null
          ? ' onwards'
          : ` until ${dayTitle(change.after.to, labels.locale)}`
      }.`;
    }
    case 'dormancy_episode': {
      const name = labels.accounts[change.positionId] ?? 'This account';
      if (change.before === null) {
        return `${name} becomes dormant from ${dayTitle(change.after as string, labels.locale)}, so months from then on carry it at zero.`;
      }
      if (change.after === null) {
        return `${name} is no longer dormant from ${dayTitle(change.before, labels.locale)}, so those months stop carrying it at zero.`;
      }
      return `${name}’s dormant period moves from ${dayTitle(change.before, labels.locale)} to ${dayTitle(change.after, labels.locale)}.`;
    }
  }
}

/** Whether the correction rewrites a dormant period, which deserves saying plainly. */
export function rewritesDormancy(preview: CorrectionPreview): boolean {
  return preview.structuralChanges.some((change) => change.kind === 'dormancy_episode');
}

/* -------------------------------------------------------------------------- */
/* What a Confirm answered                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The three things Confirm can mean, as one value (§70, §114).
 *
 * `impact_changed` is **not** an error and is deliberately not shaped like one:
 * nothing was written, the draft is still perfectly valid, and what the dialog
 * has to do is show the fresh impact and ask again. A version conflict is a
 * different thing and says so — the record moved, so reloading is the way
 * forward, not confirming harder.
 *
 * Pure, and the reason the dialog keeps the user's typed explanation across an
 * `impact_changed` is visible here: there is no arm that carries one, so no
 * arm can clear one.
 */
export type ReviewOutcome =
  | { readonly kind: 'committed' }
  | { readonly kind: 'stale'; readonly preview: CorrectionPreview }
  | { readonly kind: 'error'; readonly message: string; readonly conflict: boolean };

export function interpretConfirm(
  result: ActionResult<ConfirmCorrectionResult>,
): ReviewOutcome {
  if (!result.ok) {
    return {
      kind: 'error',
      message: result.error.message,
      conflict: result.error.code === 'CONFLICT_VERSION',
    };
  }
  return result.data.status === 'impact_changed'
    ? { kind: 'stale', preview: result.data.preview }
    : { kind: 'committed' };
}
