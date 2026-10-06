import type {
  IncomeMissingFlagDto,
  IncomeSourceDto,
  IncomeSourceOccurrenceDto,
  IncomeSourcePageDto,
} from '@vaultide/application';
import type { MoneyDto } from '@vaultide/finance/client';
import { EXPENSE_FREQUENCIES } from '@/features/monthly/expenses-presentation';
import { SKIP_REASON_LABEL } from '@/features/monthly/income-presentation';
import {
  ARCHIVED_SOURCE_REASON,
  missingFlagLink,
  occurrenceHref,
  paymentHref,
  type MissingFlagLink,
} from '@/features/income/presentation';

/**
 * How an income source's page says what its read returned (blueprint 15.2
 * "Income source", v2.1.20 30.23; ADR 0012 D2–D4).
 *
 * Words, links and display decisions — never a financial figure and never a
 * schedule. Every occurrence arrives with its state decided, and every amount
 * is one that was recorded or set.
 */

/* -------------------------------------------------------------------------- */
/* Details                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What a source with no account says (§30.9 item 1). Its payments are tracked
 * cash awaiting attribution — a template materializes tracked cash only — so
 * it must never read as income outside tracked accounts.
 */
export const NO_ACCOUNT =
  'Not attributed yet. Its payments count as money into your tracked accounts, waiting to be given an account — not as income outside them.';

/** "Every month, on day 25" — the labels both source forms use. */
export function scheduleText(source: Pick<IncomeSourceDto, 'frequency' | 'dayOfMonth' | 'startDate'>): string {
  const every = EXPENSE_FREQUENCIES.find((option) => option.value === source.frequency)?.label ?? source.frequency;
  // 6.2: with no day of its own, the schedule takes the start date's day.
  const day = source.dayOfMonth ?? Number.parseInt(source.startDate.slice(8, 10), 10);
  const clamped = day > 28 ? ', or the last day of a shorter month' : '';
  return `${every}, on day ${String(day)}${clamped}`;
}

/* -------------------------------------------------------------------------- */
/* Editing (20.3)                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Whether an open editor takes in a newer stored copy of the source.
 *
 * A server action's response can bring a fresh page while a form is open. The
 * form takes it in only while nothing holds it — no change typed, no save
 * refused, none running. Otherwise its save still claims the version it opened
 * with, and only Reload moves it: a newer copy is never a reason to discard what
 * the user typed, nor a licence to save it over what changed elsewhere.
 */
export const adoptsNewerSource = (args: {
  readonly base: Pick<IncomeSourceDto, 'version'>;
  readonly latest: Pick<IncomeSourceDto, 'version'>;
  readonly held: boolean;
}): boolean => args.latest.version !== args.base.version && !args.held;

/** A refused save, or one that met a newer version: the server's message, as it came. */
export interface EditProblem {
  readonly kind: 'refused' | 'conflict';
  readonly message: string;
}

export function editProblemOf(error: { readonly code: string; readonly message: string }): EditProblem {
  return {
    kind: error.code === 'CONFLICT_VERSION' || error.code === 'CONFLICT_DUPLICATE' ? 'conflict' : 'refused',
    message: error.message,
  };
}

export interface DetailsForm {
  readonly name: string;
  readonly payer: string;
}

export const detailsFormOf = (source: Pick<IncomeSourceDto, 'name' | 'counterparty'>): DetailsForm => ({
  name: source.name,
  payer: source.counterparty ?? '',
});

const payerOf = (form: DetailsForm): string | null => (form.payer.trim() === '' ? null : form.payer.trim());

export const detailsUnchanged = (base: Pick<IncomeSourceDto, 'name' | 'counterparty'>, form: DetailsForm): boolean =>
  form.name.trim() === base.name && payerOf(form) === base.counterparty;

/** The name-and-payer save, claiming the stored source the form opened with. */
export function detailsPayload(base: Pick<IncomeSourceDto, 'templateId' | 'version'>, form: DetailsForm) {
  return {
    templateId: base.templateId,
    expectedVersion: base.version,
    name: form.name.trim(),
    counterparty: payerOf(form),
  };
}

/* -------------------------------------------------------------------------- */
/* Archiving                                                                   */
/* -------------------------------------------------------------------------- */

/** What archiving does, said before it applies (§30.10 item 2; ADR 0012 D4). */
export const ARCHIVE_CONSEQUENCES = [
  'No new payments are suggested for it.',
  'Past missing payments cannot be recorded or skipped until it is unarchived.',
  'Every payment and skip already recorded stays.',
] as const;

export const UNARCHIVE_NOTE = 'Unarchiving suggests its payments again. Nothing recorded changes.';

/**
 * Whether "Change the amount from…" is offered: only while the source is
 * active, as Monthly hides "Change future amount" for an archived one.
 */
export const canChangeAmount = (source: Pick<IncomeSourceDto, 'archived'>): boolean => !source.archived;

/* -------------------------------------------------------------------------- */
/* Gross (ADR 0012 D3)                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Whether a table shows gross, and how many payments in it have none.
 *
 * Gross appears only when some term or payment in view records one. "Without
 * gross" counts payments only: a term with no gross simply shows none.
 */
export function grossInView(args: {
  readonly terms: readonly (MoneyDto | null)[];
  readonly payments: readonly (MoneyDto | null)[];
}): { readonly show: boolean; readonly withoutGross: number } {
  return {
    show: [...args.terms, ...args.payments].some((gross) => gross !== null),
    withoutGross: args.payments.filter((gross) => gross === null).length,
  };
}

/** The gross in view in the year's occurrence table: payments as received, and the terms of those still expected. */
export function occurrencesGross(occurrences: readonly IncomeSourceOccurrenceDto[]) {
  return grossInView({
    terms: occurrences.flatMap((row) =>
      row.state.kind === 'missing' || row.state.kind === 'not_yet_due' ? [row.term.gross] : [],
    ),
    payments: occurrences.flatMap((row) => (row.state.kind === 'received' ? [row.state.payment.gross] : [])),
  });
}

/** The gross in view in the amount history: every term and every payment. */
export function historyGross(page: Pick<IncomeSourcePageDto, 'terms' | 'arrivals'>) {
  return grossInView({
    terms: page.terms.map((row) => row.gross),
    payments: page.arrivals.map((row) => row.payment.gross),
  });
}

/* -------------------------------------------------------------------------- */
/* Occurrences                                                                 */
/* -------------------------------------------------------------------------- */

export const OCCURRENCE_STATE_LABEL = {
  received: 'Received',
  skipped: 'Skipped',
  missing: 'Missing',
  not_yet_due: 'Not yet due',
} as const;

export const OCCURRENCE_STATE_TONE = {
  received: 'positive',
  skipped: 'neutral',
  missing: 'warning',
  not_yet_due: 'neutral',
} as const;

export const skipReasonText = (reason: string, note: string | null): string =>
  `${SKIP_REASON_LABEL[reason] ?? reason}${note === null ? '' : ` — ${note}`}`;

/**
 * The year's missing payments as the year view's line for this source names
 * them (ADR 0012 D2), or `null` when none is missing.
 */
export function sourceMissingFlag(page: Pick<IncomeSourcePageDto, 'source' | 'occurrences'>): IncomeMissingFlagDto | null {
  const occurrences = page.occurrences.filter((row) => row.state.kind === 'missing').map((row) => row.occurrenceDate);
  return occurrences.length === 0
    ? null
    : { templateId: page.source.templateId, name: page.source.name, archived: page.source.archived, occurrences };
}

export type SourceOccurrenceLink =
  | { readonly kind: 'payment'; readonly href: MissingFlagLink['href']; readonly label: string }
  | { readonly kind: 'occurrence'; readonly href: MissingFlagLink['href']; readonly label: string }
  | Exclude<MissingFlagLink, { readonly kind: 'source' }>;

/**
 * Where an occurrence's row sends the user, or nowhere.
 *
 *  - a received one, to its payment's row in Monthly — the month it arrived,
 *    which stays its editor (ADR 0012 D5);
 *  - a skipped one, to its own row in Monthly, where it can be restored;
 *  - a missing one, as the year view's line does (D2): its row in Monthly when
 *    it is the year's only one, Bulk History from the first missing month when
 *    there are several. An archived source's has no link: this page's own
 *    Unarchive and end-date controls are what resolve it;
 *  - one not yet due, nowhere.
 */
export function occurrenceLink(
  occurrence: IncomeSourceOccurrenceDto,
  templateId: string,
  flag: IncomeMissingFlagDto | null,
  monthName: (month: string) => string,
): SourceOccurrenceLink | null {
  const { state, occurrenceDate } = occurrence;
  switch (state.kind) {
    case 'received':
      return {
        kind: 'payment',
        href: paymentHref(state.payment.entryId, state.payment.receivedOn),
        label: `Open ${monthName(state.payment.receivedOn.slice(0, 7))} in Monthly`,
      };
    case 'skipped':
      return {
        kind: 'occurrence',
        href: occurrenceHref(templateId, occurrenceDate),
        label: `Open ${monthName(occurrenceDate.slice(0, 7))} in Monthly`,
      };
    case 'missing': {
      if (flag === null || flag.archived) return null;
      const link = missingFlagLink(flag, monthName);
      /* v8 ignore next -- an active source's flag always links to Monthly or Bulk History. */
      return link === null || link.kind === 'source' ? null : link;
    }
    case 'not_yet_due':
      return null;
  }
}

/**
 * An archived source's missing line on this page: the year view's guidance
 * (`ARCHIVED_MISSING_HELP`) said once, as one sentence around two links to
 * this page's own controls —
 *
 * "This source is archived, so its payments cannot be recorded or skipped.
 * [Unarchive it], or, if it really ended, [set an end date] before the missing
 * payment."
 */
export const ARCHIVED_SOURCE_MISSING = {
  reason: ARCHIVED_SOURCE_REASON,
  unarchive: { href: '#archive', label: 'Unarchive it' },
  ifEnded: ', or, if it really ended,',
  endDate: { href: '#end-date', label: 'set an end date' },
  before: 'before the missing payment.',
} as const;
