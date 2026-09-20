import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { cashAccounts } from '../schema/cash-accounts';
import { otherAssets } from '../schema/other-assets';
import { positions } from '../schema/positions';
import { positionValuations } from '../schema/position-valuations';
import { withUser, type Database, type Transaction } from '../client';
import { recordAudit, type AuditContext } from './audited';

/**
 * `positions` and its Phase 2 subtypes (blueprint 6.2, 6.3, 17.2, 20.3).
 *
 * Every statement runs inside `withUser`, so RLS is the backstop for the
 * `WHERE` clause: a query carrying another user's id returns nothing and an
 * insert carrying one fails the policy's `WITH CHECK`. No function here takes a
 * caller-supplied `userId` — it always comes from the authenticated context.
 *
 * Reads join the subtype in one query rather than fetching it per position: a
 * page shows every account at once, and N+1 queries for a fixed, small set of
 * columns is the wrong shape (23.2).
 */

// Local aliases for the row shapes, so the record type below can name the enum
// columns without re-exporting the schema types under a second name.
type PositionRow = typeof positions.$inferSelect;
type CashAccountRow = typeof cashAccounts.$inferSelect;
type OtherAssetRow = typeof otherAssets.$inferSelect;

/** A position with whichever subtype columns its kind carries. */
export interface PositionRecord {
  readonly id: string;
  readonly userId: string;
  readonly kind: PositionRow['kind'];
  readonly name: string;
  readonly currency: string;
  readonly status: PositionRow['status'];
  readonly openedOn: string | null;
  readonly closedOn: string | null;
  readonly notes: string | null;
  readonly sortOrder: number;
  readonly version: number;
  readonly createdAt: Date;
  /** Cash only. */
  readonly accountType?: CashAccountRow['accountType'];
  readonly institution?: string | null;
  readonly isDormant?: boolean;
  /** Where the current dormant episode starts; NULL exactly when not dormant (8.8, 30.20). */
  readonly dormantFrom?: string | null;
  /** Other assets only. */
  readonly assetType?: OtherAssetRow['assetType'];
  readonly acquisitionDate?: string | null;
  readonly acquisitionValue?: string | null;
  readonly includeInFinancialNetWorth?: boolean;
}

const selection = {
  id: positions.id,
  userId: positions.userId,
  kind: positions.kind,
  name: positions.name,
  currency: positions.currency,
  status: positions.status,
  openedOn: positions.openedOn,
  closedOn: positions.closedOn,
  notes: positions.notes,
  sortOrder: positions.sortOrder,
  version: positions.version,
  createdAt: positions.createdAt,
  accountType: cashAccounts.accountType,
  institution: cashAccounts.institution,
  isDormant: cashAccounts.isDormant,
  dormantFrom: cashAccounts.dormantFrom,
  assetType: otherAssets.assetType,
  acquisitionDate: otherAssets.acquisitionDate,
  acquisitionValue: otherAssets.acquisitionValue,
  includeInFinancialNetWorth: otherAssets.includeInFinancialNetWorth,
} as const;

type SelectedRow = {
  [Key in keyof typeof selection]: unknown;
};

/** Drop the subtype columns that do not belong to this row's kind. */
function toRecord(row: SelectedRow): PositionRecord {
  const base = {
    id: row.id as string,
    userId: row.userId as string,
    kind: row.kind as PositionRow['kind'],
    name: row.name as string,
    currency: (row.currency as string).trim(),
    status: row.status as PositionRow['status'],
    openedOn: row.openedOn as string | null,
    closedOn: row.closedOn as string | null,
    notes: row.notes as string | null,
    sortOrder: row.sortOrder as number,
    version: row.version as number,
    createdAt: row.createdAt as Date,
  };

  if (base.kind === 'cash') {
    return {
      ...base,
      accountType: row.accountType as CashAccountRow['accountType'],
      institution: row.institution as string | null,
      isDormant: row.isDormant as boolean,
      dormantFrom: row.dormantFrom as string | null,
    };
  }
  if (base.kind === 'other_asset') {
    return {
      ...base,
      assetType: row.assetType as OtherAssetRow['assetType'],
      acquisitionDate: row.acquisitionDate as string | null,
      acquisitionValue: row.acquisitionValue as string | null,
      includeInFinancialNetWorth: row.includeInFinancialNetWorth as boolean,
    };
  }
  return base;
}

function positionQuery(tx: Transaction) {
  return tx
    .select(selection)
    .from(positions)
    .leftJoin(cashAccounts, eq(cashAccounts.positionId, positions.id))
    .leftJoin(otherAssets, eq(otherAssets.positionId, positions.id));
}

export interface ListPositionsOptions {
  readonly kinds?: readonly PositionRow['kind'][];
  /** Archived positions are hidden from the ordinary lists (6.3, R12). */
  readonly includeArchived?: boolean;
}

export async function listPositions(
  db: Database,
  userId: string,
  options: ListPositionsOptions = {},
): Promise<PositionRecord[]> {
  return withUser(db, { userId }, async (tx) => listPositionsIn(tx, options));
}

/** The same list inside a caller's transaction. */
export async function listPositionsIn(
  tx: Transaction,
  options: ListPositionsOptions = {},
): Promise<PositionRecord[]> {
  const filters = [
    ...(options.kinds === undefined ? [] : [inArray(positions.kind, [...options.kinds])]),
    ...(options.includeArchived === true ? [] : [sql`${positions.status} <> 'archived'`]),
  ];
  const rows = await positionQuery(tx)
    .where(filters.length === 0 ? undefined : and(...filters))
    .orderBy(asc(positions.sortOrder), asc(positions.name));
  return rows.map(toRecord);
}

export async function findPosition(
  db: Database,
  userId: string,
  positionId: string,
): Promise<PositionRecord | undefined> {
  return withUser(db, { userId }, async (tx) => findPositionIn(tx, positionId));
}

/**
 * The same read inside a caller's transaction.
 *
 * Unlocked on purpose: a caller that will *decide* from this row takes
 * `lockCashPositionsIn` instead. This is for the reads that only need to know
 * what a position is — its currency, its window, its kind.
 */
export async function findPositionIn(
  tx: Transaction,
  positionId: string,
): Promise<PositionRecord | undefined> {
  const rows = await positionQuery(tx).where(eq(positions.id, positionId)).limit(1);
  const row = rows[0];
  return row === undefined ? undefined : toRecord(row);
}

export interface CreateCashAccountInput {
  readonly name: string;
  readonly currency: string;
  readonly accountType: CashAccountRow['accountType'];
  readonly institution: string | null;
  readonly notes: string | null;
  readonly openedOn: string | null;
  /** Written in the same transaction when the user gave a first balance. */
  readonly openingBalance?: { readonly amount: string; readonly valuedOn: string };
}

/**
 * Create a cash account, its subtype row and — when the user gave one — its
 * first balance, inside the caller's transaction (5.2: the position aggregate).
 *
 * Transaction-taking rather than database-taking, like every financial write in
 * this package now is: the per-user write mutex is held by the caller's
 * transaction, and a repository that opened one of its own would write outside
 * it (blueprint 20.3, 30.22; ADR 0010 §5).
 */
export async function insertCashAccountIn(
  tx: Transaction,
  ctx: AuditContext,
  input: CreateCashAccountInput,
): Promise<PositionRecord> {
  const [positionRow] = await tx
    .insert(positions)
    .values({
      userId: ctx.userId,
      kind: 'cash',
      name: input.name,
      currency: input.currency,
      openedOn: input.openedOn,
      notes: input.notes,
    })
    .returning();
  const created = positionRow as PositionRow;

  const [cashRow] = await tx
    .insert(cashAccounts)
    .values({
      positionId: created.id,
      userId: ctx.userId,
      kind: 'cash',
      accountType: input.accountType,
      institution: input.institution,
    })
    .returning();

  await recordAudit(tx, ctx, {
    entityTable: 'positions',
    entityId: created.id,
    action: 'insert',
    after: { ...created, ...cashRow },
  });

  if (input.openingBalance !== undefined) {
    const [valuationRow] = await tx
      .insert(positionValuations)
      .values({
        userId: ctx.userId,
        positionId: created.id,
        valuedOn: input.openingBalance.valuedOn,
        amount: input.openingBalance.amount,
        source: 'entered',
        datePrecision: 'exact',
      })
      .returning();
    await recordAudit(tx, ctx, {
      entityTable: 'position_valuations',
      entityId: (valuationRow as { id: string }).id,
      action: 'insert',
      after: valuationRow as Record<string, unknown>,
    });
  }

  const rows = await positionQuery(tx).where(eq(positions.id, created.id)).limit(1);
  return toRecord(rows[0] as SelectedRow);
}

export interface CreateOtherAssetInput {
  readonly name: string;
  readonly currency: string;
  readonly assetType: OtherAssetRow['assetType'];
  readonly notes: string | null;
  readonly acquisitionDate: string | null;
  readonly acquisitionValue: string | null;
  readonly includeInFinancialNetWorth: boolean;
  readonly currentValue?: { readonly amount: string; readonly valuedOn: string };
}

export async function insertOtherAssetIn(
  tx: Transaction,
  ctx: AuditContext,
  input: CreateOtherAssetInput,
): Promise<PositionRecord> {
  const [positionRow] = await tx
    .insert(positions)
    .values({
      userId: ctx.userId,
      kind: 'other_asset',
      name: input.name,
      currency: input.currency,
      // An other asset is not "opened empty on a date": its acquisition date
      // is metadata about the purchase, and its value only ever comes from a
      // valuation. Leaving `opened_on` NULL keeps "unknown before the first
      // valuation" true rather than asserting a zero nobody stated.
      openedOn: null,
      notes: input.notes,
    })
    .returning();
  const created = positionRow as PositionRow;

  const [assetRow] = await tx
    .insert(otherAssets)
    .values({
      positionId: created.id,
      userId: ctx.userId,
      kind: 'other_asset',
      assetType: input.assetType,
      acquisitionDate: input.acquisitionDate,
      acquisitionValue: input.acquisitionValue,
      includeInFinancialNetWorth: input.includeInFinancialNetWorth,
    })
    .returning();

  await recordAudit(tx, ctx, {
    entityTable: 'positions',
    entityId: created.id,
    action: 'insert',
    after: { ...created, ...assetRow },
  });

  if (input.currentValue !== undefined) {
    const [valuationRow] = await tx
      .insert(positionValuations)
      .values({
        userId: ctx.userId,
        positionId: created.id,
        valuedOn: input.currentValue.valuedOn,
        amount: input.currentValue.amount,
        source: 'entered',
        datePrecision: 'exact',
      })
      .returning();
    await recordAudit(tx, ctx, {
      entityTable: 'position_valuations',
      entityId: (valuationRow as { id: string }).id,
      action: 'insert',
      after: valuationRow as Record<string, unknown>,
    });
  }

  const rows = await positionQuery(tx).where(eq(positions.id, created.id)).limit(1);
  return toRecord(rows[0] as SelectedRow);
}

export interface PositionPatch {
  name?: string;
  notes?: string | null;
  status?: PositionRow['status'];
  closedOn?: string | null;
  sortOrder?: number;
}

export interface CashAccountPatch {
  accountType?: CashAccountRow['accountType'];
  institution?: string | null;
  /**
   * The flag and its date, written together or not at all: the database
   * refuses one without the other (`cash_accounts_dormant_anchor`). A dormant
   * account names the zero balance its episode starts from; a woken one names
   * nothing (8.8, v2.1.17 30.20).
   */
  dormancy?: { isDormant: true; dormantFrom: string } | { isDormant: false; dormantFrom: null };
}

export interface OtherAssetPatch {
  assetType?: OtherAssetRow['assetType'];
  acquisitionDate?: string | null;
  acquisitionValue?: string | null;
  includeInFinancialNetWorth?: boolean;
}

/**
 * Update a position and, optionally, its subtype row under an optimistic
 * version check (20.3), inside the caller's transaction. Returns `undefined`
 * when the version moved on, which the service turns into `CONFLICT_VERSION`
 * with the current values rather than overwriting somebody else's edit.
 *
 * The evidence a decision rests on and the write it justifies belong to one
 * transaction: marking a cash account dormant needs a zero latest balance that
 * no attributed flow post-dates, and a flow arriving between the check and the
 * write would leave the account dormant on a zero it had already moved past
 * (20.3, v2.1.17 30.20 item 5, 30.22 item 5).
 */
export async function updatePositionIn(
  tx: Transaction,
  ctx: AuditContext,
  positionId: string,
  expectedVersion: number,
  patch: PositionPatch,
  subtype?: { cash?: CashAccountPatch; otherAsset?: OtherAssetPatch },
): Promise<PositionRecord | undefined> {
  const before = await loadForUpdate(tx, positionId);
  if (before === undefined) return undefined;

  const [updated] = await tx
    .update(positions)
    .set({ ...patch, version: expectedVersion + 1 })
    .where(and(eq(positions.id, positionId), eq(positions.version, expectedVersion)))
    .returning();
  if (updated === undefined) return undefined;

  let subtypeAfter: Record<string, unknown> | undefined;
  if (subtype?.cash !== undefined) {
    const { dormancy, ...columns } = subtype.cash;
    const values = { ...columns, ...dormancy };
    if (Object.keys(values).length > 0) {
      const [row] = await tx
        .update(cashAccounts)
        .set(values)
        .where(eq(cashAccounts.positionId, positionId))
        .returning();
      subtypeAfter = row;
    }
  }
  if (subtype?.otherAsset !== undefined && Object.keys(subtype.otherAsset).length > 0) {
    const [row] = await tx
      .update(otherAssets)
      .set(subtype.otherAsset)
      .where(eq(otherAssets.positionId, positionId))
      .returning();
    subtypeAfter = row;
  }

  await recordAudit(tx, ctx, {
    entityTable: 'positions',
    entityId: positionId,
    action: 'update',
    before: before.image,
    after: { ...(updated as Record<string, unknown>), ...(subtypeAfter ?? before.subtype) },
  });

  const rows = await positionQuery(tx).where(eq(positions.id, positionId)).limit(1);
  return toRecord(rows[0] as SelectedRow);
}

/** The current position and subtype rows, locked for the rest of the transaction. */
async function loadForUpdate(
  tx: Transaction,
  positionId: string,
): Promise<{ image: Record<string, unknown>; subtype: Record<string, unknown> } | undefined> {
  const [row] = await tx
    .select()
    .from(positions)
    .where(eq(positions.id, positionId))
    .limit(1)
    .for('update');
  if (row === undefined) return undefined;

  const [cash] = await tx
    .select()
    .from(cashAccounts)
    .where(eq(cashAccounts.positionId, positionId))
    .limit(1);
  const [asset] = await tx
    .select()
    .from(otherAssets)
    .where(eq(otherAssets.positionId, positionId))
    .limit(1);

  const subtype = (cash ?? asset ?? {}) as Record<string, unknown>;
  return { image: { ...(row as Record<string, unknown>), ...subtype }, subtype };
}

/**
 * Delete a position outright. Only possible while it has no history: the
 * `NO ACTION` foreign key from `position_valuations` refuses otherwise, which
 * is what keeps a deletion from silently orphaning financial records (6.3).
 */
export async function deletePositionIn(
  tx: Transaction,
  ctx: AuditContext,
  positionId: string,
): Promise<boolean> {
  const before = await loadForUpdate(tx, positionId);
  if (before === undefined) return false;

  await tx.delete(cashAccounts).where(eq(cashAccounts.positionId, positionId));
  await tx.delete(otherAssets).where(eq(otherAssets.positionId, positionId));
  const deleted = await tx
    .delete(positions)
    .where(eq(positions.id, positionId))
    .returning({ id: positions.id });
  if (deleted.length === 0) return false;

  await recordAudit(tx, ctx, {
    entityTable: 'positions',
    entityId: positionId,
    action: 'delete',
    before: before.image,
  });
  return true;
}

/**
 * The user's **cash** positions among `positionIds`, locked for the rest of the
 * transaction (blueprint 20.3).
 *
 * The two rows a cash account's lifecycle lives in are locked together, because
 * two different writers change it: `updatePosition` — closing, marking dormant,
 * editing — locks the `positions` row, while `clearCashDormancyIn` locks the
 * `cash_accounts` row alone to clear dormancy for a flow or a balance. A caller
 * that validates eligibility from these rows and then writes in the same
 * transaction therefore cannot have either changed underneath it.
 *
 * Three properties are deliberate:
 *
 *  - the join to `cash_accounts` is **inner**, so a position of another kind is
 *    absent exactly as another user's id and a nonexistent one are — a caller
 *    cannot tell the three apart (17.2, 17.3);
 *  - rows come back in id order and are locked in that order, so two overlapping
 *    requests queue rather than deadlock;
 *  - `FOR UPDATE OF` names the two inner tables: `other_assets` is on the
 *    nullable side of an outer join, which PostgreSQL refuses to lock at all.
 *
 * The order — `positions`, then `cash_accounts` — is the order `updatePosition`
 * already takes them, and nothing in this package locks `position_valuations`
 * before either, so a caller may lock these first and write valuations after.
 */
export async function lockCashPositionsIn(
  tx: Transaction,
  positionIds: readonly string[],
): Promise<PositionRecord[]> {
  const ids = [...new Set(positionIds)];
  if (ids.length === 0) return [];

  const rows = await tx
    .select(selection)
    .from(positions)
    .innerJoin(cashAccounts, eq(cashAccounts.positionId, positions.id))
    .leftJoin(otherAssets, eq(otherAssets.positionId, positions.id))
    .where(inArray(positions.id, ids))
    .orderBy(asc(positions.id))
    .for('update', { of: [positions, cashAccounts] });

  return rows.map(toRecord);
}

/** How many valuations a position has — the "may it be deleted?" question. */
export async function countValuations(
  db: Database,
  userId: string,
  positionId: string,
): Promise<number> {
  return withUser(db, { userId }, async (tx) => countValuationsIn(tx, positionId));
}

/**
 * The same count inside a caller's transaction.
 *
 * What a delete needs: the answer decides whether the delete may proceed, so it
 * is read inside the transaction that would perform it (30.22 item 5). The
 * wrapper above answers the same question for a page that is only describing a
 * position.
 */
export async function countValuationsIn(
  tx: Transaction,
  positionId: string,
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(positionValuations)
    .where(eq(positionValuations.positionId, positionId));
  return row?.n ?? 0;
}

export interface FinancialWindow {
  readonly positions: PositionRecord[];
  readonly valuations: (typeof positionValuations.$inferSelect)[];
  /** The earliest financial date on record, for the FX backfill (10.4). */
  readonly earliestValuedOn?: string;
}

/**
 * `loadFinancialWindow` (blueprint 23.2) — everything a read needs, in two
 * bulk queries rather than one per position.
 *
 * Every position, whatever its status: a closed one contributes nothing after
 * its closing date and the engine knows it, and there is no way to archive one
 * in Phase 2 (what archiving means for net worth is 12.3's "removed from
 * tracking", which needs a date this schema does not carry). When archiving
 * arrives, this query is the place that has to decide what an archived position
 * is worth at a past date — silently filtering it here would rewrite history.
 *
 * Valuations are loaded with no lower bound, only `valued_on <= to`. That is
 * deliberate: a position's value at a date is its **latest valuation on or
 * before** it, so a window that started at `from` would silently turn a balance
 * carried from before the window into "missing" — the one thing this engine
 * must never do. At Phase 2 volumes (23.1: ~10k valuations for thirty years)
 * this is a single indexed scan; when a lower bound becomes worth having, it
 * has to come with a per-position "latest before `from`" query, not without one.
 */
export async function loadFinancialWindow(
  db: Database,
  userId: string,
  to: string,
): Promise<FinancialWindow> {
  return withUser(db, { userId }, async (tx) => loadFinancialWindowIn(tx, to));
}

/**
 * The same window inside a caller's transaction.
 *
 * The adjustment path needs it: its amount is derived from a reconciliation the
 * server recomputes, and that recomputation is the decision the write rests on,
 * so it has to happen under the same write mutex (ADR 0010 §15). Ordinary reads
 * keep using the wrapper above.
 */
export async function loadFinancialWindowIn(
  tx: Transaction,
  to: string,
): Promise<FinancialWindow> {
  {
    const positionRows = await positionQuery(tx).orderBy(
      asc(positions.sortOrder),
      asc(positions.name),
    );

    const valuationRows = await tx
      .select()
      .from(positionValuations)
      .where(lte(positionValuations.valuedOn, to))
      .orderBy(asc(positionValuations.positionId), desc(positionValuations.valuedOn));

    const [earliest] = await tx
      .select({ valuedOn: sql<string | null>`min(${positionValuations.valuedOn})::text` })
      .from(positionValuations);

    const earliestValuedOn = earliest?.valuedOn ?? undefined;

    return {
      positions: positionRows.map(toRecord),
      valuations: valuationRows,
      ...(earliestValuedOn === null || earliestValuedOn === undefined
        ? {}
        : { earliestValuedOn }),
    };
  }
}

/**
 * Is there a cash account of this currency in the bucket `(M, C)` that a flow
 * dated `on` would fall into (blueprint 8.1)?
 *
 * The question a tracked-cash flow with **no** cash position has to answer.
 * 8.1 says such a flow "belongs to the bucket" and that "validation requires a
 * participating cash account of that currency" — the null leg means "I have not
 * said which account", never "this was not tracked". Without one the flow lands
 * in a bucket with nothing to reconcile against, which is 8.5's blocking
 * `flow_without_cash_account`.
 *
 * ## The predicate is the month's, not the day's
 *
 * 8.1 defines the bucket as "all cash positions of currency C **open at any
 * time during M**: `(opened_on IS NULL OR opened_on <= end(M)) AND (closed_on
 * IS NULL OR closed_on >= start(M))`", and that is reproduced exactly here.
 *
 * Asking whether an account is open on the flow's own *date* is a different and
 * stricter question, and using it would reject flows the engine will happily
 * reconcile: an account opened on 20 September participates in September's
 * bucket, so a null-leg flow dated the 5th has somewhere to go. Rejecting it
 * would be the validation layer disagreeing with the engine about what a bucket
 * contains.
 *
 * This is only about the **null-leg** case. A flow that names an account is
 * judged against that account's own window by the domain rule "date within
 * position window" (20.1), which is the day-level question and is asked
 * elsewhere.
 */
export async function hasParticipatingCashAccountIn(
  tx: Transaction,
  currency: string,
  on: string,
): Promise<boolean> {
  const monthStart = `${on.slice(0, 7)}-01`;
  const rows = await tx
    .select({ id: positions.id })
    .from(positions)
    .where(
      and(
        eq(positions.kind, 'cash'),
        eq(positions.currency, currency),
        or(
          isNull(positions.openedOn),
          lte(positions.openedOn, sql`(date_trunc('month', ${monthStart}::date) + interval '1 month - 1 day')::date`),
        ),
        or(isNull(positions.closedOn), gte(positions.closedOn, monthStart)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** The currencies a user's positions are held in — what the FX table must cover. */
export async function positionCurrencies(db: Database, userId: string): Promise<string[]> {
  const rows = await withUser(db, { userId }, async (tx) =>
    tx.selectDistinct({ currency: positions.currency }).from(positions),
  );
  return rows.map((row) => row.currency.trim());
}

/**
 * Wake a cash account — end its dormant episode — inside the caller's
 * transaction.
 *
 * Separate from `updatePositionIn` because it is not a user edit and must not
 * consume the position's optimistic version: recording a non-zero balance
 * wakes the account as a consequence (6.2, R22), and doing so must not
 * invalidate an account form somebody has open.
 *
 * It only ever clears. Starting an episode needs a date and the evidence for
 * it, which is the service's own decision (`updatePositionIn`); a function that
 * set the flag alone could only ever violate `cash_accounts_dormant_anchor`.
 *
 * Transaction-taking only: 8.8 says an attributed flow or a non-zero balance
 * clears dormancy, and the clear belongs to that write's own transaction so the
 * two facts cannot come apart — a recorded flow with the account still flagged
 * dormant would let a month carry at zero against evidence that it did not.
 */
export async function clearCashDormancyIn(
  tx: Transaction,
  ctx: AuditContext,
  positionId: string,
): Promise<void> {
  const [before] = await tx
    .select()
    .from(cashAccounts)
    .where(eq(cashAccounts.positionId, positionId))
    .limit(1)
    .for('update');
  if (before === undefined || !before.isDormant) return;

  // The flag and the date of the episode it ends, in one statement. Every wake
  // comes through here, so neither can outlive the other (30.20 item 6).
  const [after] = await tx
    .update(cashAccounts)
    .set({ isDormant: false, dormantFrom: null })
    .where(eq(cashAccounts.positionId, positionId))
    .returning();

  await recordAudit(tx, ctx, {
    entityTable: 'cash_accounts',
    entityId: positionId,
    action: 'update',
    before: before,
    after: after as unknown as Record<string, unknown>,
  });
}
