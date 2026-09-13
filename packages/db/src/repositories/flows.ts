import { and, asc, between, eq, isNotNull } from 'drizzle-orm';
import { expenseEntries } from '../schema/expense-entries';
import { incomeEntries } from '../schema/income-entries';
import { transfers } from '../schema/transfers';
import { withUser, type Database, type Transaction } from '../client';
import { recordAudit, type AuditContext } from './audited';

/**
 * The three flow tables (blueprint 6.2, 18.1, 20.3).
 *
 * Income, expenses and transfers share a shape: an audited insert, an audited
 * update under an optimistic version, an audited hard delete with a
 * before-image, and reads bounded by a date range. They are together in one
 * module because the rules that make them safe are the same rules, and a reader
 * checking "is every flow write audited?" should be able to answer it here.
 *
 * Two things worth knowing before editing this file:
 *
 *  - **the occurrence pair is written together or not at all.** `template_id`
 *    and `occurrence_date` are both set when a row materializes a recurring
 *    occurrence and both NULL otherwise; a database CHECK enforces it and the
 *    inputs here make the pair a single optional argument so no caller can set
 *    half of it.
 *  - **`occurrence_date` is never in a patch.** It is scheduling identity, so a
 *    correction to a financial date must not move it; the patch types simply do
 *    not carry the field (§30.9 item 2).
 */

import type { ExpenseEntryRow } from '../schema/expense-entries';
import type { IncomeEntryRow } from '../schema/income-entries';
import type { TransferRow } from '../schema/transfers';

/** The scheduled occurrence a flow materializes, when it materializes one. */
export interface OccurrenceRef {
  readonly templateId: string;
  readonly occurrenceDate: string;
}

function occurrenceColumns(occurrence: OccurrenceRef | undefined) {
  return occurrence === undefined
    ? { templateId: null, occurrenceDate: null }
    : { templateId: occurrence.templateId, occurrenceDate: occurrence.occurrenceDate };
}

/**
 * Typed position references always set the id and its companion kind together.
 *
 * Setting the id alone would satisfy the `MATCH SIMPLE` composite foreign key
 * without referencing anything at all (see `schema/typed-position-ref.ts`), so
 * the two are produced by one function and never assigned separately.
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

/* ------------------------------------------------------------------------- */
/* Income                                                                     */
/* ------------------------------------------------------------------------- */

export interface IncomeEntryInput {
  readonly kind: IncomeEntryRow['kind'];
  readonly receivedOn: string;
  readonly netAmount: string;
  readonly grossAmount?: string | null;
  readonly currency: string;
  readonly settlement: IncomeEntryRow['settlement'];
  readonly cashPositionId?: string | null;
  readonly propertyPositionId?: string | null;
  readonly description?: string | null;
  readonly tags?: string[];
  readonly isOneOff?: boolean;
  readonly occurrence?: OccurrenceRef;
}

export async function insertIncomeEntry(
  db: Database,
  ctx: AuditContext,
  input: IncomeEntryInput,
): Promise<IncomeEntryRow> {
  return withUser(db, { userId: ctx.userId }, async (tx) => insertIncomeEntryIn(tx, ctx, input));
}

export async function insertIncomeEntryIn(
  tx: Transaction,
  ctx: AuditContext,
  input: IncomeEntryInput,
): Promise<IncomeEntryRow> {
  const [row] = await tx
    .insert(incomeEntries)
    .values({
      userId: ctx.userId,
      kind: input.kind,
      receivedOn: input.receivedOn,
      netAmount: input.netAmount,
      grossAmount: input.grossAmount ?? null,
      currency: input.currency,
      settlement: input.settlement,
      description: input.description ?? null,
      tags: input.tags ?? [],
      isOneOff: input.isOneOff ?? false,
      ...occurrenceColumns(input.occurrence),
      ...cashRef(input.cashPositionId),
      ...propertyRef(input.propertyPositionId),
    } as typeof incomeEntries.$inferInsert)
    .returning();

  const created = row as IncomeEntryRow;
  await recordAudit(tx, ctx, {
    entityTable: 'income_entries',
    entityId: created.id,
    action: 'insert',
    after: created,
  });
  return created;
}

/** No `occurrenceDate`: scheduling identity is immutable after creation. */
export interface IncomeEntryPatch {
  kind?: IncomeEntryRow['kind'];
  receivedOn?: string;
  netAmount?: string;
  grossAmount?: string | null;
  settlement?: IncomeEntryRow['settlement'];
  cashPositionId?: string | null;
  description?: string | null;
  tags?: string[];
  isOneOff?: boolean;
}

export async function updateIncomeEntry(
  db: Database,
  ctx: AuditContext,
  entryId: string,
  expectedVersion: number,
  patch: IncomeEntryPatch,
): Promise<IncomeEntryRow | undefined> {
  return withUser(db, { userId: ctx.userId }, async (tx) =>
    updateIncomeEntryIn(tx, ctx, entryId, expectedVersion, patch),
  );
}

export async function updateIncomeEntryIn(
  tx: Transaction,
  ctx: AuditContext,
  entryId: string,
  expectedVersion: number,
  patch: IncomeEntryPatch,
): Promise<IncomeEntryRow | undefined> {
  const [before] = await tx
    .select()
    .from(incomeEntries)
    .where(eq(incomeEntries.id, entryId))
    .limit(1)
    .for('update');
  if (before === undefined) return undefined;

  const { cashPositionId, ...rest } = patch;
  const values = {
    ...rest,
    ...(cashPositionId === undefined ? {} : cashRef(cashPositionId)),
    version: expectedVersion + 1,
  };

  const [row] = await tx
    .update(incomeEntries)
    .set(values as Partial<typeof incomeEntries.$inferInsert>)
    .where(and(eq(incomeEntries.id, entryId), eq(incomeEntries.version, expectedVersion)))
    .returning();
  if (row === undefined) return undefined;

  await recordAudit(tx, ctx, {
    entityTable: 'income_entries',
    entityId: entryId,
    action: 'update',
    before,
    after: row,
  });
  return row;
}

export async function deleteIncomeEntry(
  db: Database,
  ctx: AuditContext,
  entryId: string,
): Promise<IncomeEntryRow | undefined> {
  return withUser(db, { userId: ctx.userId }, async (tx) => {
    const [before] = await tx
      .select()
      .from(incomeEntries)
      .where(eq(incomeEntries.id, entryId))
      .limit(1)
      .for('update');
    if (before === undefined) return undefined;

    await tx.delete(incomeEntries).where(eq(incomeEntries.id, entryId));
    await recordAudit(tx, ctx, {
      entityTable: 'income_entries',
      entityId: entryId,
      action: 'delete',
      before,
    });
    return before;
  });
}

export async function findIncomeEntry(
  db: Database,
  userId: string,
  entryId: string,
): Promise<IncomeEntryRow | undefined> {
  const [row] = await withUser(db, { userId }, async (tx) =>
    tx.select().from(incomeEntries).where(eq(incomeEntries.id, entryId)).limit(1),
  );
  return row;
}

export async function listIncomeEntries(
  db: Database,
  userId: string,
  from: string,
  to: string,
): Promise<IncomeEntryRow[]> {
  return withUser(db, { userId }, async (tx) =>
    tx
      .select()
      .from(incomeEntries)
      .where(between(incomeEntries.receivedOn, from, to))
      .orderBy(asc(incomeEntries.receivedOn), asc(incomeEntries.id)),
  );
}

/**
 * Income entries by the **scheduled** date of the occurrence they materialize,
 * inside an existing scope (blueprint 6.2, 15.3 section 2).
 *
 * The sibling above asks "what money arrived in this month?" and this one asks
 * "which of this month's occurrences were recorded?". They are different
 * questions and they return different rows: a salary scheduled for 1 October
 * and received on 30 September answers the first for September and the second
 * for October, and a read keyed on `received_on` alone cannot see it from
 * October at all (§30.9 item 2).
 *
 * Takes the transaction rather than the database so a caller composing one
 * user-scoped read does not open a second one.
 */
export async function listIncomeEntriesByOccurrenceIn(
  tx: Transaction,
  from: string,
  to: string,
): Promise<IncomeEntryRow[]> {
  return tx
    .select()
    .from(incomeEntries)
    .where(
      and(
        isNotNull(incomeEntries.occurrenceDate),
        between(incomeEntries.occurrenceDate, from, to),
      ),
    )
    .orderBy(asc(incomeEntries.occurrenceDate), asc(incomeEntries.id));
}

/* ------------------------------------------------------------------------- */
/* Expenses                                                                   */
/* ------------------------------------------------------------------------- */

export interface ExpenseEntryInput {
  readonly categoryId: string;
  readonly incurredOn: string;
  readonly amount: string;
  readonly currency: string;
  readonly settlement: ExpenseEntryRow['settlement'];
  readonly cashPositionId?: string | null;
  readonly propertyPositionId?: string | null;
  readonly transferId?: string | null;
  readonly description?: string | null;
  readonly tags?: string[];
  readonly isOneOff?: boolean;
  readonly occurrence?: OccurrenceRef;
}

export async function insertExpenseEntry(
  db: Database,
  ctx: AuditContext,
  input: ExpenseEntryInput,
): Promise<ExpenseEntryRow> {
  return withUser(db, { userId: ctx.userId }, async (tx) => insertExpenseEntryIn(tx, ctx, input));
}

export async function insertExpenseEntryIn(
  tx: Transaction,
  ctx: AuditContext,
  input: ExpenseEntryInput,
): Promise<ExpenseEntryRow> {
  const [row] = await tx
    .insert(expenseEntries)
    .values({
      userId: ctx.userId,
      categoryId: input.categoryId,
      incurredOn: input.incurredOn,
      amount: input.amount,
      currency: input.currency,
      settlement: input.settlement,
      transferId: input.transferId ?? null,
      description: input.description ?? null,
      tags: input.tags ?? [],
      isOneOff: input.isOneOff ?? false,
      ...occurrenceColumns(input.occurrence),
      ...cashRef(input.cashPositionId),
      ...propertyRef(input.propertyPositionId),
    } as typeof expenseEntries.$inferInsert)
    .returning();

  const created = row as ExpenseEntryRow;
  await recordAudit(tx, ctx, {
    entityTable: 'expense_entries',
    entityId: created.id,
    action: 'insert',
    after: created,
  });
  return created;
}

export interface ExpenseEntryPatch {
  categoryId?: string;
  incurredOn?: string;
  amount?: string;
  currency?: string;
  settlement?: ExpenseEntryRow['settlement'];
  cashPositionId?: string | null;
  description?: string | null;
  tags?: string[];
  isOneOff?: boolean;
}

export async function updateExpenseEntry(
  db: Database,
  ctx: AuditContext,
  entryId: string,
  expectedVersion: number,
  patch: ExpenseEntryPatch,
): Promise<ExpenseEntryRow | undefined> {
  return withUser(db, { userId: ctx.userId }, async (tx) =>
    updateExpenseEntryIn(tx, ctx, entryId, expectedVersion, patch),
  );
}

export async function updateExpenseEntryIn(
  tx: Transaction,
  ctx: AuditContext,
  entryId: string,
  expectedVersion: number,
  patch: ExpenseEntryPatch,
): Promise<ExpenseEntryRow | undefined> {
  const [before] = await tx
    .select()
    .from(expenseEntries)
    .where(eq(expenseEntries.id, entryId))
    .limit(1)
    .for('update');
  if (before === undefined) return undefined;

  const { cashPositionId, ...rest } = patch;
  const values = {
    ...rest,
    ...(cashPositionId === undefined ? {} : cashRef(cashPositionId)),
    version: expectedVersion + 1,
  };

  const [row] = await tx
    .update(expenseEntries)
    .set(values as Partial<typeof expenseEntries.$inferInsert>)
    .where(and(eq(expenseEntries.id, entryId), eq(expenseEntries.version, expectedVersion)))
    .returning();
  if (row === undefined) return undefined;

  await recordAudit(tx, ctx, {
    entityTable: 'expense_entries',
    entityId: entryId,
    action: 'update',
    before,
    after: row,
  });
  return row;
}

export async function deleteExpenseEntry(
  db: Database,
  ctx: AuditContext,
  entryId: string,
): Promise<ExpenseEntryRow | undefined> {
  return withUser(db, { userId: ctx.userId }, async (tx) =>
    deleteExpenseEntryIn(tx, ctx, entryId),
  );
}

export async function deleteExpenseEntryIn(
  tx: Transaction,
  ctx: AuditContext,
  entryId: string,
): Promise<ExpenseEntryRow | undefined> {
  const [before] = await tx
    .select()
    .from(expenseEntries)
    .where(eq(expenseEntries.id, entryId))
    .limit(1)
    .for('update');
  if (before === undefined) return undefined;

  await tx.delete(expenseEntries).where(eq(expenseEntries.id, entryId));
  await recordAudit(tx, ctx, {
    entityTable: 'expense_entries',
    entityId: entryId,
    action: 'delete',
    before,
  });
  return before;
}

export async function findExpenseEntry(
  db: Database,
  userId: string,
  entryId: string,
): Promise<ExpenseEntryRow | undefined> {
  const [row] = await withUser(db, { userId }, async (tx) =>
    tx.select().from(expenseEntries).where(eq(expenseEntries.id, entryId)).limit(1),
  );
  return row;
}

export async function listExpenseEntries(
  db: Database,
  userId: string,
  from: string,
  to: string,
): Promise<ExpenseEntryRow[]> {
  return withUser(db, { userId }, async (tx) =>
    tx
      .select()
      .from(expenseEntries)
      .where(between(expenseEntries.incurredOn, from, to))
      .orderBy(asc(expenseEntries.incurredOn), asc(expenseEntries.id)),
  );
}

/**
 * Expense entries by the **scheduled** date of the occurrence they materialize,
 * inside an existing scope (blueprint 6.2, 15.3 section 3).
 *
 * The expense twin of `listIncomeEntriesByOccurrenceIn`, for the same reason:
 * the sibling above asks "what was spent in this month?" and this one asks
 * "which of this month's occurrences were recorded?". A gym fee scheduled for
 * 1 October and paid on 30 September answers the first for September and the
 * second for October, and a read keyed on `incurred_on` alone cannot see it
 * from October at all (§30.9 item 2).
 *
 * Takes the transaction rather than the database so a caller composing one
 * user-scoped read does not open a second one.
 */
export async function listExpenseEntriesByOccurrenceIn(
  tx: Transaction,
  from: string,
  to: string,
): Promise<ExpenseEntryRow[]> {
  return tx
    .select()
    .from(expenseEntries)
    .where(
      and(
        isNotNull(expenseEntries.occurrenceDate),
        between(expenseEntries.occurrenceDate, from, to),
      ),
    )
    .orderBy(asc(expenseEntries.occurrenceDate), asc(expenseEntries.id));
}

/** The fee rows linked to a transfer. Normally one; the query does not assume it. */
export async function findTransferFeesIn(
  tx: Transaction,
  transferId: string,
): Promise<ExpenseEntryRow[]> {
  return tx
    .select()
    .from(expenseEntries)
    .where(eq(expenseEntries.transferId, transferId))
    .orderBy(asc(expenseEntries.id))
    .for('update');
}

export async function findTransferFees(
  db: Database,
  userId: string,
  transferId: string,
): Promise<ExpenseEntryRow[]> {
  return withUser(db, { userId }, async (tx) =>
    tx
      .select()
      .from(expenseEntries)
      .where(and(eq(expenseEntries.transferId, transferId), isNotNull(expenseEntries.transferId)))
      .orderBy(asc(expenseEntries.id)),
  );
}

/* ------------------------------------------------------------------------- */
/* Transfers                                                                  */
/* ------------------------------------------------------------------------- */

export interface TransferInput {
  readonly kind: TransferRow['kind'];
  readonly occurredOn: string;
  readonly fromPositionId?: string | null;
  readonly fromCurrency: string;
  readonly fromAmount: string;
  readonly toPositionId?: string | null;
  readonly toCurrency: string;
  readonly toAmount: string;
  readonly description?: string | null;
  readonly tags?: string[];
  readonly occurrence?: OccurrenceRef;
}

export async function insertTransferIn(
  tx: Transaction,
  ctx: AuditContext,
  input: TransferInput,
): Promise<TransferRow> {
  const [row] = await tx
    .insert(transfers)
    .values({
      userId: ctx.userId,
      kind: input.kind,
      occurredOn: input.occurredOn,
      fromPositionId: input.fromPositionId ?? null,
      fromCurrency: input.fromCurrency,
      fromAmount: input.fromAmount,
      toPositionId: input.toPositionId ?? null,
      toCurrency: input.toCurrency,
      toAmount: input.toAmount,
      description: input.description ?? null,
      tags: input.tags ?? [],
      ...occurrenceColumns(input.occurrence),
    })
    .returning();

  const created = row as TransferRow;
  await recordAudit(tx, ctx, {
    entityTable: 'transfers',
    entityId: created.id,
    action: 'insert',
    after: created,
  });
  return created;
}

export interface TransferPatch {
  occurredOn?: string;
  fromPositionId?: string | null;
  fromCurrency?: string;
  fromAmount?: string;
  toPositionId?: string | null;
  toCurrency?: string;
  toAmount?: string;
  description?: string | null;
  tags?: string[];
}

export async function updateTransferIn(
  tx: Transaction,
  ctx: AuditContext,
  transferId: string,
  expectedVersion: number,
  patch: TransferPatch,
): Promise<TransferRow | undefined> {
  const [before] = await tx
    .select()
    .from(transfers)
    .where(eq(transfers.id, transferId))
    .limit(1)
    .for('update');
  if (before === undefined) return undefined;

  const [row] = await tx
    .update(transfers)
    .set({ ...patch, version: expectedVersion + 1 })
    .where(and(eq(transfers.id, transferId), eq(transfers.version, expectedVersion)))
    .returning();
  if (row === undefined) return undefined;

  await recordAudit(tx, ctx, {
    entityTable: 'transfers',
    entityId: transferId,
    action: 'update',
    before,
    after: row,
  });
  return row;
}

export async function deleteTransferIn(
  tx: Transaction,
  ctx: AuditContext,
  transferId: string,
): Promise<TransferRow | undefined> {
  const [before] = await tx
    .select()
    .from(transfers)
    .where(eq(transfers.id, transferId))
    .limit(1)
    .for('update');
  if (before === undefined) return undefined;

  await tx.delete(transfers).where(eq(transfers.id, transferId));
  await recordAudit(tx, ctx, {
    entityTable: 'transfers',
    entityId: transferId,
    action: 'delete',
    before,
  });
  return before;
}

export async function findTransfer(
  db: Database,
  userId: string,
  transferId: string,
): Promise<TransferRow | undefined> {
  const [row] = await withUser(db, { userId }, async (tx) =>
    tx.select().from(transfers).where(eq(transfers.id, transferId)).limit(1),
  );
  return row;
}

export async function listTransfers(
  db: Database,
  userId: string,
  from: string,
  to: string,
): Promise<TransferRow[]> {
  return withUser(db, { userId }, async (tx) =>
    tx
      .select()
      .from(transfers)
      .where(between(transfers.occurredOn, from, to))
      .orderBy(asc(transfers.occurredOn), asc(transfers.id)),
  );
}
