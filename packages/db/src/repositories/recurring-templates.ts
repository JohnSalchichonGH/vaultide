import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { expenseEntries } from '../schema/expense-entries';
import { incomeEntries } from '../schema/income-entries';
import { recurringTemplateSkips } from '../schema/recurring-template-skips';
import { recurringTemplateTerms, recurringTemplates } from '../schema/recurring-templates';
import { transfers } from '../schema/transfers';
import { withUser, type Database, type Transaction } from '../client';
import { recordAudit, type AuditContext } from './audited';

/**
 * Recurring templates, their terms and their skips (blueprint 6.2, 18.1, 20.3).
 *
 * Three tables, one aggregate. Everything here is audited inside the caller's
 * transaction, and the two functions that decide an occurrence's fate —
 * `lockTemplate` and the skip writer — exist so the application can serialize
 * accept against skip on the template row rather than hoping two requests do
 * not interleave (20.3).
 *
 * There is deliberately **no** `deleteTemplate`. 6.3 permits hard-deleting an
 * unreferenced template, but its terms and skips cascade, and a skip can carry
 * an occupancy fact (`vacant`, `non_payment`, 11.2) whose deletion has to be
 * audited like any other financial record. Until a phase defines that child-row
 * behaviour deliberately, retirement is archiving — which loses nothing, since
 * an archived template stops generating suggestions and keeps all its history.
 */

import type { RecurringTemplateSkipRow } from '../schema/recurring-template-skips';
import type {
  RecurringTemplateRow,
  RecurringTemplateTermRow,
} from '../schema/recurring-templates';

export interface TemplateInput {
  readonly kind: RecurringTemplateRow['kind'];
  readonly name: string;
  readonly counterparty?: string | null;
  readonly incomeKind?: RecurringTemplateRow['incomeKind'];
  readonly categoryId?: string | null;
  readonly currency: string;
  readonly frequency: RecurringTemplateRow['frequency'];
  readonly dayOfMonth?: number | null;
  readonly startDate: string;
  readonly endDate?: string | null;
  readonly cashPositionId?: string | null;
  readonly propertyPositionId?: string | null;
}

/**
 * The typed position reference of 6.1 always sets its companion kind column
 * with its id, never one without the other: a set id with a NULL kind would
 * satisfy the `MATCH SIMPLE` foreign key without referencing anything.
 */
function cashRef(positionId: string | null | undefined) {
  return positionId === null || positionId === undefined
    ? { cashPositionId: null, cashPositionKind: null }
    : { cashPositionId: positionId, cashPositionKind: 'cash' as const };
}

function propertyRef(positionId: string | null | undefined) {
  return positionId === null || positionId === undefined
    ? { propertyPositionId: null, propertyPositionKind: null }
    : { propertyPositionId: positionId, propertyPositionKind: 'property' as const };
}

export async function listTemplates(
  db: Database,
  userId: string,
  options: { includeArchived?: boolean } = {},
): Promise<RecurringTemplateRow[]> {
  return withUser(db, { userId }, async (tx) =>
    tx
      .select()
      .from(recurringTemplates)
      .where(
        options.includeArchived === true ? undefined : isNull(recurringTemplates.archivedAt),
      )
      .orderBy(asc(recurringTemplates.name)),
  );
}

export async function findTemplate(
  db: Database,
  userId: string,
  templateId: string,
): Promise<RecurringTemplateRow | undefined> {
  const [row] = await withUser(db, { userId }, async (tx) =>
    tx.select().from(recurringTemplates).where(eq(recurringTemplates.id, templateId)).limit(1),
  );
  return row;
}

/**
 * Take the template row's lock, inside an existing transaction.
 *
 * This is the serialization point for accept and skip (20.3). Both facts live
 * in different tables, so checking one and inserting into the other is not
 * atomic on its own; holding this row makes the pair of checks and the write
 * one indivisible step, and two concurrent requests queue instead of both
 * seeing an empty occurrence.
 */
export async function lockTemplateIn(
  tx: Transaction,
  templateId: string,
): Promise<RecurringTemplateRow | undefined> {
  const [row] = await tx
    .select()
    .from(recurringTemplates)
    .where(eq(recurringTemplates.id, templateId))
    .limit(1)
    .for('update');
  return row;
}

export async function insertTemplate(
  db: Database,
  ctx: AuditContext,
  input: TemplateInput,
): Promise<RecurringTemplateRow> {
  return withUser(db, { userId: ctx.userId }, async (tx) => {
    const [row] = await tx
      .insert(recurringTemplates)
      .values({
        userId: ctx.userId,
        kind: input.kind,
        name: input.name,
        counterparty: input.counterparty ?? null,
        incomeKind: input.incomeKind ?? null,
        categoryId: input.categoryId ?? null,
        currency: input.currency,
        frequency: input.frequency,
        dayOfMonth: input.dayOfMonth ?? null,
        startDate: input.startDate,
        endDate: input.endDate ?? null,
        ...cashRef(input.cashPositionId),
        ...propertyRef(input.propertyPositionId),
      })
      .returning();

    const created = row as RecurringTemplateRow;
    await recordAudit(tx, ctx, {
      entityTable: 'recurring_templates',
      entityId: created.id,
      action: 'insert',
      after: created,
    });
    return created;
  });
}

export interface TemplatePatch {
  name?: string;
  counterparty?: string | null;
  endDate?: string | null;
  archivedAt?: Date | null;
}

export async function updateTemplate(
  db: Database,
  ctx: AuditContext,
  templateId: string,
  expectedVersion: number,
  patch: TemplatePatch,
): Promise<RecurringTemplateRow | undefined> {
  return withUser(db, { userId: ctx.userId }, async (tx) => {
    const before = await lockTemplateIn(tx, templateId);
    if (before === undefined) return undefined;

    const [row] = await tx
      .update(recurringTemplates)
      .set({ ...patch, version: expectedVersion + 1 })
      .where(
        and(
          eq(recurringTemplates.id, templateId),
          eq(recurringTemplates.version, expectedVersion),
        ),
      )
      .returning();
    if (row === undefined) return undefined;

    await recordAudit(tx, ctx, {
      entityTable: 'recurring_templates',
      entityId: templateId,
      action: 'update',
      before,
      after: row,
    });
    return row;
  });
}

/** `true` when any materialized flow or skip references this template. */
export async function templateHasHistory(
  db: Database,
  userId: string,
  templateId: string,
): Promise<boolean> {
  return withUser(db, { userId }, async (tx) => templateHasHistoryIn(tx, templateId));
}

export async function templateHasHistoryIn(
  tx: Transaction,
  templateId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({
      referenced: sql<boolean>`
        EXISTS (SELECT 1 FROM income_entries WHERE template_id = ${templateId})
        OR EXISTS (SELECT 1 FROM expense_entries WHERE template_id = ${templateId})
        OR EXISTS (SELECT 1 FROM transfers WHERE template_id = ${templateId})
        OR EXISTS (SELECT 1 FROM recurring_template_skips WHERE template_id = ${templateId})
      `,
    })
    .from(recurringTemplates)
    .where(eq(recurringTemplates.id, templateId))
    .limit(1);
  return row?.referenced === true;
}

/** The latest occurrence date any materialized flow or skip refers to. */
export async function latestReferencedOccurrence(
  db: Database,
  userId: string,
  templateId: string,
): Promise<string | undefined> {
  const [row] = await withUser(db, { userId }, async (tx) =>
    tx
      .select({
        latest: sql<string | null>`(
          SELECT max(d)::text FROM (
            SELECT occurrence_date AS d FROM income_entries WHERE template_id = ${templateId}
            UNION ALL
            SELECT occurrence_date FROM expense_entries WHERE template_id = ${templateId}
            UNION ALL
            SELECT occurrence_date FROM transfers WHERE template_id = ${templateId}
            UNION ALL
            SELECT occurrence_date FROM recurring_template_skips WHERE template_id = ${templateId}
          ) AS occurrences
        )`,
      })
      .from(recurringTemplates)
      .where(eq(recurringTemplates.id, templateId))
      .limit(1),
  );
  return row?.latest ?? undefined;
}

/* ------------------------------------------------------------------------- */
/* Terms                                                                      */
/* ------------------------------------------------------------------------- */

export interface TermInput {
  readonly templateId: string;
  readonly effectiveFrom: string;
  readonly amount: string;
  readonly grossAmount?: string | null;
  readonly note?: string | null;
}

export async function listTerms(
  db: Database,
  userId: string,
  templateId: string,
): Promise<RecurringTemplateTermRow[]> {
  return withUser(db, { userId }, async (tx) =>
    tx
      .select()
      .from(recurringTemplateTerms)
      .where(eq(recurringTemplateTerms.templateId, templateId))
      .orderBy(desc(recurringTemplateTerms.effectiveFrom)),
  );
}

/**
 * The terms a date range needs — **including the one that was already in force
 * when the range began**.
 *
 * A naive `effective_from >= rangeStart` would drop a term set years ago and
 * still effective, and the first suggestion on the page would lose its amount.
 * So this is two questions in one query: the latest term on or before
 * `rangeStart` per template, plus every term inside the range. The same shape
 * ADR 0004 §3 requires of valuations, for the same reason.
 */
export async function loadTermsForRange(
  db: Database,
  userId: string,
  templateIds: readonly string[],
  rangeStart: string,
  rangeEnd: string,
): Promise<RecurringTemplateTermRow[]> {
  if (templateIds.length === 0) return [];

  return withUser(db, { userId }, async (tx) => {
    const inRange = await tx
      .select()
      .from(recurringTemplateTerms)
      .where(
        and(
          inArray(recurringTemplateTerms.templateId, [...templateIds]),
          gt(recurringTemplateTerms.effectiveFrom, rangeStart),
          lte(recurringTemplateTerms.effectiveFrom, rangeEnd),
        ),
      );

    // `DISTINCT ON` gives the latest term at or before the range start for each
    // template in one pass rather than one query per template.
    const opening = await tx
      .select()
      .from(recurringTemplateTerms)
      .where(
        and(
          inArray(recurringTemplateTerms.templateId, [...templateIds]),
          lte(recurringTemplateTerms.effectiveFrom, rangeStart),
        ),
      )
      .orderBy(
        asc(recurringTemplateTerms.templateId),
        desc(recurringTemplateTerms.effectiveFrom),
      );

    const seen = new Set<string>();
    const latestOpening = opening.filter((row) => {
      if (seen.has(row.templateId)) return false;
      seen.add(row.templateId);
      return true;
    });

    return [...latestOpening, ...inRange];
  });
}

/**
 * PostgreSQL's `unique_violation`.
 *
 * `UNIQUE (template_id, effective_from)` is what actually decides whether a
 * term already exists at an effective date, so a caller that means "create,
 * and only if none exists" has to learn its answer from the constraint rather
 * than from a read it took a moment earlier.
 */
const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(error: unknown): boolean {
  // Drizzle wraps the driver error, so the SQLSTATE sits on `cause` rather than
  // on what was thrown. Walk the chain rather than assuming a depth.
  for (let current: unknown = error, depth = 0; current != null && depth < 5; depth += 1) {
    if ((current as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Find a template's term at an exact effective date, if it has one. */
export async function findTermAt(
  db: Database,
  userId: string,
  templateId: string,
  effectiveFrom: string,
): Promise<RecurringTemplateTermRow | undefined> {
  const [row] = await withUser(db, { userId }, async (tx) =>
    tx
      .select()
      .from(recurringTemplateTerms)
      .where(
        and(
          eq(recurringTemplateTerms.templateId, templateId),
          eq(recurringTemplateTerms.effectiveFrom, effectiveFrom),
        ),
      )
      .limit(1),
  );
  return row;
}

export async function insertTerm(
  db: Database,
  ctx: AuditContext,
  input: TermInput,
): Promise<RecurringTemplateTermRow> {
  return withUser(db, { userId: ctx.userId }, async (tx) => {
    const [row] = await tx
      .insert(recurringTemplateTerms)
      .values({
        userId: ctx.userId,
        templateId: input.templateId,
        effectiveFrom: input.effectiveFrom,
        amount: input.amount,
        grossAmount: input.grossAmount ?? null,
        note: input.note ?? null,
      })
      .returning();

    const created = row as RecurringTemplateTermRow;
    await recordAudit(tx, ctx, {
      entityTable: 'recurring_template_terms',
      entityId: created.id,
      action: 'insert',
      after: created,
    });
    return created;
  });
}

export async function updateTerm(
  db: Database,
  ctx: AuditContext,
  termId: string,
  expectedVersion: number,
  patch: { amount?: string; grossAmount?: string | null; note?: string | null },
): Promise<RecurringTemplateTermRow | undefined> {
  return withUser(db, { userId: ctx.userId }, async (tx) => {
    const [before] = await tx
      .select()
      .from(recurringTemplateTerms)
      .where(eq(recurringTemplateTerms.id, termId))
      .limit(1)
      .for('update');
    if (before === undefined) return undefined;

    const [row] = await tx
      .update(recurringTemplateTerms)
      .set({ ...patch, version: expectedVersion + 1 })
      .where(
        and(
          eq(recurringTemplateTerms.id, termId),
          eq(recurringTemplateTerms.version, expectedVersion),
        ),
      )
      .returning();
    if (row === undefined) return undefined;

    await recordAudit(tx, ctx, {
      entityTable: 'recurring_template_terms',
      entityId: termId,
      action: 'update',
      before,
      after: row,
    });
    return row;
  });
}

/**
 * Which occurrences of these templates already have a materialized flow.
 *
 * One query across the three flow tables rather than one per template. The
 * occurrence's identity is `(template_id, occurrence_date)` everywhere, so the
 * union is the whole answer (§30.9 item 2).
 */
export async function listMaterializedOccurrences(
  db: Database,
  userId: string,
  templateIds: readonly string[],
): Promise<{ templateId: string; occurrenceDate: string }[]> {
  if (templateIds.length === 0) return [];

  const ids = [...templateIds];
  return withUser(db, { userId }, async (tx) => {
    const [income, expenses, moves] = await Promise.all([
      tx
        .select({ templateId: incomeEntries.templateId, occurrenceDate: incomeEntries.occurrenceDate })
        .from(incomeEntries)
        .where(
          and(inArray(incomeEntries.templateId, ids), isNotNull(incomeEntries.occurrenceDate)),
        ),
      tx
        .select({
          templateId: expenseEntries.templateId,
          occurrenceDate: expenseEntries.occurrenceDate,
        })
        .from(expenseEntries)
        .where(
          and(inArray(expenseEntries.templateId, ids), isNotNull(expenseEntries.occurrenceDate)),
        ),
      tx
        .select({ templateId: transfers.templateId, occurrenceDate: transfers.occurrenceDate })
        .from(transfers)
        .where(and(inArray(transfers.templateId, ids), isNotNull(transfers.occurrenceDate))),
    ]);

    return [...income, ...expenses, ...moves].map((row) => ({
      templateId: row.templateId as string,
      occurrenceDate: row.occurrenceDate as string,
    }));
  });
}

/**
 * Every occurrence date of one template that is already resolved — by a
 * materialized flow or by an explicit skip.
 *
 * Read inside the transaction holding the template's lock, so the eligibility
 * decision of 30.10 sees the same state the write will (20.3).
 */
export async function listResolvedOccurrenceDatesIn(
  tx: Transaction,
  templateId: string,
): Promise<string[]> {
  const [income, expenses, moves, skips] = await Promise.all([
    tx
      .select({ occurrenceDate: incomeEntries.occurrenceDate })
      .from(incomeEntries)
      .where(
        and(eq(incomeEntries.templateId, templateId), isNotNull(incomeEntries.occurrenceDate)),
      ),
    tx
      .select({ occurrenceDate: expenseEntries.occurrenceDate })
      .from(expenseEntries)
      .where(
        and(eq(expenseEntries.templateId, templateId), isNotNull(expenseEntries.occurrenceDate)),
      ),
    tx
      .select({ occurrenceDate: transfers.occurrenceDate })
      .from(transfers)
      .where(and(eq(transfers.templateId, templateId), isNotNull(transfers.occurrenceDate))),
    tx
      .select({ occurrenceDate: recurringTemplateSkips.occurrenceDate })
      .from(recurringTemplateSkips)
      .where(eq(recurringTemplateSkips.templateId, templateId)),
  ]);

  return [...income, ...expenses, ...moves, ...skips].map(
    (row) => row.occurrenceDate as string,
  );
}

/**
 * Is this exact occurrence already materialized? Read inside the transaction
 * that holds the template's lock, so accept and skip cannot interleave (20.3).
 */
export async function hasMaterializedOccurrenceIn(
  tx: Transaction,
  templateId: string,
  occurrenceDate: string,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    SELECT id FROM income_entries
     WHERE template_id = ${templateId} AND occurrence_date = ${occurrenceDate}
     UNION ALL
    SELECT id FROM expense_entries
     WHERE template_id = ${templateId} AND occurrence_date = ${occurrenceDate}
     UNION ALL
    SELECT id FROM transfers
     WHERE template_id = ${templateId} AND occurrence_date = ${occurrenceDate}
     LIMIT 1
  `);
  return rows.rows.length > 0;
}

/* ------------------------------------------------------------------------- */
/* Skips                                                                      */
/* ------------------------------------------------------------------------- */

export async function listSkips(
  db: Database,
  userId: string,
  templateIds: readonly string[],
): Promise<RecurringTemplateSkipRow[]> {
  if (templateIds.length === 0) return [];
  return withUser(db, { userId }, async (tx) =>
    tx
      .select()
      .from(recurringTemplateSkips)
      .where(inArray(recurringTemplateSkips.templateId, [...templateIds])),
  );
}

export async function findSkipIn(
  tx: Transaction,
  templateId: string,
  occurrenceDate: string,
): Promise<RecurringTemplateSkipRow | undefined> {
  const [row] = await tx
    .select()
    .from(recurringTemplateSkips)
    .where(
      and(
        eq(recurringTemplateSkips.templateId, templateId),
        eq(recurringTemplateSkips.occurrenceDate, occurrenceDate),
      ),
    )
    .limit(1);
  return row;
}

export async function insertSkipIn(
  tx: Transaction,
  ctx: AuditContext,
  input: {
    templateId: string;
    occurrenceDate: string;
    reason: RecurringTemplateSkipRow['reason'];
    note?: string | null;
  },
): Promise<RecurringTemplateSkipRow> {
  const [row] = await tx
    .insert(recurringTemplateSkips)
    .values({
      userId: ctx.userId,
      templateId: input.templateId,
      occurrenceDate: input.occurrenceDate,
      reason: input.reason,
      note: input.note ?? null,
    })
    .returning();

  const created = row as RecurringTemplateSkipRow;
  await recordAudit(tx, ctx, {
    entityTable: 'recurring_template_skips',
    entityId: created.id,
    action: 'insert',
    after: created,
  });
  return created;
}

/** Un-skip: a hard delete with its before-image (6.3). */
export async function deleteSkip(
  db: Database,
  ctx: AuditContext,
  skipId: string,
): Promise<RecurringTemplateSkipRow | undefined> {
  return withUser(db, { userId: ctx.userId }, async (tx) => {
    const [before] = await tx
      .select()
      .from(recurringTemplateSkips)
      .where(eq(recurringTemplateSkips.id, skipId))
      .limit(1)
      .for('update');
    if (before === undefined) return undefined;

    await tx.delete(recurringTemplateSkips).where(eq(recurringTemplateSkips.id, skipId));

    await recordAudit(tx, ctx, {
      entityTable: 'recurring_template_skips',
      entityId: skipId,
      action: 'delete',
      before,
    });
    return before;
  });
}

/** Templates active at any point in a date range — what suggestions need. */
export async function listTemplatesForRange(
  db: Database,
  userId: string,
  from: string,
  to: string,
): Promise<RecurringTemplateRow[]> {
  return withUser(db, { userId }, async (tx) =>
    tx
      .select()
      .from(recurringTemplates)
      .where(
        and(
          lte(recurringTemplates.startDate, to),
          or(isNull(recurringTemplates.endDate), sql`${recurringTemplates.endDate} >= ${from}`),
        ),
      )
      .orderBy(asc(recurringTemplates.name)),
  );
}
