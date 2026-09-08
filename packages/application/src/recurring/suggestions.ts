import {
  deleteSkip,
  findSkipIn,
  findTemplate,
  hasMaterializedOccurrenceIn,
  insertExpenseEntryIn,
  insertIncomeEntryIn,
  insertSkipIn,
  listMaterializedOccurrences,
  listSkips,
  listTerms,
  lockTemplateIn,
  withUser,
  type ExpenseEntryRow,
  type IncomeEntryRow,
  type RecurringTemplateRow,
  type RecurringTemplateSkipRow,
  type Transaction,
} from '@vaultide/db';
import {
  Decimal,
  occurrencesInRange,
  plainDate,
  termForOccurrence,
  type PlainDate,
} from '@vaultide/finance';
import { isRentalOnlySkipReason, type SkipReason } from '@vaultide/validation';
import type { RequestContext } from '../context';
import {
  DuplicateConflictError,
  ImpossibleOperationError,
  NotFoundError,
  ValidationError,
} from '../errors';
import { clearDormancyForFlowIn, auditContextOf, resolveTrackedCashLeg, type FlowDependencies } from '../flows/shared';

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
      {
        frequency: template.frequency,
        dayOfMonth: template.dayOfMonth,
        startDate: plainDate(template.startDate),
        endDate: template.endDate === null ? null : plainDate(template.endDate),
      },
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

/** The occurrence must be one this template actually has (6.2). */
function assertScheduledOccurrence(
  template: RecurringTemplateRow,
  occurrenceDate: string,
): void {
  const dates = occurrencesInRange(
    {
      frequency: template.frequency,
      dayOfMonth: template.dayOfMonth,
      startDate: plainDate(template.startDate),
      endDate: template.endDate === null ? null : plainDate(template.endDate),
    },
    plainDate(occurrenceDate),
    plainDate(occurrenceDate),
  );
  if (dates.length === 0) {
    throw new ValidationError('That is not one of this source’s scheduled dates.', {
      occurrenceDate: ['This source has no occurrence on that date.'],
    });
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
  args: { templateId: string; occurrenceDate: string },
): Promise<RecurringTemplateRow> {
  const template = await lockTemplateIn(tx, args.templateId);
  if (template === undefined) throw new NotFoundError('That source no longer exists.');
  if (template.archivedAt !== null) {
    throw new ImpossibleOperationError(
      'This source is archived, so its suggestions are no longer offered.',
    );
  }
  assertScheduledOccurrence(template, args.occurrenceDate);

  const skip = await findSkipIn(tx, args.templateId, args.occurrenceDate);
  if (skip !== undefined) {
    throw new DuplicateConflictError(
      'This occurrence is already marked as skipped. Un-skip it first if it did happen after all.',
    );
  }

  if (await hasMaterializedOccurrenceIn(tx, args.templateId, args.occurrenceDate)) {
    throw new DuplicateConflictError('This occurrence has already been recorded.');
  }

  return template;
}

export interface AcceptSuggestionArgs {
  readonly templateId: string;
  readonly occurrenceDate: string;
  /**
   * When the money actually moved. Defaults to the occurrence's own date, and
   * "received today" passes today — the occurrence keeps its scheduled identity
   * either way.
   */
  readonly financialDate?: string | undefined;
  /** Overrides the term's amount for this occurrence only ("this month only"). */
  readonly amount?: string | undefined;
  readonly cashPositionId?: string | null | undefined;
  readonly description?: string | undefined;
}

export type AcceptedOccurrence =
  | { readonly kind: 'income'; readonly entry: IncomeEntryRow }
  | { readonly kind: 'expense'; readonly entry: ExpenseEntryRow };

/**
 * Accept one occurrence, creating the source row it materializes.
 *
 * The settlement is always `tracked_cash` (§30.9 item 1): the template carries
 * no settlement preference, and inferring one from a NULL cash position would
 * contradict 8.1, where a null cash leg is a tracked flow awaiting attribution.
 */
export async function acceptSuggestion(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: AcceptSuggestionArgs,
): Promise<AcceptedOccurrence> {
  const template = await findTemplate(deps.db, ctx.userId, args.templateId);
  if (template === undefined) throw new NotFoundError('That source no longer exists.');

  const financialDate = args.financialDate ?? args.occurrenceDate;

  // Only the **financial** date is bound by "not after today" (M5). The
  // occurrence's own date is scheduling metadata and may legitimately be later.
  if (financialDate > ctx.today) {
    throw new ValidationError(
      'This has not happened yet. Accept it on the day, or record that you received it today.',
      { financialDate: ['This date is in the future.'] },
    );
  }

  const terms = (await listTerms(deps.db, ctx.userId, args.templateId)).map((row) => ({
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

  const cashPositionId =
    args.cashPositionId === undefined ? template.cashPositionId : args.cashPositionId;

  await resolveTrackedCashLeg(deps, ctx, {
    cashPositionId,
    currency: template.currency,
    on: financialDate,
    dateField: 'financialDate',
  });

  const audit = auditContextOf(ctx);
  const occurrence = { templateId: args.templateId, occurrenceDate: args.occurrenceDate };

  const result = await withUser(deps.db, { userId: ctx.userId }, async (tx) => {
    const locked = await claimOccurrenceIn(tx, occurrence);

    if (locked.kind === 'income') {
      if (locked.incomeKind === null) {
        /* v8 ignore next -- a 6.2 CHECK makes an income template's kind non-null. */
        throw new ImpossibleOperationError('This income source has no kind.');
      }
      const entry = await insertIncomeEntryIn(tx, audit, {
        kind: locked.incomeKind,
        receivedOn: financialDate,
        netAmount: amount,
        grossAmount: term?.grossAmount?.toString() ?? null,
        currency: locked.currency,
        settlement: 'tracked_cash',
        cashPositionId,
        description: args.description ?? null,
        occurrence,
      });
      await clearDormancyForFlowIn(tx, ctx, [cashPositionId]);
      return { kind: 'income' as const, entry };
    }

    if (locked.categoryId === null) {
      /* v8 ignore next -- a 6.2 CHECK makes an expense template's category non-null. */
      throw new ImpossibleOperationError('This expense source has no category.');
    }
    const entry = await insertExpenseEntryIn(tx, audit, {
      categoryId: locked.categoryId,
      incurredOn: financialDate,
      amount,
      currency: locked.currency,
      settlement: 'tracked_cash',
      cashPositionId,
      description: args.description ?? null,
      occurrence,
    });
    await clearDormancyForFlowIn(tx, ctx, [cashPositionId]);
    return { kind: 'expense' as const, entry };
  });

  await deps.fx.ensureHistory(template.currency, financialDate);
  return result;
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
export async function skipSuggestion(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: SkipSuggestionArgs,
): Promise<RecurringTemplateSkipRow> {
  const audit = auditContextOf(ctx);

  return withUser(deps.db, { userId: ctx.userId }, async (tx) => {
    const template = await claimOccurrenceIn(tx, args);

    if (isRentalOnlySkipReason(args.reason) && template.incomeKind !== 'rental') {
      throw new ValidationError(
        'A vacancy or a missed payment is something only a rental can record.',
        { reason: ['Choose another reason.'] },
      );
    }

    return insertSkipIn(tx, audit, {
      templateId: args.templateId,
      occurrenceDate: args.occurrenceDate,
      reason: args.reason,
      note: args.note ?? null,
    });
  });
}

/**
 * Un-skip: delete the skip row with its before-image (6.3).
 *
 * The occurrence becomes due again, unless an accepted flow exists for it —
 * which `claimOccurrenceIn` would have prevented in the first place.
 */
export async function unskipSuggestion(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: { skipId: string; reason?: string | undefined },
): Promise<RecurringTemplateSkipRow> {
  const removed = await deleteSkip(deps.db, auditContextOf(ctx, args.reason), args.skipId);
  if (removed === undefined) throw new NotFoundError('That skipped occurrence no longer exists.');
  return removed;
}
