import type {
  CompletenessStateDto,
  MissingReportingContributionDto,
  ReconciliationIssueDto,
  ReconciliationStatusDto,
} from '@vaultide/application';

/**
 * How the Monthly page presents what the reads returned (blueprint 8.4, 8.5,
 * 12.6, 15.3).
 *
 * Words and grouping, and nothing else: no figure is computed here and no issue
 * trigger is re-derived. Every issue this receives was raised by the engine, and
 * every class it shows is the one the server attached from the catalogue.
 *
 * Dismissal is applied here and only here. The reads return every issue they
 * raised; the page hides an advisory **key** the user dismissed for the month,
 * because `month_reviews.dismissed_issues` stores keys (6.2) — so a dismissal
 * hides every instance of that key, and the control that makes it is one per
 * key, never one per instance. A blocking or informational issue is never
 * hidden, whatever the stored keys say.
 */

export type IssueClass = ReconciliationIssueDto['class'];

/** One advisory, blocking or informational key, with every instance raised this month. */
export interface IssueGroup {
  readonly key: string;
  readonly issueClass: IssueClass;
  readonly title: string;
  readonly summary: string;
  readonly instances: readonly ReconciliationIssueDto[];
  /** `true` for an advisory: the one kind a user may hide, key by key. */
  readonly dismissable: boolean;
  /**
   * `true` when the key's instances do not all mean the same thing — one
   * currency's `unexplained_inflow` reading A and another's reading B (8.5,
   * 30.11). The group's own words are then neutral, and each instance says
   * which reading it is.
   */
  readonly variantsDiffer: boolean;
}

export interface IssuePresentation {
  /** Blocking first, then advisories, then information; each in the order raised. */
  readonly active: readonly IssueGroup[];
  /** Advisory keys raised this month that the user dismissed for it. */
  readonly dismissed: readonly IssueGroup[];
}

const CLASS_ORDER: Readonly<Record<IssueClass, number>> = { blocking: 0, advisory: 1, info: 2 };

/**
 * Group a month's issues by key and set the dismissed advisory keys aside.
 *
 * A stored key that nothing raised this month is not an issue and is not shown:
 * it simply stays stored. A stored key that names a blocking or informational
 * issue is ignored — those are never dismissable.
 */
export function presentIssues(
  issues: readonly ReconciliationIssueDto[],
  dismissedKeys: readonly string[],
): IssuePresentation {
  const byKey = new Map<string, ReconciliationIssueDto[]>();
  for (const issue of issues) {
    const list = byKey.get(issue.key);
    if (list === undefined) byKey.set(issue.key, [issue]);
    else list.push(issue);
  }

  const groups: IssueGroup[] = [...byKey.entries()].map(([key, instances]) => {
    const first = instances[0] as ReconciliationIssueDto;
    // One key, one group, one control — however its instances read. Only the
    // words change when they read differently: the group's become neutral and
    // each instance carries its own.
    const variantsDiffer = new Set(instances.map((instance) => instance.variant)).size > 1;
    return {
      key,
      issueClass: first.class,
      title: variantsDiffer ? neutralTitle(key) : issueTitle(first),
      summary: variantsDiffer ? neutralSummary(key) : issueSummary(first),
      instances,
      dismissable: first.class === 'advisory',
      variantsDiffer,
    };
  });

  // A stable sort: groups of one class keep the order the engine raised them in.
  const ordered = groups.sort((a, b) => CLASS_ORDER[a.issueClass] - CLASS_ORDER[b.issueClass]);
  const dismissed = new Set(dismissedKeys);
  const isDismissed = (group: IssueGroup): boolean => group.dismissable && dismissed.has(group.key);

  return {
    active: ordered.filter((group) => !isDismissed(group)),
    dismissed: ordered.filter(isDismissed),
  };
}

/** A readable name for a key this version has no words for yet. */
function fallbackTitle(key: string): string {
  const words = key.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A key's name when its instances read differently. `unexplained_inflow` is
 * the one key with readings in Phase 3: the name has to cover cash growing more
 * than the records explain *and* known expenses exceeding the cash that left.
 */
function neutralTitle(key: string): string {
  return key === 'unexplained_inflow' ? 'Cash and records disagree' : fallbackTitle(key);
}

function neutralSummary(key: string): string {
  return key === 'unexplained_inflow'
    ? 'In each currency below, the recorded flows and the change in cash cannot both be right. Each one says which way they disagree.'
    : 'Vaultide raised this more than one way for the month; each instance below says how.';
}

/** The issue's name, in the blueprint's own meaning (8.5, 30.11 for the two variants). */
export function issueTitle(issue: Pick<ReconciliationIssueDto, 'key' | 'variant'>): string {
  switch (issue.key) {
    case 'missing_month_end':
      return 'Month-end balance missing';
    case 'first_balance':
      return 'First balance this month';
    case 'flow_without_cash_account':
      return 'Flow without a cash account';
    case 'unexplained_inflow':
      return issue.variant === 'b'
        ? 'Known expenses exceed the cash that left'
        : 'Cash grew more than your records explain';
    case 'possible_missing_conversion':
      return 'Possible unrecorded currency conversion';
    case 'possible_missing_interest':
      return 'Possible unrecorded interest';
    case 'suggested_income_missing':
      return 'Expected income not recorded';
    case 'large_unclassified':
      return 'Unusually large unclassified spending';
    case 'mtd_no_common_date':
      return 'No common balance date';
    case 'mtd_newer_balances':
      return 'Some accounts have newer balances';
    default:
      return fallbackTitle(issue.key);
  }
}

/** What the issue means for the month, and — where there is one — what would resolve it. */
export function issueSummary(issue: Pick<ReconciliationIssueDto, 'key' | 'variant'>): string {
  switch (issue.key) {
    case 'missing_month_end':
      return 'Without a statement balance at the end of the month, and at the end of the month before, spending in this currency cannot be inferred. Enter the month-end balance, confirm a last-day snapshot as the statement balance, or confirm the balance did not change.';
    case 'first_balance':
      return 'This account started being tracked this month, so its earlier movements are not part of the month’s spending.';
    case 'flow_without_cash_account':
      return 'A flow in this currency names no cash account, and no cash account of that currency took part in the month. Choose the account, or add it.';
    case 'unexplained_inflow':
      return issue.variant === 'b'
        ? 'Recorded expenses are more than the cash that left. An inflow may be missing, or an expense was paid from outside your tracked accounts.'
        : 'Your cash grew by more than the recorded flows explain. An income or a transfer in may be missing.';
    case 'possible_missing_conversion':
      return 'One currency gained cash nobody recorded while another lost about as much. That is the shape of a transfer between currencies that was never recorded.';
    case 'possible_missing_interest':
      return 'A savings account grew slightly more than its recorded flows explain — possibly interest that was not recorded.';
    case 'suggested_income_missing':
      return 'A recurring income was expected this month and nothing records it yet. Hiding this advisory does not skip the income or record it: it stays expected, and completeness still counts it.';
    case 'large_unclassified':
      return 'This month’s unclassified spending is more than twice the median of recent reliable months.';
    case 'mtd_no_common_date':
      return 'Update all cash accounts to the same date to calculate month-to-date spending.';
    case 'mtd_newer_balances':
      return 'Some accounts have newer individual balances; update all accounts to move the month-to-date date forward.';
    default:
      return 'Vaultide raised this for the month.';
  }
}

export const ISSUE_CLASS_LABEL: Readonly<Record<IssueClass, string>> = {
  blocking: 'Blocking',
  advisory: 'Advisory',
  info: 'Info',
};

export const ISSUE_CLASS_TONE = {
  blocking: 'negative',
  advisory: 'warning',
  info: 'neutral',
} as const satisfies Record<IssueClass, string>;

/* -------------------------------------------------------------------------- */
/* Statuses                                                                    */
/* -------------------------------------------------------------------------- */

export const STATUS_LABEL: Readonly<Record<ReconciliationStatusDto, string>> = {
  reliable: 'Reliable',
  estimated: 'Estimated',
  provisional: 'Provisional',
  unavailable: 'Unavailable',
  unresolved: 'Unresolved',
};

export const STATUS_TONE = {
  reliable: 'positive',
  estimated: 'info',
  provisional: 'info',
  unavailable: 'unavailable',
  unresolved: 'negative',
} as const satisfies Record<ReconciliationStatusDto, string>;

/**
 * What a status means to the person reading it (8.4).
 *
 * `unavailable` stays generic on purpose. At month level it is the worst of
 * several buckets, and a bucket is unavailable for more than one reason — a
 * missing statement, a missing opening, a flow with no cash account, or no
 * account left to reconcile — so the month's status alone cannot say which.
 * Each bucket says its own cause (`unavailableCauseOf`).
 */
export const STATUS_MEANING: Readonly<Record<ReconciliationStatusDto, string>> = {
  reliable: 'Every account has its evidence and the records explain the cash.',
  estimated:
    'An account started being tracked this month; its earlier movements are not included.',
  provisional: 'Measured to the latest date every account shares; the month is not over.',
  unavailable: 'At least one currency cannot be reconciled; see the issues.',
  unresolved: 'The records and the balances contradict each other; see the issues.',
};

/** Why one bucket could not be reconciled, as far as its own evidence says. */
export type UnavailableCause =
  | 'missing_opening'
  | 'missing_month_end'
  | 'flow_without_cash_account'
  | 'first_balance'
  | 'unknown';

/**
 * The cause of an unavailable bucket, read off the bucket itself.
 *
 * Never inferred from the status: an unavailable bucket is only a bucket the
 * arithmetic could not run for, and both engines already record why — the
 * month-to-date one in `reason`, both in the issues they raised. The order is
 * fixed rather than whichever issue came first, and it is the order the
 * reporting read gives a residual's missing cause, so a bucket and the figures
 * built on it name the same one. Nothing here decides whether an issue applies.
 */
export function unavailableCauseOf(bucket: {
  readonly status: ReconciliationStatusDto;
  readonly reason?: string | null;
  readonly issues: readonly Pick<ReconciliationIssueDto, 'key'>[];
}): UnavailableCause | null {
  if (bucket.status !== 'unavailable') return null;
  const raised = (key: string): boolean => bucket.issues.some((issue) => issue.key === key);
  if (bucket.reason === 'missing_opening') return 'missing_opening';
  if (raised('missing_month_end')) return 'missing_month_end';
  if (raised('flow_without_cash_account')) return 'flow_without_cash_account';
  if (raised('first_balance')) return 'first_balance';
  return 'unknown';
}

/** A bucket's cause, as the sentence under its heading. */
export const UNAVAILABLE_CAUSE_MEANING: Readonly<Record<UnavailableCause, string>> = {
  missing_month_end:
    'An account has no statement balance for the end of this month or of the month before, so spending in this currency cannot be inferred.',
  missing_opening:
    'An account of this currency has no usable opening balance, so it cannot be reconciled through the common date.',
  flow_without_cash_account:
    'A flow in this currency names no cash account, and no cash account of this currency took part, so there is nothing to reconcile it against.',
  first_balance:
    'Every account of this currency was first tracked this month, so there is nothing to reconcile yet.',
  unknown: 'This currency could not be reconciled; see the issues.',
};

/** A bucket's cause, as the reason a figure it could not compute is missing. */
export const UNAVAILABLE_FIGURE_REASON: Readonly<Record<UnavailableCause, string>> = {
  missing_month_end: 'a month-end balance is missing — see the issues.',
  missing_opening: 'an opening balance is missing — see the issues.',
  flow_without_cash_account: 'a flow has no cash account to reconcile against — see the issues.',
  first_balance: 'no account of this currency is in the month’s arithmetic yet.',
  unknown: 'this currency could not be reconciled — see the issues.',
};

export const COMPLETENESS_LABEL: Readonly<Record<CompletenessStateDto, string>> = {
  sufficient: 'Sufficient',
  partial: 'Partial',
  incomplete: 'Incomplete',
  stale: 'Stale',
};

export const COMPLETENESS_TONE = {
  sufficient: 'positive',
  partial: 'warning',
  incomplete: 'negative',
  stale: 'unavailable',
} as const satisfies Record<CompletenessStateDto, string>;

/** What each completeness state says about the month (12.6, v2.1.15 30.18). */
export function completenessMeaning(state: CompletenessStateDto, required: number): string {
  switch (state) {
    case 'stale':
      return 'No balance was recorded inside this month for any account or asset.';
    case 'incomplete':
      return 'At least one cash account has no month-end balance, and did not close, this month.';
    case 'partial':
      return 'Every cash account is covered, but a scheduled recurring item has no flow or skip.';
    case 'sufficient':
      return required === 0
        ? 'Nothing was required this month.'
        : 'Every requirement for the month is satisfied.';
  }
}

/** A cash requirement's evidence, in words. */
export const CLOSE_STATE_LABEL: Readonly<Record<string, string>> = {
  month_end: 'Statement balance',
  closed_zero: 'Closed this month',
  dormant_zero: 'Dormant (0)',
  carried: 'No statement — an earlier balance only',
  missing: 'No balance recorded',
  opened_zero: 'Opened this month (0)',
  first_balance: 'First balance',
};

/** A month-to-date account's value at the common date, in words. */
export const AS_OF_STATE_LABEL: Readonly<Record<string, string>> = {
  snapshot: 'Snapshot',
  closed_zero: 'Closed (0)',
  dormant_zero: 'Dormant (0)',
  absent: 'Not needed',
};

export function stateLabel(labels: Readonly<Record<string, string>>, state: string): string {
  return labels[state] ?? fallbackTitle(state);
}

/* -------------------------------------------------------------------------- */
/* Availability                                                                */
/* -------------------------------------------------------------------------- */

/** Why a contribution is not inside a reporting figure, in words (7.6, 12.5, 30.16). */
export function missingReason(item: Pick<MissingReportingContributionDto, 'reason' | 'detail'>): string {
  switch (item.reason) {
    case 'fx_missing':
      return 'no exchange rate';
    case 'missing_month_end':
      return 'a month-end balance is missing';
    case 'missing_opening':
      return 'no usable opening balance';
    case 'not_applicable':
      switch (item.detail) {
        case 'unresolved':
          return 'the records contradict the balances';
        case 'flow_without_cash_account':
          return 'a flow has no cash account';
        case 'first_balance':
          return 'an account was first tracked this month';
        default:
          return 'spending could not be inferred';
      }
    default:
      return item.reason.replaceAll('_', ' ');
  }
}

/** Each missing contribution once, as "USD (no exchange rate)". */
export function missingSummary(missing: readonly MissingReportingContributionDto[]): string {
  const parts = new Set(missing.map((item) => `${item.currency} (${missingReason(item)})`));
  return [...parts].join(', ');
}

/**
 * Why a savings rate could not be stated, in words.
 *
 * The rate is a quotient and never partial (12.5): it is `divide_by_zero` when
 * there was no income, and `not_applicable` — with the side that was incomplete
 * in `detail` — when either aggregate could not be stated in full.
 */
export function savingsRateReason(reason: string, detail?: string): string {
  if (reason === 'divide_by_zero') return 'There was no income this month to measure it against.';
  if (reason === 'not_applicable' && detail !== undefined) {
    const sentence = detail.charAt(0).toUpperCase() + detail.slice(1);
    return sentence.endsWith('.') ? sentence : `${sentence}.`;
  }
  return 'A figure it depends on could not be stated in full.';
}

/* -------------------------------------------------------------------------- */
/* Months and days                                                             */
/* -------------------------------------------------------------------------- */

const MONTH_PATTERN = /^(\d{4})-(\d{2})$/u;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

/**
 * "September 2026" for `2026-09`.
 *
 * Formatting only: the month is fixed by the server, and the date built here is
 * pinned to UTC so no browser timezone can move it into a neighbouring month.
 */
export function monthTitle(month: string, locale: string): string {
  const match = MONTH_PATTERN.exec(month);
  if (match === null) return month;
  const date = new Date(
    Date.UTC(Number.parseInt(match[1] as string, 10), Number.parseInt(match[2] as string, 10) - 1, 1),
  );
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    date,
  );
}

/** "6 Sep 2026" for `2026-09-06`, pinned to UTC for the same reason. */
export function dayTitle(day: string, locale: string): string {
  const match = DAY_PATTERN.exec(day);
  if (match === null) return day;
  const date = new Date(
    Date.UTC(
      Number.parseInt(match[1] as string, 10),
      Number.parseInt(match[2] as string, 10) - 1,
      Number.parseInt(match[3] as string, 10),
    ),
  );
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/** Is `value` a month the Monthly page may open: well-formed and not after the current month? */
export function isOpenableMonth(value: string, current: string): boolean {
  const match = MONTH_PATTERN.exec(value);
  if (match === null) return false;
  const month = Number.parseInt(match[2] as string, 10);
  // Both are `YYYY-MM`, so the string order is the calendar order.
  return month >= 1 && month <= 12 && value <= current;
}

/**
 * Should a key press be left alone rather than treated as a month shortcut?
 *
 * Anything that takes text — an input, a text area, a select, an editable
 * region — owns its keys; so does any press with a modifier.
 */
export function isEditableTarget(target: {
  readonly tagName?: string;
  readonly isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
} | null): boolean {
  if (target === null) return false;
  if (target.isContentEditable === true) return true;
  const tag = (target.tagName ?? '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return typeof target.closest === 'function' && target.closest('[contenteditable="true"]') !== null;
}
