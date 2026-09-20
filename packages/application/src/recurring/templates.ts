import {
  findTermAtIn,
  findTemplateIn,
  insertTemplateIn,
  insertTermIn,
  isUniqueViolation,
  latestReferencedOccurrenceIn,
  listTemplates,
  lockTemplateIn,
  templateHasHistoryIn,
  updateTemplateIn,
  updateTermIn,
  type RecurringTemplateRow,
  type RecurringTemplateTermRow,
  type Transaction,
} from '@vaultide/db';
import type { IncomeKind, RecurrenceFrequency, TemplateKind } from '@vaultide/validation';
import type { RequestContext } from '../context';
import { withUserWrite } from '../coordination';
import {
  DuplicateConflictError,
  ImpossibleOperationError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
} from '../errors';
import { assertCategoryUsableInPhase3, requireLiveCategoryIn } from '../flows/expenses';
import { auditContextOf, requireCashAccountIn, type FlowDependencies } from '../flows/shared';

/**
 * Recurring templates and their terms (blueprint 6.2, 15.3, 20.3, 30.22,
 * v2.1.6 §30.9).
 *
 * A template generates suggestions; it holds no financial fact of its own.
 * Three rules give it its shape, and all three exist because a template that
 * can be edited freely can rewrite what the past is supposed to have contained.
 *
 * ## Tracked cash only
 *
 * The table has no settlement column, so a Phase 3 template materializes
 * tracked-cash flows only (§30.9 item 1). Settlement is never inferred from the
 * template's `cash_position_id` being NULL — 8.1 says a tracked flow with no
 * cash leg is an ordinary tracked flow awaiting attribution.
 *
 * ## Frozen identity once history exists
 *
 * The moment any materialized flow or skip references the template, the fields
 * that decide what its historical occurrences *were* stop being editable. A
 * salary that used to fall on the 25th and now falls on the 30th is a different
 * schedule, and regenerating September from the new one would claim an
 * occurrence that never existed. The answer is a new template, not an edit.
 *
 * ## Archive, never hard-delete
 *
 * Archiving is always available, history or not: it stops the suggestions and
 * keeps every row. There is deliberately **no** hard-delete action in Phase 3 —
 * terms and skips cascade, and a skip can carry an occupancy fact (`vacant`,
 * `non_payment`) whose removal has to be audited like any other record. A phase
 * that wants template deletion must define that child-row behaviour first.
 *
 * ## Every mutation is one mutex-owned transaction
 *
 * A template, a term and a skip are mutable financial evidence: they decide
 * which occurrences a month expected and what each one was worth (8.5, 12.6).
 * So the reads each decision rests on — the template, its history, its terms,
 * the category it files under, the account it defaults to — happen inside the
 * write's own `withUserWrite` transaction (30.22 item 5).
 */

export interface CreateTemplateArgs {
  readonly kind: TemplateKind;
  readonly name: string;
  readonly counterparty?: string | undefined;
  readonly incomeKind?: IncomeKind | undefined;
  readonly categoryId?: string | undefined;
  readonly currency: string;
  readonly frequency: RecurrenceFrequency;
  readonly dayOfMonth?: number | undefined;
  readonly startDate: string;
  readonly endDate?: string | undefined;
  readonly cashPositionId?: string | undefined;
  /** The first amount, written as the opening term. */
  readonly amount: string;
  readonly grossAmount?: string | undefined;
}

/** The fields that decide what a template's historical occurrences were. */
export const FROZEN_TEMPLATE_FIELDS = [
  'kind',
  'incomeKind',
  'categoryId',
  'currency',
  'frequency',
  'dayOfMonth',
  'startDate',
  'cashPositionId',
  'propertyPositionId',
  'targetInvestmentPositionId',
] as const;

async function validateTemplateShapeIn(
  tx: Transaction,
  args: {
    kind: TemplateKind;
    incomeKind?: IncomeKind | undefined;
    categoryId?: string | undefined;
    currency: string;
    cashPositionId?: string | undefined;
    dayOfMonth?: number | undefined;
    startDate: string;
    endDate?: string | undefined;
  },
): Promise<void> {
  if (args.kind === 'contribution') {
    throw new ImpossibleOperationError(
      'Recurring investment contributions arrive with investments.',
    );
  }
  if (args.kind === 'income' && args.incomeKind === undefined) {
    throw new ValidationError('Choose what kind of income this is.', {
      incomeKind: ['Choose an income kind.'],
    });
  }
  if (args.kind === 'expense' && args.categoryId === undefined) {
    throw new ValidationError('Choose a category for this expense.', {
      categoryId: ['Choose a category.'],
    });
  }
  if (
    args.incomeKind === 'external_inflow' ||
    args.incomeKind === 'adjustment'
  ) {
    // 6.2 CHECK, restated so the user sees a sentence rather than a constraint.
    throw new ValidationError(
      'Money moved in from outside, and reconciliation adjustments, are recorded when they happen rather than on a schedule.',
      { incomeKind: ['This kind cannot repeat on a schedule.'] },
    );
  }
  if (args.dayOfMonth !== undefined && (args.dayOfMonth < 1 || args.dayOfMonth > 31)) {
    throw new ValidationError('Choose a day between 1 and 31.', {
      dayOfMonth: ['Choose a day between 1 and 31.'],
    });
  }
  if (args.endDate !== undefined && args.endDate < args.startDate) {
    throw new ValidationError('The end date cannot be before the start date.', {
      endDate: ['This is before the start date.'],
    });
  }

  if (args.categoryId !== undefined) {
    // Chosen afresh, so it is held live for the rest of this transaction
    // (30.22 item 8; ADR 0010 §9).
    const category = await requireLiveCategoryIn(tx, args.categoryId);
    if (args.kind === 'expense') {
      // A recurring expense is an ordinary Phase 3 expense that happens to be
      // scheduled, so it obeys the same rule about which category kinds one may
      // be filed under (7.4). Checking only that the category exists and is live
      // let a template be built on a kind the direct path refuses, and every
      // occurrence it materialized was a fact 7.4 does not define.
      //
      // Only for an expense: 7.4 is a rule about what an expense may be filed
      // under, and an income template's category is not that. The input accepts
      // one on either kind, and widening this test to both would narrow an
      // accepted contract that has nothing to do with the defect being repaired.
      assertCategoryUsableInPhase3(category);
    }
  }

  if (args.cashPositionId !== undefined) {
    const account = await requireCashAccountIn(tx, args.cashPositionId);
    if (account.currency !== args.currency) {
      throw new ValidationError(
        `${account.name} is held in ${account.currency}, so it cannot be the default account for a ${args.currency} template.`,
        { cashPositionId: [`Choose a ${args.currency} account.`] },
      );
    }
  }
}

async function createTemplateIn(
  tx: Transaction,
  ctx: RequestContext,
  args: CreateTemplateArgs,
): Promise<{ template: RecurringTemplateRow; term: RecurringTemplateTermRow }> {
  await validateTemplateShapeIn(tx, args);

  const audit = auditContextOf(ctx);
  const template = await insertTemplateIn(tx, audit, {
    kind: args.kind,
    name: args.name,
    counterparty: args.counterparty ?? null,
    incomeKind: args.incomeKind ?? null,
    categoryId: args.categoryId ?? null,
    currency: args.currency,
    frequency: args.frequency,
    dayOfMonth: args.dayOfMonth ?? null,
    startDate: args.startDate,
    endDate: args.endDate ?? null,
    cashPositionId: args.cashPositionId ?? null,
  });

  // The opening term: a template with no term has a date and no amount, which
  // is a real state but not one the creation form should leave behind. In the
  // same transaction, so a template can never exist without the amount its
  // creation stated.
  const term = await insertTermIn(tx, audit, {
    templateId: template.id,
    effectiveFrom: args.startDate,
    amount: args.amount,
    grossAmount: args.grossAmount ?? null,
  });

  return { template, term };
}

export async function createTemplate(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: CreateTemplateArgs,
): Promise<{ template: RecurringTemplateRow; term: RecurringTemplateTermRow }> {
  const created = await withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    createTemplateIn(tx, ctx, args),
  );

  await deps.fx.ensureHistory(args.currency, args.startDate);
  return created;
}

export interface UpdateTemplateArgs {
  readonly templateId: string;
  readonly expectedVersion: number;
  readonly name?: string | undefined;
  readonly counterparty?: string | null | undefined;
  readonly endDate?: string | null | undefined;
}

async function updateTemplateDetailsIn(
  tx: Transaction,
  ctx: RequestContext,
  args: UpdateTemplateArgs,
): Promise<RecurringTemplateRow> {
  const existing = await lockTemplateIn(tx, args.templateId);
  if (existing === undefined) throw new NotFoundError('That source no longer exists.');

  if (args.endDate !== undefined && args.endDate !== null) {
    if (args.endDate < existing.startDate) {
      throw new ValidationError('The end date cannot be before the start date.', {
        endDate: ['This is before the start date.'],
      });
    }
    const latest = await latestReferencedOccurrenceIn(tx, args.templateId);
    if (latest !== undefined && args.endDate < latest) {
      throw new ValidationError(
        `This would end the schedule before ${latest}, which you have already recorded or skipped. Choose a later date.`,
        { endDate: [`There is history on ${latest}.`] },
      );
    }
  }

  const updated = await updateTemplateIn(
    tx,
    auditContextOf(ctx),
    args.templateId,
    args.expectedVersion,
    {
      ...(args.name === undefined ? {} : { name: args.name }),
      ...(args.counterparty === undefined ? {} : { counterparty: args.counterparty }),
      ...(args.endDate === undefined ? {} : { endDate: args.endDate }),
    },
  );
  if (updated === undefined) {
    throw new VersionConflictError('This source changed while you were editing it.');
  }
  return updated;
}

/**
 * Edit the parts of a template that carry no accounting meaning.
 *
 * `name` and `counterparty` are the only two fields this table has that no
 * engine reads. `end_date` is editable as well, but never backwards past an
 * occurrence that has already been materialized or skipped — that would erase
 * an occurrence the history claims happened. The occurrence it checks against
 * is read under the template's own lock, inside the write's transaction, so an
 * acceptance landing at the same moment cannot be erased by it.
 */
export async function updateTemplateDetails(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: UpdateTemplateArgs,
): Promise<RecurringTemplateRow> {
  return withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    updateTemplateDetailsIn(tx, ctx, args),
  );
}

/**
 * Refuse an edit to a field that decides what the past contained.
 *
 * Exported so a caller inside the write transaction can reject the attempt
 * before it reaches the repository, and so the rule is testable on its own.
 */
export async function assertScheduleEditableIn(
  tx: Transaction,
  templateId: string,
): Promise<void> {
  if (await templateHasHistoryIn(tx, templateId)) {
    throw new ImpossibleOperationError(
      'This source already has recorded or skipped occurrences, so its schedule and category are fixed. End it and create a new one to change them.',
    );
  }
}

async function setArchivedAtIn(
  tx: Transaction,
  ctx: RequestContext,
  args: { templateId: string; expectedVersion: number },
  archivedAt: Date | null,
): Promise<RecurringTemplateRow> {
  const updated = await updateTemplateIn(
    tx,
    auditContextOf(ctx),
    args.templateId,
    args.expectedVersion,
    { archivedAt },
  );
  if (updated === undefined) {
    const exists = await findTemplateIn(tx, args.templateId);
    if (exists === undefined) throw new NotFoundError('That income source no longer exists.');
    throw new VersionConflictError('This income source changed while you were editing it.');
  }
  return updated;
}

export async function archiveTemplate(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: { templateId: string; expectedVersion: number },
): Promise<RecurringTemplateRow> {
  // Always allowed, history or not: archiving stops the suggestions and keeps
  // every row. It is not a delete and must not behave like one.
  return withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    setArchivedAtIn(tx, ctx, args, new Date()),
  );
}

export async function unarchiveTemplate(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: { templateId: string; expectedVersion: number },
): Promise<RecurringTemplateRow> {
  return withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    setArchivedAtIn(tx, ctx, args, null),
  );
}

export interface SetTemplateTermArgs {
  readonly templateId: string;
  readonly effectiveFrom: string;
  readonly amount: string;
  readonly grossAmount?: string | undefined;
  readonly note?: string | undefined;
  readonly expected: { state: 'absent' } | { state: 'version'; version: number };
}

async function setTemplateTermIn(
  tx: Transaction,
  ctx: RequestContext,
  args: SetTemplateTermArgs,
): Promise<RecurringTemplateTermRow> {
  const template = await findTemplateIn(tx, args.templateId);
  if (template === undefined) throw new NotFoundError('That income source no longer exists.');

  if (args.effectiveFrom < template.startDate) {
    throw new ValidationError('An amount cannot start before the source does.', {
      effectiveFrom: [`This source starts on ${template.startDate}.`],
    });
  }

  const audit = auditContextOf(ctx);

  if (args.expected.state === 'absent') {
    try {
      return await insertTermIn(tx, audit, {
        templateId: args.templateId,
        effectiveFrom: args.effectiveFrom,
        amount: args.amount,
        grossAmount: args.grossAmount ?? null,
        note: args.note ?? null,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateConflictError(
          `There is already an amount starting ${args.effectiveFrom}. Reload to see it before changing it.`,
        );
      }
      throw error;
    }
  }

  const existing = await findTermAtIn(tx, args.templateId, args.effectiveFrom, { lock: 'update' });
  if (existing === undefined) {
    // The row the client was editing is gone. Inserting instead would recreate
    // an amount somebody deliberately removed.
    throw new VersionConflictError(
      `The amount starting ${args.effectiveFrom} is no longer there. Reload before changing it.`,
    );
  }

  const updated = await updateTermIn(tx, audit, existing.id, args.expected.version, {
    amount: args.amount,
    grossAmount: args.grossAmount ?? null,
    note: args.note ?? null,
  });
  if (updated === undefined) {
    throw new VersionConflictError('This amount changed while you were editing it.');
  }
  return updated;
}

/**
 * "From this month on": a new term effective at the occurrence's **scheduled**
 * date (§30.9 item 4).
 *
 * Keying it to the occurrence rather than to today is what makes an early
 * payment behave: a raise effective 1 October applies to the October occurrence
 * even when the money arrived on 30 September. Already materialized flows are
 * untouched — a term is what a *suggestion* is worth, not a correction to what
 * was recorded.
 *
 * ## The caller says what it expected to find
 *
 * A term amount is a source financial value, so "create or update" is decided
 * by the client's stated expectation, never by a read the server takes for
 * itself. Reading the current row and updating with the version just read
 * prevents a blind SQL write and permits the lost update that matters: two
 * people open the same term at version 3, one saves 2,200, the other saves
 * 2,150 against a stale form, and the second silently overwrites the first
 * because the server refreshed the version on its behalf.
 *
 * So `expected` is required. `absent` inserts and lets the
 * `UNIQUE (template_id, effective_from)` constraint answer — not a prior read,
 * which another transaction can invalidate between the check and the write.
 * `version` updates that exact row under 20.3's optimistic check, and a
 * vanished row is a conflict rather than a quiet insert.
 */
export async function setTemplateTerm(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: SetTemplateTermArgs,
): Promise<RecurringTemplateTermRow> {
  return withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    setTemplateTermIn(tx, ctx, args),
  );
}

/** Templates as a page lists them: an ordinary read, on the ordinary path. */
export async function listUserTemplates(
  deps: FlowDependencies,
  ctx: RequestContext,
  options: { includeArchived?: boolean } = {},
): Promise<RecurringTemplateRow[]> {
  return listTemplates(deps.db, ctx.userId, options);
}
