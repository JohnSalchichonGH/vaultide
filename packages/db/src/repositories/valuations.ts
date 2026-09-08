import { and, desc, eq, lte } from 'drizzle-orm';
import { positionValuations } from '../schema/position-valuations';
import { withUser, type Database, type Transaction } from '../client';
import { recordAudit, type AuditContext } from './audited';

/**
 * `position_valuations` reads and writes (blueprint 6.2, 18.1, 20.3).
 *
 * A valuation is a snapshot: what a position was worth on a date. These
 * functions insert, correct and delete them, always with an audit image, and
 * always inside `withUser`.
 *
 * What they deliberately do not do is derive anything. There is no "current
 * balance" column to keep in step, no running total, no cached net worth: the
 * value at any date is computed from these rows by the finance engine, so a
 * correction to a six-month-old balance simply changes what every later figure
 * reads (5.3, D1).
 */

export type ValuationRow = typeof positionValuations.$inferSelect;

export async function listValuations(
  db: Database,
  userId: string,
  positionId: string,
): Promise<ValuationRow[]> {
  return withUser(db, { userId }, async (tx) =>
    tx
      .select()
      .from(positionValuations)
      .where(eq(positionValuations.positionId, positionId))
      .orderBy(desc(positionValuations.valuedOn)),
  );
}

export async function findValuation(
  db: Database,
  userId: string,
  valuationId: string,
): Promise<ValuationRow | undefined> {
  const [row] = await withUser(db, { userId }, async (tx) =>
    tx.select().from(positionValuations).where(eq(positionValuations.id, valuationId)).limit(1),
  );
  return row;
}

export async function findValuationOn(
  db: Database,
  userId: string,
  positionId: string,
  valuedOn: string,
): Promise<ValuationRow | undefined> {
  const [row] = await withUser(db, { userId }, async (tx) =>
    tx
      .select()
      .from(positionValuations)
      .where(
        and(
          eq(positionValuations.positionId, positionId),
          eq(positionValuations.valuedOn, valuedOn),
        ),
      )
      .limit(1),
  );
  return row;
}

/** The latest valuation on or before a date — the "current balance" question. */
export async function findLatestValuation(
  db: Database,
  userId: string,
  positionId: string,
  onOrBefore: string,
): Promise<ValuationRow | undefined> {
  const [row] = await withUser(db, { userId }, async (tx) =>
    tx
      .select()
      .from(positionValuations)
      .where(
        and(
          eq(positionValuations.positionId, positionId),
          lte(positionValuations.valuedOn, onOrBefore),
        ),
      )
      .orderBy(desc(positionValuations.valuedOn))
      .limit(1),
  );
  return row;
}

export interface ValuationInput {
  readonly positionId: string;
  readonly valuedOn: string;
  readonly amount: string;
  readonly source: ValuationRow['source'];
  readonly datePrecision: ValuationRow['datePrecision'];
  readonly note?: string | null;
}

export async function insertValuation(
  db: Database,
  ctx: AuditContext,
  input: ValuationInput,
): Promise<ValuationRow> {
  return withUser(db, { userId: ctx.userId }, async (tx) => insertValuationIn(tx, ctx, input));
}

/** The insert itself, so a caller already inside a transaction can reuse it. */
export async function insertValuationIn(
  tx: Transaction,
  ctx: AuditContext,
  input: ValuationInput,
): Promise<ValuationRow> {
  const [row] = await tx
    .insert(positionValuations)
    .values({
      userId: ctx.userId,
      positionId: input.positionId,
      valuedOn: input.valuedOn,
      amount: input.amount,
      source: input.source,
      datePrecision: input.datePrecision,
      note: input.note ?? null,
    })
    .returning();

  const created = row as ValuationRow;
  await recordAudit(tx, ctx, {
    entityTable: 'position_valuations',
    entityId: created.id,
    action: 'insert',
    after: created,
  });
  return created;
}

export interface ValuationPatch {
  amount?: string;
  valuedOn?: string;
  datePrecision?: ValuationRow['datePrecision'];
  source?: ValuationRow['source'];
  note?: string | null;
}

/**
 * Correct a valuation in place, under an optimistic version check (20.3), with
 * a before-image (18.1). `undefined` means the row moved on or is not the
 * caller's — the service tells those apart with a second read.
 */
export async function updateValuation(
  db: Database,
  ctx: AuditContext,
  valuationId: string,
  expectedVersion: number,
  patch: ValuationPatch,
): Promise<ValuationRow | undefined> {
  return withUser(db, { userId: ctx.userId }, async (tx) =>
    updateValuationIn(tx, ctx, valuationId, expectedVersion, patch),
  );
}

export async function updateValuationIn(
  tx: Transaction,
  ctx: AuditContext,
  valuationId: string,
  expectedVersion: number,
  patch: ValuationPatch,
): Promise<ValuationRow | undefined> {
  const [before] = await tx
    .select()
    .from(positionValuations)
    .where(eq(positionValuations.id, valuationId))
    .limit(1)
    .for('update');
  if (before === undefined) return undefined;

  const [row] = await tx
    .update(positionValuations)
    .set({ ...patch, version: expectedVersion + 1 })
    .where(
      and(
        eq(positionValuations.id, valuationId),
        eq(positionValuations.version, expectedVersion),
      ),
    )
    .returning();
  if (row === undefined) return undefined;

  await recordAudit(tx, ctx, {
    entityTable: 'position_valuations',
    entityId: valuationId,
    action: 'update',
    before: before,
    after: row,
  });
  return row;
}

/**
 * Hard-delete a valuation, keeping its full before-image (R12, T7).
 *
 * Financial rows are deleted rather than flagged, because a soft-deleted
 * balance is a balance every later query has to remember to exclude. The audit
 * row is what makes that safe.
 */
export async function deleteValuation(
  db: Database,
  ctx: AuditContext,
  valuationId: string,
): Promise<ValuationRow | undefined> {
  return withUser(db, { userId: ctx.userId }, async (tx) => {
    const [before] = await tx
      .select()
      .from(positionValuations)
      .where(eq(positionValuations.id, valuationId))
      .limit(1)
      .for('update');
    if (before === undefined) return undefined;

    await tx.delete(positionValuations).where(eq(positionValuations.id, valuationId));

    await recordAudit(tx, ctx, {
      entityTable: 'position_valuations',
      entityId: valuationId,
      action: 'delete',
      before: before,
    });
    return before;
  });
}

export interface QuickUpdateEntry {
  readonly positionId: string;
  readonly amount: string;
  readonly expectedVersion?: number;
}

export interface QuickUpdateResult {
  readonly written: ValuationRow[];
  readonly inserted: number;
  readonly corrected: number;
}

/**
 * Quick update (15.3): today's balance for several positions at once.
 *
 * **One transaction, all or nothing.** 20.3 says a bulk save "aborts entirely
 * on any conflict", and a half-applied balance sheet is exactly the state that
 * would make a net-worth figure quietly wrong — so the same rule applies here.
 *
 * Each entry writes an ordinary `exact` valuation dated today. A position that
 * already has one for today is **corrected** rather than duplicated (M1: one
 * valuation per position per date) — that touches today's row and no other, so
 * no history is overwritten and no earlier snapshot moves.
 */
export async function quickUpdateValuations(
  db: Database,
  ctx: AuditContext,
  today: string,
  entries: readonly QuickUpdateEntry[],
): Promise<QuickUpdateResult> {
  return withUser(db, { userId: ctx.userId }, async (tx) => {
    const written: ValuationRow[] = [];
    let inserted = 0;
    let corrected = 0;

    for (const item of entries) {
      const [existing] = await tx
        .select()
        .from(positionValuations)
        .where(
          and(
            eq(positionValuations.positionId, item.positionId),
            eq(positionValuations.valuedOn, today),
          ),
        )
        .limit(1)
        .for('update');

      if (existing === undefined) {
        written.push(
          await insertValuationIn(tx, ctx, {
            positionId: item.positionId,
            valuedOn: today,
            amount: item.amount,
            source: 'entered',
            datePrecision: 'exact',
          }),
        );
        inserted += 1;
        continue;
      }

      const row = await updateValuationIn(
        tx,
        ctx,
        existing.id,
        item.expectedVersion ?? existing.version,
        { amount: item.amount, source: 'entered' },
      );
      if (row === undefined) {
        // A conflict aborts the whole submission (20.3). Throwing rolls the
        // transaction back, so nothing partial is left behind.
        throw new QuickUpdateConflictError(item.positionId);
      }
      written.push(row);
      corrected += 1;
    }

    return { written, inserted, corrected };
  });
}

export class QuickUpdateConflictError extends Error {
  readonly code = 'QUICK_UPDATE_CONFLICT';
  constructor(readonly positionId: string) {
    super('One of these balances changed elsewhere; nothing was saved.');
    this.name = 'QuickUpdateConflictError';
  }
}
