import {
  deleteSkipIn,
  findSkipIn,
  findTemplateIn,
  hasMaterializedOccurrenceIn,
  insertSkipIn,
  listMaterializedOccurrences,
  listResolvedOccurrenceDatesIn,
  listSkips,
  listTerms,
  listTermsIn,
  lockTemplateIn,
  type ExpenseEntryRow,
  type IncomeEntryRow,
  type OccurrenceRef,
  type RecurringTemplateRow,
  type RecurringTemplateSkipRow,
  type RecurringTemplateTermRow,
  type Transaction,
} from '@vaultide/db';
import {
  Decimal,
  nextUnresolvedOccurrence,
  occurrencesInRange,
  plainDate,
  termForOccurrence,
  type PlainDate,
} from '@vaultide/finance';
import { isRentalOnlySkipReason, type SkipReason } from '@vaultide/validation';
import type { RequestContext } from '../context';
import { withUserWrite } from '../coordination';
import {
  DuplicateConflictError,
  ImpossibleOperationError,
  NotFoundError,
  ValidationError,
} from '../errors';
import { assertNoHistoricalReview } from '../corrections/guard';
import {
  applyExpensePlanIn,
  resolveExpenseCreateIn,
  type ExpenseWritePlan,
} from '../flows/expenses';
import {
  applyIncomePlanIn,
  resolveIncomeCreateIn,
  type IncomeWritePlan,
} from '../flows/income';
import { auditContextOf, type FlowDependencies } from '../flows/shared';
import type { ResolvedWrite, ResolveOptions } from '../write-plan';

/**
 * Accepting and skipping recurring occurrences (blueprint 6.2, 15.3, 20.3,
 * v2.1.6 §30.9).
 *
 * A suggestion is derived and holds no fact. Exactly one of two things can make
 * an occurrence real: an accepted flow carrying `(template_id, occurrence_date)`,
 * or a `recurring_template_skips` row carrying the same pair.
 *
 * ## Why both writes take the template's lock
 *
 * The two facts live in **different tables**, so a partial unique index cannot
 * see both and a check-then-insert is not atomic: two requests could each read
 * an empty occurrence, one accept and one skip, and both commit. So accept and
 * skip open a transaction, take `SELECT … FOR UPDATE` on the template row,
 * check the flow table *and* the skip table, and only then write. Concurrent
 * accept and skip therefore queue, and exactly one wins.
 *
 * The partial unique index remains the second line of defence, and is what
 * makes a double *accept* a database conflict rather than a race.
 *
 * ## Two dates, deliberately different
 *
 * `occurrence_date` is the scheduled identity and never moves. The financial
 * date is when the money actually moved, and it alone is bound by "not after
 * today" (M5). That is what makes "received today" work: a salary scheduled for
 * 1 October and received on 30 September is one row with both dates, September
 * sees the cash, and October never suggests it again. Applying the future-date
 * rule to `occurrence_date` would break exactly that case, so it is applied to
 * the financial date only.
 */

export type SuggestionState = 'due' | 'upcoming' | 'accepted' | 'skipped';

export interface Suggestion {
  readonly templateId: string;
  readonly templateName: string;
  readonly occurrenceDate: PlainDate;
  readonly state: SuggestionState;
  readonly currency: string;
  /** The term's amount, or `null` when the template has no term yet. */
  readonly amount: string | null;
  readonly grossAmount: string | null;
  readonly kind: RecurringTemplateRow['kind'];
  readonly incomeKind: RecurringTemplateRow['incomeKind'];
  readonly categoryId: string | null;
  readonly cashPositionId: string | null;
  readonly skipReason: SkipReason | null;
}

/**
 * Every occurrence of the user's templates in a range, with its state.
 *
 * Pure generation (`@vaultide/finance`) plus two bulk reads; no query per
 * template and no N+1.
 */
export async function listSuggestions(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: { from: string; to: string; templates: readonly RecurringTemplateRow[] },
): Promise<Suggestion[]> {
  const active = args.templates.filter((template) => template.archivedAt === null);
  const templateIds = active.map((template) => template.id);
  if (templateIds.length === 0) return [];

  const [materialized, skips] = await Promise.all([
    listMaterializedOccurrences(deps.db, ctx.userId, templateIds),
    listSkips(deps.db, ctx.userId, templateIds),
  ]);

  const accepted = new Set(
    materialized.map((row) => `${row.templateId}#${row.occurrenceDate}`),
  );

  const skipByKey = new Map<string, RecurringTemplateSkipRow>();
  for (const skip of skips) skipByKey.set(`${skip.templateId}#${skip.occurrenceDate}`, skip);

  const suggestions: Suggestion[] = [];
  for (const template of active) {
    const terms = (await listTerms(deps.db, ctx.userId, template.id)).map((row) => ({
      id: row.id,
      templateId: row.templateId,
      effectiveFrom: plainDate(row.effectiveFrom),
      amount: new Decimal(row.amount),
      grossAmount: row.grossAmount === null ? null : new Decimal(row.grossAmount),
    }));

    const dates = occurrencesInRange(
      scheduleOf(template),
      plainDate(args.from),
      plainDate(args.to),
    );

    for (const occurrenceDate of dates) {
      const key = `${template.id}#${occurrenceDate}`;
      const skip = skipByKey.get(key);
      const term = termForOccurrence(terms, occurrenceDate);

      const state: SuggestionState = accepted.has(key)
        ? 'accepted'
        : skip !== undefined
          ? 'skipped'
          : occurrenceDate > ctx.today
            ? 'upcoming'
            : 'due';

      suggestions.push({
        templateId: template.id,
        templateName: template.name,
        occurrenceDate,
        state,
        currency: template.currency,
        amount: term?.amount.toString() ?? null,
        grossAmount: term?.grossAmount?.toString() ?? null,
        kind: template.kind,
        incomeKind: template.incomeKind,
        categoryId: template.categoryId,
        cashPositionId: template.cashPositionId,
        skipReason: skip?.reason ?? null,
      });
    }
  }

  return suggestions;
}

function scheduleOf(template: RecurringTemplateRow) {
  return {
    frequency: template.frequency,
    dayOfMonth: template.dayOfMonth,
    startDate: plainDate(template.startDate),
    endDate: template.endDate === null ? null : plainDate(template.endDate),
  };
}

/*
 * ## The occurrence rules, as decisions
 *
 * Claiming an occurrence — for an acceptance or a skip — and accepting one are
 * a handful of rules, each asked of rows the caller has read: the template, its
 * terms, the occurrence's skip and whether a flow already carries it, and for a
 * future occurrence what the template has already resolved. The functions
 * below hold those rules and perform no IO, take no lock and read no clock.
 * `claimOccurrenceIn` and `resolveAcceptSuggestionIn` read, in the order they
 * always have, and ask them between the reads; the correction preview (no
 * locks) and Historical Confirm (under them) reach them through those same
 * functions.
 *
 * They are separate rather than one because reads sit between them: an
 * occurrence already skipped is refused before anything else is looked up.
 *
 * Each is handed the occurrence it judges, and checks that the template, the
 * terms and the skip it is given belong to that occurrence before it judges
 * anything. A mismatch is refused as the programming error it is — never
 * filtered, which would turn a mis-grouped term into a confident "no amount" —
 * so a caller that paired an occurrence with another template's rows gets no
 * plan at all. A template that is missing or foreign stays the loader's
 * business: RLS makes it read as absent, and that is `NOT_FOUND`.
 */

/** The template a decision is handed is the one the occurrence names. */
function assertOwnTemplate(template: RecurringTemplateRow, templateId: string): void {
  if (template.id !== templateId) {
    throw new Error('an occurrence decision was handed another template');
  }
}

/**
 * The template an occurrence is claimed from: it exists, it is not archived,
 * and the occurrence is one of its scheduled dates (6.2, 30.10).
 *
 * Archiving withdraws a source from new acceptances and skips; it rewrites no
 * history, and it does not change what the schedule contained.
 */
export function assertClaimableOccurrence(
  template: RecurringTemplateRow | undefined,
  claim: OccurrenceRef,
): RecurringTemplateRow {
  if (template === undefined) throw new NotFoundError('That source no longer exists.');
  assertOwnTemplate(template, claim.templateId);
  const occurrenceDate = claim.occurrenceDate;
  if (template.archivedAt !== null) {
    throw new ImpossibleOperationError(
      'This source is archived, so its suggestions are no longer offered.',
    );
  }
  const dates = occurrencesInRange(
    scheduleOf(template),
    plainDate(occurrenceDate),
    plainDate(occurrenceDate),
  );
  if (dates.length === 0) {
    throw new ValidationError('That is not one of this source’s scheduled dates.', {
      occurrenceDate: ['This source has no occurrence on that date.'],
    });
  }
  return template;
}

/**
 * A future occurrence may be materialized only if it is the next one nothing
 * has resolved (30.10). `resolved` holds every occurrence date of the template
 * that a flow or a skip already carries.
 */
export function assertEarliestUnresolvedOccurrence(
  template: RecurringTemplateRow,
  claim: OccurrenceRef,
  today: string,
  resolved: ReadonlySet<string>,
): void {
  assertOwnTemplate(template, claim.templateId);
  const eligible = nextUnresolvedOccurrence(scheduleOf(template), plainDate(today), resolved);

  if (eligible === undefined || eligible !== claim.occurrenceDate) {
    throw new ValidationError(
      eligible === undefined
        ? 'This source has no upcoming date left to record early.'
        : `The next one still to record is ${eligible}. Record that one before this, so nothing is left with a gap behind it.`,
      { occurrenceDate: ['This is not the next date still to record.'] },
    );
  }
}

/**
 * An occurrence already skipped is resolved; it is un-skipped before anything
 * else (20.3). `skip` is the claimed occurrence's own skip, if it has one.
 */
export function assertNotSkipped(
  skip: RecurringTemplateSkipRow | undefined,
  claim: OccurrenceRef,
): void {
  if (
    skip !== undefined &&
    (skip.templateId !== claim.templateId || skip.occurrenceDate !== claim.occurrenceDate)
  ) {
    throw new Error('an occurrence decision was handed the skip of another occurrence');
  }
  if (skip !== undefined) {
    throw new DuplicateConflictError(
      'This occurrence is already marked as skipped. Un-skip it first if it did happen after all.',
    );
  }
}

/** An occurrence a flow already carries is resolved, and is not materialized twice (20.3). */
export function assertNotMaterialized(materialized: boolean): void {
  if (materialized) {
    throw new DuplicateConflictError('This occurrence has already been recorded.');
  }
}

/**
 * Hold the template and check both tables for the occurrence.
 *
 * Every accept and every skip goes through here, so the serialization point is
 * one function rather than a convention.
 */
async function claimOccurrenceIn(
  tx: Transaction,
  args: { templateId: string; occurrenceDate: string; today?: string },
  options: ResolveOptions = { lock: true },
): Promise<RecurringTemplateRow> {
  // The correction preview runs the same checks without the lock: it claims
  // nothing, writes nothing and cannot take a row lock in a `READ ONLY`
  // transaction. Confirm takes it for real, so an occurrence somebody else
  // recorded in between is still the existing conflict rather than a changed
  // impact (§12 of the slice prompt).
  const template = assertClaimableOccurrence(
    options.lock
      ? await lockTemplateIn(tx, args.templateId)
      : await findTemplateIn(tx, args.templateId),
    args,
  );

  // Asked here, under the template's lock, so a concurrent acceptance of the
  // earlier occurrence cannot slip in between the decision and the write — and
  // so the rule holds against any caller, not only against a well-behaved
  // interface.
  if (args.today !== undefined && args.occurrenceDate > args.today) {
    const resolved = new Set(await listResolvedOccurrenceDatesIn(tx, args.templateId));
    assertEarliestUnresolvedOccurrence(template, args, args.today, resolved);
  }

  assertNotSkipped(await findSkipIn(tx, args.templateId, args.occurrenceDate), args);
  assertNotMaterialized(await hasMaterializedOccurrenceIn(tx, args.templateId, args.occurrenceDate));

  return template;
}

export interface AcceptSuggestionArgs {
  readonly templateId: string;
  readonly occurrenceDate: string;
  /**
   * When the money actually moved. Defaults to the occurrence's own date. For a
   * future occurrence it is not an input at all: `receivedToday` fixes it to
   * `ctx.today`, so a caller cannot pair a future occurrence with an arbitrary
   * past date (30.10).
   */
  readonly financialDate?: string | undefined;
  /**
   * The explicit "I received this today" mode, and the **only** way to
   * materialize an occurrence dated after today.
   */
  readonly receivedToday?: boolean | undefined;
  /** Overrides the term's amount for this occurrence only ("this month only"). */
  readonly amount?: string | undefined;
  /**
   * The gross figure for this occurrence only, in three distinct states:
   * omitted inherits the term's gross, a string states this occurrence's own,
   * and `null` states that it had none. Income sources only.
   */
  readonly grossAmount?: string | null | undefined;
  readonly cashPositionId?: string | null | undefined;
  readonly description?: string | undefined;
}

export type AcceptedOccurrence =
  | { readonly kind: 'income'; readonly entry: IncomeEntryRow }
  | { readonly kind: 'expense'; readonly entry: ExpenseEntryRow };

/**
 * A resolved acceptance: the flow it would materialize, and the occurrence it
 * would claim.
 *
 * Accepting is a **first assertion** — the occurrence's financial date may be
 * historical and that alone is not a correction (30.22 item 2). What can make
 * one is its dormancy consequence: materializing a flow onto an account whose
 * dormant episode began in a closed month rewrites that episode, and that goes
 * through Preview → Confirm (§12 of the slice prompt).
 *
 * The plan delegates its `changes`, `dormancy` and `support` to the flow plan
 * underneath, so an acceptance and a direct creation are classified by exactly
 * the same rule.
 */
export type AcceptWritePlan = ResolvedWrite & {
  readonly currency: string;
  readonly financialDate: string;
  readonly occurrence: OccurrenceRef;
} & (
    | { readonly kind: 'income'; readonly income: IncomeWritePlan }
    | { readonly kind: 'expense'; readonly expense: ExpenseWritePlan }
  );

/**
 * An acceptance on its own terms: a gross amount only for income, and the
 * financial date its occurrence allows (M5, 30.10).
 */
export function decideAcceptance(
  today: PlainDate,
  template: RecurringTemplateRow,
  args: AcceptSuggestionArgs,
): { readonly financialDate: string } {
  assertOwnTemplate(template, args.templateId);

  // An expense has no gross figure to carry (6.2: `expense_entries` has no such
  // column), so a stated one is refused rather than silently dropped.
  if (args.grossAmount !== undefined && template.kind !== 'income') {
    throw new ValidationError('Only income records a gross amount.', {
      grossAmount: ['This source is not income.'],
    });
  }

  // Two shapes, and only one of them may carry a future occurrence.
  //
  // Ordinary acceptance: the occurrence has arrived, and the financial date is
  // its own date unless the user says otherwise — bound by "not after today"
  // (M5), because that date is the financial fact.
  //
  // Early materialization: the occurrence is still ahead, so it is reachable
  // only through the explicit mode, only if it is the next unresolved one
  // (`assertEarliestUnresolvedOccurrence`, asked where the occurrence is
  // claimed, under the template's lock), and its financial date is today by
  // definition rather than by choice (30.10).
  if (args.occurrenceDate > today) {
    if (args.receivedToday !== true) {
      throw new ValidationError(
        'This has not happened yet. Accept it on the day, or say that you received it today.',
        { occurrenceDate: ['This date has not arrived yet.'] },
      );
    }
    if (args.financialDate !== undefined && args.financialDate !== today) {
      // Recording something ahead of its date says it arrived *today*. Any
      // other date would be a claim about a day nothing was known to happen.
      throw new ValidationError(
        'Money received before its scheduled date is recorded as arriving today.',
        { financialDate: ['This has to be today.'] },
      );
    }
    return { financialDate: today };
  }

  const financialDate = args.financialDate ?? args.occurrenceDate;
  if (financialDate > today) {
    throw new ValidationError(
      'This has not happened yet. Accept it on the day, or say that you received it today.',
      { financialDate: ['This date is in the future.'] },
    );
  }
  return { financialDate };
}

/**
 * What an acceptance materializes, from the template and its terms: the amount
 * and gross of the term the occurrence falls under unless the caller states
 * this occurrence's own, and the template's own account unless the caller names
 * another.
 */
export function decideAcceptedAmounts(
  template: RecurringTemplateRow,
  termRows: readonly RecurringTemplateTermRow[],
  args: AcceptSuggestionArgs,
): {
  readonly amount: string;
  readonly grossAmount: string | null;
  readonly cashPositionId: string | null;
} {
  assertOwnTemplate(template, args.templateId);
  if (termRows.some((row) => row.templateId !== template.id)) {
    throw new Error('an occurrence decision was handed the terms of another template');
  }

  const terms = termRows.map((row) => ({
    id: row.id,
    templateId: row.templateId,
    effectiveFrom: plainDate(row.effectiveFrom),
    amount: new Decimal(row.amount),
    grossAmount: row.grossAmount === null ? null : new Decimal(row.grossAmount),
  }));
  // The term is chosen by the **scheduled** date, so an early payment still
  // takes the term the schedule says applies (§30.9 item 4).
  const term = termForOccurrence(terms, plainDate(args.occurrenceDate));

  const amount = args.amount ?? term?.amount.toString();
  if (amount === undefined) {
    throw new ValidationError('This source has no amount for that date yet.', {
      amount: ['Enter the amount.'],
    });
  }

  // An expense is strictly positive (6.2), while a term may legitimately be
  // zero — `recurring_template_terms.amount >= 0`, which income relies on. The
  // two contracts are both correct and they meet here, at the one point where a
  // term amount becomes an expense, so this is where the difference is stated.
  // Without it a zero-term acceptance reaches `expense_entries_amount_positive`
  // and surfaces as an internal error instead of something the user can act on.
  // The DB CHECK stays the backstop; this is the answer.
  if (template.kind === 'expense' && !new Decimal(amount).greaterThan(0)) {
    throw new ValidationError(
      'An expense has to be more than zero. Enter what this one actually cost.',
      { amount: ['Enter an amount greater than zero.'] },
    );
  }

  // Three states, and `??` would collapse two of them: an omitted gross inherits
  // the term's — exactly what every caller did before the field existed — while
  // an explicit `null` states that this occurrence had no gross at all. Written
  // as an `undefined` test rather than a coalesce so that stays true.
  const grossAmount =
    args.grossAmount === undefined ? (term?.grossAmount?.toString() ?? null) : args.grossAmount;

  const cashPositionId =
    args.cashPositionId === undefined ? template.cashPositionId : args.cashPositionId;

  return { amount, grossAmount, cashPositionId };
}

export async function resolveAcceptSuggestionIn(
  tx: Transaction,
  ctx: RequestContext,
  args: AcceptSuggestionArgs,
  options: ResolveOptions = { lock: true },
): Promise<AcceptWritePlan> {
  const template = await findTemplateIn(tx, args.templateId);
  if (template === undefined) throw new NotFoundError('That source no longer exists.');

  const { financialDate } = decideAcceptance(ctx.today, template, args);
  const { amount, grossAmount, cashPositionId } = decideAcceptedAmounts(
    template,
    await listTermsIn(tx, args.templateId),
    args,
  );

  const occurrence = { templateId: args.templateId, occurrenceDate: args.occurrenceDate };

  // The claim is the serialization point and it comes **before** the flow is
  // resolved, so an occurrence somebody else has already recorded refuses with
  // its own conflict rather than being previewed as though it were free. In
  // preview mode it runs the same checks without the template's lock: a preview
  // claims nothing (§12 of the slice prompt).
  const locked = await claimOccurrenceIn(tx, { ...occurrence, today: ctx.today }, options);

  if (locked.kind === 'income') {
    if (locked.incomeKind === null) {
      /* v8 ignore next -- a 6.2 CHECK makes an income template's kind non-null. */
      throw new ImpossibleOperationError('This income source has no kind.');
    }
    const income = await resolveIncomeCreateIn(
      tx,
      ctx,
      {
        kind: locked.incomeKind,
        receivedOn: financialDate,
        netAmount: amount,
        ...(grossAmount === null ? {} : { grossAmount }),
        currency: locked.currency,
        settlement: 'tracked_cash',
        cashPositionId,
        ...(args.description === undefined ? {} : { description: args.description }),
      },
      occurrence,
    );
    return {
      kind: 'income',
      income,
      currency: locked.currency,
      financialDate,
      occurrence,
      revision: income.revision,
      changes: income.changes,
      dormancy: income.dormancy,
      support: income.support,
    };
  }

  if (locked.categoryId === null) {
    /* v8 ignore next -- a 6.2 CHECK makes an expense template's category non-null. */
    throw new ImpossibleOperationError('This expense source has no category.');
  }

  const expense = await resolveExpenseCreateIn(
    tx,
    ctx,
    {
      categoryId: locked.categoryId,
      incurredOn: financialDate,
      amount,
      currency: locked.currency,
      settlement: 'tracked_cash',
      cashPositionId,
      ...(args.description === undefined ? {} : { description: args.description }),
    },
    // The category was chosen when the template was made, and a category
    // archived since does not change what its occurrences are (30.22 item 9).
    { lock: options.lock, occurrence, carryCategory: true },
  );
  return {
    kind: 'expense',
    expense,
    currency: locked.currency,
    financialDate,
    occurrence,
    revision: expense.revision,
    changes: expense.changes,
    dormancy: expense.dormancy,
    support: expense.support,
  };
}

export async function applyAcceptPlanIn(
  tx: Transaction,
  ctx: RequestContext,
  plan: AcceptWritePlan,
  reason?: string,
): Promise<AcceptedOccurrence> {
  if (plan.kind === 'income') {
    return { kind: 'income', entry: await applyIncomePlanIn(tx, ctx, plan.income, reason) };
  }
  return { kind: 'expense', entry: await applyExpensePlanIn(tx, ctx, plan.expense, reason) };
}

/**
 * Accept one occurrence, creating the source row it materializes.
 *
 * The settlement is always `tracked_cash` (§30.9 item 1): the template carries
 * no settlement preference, and inferring one from a NULL cash position would
 * contradict 8.1, where a null cash leg is a tracked flow awaiting attribution.
 */
async function acceptSuggestionIn(
  tx: Transaction,
  ctx: RequestContext,
  args: AcceptSuggestionArgs,
): Promise<{ accepted: AcceptedOccurrence; currency: string; financialDate: string }> {
  const plan = await resolveAcceptSuggestionIn(tx, ctx, args);
  assertNoHistoricalReview(plan, ctx.today);
  return {
    accepted: await applyAcceptPlanIn(tx, ctx, plan),
    currency: plan.currency,
    financialDate: plan.financialDate,
  };
}

/**
 * Accept one occurrence, creating the source row it materializes.
 *
 * One transaction under the per-user write mutex: the template, its terms, the
 * cash leg the flow attaches to and the occurrence claim are all read there, so
 * a term edited or an account closed between the read and the write cannot
 * change what this acceptance meant (30.22 item 5).
 *
 * Accepting a historical occurrence stays ordinary. Accepting one that would
 * wake an account out of a dormant episode anchored in a closed month does not:
 * that is a rewrite of history and goes through Preview → Confirm.
 */
export async function acceptSuggestion(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: AcceptSuggestionArgs,
): Promise<AcceptedOccurrence> {
  const written = await withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    acceptSuggestionIn(tx, ctx, args),
  );

  await deps.fx.ensureHistory(written.currency, written.financialDate);
  return written.accepted;
}
export interface SkipSuggestionArgs {
  readonly templateId: string;
  readonly occurrenceDate: string;
  readonly reason: SkipReason;
  readonly note?: string | undefined;
}

/**
 * Skip one occurrence: a durable row, no financial flow.
 *
 * For rental income the reason is the **only** occupancy fact the product ever
 * records (F18, 11.2). Absence of a rent entry means nothing; `vacant` means
 * the property was empty. That is why `vacant` and `non_payment` are refused
 * for anything but a rental template rather than quietly accepted.
 */
async function skipSuggestionIn(
  tx: Transaction,
  ctx: RequestContext,
  args: SkipSuggestionArgs,
): Promise<RecurringTemplateSkipRow> {
  const template = await claimOccurrenceIn(tx, args);

  if (isRentalOnlySkipReason(args.reason) && template.incomeKind !== 'rental') {
    throw new ValidationError(
      'A vacancy or a missed payment is something only a rental can record.',
      { reason: ['Choose another reason.'] },
    );
  }

  return insertSkipIn(tx, auditContextOf(ctx), {
    templateId: args.templateId,
    occurrenceDate: args.occurrenceDate,
    reason: args.reason,
    note: args.note ?? null,
  });
}

export async function skipSuggestion(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: SkipSuggestionArgs,
): Promise<RecurringTemplateSkipRow> {
  return withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    skipSuggestionIn(tx, ctx, args),
  );
}

/**
 * Un-skip: delete the skip row with its before-image (6.3).
 *
 * The occurrence becomes due again, unless an accepted flow exists for it —
 * which `claimOccurrenceIn` would have prevented in the first place.
 */
export interface UnskipSuggestionArgs {
  readonly skipId: string;
  readonly reason?: string | undefined;
}

async function unskipSuggestionIn(
  tx: Transaction,
  ctx: RequestContext,
  args: UnskipSuggestionArgs,
): Promise<RecurringTemplateSkipRow> {
  const removed = await deleteSkipIn(tx, auditContextOf(ctx, args.reason), args.skipId);
  if (removed === undefined) throw new NotFoundError('That skipped occurrence no longer exists.');
  return removed;
}

export async function unskipSuggestion(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: UnskipSuggestionArgs,
): Promise<RecurringTemplateSkipRow> {
  return withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    unskipSuggestionIn(tx, ctx, args),
  );
}
