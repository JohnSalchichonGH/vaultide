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
import {
  SETTLEMENT_LABEL as INCOME_SETTLEMENT_LABEL,
  incomeKindLabel,
} from '@/features/monthly/income-presentation';

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
 * is identified by its id everywhere that matters — including whether a row
 * changed — and the label is only what the reader sees. Renaming one changes no
 * consent (§75), and two that share a name are never mistaken for each other.
 */

/**
 * What the review knows about one account: its name, and its currency where
 * the caller has it. Currency is only ever used to tell two same-named
 * accounts apart; it is never shown for an account whose name is its own.
 */
export interface AccountLabel {
  readonly name: string;
  readonly currency?: string;
}

/** The account labels a page already holds, by id, for the review. */
export function accountLabelsOf(
  accounts: readonly {
    readonly positionId: string;
    readonly name: string;
    readonly currency: string;
  }[],
): Readonly<Record<string, AccountLabel>> {
  return Object.fromEntries(
    accounts.map((row) => [row.positionId, { name: row.name, currency: row.currency }]),
  );
}

export interface CorrectionLabels {
  readonly accounts: Readonly<Record<string, AccountLabel>>;
  /**
   * Category names by id. A live category's name is unique per user
   * (`categories_user_name_uidx`, partial on `archived_at IS NULL`), and the
   * editors pass live categories only, so two entries here never share a name.
   * An archived or unknown category falls back to "A category" — and whether
   * it changed is decided by its id, never by that fallback (see `compareField`).
   */
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

/**
 * One side of a review row, kept as two things that must not be confused.
 *
 * `value` is the stored fact itself — an id, an exact amount with its currency,
 * an ISO date, an enum code — and it alone decides whether the row changed.
 * `display` is what a person reads, and it may lose information: two accounts
 * can share a name, a label can stand for several codes, a date can be written
 * the same way twice. Deciding "changed" from the display is how a correction
 * that moved a salary between two accounts called Savings once reviewed as
 * nothing having changed at all.
 */
export interface FieldValue {
  readonly value: string | boolean | null | readonly (string | null)[];
  readonly display: string | null;
}

/**
 * Compare one field, semantically, and render it.
 *
 * The order is the rule: equality is decided on the stored facts first, and the
 * words are only attached afterwards. `null` on a side means the fact is absent
 * there — a record that does not exist yet, or a gross amount nobody entered —
 * which is never the same as a zero.
 */
export function compareField(
  label: string,
  before: FieldValue | null,
  after: FieldValue | null,
): FieldChange {
  return {
    label,
    before: before?.display ?? null,
    after: after?.display ?? null,
    changed: JSON.stringify(before?.value ?? null) !== JSON.stringify(after?.value ?? null),
  };
}

const plain = (value: string | null): FieldValue => ({ value, display: value });

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

/* -------------------------------------------------------------------------- */
/* Account names, told apart                                                   */
/* -------------------------------------------------------------------------- */

const UNKNOWN_ACCOUNT = 'An account';

/** What an Account row says when a record names no account at all. */
const NO_ACCOUNT = 'No account chosen yet';

const compactId = (id: string): string => id.replace(/-/gu, '').toLowerCase();

/** The most of an id a label ever shows: eight of a UUID's thirty-two digits. */
const MAX_ID_PREFIX = 8;

/**
 * The shortest prefix, four characters at least, that tells these ids apart —
 * or `null` when none does within `MAX_ID_PREFIX` characters.
 *
 * A length is only accepted while it is shorter than **every** id in the group,
 * so an accepted prefix is never a whole id, whatever shape the ids have.
 */
function distinctPrefixLength(ids: readonly string[]): number | null {
  const shortest = Math.min(...ids.map((id) => compactId(id).length));
  for (let length = 4; length <= MAX_ID_PREFIX && length < shortest; length += 1) {
    if (new Set(ids.map((id) => compactId(id).slice(0, length))).size === ids.length) return length;
  }
  return null;
}

/** One account's name before the review makes every name unique. */
interface PreferredName {
  readonly id: string;
  readonly label: string;
  /** Whether `label` is the account's own name, undecorated. */
  readonly own: boolean;
}

/**
 * Each account's preferred name, by the rules of `accountDisplayNames`.
 *
 * Unique only within a group of accounts that share a name. Across groups a
 * decorated name can still equal another account's own name, because nothing
 * stops a person calling an account "Savings (EUR)" — that is `settle`'s job.
 */
function preferredNames(ids: readonly string[], labels: CorrectionLabels): PreferredName[] {
  const byName = new Map<string, string[]>();
  for (const id of ids) {
    const name = labels.accounts[id]?.name ?? UNKNOWN_ACCOUNT;
    byName.set(name, [...(byName.get(name) ?? []), id]);
  }

  const preferred: PreferredName[] = [];
  for (const [name, group] of byName) {
    if (group.length === 1) {
      preferred.push({ id: group[0] as string, label: name, own: true });
      continue;
    }
    const currencies = group.map((id) => labels.accounts[id]?.currency);
    if (currencies.every((code) => code !== undefined) && new Set(currencies).size === group.length) {
      group.forEach((id, index) =>
        preferred.push({ id, label: `${name} (${currencies[index] as string})`, own: false }),
      );
      continue;
    }
    const length = distinctPrefixLength(group);
    group.forEach((id, index) =>
      preferred.push({
        id,
        label:
          length === null
            ? `${name} (${String(index + 1)} of ${String(group.length)})`
            : `${name} · #${compactId(id).slice(0, length)}`,
        own: false,
      }),
    );
  }
  return preferred;
}

/**
 * Give each account a final name no other account in this review has.
 *
 * Every name handed out is first checked against `taken` and then added to
 * it, so no two accounts can end up with the same one. A preferred name held
 * by one account only is kept. One held by several stays with the account
 * whose own, undecorated name it is — at most one can be, because two accounts
 * with the same own name were decorated as a group — and every other holder
 * takes the first of "name [1]", "name [2]", … that is still free. Those are
 * all different strings and `taken` is finite, so a free one is always found.
 */
function settle(
  preferred: readonly PreferredName[],
  taken: Set<string>,
  display: Map<string, string>,
): void {
  const holders = new Map<string, PreferredName[]>();
  for (const name of preferred) holders.set(name.label, [...(holders.get(name.label) ?? []), name]);

  const displaced: PreferredName[] = [];
  for (const [label, group] of holders) {
    const keeper = group.length === 1 ? group[0] : group.find((name) => name.own);
    for (const name of group) {
      if (name === keeper && !taken.has(label)) {
        taken.add(label);
        display.set(name.id, label);
      } else {
        displaced.push(name);
      }
    }
  }

  for (const name of [...displaced].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    let index = 1;
    while (taken.has(`${name.label} [${String(index)}]`)) index += 1;
    const label = `${name.label} [${String(index)}]`;
    taken.add(label);
    display.set(name.id, label);
  }
}

/**
 * Every account's name as the review shows it (§68).
 *
 * Account names are **not** unique — nothing stops a person having two EUR
 * accounts called Savings — so a name alone cannot tell a reader which account
 * a record left and which it arrived in. An account whose name is its own is
 * shown by that name and nothing more. Where names collide, the whole group is
 * told apart by the least that does it:
 *
 *  1. the currency, when every account in the group has a different one;
 *  2. otherwise a short prefix of each account's id — four to eight of its
 *     digits, as few as keep the group apart, and never a whole id;
 *  3. and when no prefix that short separates the group, the account's place in
 *     it, in id order: "Savings (1 of 2)", "Savings (2 of 2)".
 *
 * Currency cannot do this on its own: a salary moved between two accounts is
 * always moved between two accounts of the salary's own currency.
 *
 * **Every account in the review gets a name no other account in it has.** A
 * name is any text, so one person's account can be called exactly what another
 * account's decoration reads — "Savings (EUR)", "Savings · #6f1c". The last
 * step, `settle`, makes the names unique across the whole review, not just
 * inside each group: the account whose own name it is keeps it, and the others
 * become "Savings (EUR) [1]" and so on.
 *
 * Deterministic, not permanent: the same accounts are always named the same
 * way, but a name can change when an account joins or leaves the review.
 * That is enough for what the names are for — telling apart, inside one
 * review, the accounts that review shows.
 *
 * The accounts the page labelled are named first, from the labels alone, and
 * the ones only the preview mentions afterwards, around them, so a labelled
 * account's name never depends on what else the preview mentions. A review
 * takes all its names from one call, `reviewAccountNames`.
 */
export function accountDisplayNames(
  labels: CorrectionLabels,
  mentioned: Iterable<string>,
): ReadonlyMap<string, string> {
  const labelled = Object.keys(labels.accounts).sort();
  const unlabelled = [...new Set(mentioned)]
    .filter((id) => labels.accounts[id] === undefined)
    .sort();

  // Reserved: a record with no account says so, and an account someone named
  // exactly that must not read like the absence of one.
  const taken = new Set<string>([NO_ACCOUNT]);
  const display = new Map<string, string>();
  settle(preferredNames(labelled, labels), taken, display);
  settle(preferredNames(unlabelled, labels), taken, display);
  return display;
}

/**
 * The one set of account names a review uses, for its table and its sentences
 * alike: every account the page labelled and every account the preview
 * mentions, each with a name no other account in the review has.
 */
export function reviewAccountNames(
  preview: CorrectionPreview,
  labels: CorrectionLabels,
): ReadonlyMap<string, string> {
  return accountDisplayNames(labels, accountsMentioned(preview));
}

/** Every account a preview mentions, source facts and structural changes alike. */
function accountsMentioned(preview: CorrectionPreview): string[] {
  const ids: string[] = [];
  for (const change of preview.sourceChanges) {
    for (const facts of [change.before, change.after]) {
      if (facts === null) continue;
      switch (facts.kind) {
        case 'income':
        case 'expense':
          if (facts.cashPositionId !== null) ids.push(facts.cashPositionId);
          break;
        case 'transfer':
          if (facts.fromPositionId !== null) ids.push(facts.fromPositionId);
          if (facts.toPositionId !== null) ids.push(facts.toPositionId);
          break;
        case 'valuation':
        case 'cash_dormancy':
          ids.push(facts.positionId);
          break;
      }
    }
  }
  for (const change of preview.structuralChanges) {
    if (change.kind === 'valuation_carry' || change.kind === 'dormancy_episode') {
      ids.push(change.positionId);
    }
  }
  return ids;
}

/* -------------------------------------------------------------------------- */
/* The fields                                                                  */
/* -------------------------------------------------------------------------- */

interface FieldContext {
  readonly labels: CorrectionLabels;
  readonly accounts: ReadonlyMap<string, string>;
}

function account(context: FieldContext, id: string | null): FieldValue {
  if (id === null) return { value: null, display: NO_ACCOUNT };
  return { value: id, display: context.accounts.get(id) ?? UNKNOWN_ACCOUNT };
}

function day(context: FieldContext, value: string | null): FieldValue {
  return { value, display: value === null ? null : dayTitle(value, context.labels.locale) };
}

/** An exact amount in its own currency, or absent — never a stand-in zero. */
function money(amount: string | null, currency: string): FieldValue {
  return amount === null
    ? { value: null, display: null }
    : { value: [amount, currency], display: `${amount} ${currency}` };
}

/** One side of a transfer: which account, and exactly how much in its currency. */
function leg(
  context: FieldContext,
  positionId: string | null,
  amount: string,
  currency: string,
): FieldValue {
  return {
    value: [positionId, amount, currency],
    display: `${account(context, positionId).display ?? ''} · ${amount} ${currency}`,
  };
}

function coded(code: string, labels: Readonly<Record<string, string>>): FieldValue {
  return { value: code, display: labels[code] ?? code };
}

function yesNo(value: boolean): FieldValue {
  return { value, display: value ? 'Yes' : 'No' };
}

/**
 * The fields of one source fact, in the order a reader wants them.
 *
 * Every fact a person can revise from a Phase 3 editor has a row here, because
 * the review is the consent: a salary whose only change is its gross amount, or
 * an expense whose only change is its one-off mark, is still a revision of a
 * closed month, and a review that listed nothing as changed would be asking the
 * user to agree to something it did not show them. A balance names its account
 * even though no correction moves it, because a review of several balances is
 * otherwise a list of amounts belonging to nobody. Identity — ids, versions,
 * the scheduled occurrence a row materializes — is never a field here; the only
 * trace of an id a reader sees is the short tie-breaker `accountDisplayNames`
 * adds to two accounts that share a name.
 */
function fieldsOf(facts: SourceFacts, context: FieldContext): Record<string, FieldValue> {
  switch (facts.kind) {
    case 'income':
      return {
        Kind: { value: facts.incomeKind, display: incomeKindLabel(facts.incomeKind) },
        Date: day(context, facts.receivedOn),
        // Net and gross are two facts, and "Amount" beside a gross figure
        // would not say which one it is.
        Net: money(facts.netAmount, facts.currency),
        Gross: money(facts.grossAmount, facts.currency),
        'Paid into': coded(facts.settlement, INCOME_SETTLEMENT_LABEL),
        Account: account(context, facts.cashPositionId),
        Description: plain(facts.description),
      };
    case 'expense':
      return {
        Date: day(context, facts.incurredOn),
        Amount: money(facts.amount, facts.currency),
        Category: {
          value: facts.categoryId,
          display: context.labels.categories[facts.categoryId] ?? 'A category',
        },
        'Paid from': coded(facts.settlement, SETTLEMENT_LABEL),
        Account: account(context, facts.cashPositionId),
        Description: plain(facts.description),
        'One-off': yesNo(facts.isOneOff),
      };
    case 'transfer':
      return {
        Date: day(context, facts.occurredOn),
        From: leg(context, facts.fromPositionId, facts.fromAmount, facts.fromCurrency),
        To: leg(context, facts.toPositionId, facts.toAmount, facts.toCurrency),
        Description: plain(facts.description),
      };
    case 'valuation':
      return {
        Account: account(context, facts.positionId),
        Date: day(context, facts.valuedOn),
        Balance: money(facts.amount, facts.currency),
        Kind: coded(facts.datePrecision, PRECISION_LABEL),
        Note: plain(facts.note),
      };
    case 'cash_dormancy':
      return {
        Account: account(context, facts.positionId),
        Dormant: yesNo(facts.isDormant),
        'Dormant from': day(context, facts.dormantFrom),
      };
  }
}

/**
 * The correction's own source facts, before and after.
 *
 * Only the fields that mean something to a person: no database id, no version,
 * no timestamp and no fingerprint (§68). A row with nothing to show on either
 * side is left out — unless its facts differ, which is never hidden.
 */
export function summarizeSources(
  preview: CorrectionPreview,
  labels: CorrectionLabels,
): readonly SourceSummary[] {
  const context: FieldContext = { labels, accounts: reviewAccountNames(preview, labels) };

  return preview.sourceChanges.map((change) => {
    const facts = change.after ?? change.before;
    const before = change.before === null ? null : fieldsOf(change.before, context);
    const after = change.after === null ? null : fieldsOf(change.after, context);
    const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];

    const fields = keys
      .map((label) => compareField(label, before?.[label] ?? null, after?.[label] ?? null))
      .filter((field) => field.before !== null || field.after !== null || field.changed);

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

/**
 * One sentence per structural consequence, from its canonical identity (§42).
 *
 * `names` is the review's own `reviewAccountNames`, so an account a sentence
 * names reads exactly as it does in the table above it, and no two accounts in
 * the review — labelled or not — are ever named alike.
 */
export function describeStructuralChange(
  change: StructuralChange,
  labels: CorrectionLabels,
  names: ReadonlyMap<string, string>,
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
      const name = names.get(change.positionId) ?? 'This account';
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
      const name = names.get(change.positionId) ?? 'This account';
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
