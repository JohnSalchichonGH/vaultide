import {
  deleteIncomeEntryIn as deleteIncomeEntryRowIn,
  findIncomeEntryIn,
  insertIncomeEntryIn,
  updateIncomeEntryIn as updateIncomeEntryRowIn,
  type IncomeEntryRow,
  type OccurrenceRef,
  type PositionRecord as PositionRow,
  type Transaction,
} from '@vaultide/db';
import type { PlainDate } from '@vaultide/finance';
import { allowedIncomeSettlements, type IncomeKind, type IncomeSettlement } from '@vaultide/validation';
import type { RequestContext } from '../context';
import { withUserWrite } from '../coordination';
import { assertNoHistoricalReview } from '../corrections/guard';
import { NotFoundError, ValidationError, VersionConflictError } from '../errors';
import {
  canonicalAmount,
  created,
  deleted,
  dormancyChange,
  mergeSupport,
  realDormancyEffects,
  updated,
  type IncomeSourceFacts,
  type ResolvedWrite,
  type ResolveOptions,
} from '../write-plan';
import {
  applyDormancyClearsIn,
  assertNotFuture,
  auditContextOf,
  clearDormancyEffect,
  resolveTrackedCashLegIn,
  type FlowDependencies,
  type TrackedCashLegRequest,
} from './shared';

/**
 * Income entries (blueprint 6.2, 7.4, 12.5, 20.3, 30.22, v2.1.6 §30.9 item 5).
 *
 * Money arriving, and the settlement that says what it means. Every function
 * here is reached only through `financialAction`, whose session is validated
 * against the store rather than the cookie cache (ADR 0003), and every one is
 * one `withUserWrite` transaction that takes the per-user write mutex before
 * its first authoritative read (ADR 0010 §5).
 *
 * ## What Phase 3 will and will not record
 *
 * | kind | `tracked_cash` | `external` | `reinvested` |
 * |---|---|---|---|
 * | employment, freelance, bonus, rental, other | yes | yes | no |
 * | dividend, interest | yes | **no** | no |
 * | external_inflow, adjustment | yes | no | no |
 *
 * `reinvested` needs an investment position, which Phase 3 has not got.
 * `external` on a dividend or interest is the case 7.4 covers **only** when the
 * row is linked to an investment — where it keeps the investment-performance
 * credit and pairs with an equal external outflow — so Phase 3 would be writing
 * a row the matrix does not define. And `external_inflow` and `adjustment`
 * exist to explain **tracked** cash, so an external one could not affect the
 * discrepancy it was created for.
 *
 * These are phase restrictions over unchanged enums: Phase 4 lifts them by
 * widening a list, never by a migration.
 */

export interface IncomeEntryArgs {
  readonly kind: IncomeKind;
  readonly receivedOn: string;
  readonly netAmount: string;
  readonly grossAmount?: string | undefined;
  readonly currency: string;
  readonly settlement: IncomeSettlement;
  readonly cashPositionId?: string | null | undefined;
  readonly description?: string | undefined;
  readonly tags?: string[] | undefined;
  readonly isOneOff?: boolean | undefined;
}

/** The one place a Phase 3 income settlement is judged (7.4, §30.9 item 5). */
export function assertIncomeSettlementAllowed(
  kind: IncomeKind,
  settlement: IncomeSettlement,
): void {
  const allowed = allowedIncomeSettlements(kind);
  if (allowed.includes(settlement)) return;

  const message =
    settlement === 'reinvested'
      ? 'A reinvested distribution needs an investment to reinvest into, which arrives with investments.'
      : kind === 'dividend' || kind === 'interest'
        ? 'A dividend or interest paid outside your tracked accounts belongs to the investment it came from, which arrives with investments. Record it as received in a tracked account, or leave it out for now.'
        : 'This kind of income has to arrive in a tracked account: it exists to explain money that reached your tracked balance.';

  throw new ValidationError(message, { settlement: [message] });
}

/** The columns an income write sets. */
export interface IncomeColumns {
  readonly kind: IncomeKind;
  readonly receivedOn: string;
  readonly netAmount: string;
  readonly grossAmount: string | null;
  readonly currency: string;
  readonly settlement: IncomeSettlement;
  readonly cashPositionId: string | null;
  readonly description: string | null;
  readonly tags: string[] | undefined;
  readonly isOneOff: boolean | undefined;
}

/**
 * A resolved income write (ADR 0010 §1; §20 of the slice prompt).
 *
 * The ordinary mutation, the correction preview and Historical Confirm all
 * resolve through the same three functions below and apply through the same
 * one, so there is no second validator that can drift from what actually
 * happens when the row is written.
 */
export interface IncomeWritePlan extends ResolvedWrite {
  readonly operation: 'create' | 'update' | 'delete';
  readonly existing: IncomeEntryRow | null;
  readonly expectedVersion: number | null;
  readonly columns: IncomeColumns | null;
  /** The occurrence a creation materializes, when it materializes one. */
  readonly occurrence: OccurrenceRef | undefined;
}

function incomeFacts(row: IncomeEntryRow): IncomeSourceFacts {
  return {
    kind: 'income',
    incomeKind: row.kind,
    receivedOn: row.receivedOn,
    netAmount: canonicalAmount(row.netAmount),
    grossAmount: row.grossAmount === null ? null : canonicalAmount(row.grossAmount),
    currency: row.currency,
    settlement: row.settlement,
    cashPositionId: row.cashPositionId,
    description: row.description,
    templateId: row.templateId,
    occurrenceDate: row.occurrenceDate,
  };
}

function incomeFactsOf(
  columns: IncomeColumns,
  occurrence: OccurrenceRef | undefined,
): IncomeSourceFacts {
  return {
    kind: 'income',
    incomeKind: columns.kind,
    receivedOn: columns.receivedOn,
    netAmount: canonicalAmount(columns.netAmount),
    grossAmount: columns.grossAmount === null ? null : canonicalAmount(columns.grossAmount),
    currency: columns.currency,
    settlement: columns.settlement,
    cashPositionId: columns.cashPositionId,
    description: columns.description,
    templateId: occurrence?.templateId ?? null,
    occurrenceDate: occurrence?.occurrenceDate ?? null,
  };
}

/*
 * ## Decisions, reads, plans
 *
 * Each income resolver below is three steps, and only the middle one reads:
 *
 * ```text
 * decideIncome…     every rule the entry obeys on its own terms, the columns it
 *                   will have, and the cash leg it names          (pure)
 * the cash leg      read and judged by `resolveTrackedCashLegIn`  (reads)
 * planIncome…       the resolved write: facts, identity, dormancy  (pure)
 * ```
 *
 * The decisions and plans perform no IO, take no lock and read no clock —
 * `today` arrives as an argument — so the same rule judges the same rows
 * whoever loaded them: the ordinary write, the correction preview and
 * Historical Confirm. A delete names no leg, so it is one decision.
 */

/** An income write judged on its own terms, and the cash leg it still needs judged. */
export interface IncomeDecision {
  readonly columns: IncomeColumns;
  /** The tracked-cash leg to judge, or `null` for income not received in tracked cash. */
  readonly leg: TrackedCashLegRequest | null;
}

/** The tracked-cash leg an income entry with these columns needs judged, if any. */
function incomeLegOf(columns: IncomeColumns): TrackedCashLegRequest | null {
  return columns.settlement === 'tracked_cash'
    ? {
        cashPositionId: columns.cashPositionId,
        currency: columns.currency,
        on: columns.receivedOn,
        dateField: 'receivedOn',
      }
    : null;
}

/**
 * The leg a plan is given must be the one its columns name: the account the
 * entry attaches to, or none. A mismatch is a caller's mistake.
 */
function assertLegMatches(columns: IncomeColumns, leg: PositionRow | null): void {
  if ((leg?.id ?? null) !== columns.cashPositionId) {
    throw new Error('an income plan was given the cash leg of another account');
  }
}

/** The occurrence a stored row fulfils, when it fulfils one. */
function occurrenceOfRow(row: IncomeEntryRow): OccurrenceRef | undefined {
  return row.templateId === null || row.occurrenceDate === null
    ? undefined
    : { templateId: row.templateId, occurrenceDate: row.occurrenceDate };
}

/**
 * A new income entry on its own terms: not in the future (M5), a settlement
 * Phase 3 records for its kind (7.4), and a cash position only when it is
 * tracked cash.
 */
export function decideIncomeCreate(today: PlainDate, args: IncomeEntryArgs): IncomeDecision {
  assertNotFuture({ today }, args.receivedOn, 'receivedOn');
  assertIncomeSettlementAllowed(args.kind, args.settlement);

  const columns: IncomeColumns = {
    kind: args.kind,
    receivedOn: args.receivedOn,
    netAmount: args.netAmount,
    grossAmount: args.grossAmount ?? null,
    currency: args.currency,
    settlement: args.settlement,
    cashPositionId: args.settlement === 'tracked_cash' ? (args.cashPositionId ?? null) : null,
    description: args.description ?? null,
    tags: args.tags,
    isOneOff: args.isOneOff,
  };
  return { columns, leg: incomeLegOf(columns) };
}

/**
 * The resolved creation, given its judged cash leg and the occurrence it
 * materializes, if it materializes one.
 */
export function planIncomeCreate(
  columns: IncomeColumns,
  leg: PositionRow | null,
  occurrence?: OccurrenceRef,
): IncomeWritePlan {
  assertLegMatches(columns, leg);
  const dormancy = realDormancyEffects(leg === null ? [] : [clearDormancyEffect(leg)]);

  return {
    operation: 'create',
    existing: null,
    expectedVersion: null,
    columns,
    occurrence,
    // A first assertion, whatever month it lands in (30.22 item 2).
    revision: false,
    changes: [
      created(
        {
          scope: 'prospective',
          kind: 'income',
          role: occurrence === undefined ? 'entry' : 'occurrence',
          owner:
            occurrence === undefined
              ? null
              : `${occurrence.templateId}#${occurrence.occurrenceDate}`,
        },
        incomeFactsOf(columns, occurrence),
      ),
      ...dormancy.map(dormancyChange),
    ],
    dormancy,
    support: [{ currency: columns.currency, from: columns.receivedOn }],
  };
}

/**
 * Resolve a new income entry, whoever is creating it.
 *
 * Exported because the reconciliation adjustment and a recurring acceptance are
 * ordinary income entries whose amount and occurrence identity their own
 * services derive (ADR 0009 §5, ADR 0010 §15). Everything a direct caller gets
 * — the settlement matrix, the null-leg rule, the future-date rule and the
 * dormancy consequence — they get too.
 */
export async function resolveIncomeCreateIn(
  tx: Transaction,
  ctx: RequestContext,
  args: IncomeEntryArgs,
  occurrence?: OccurrenceRef,
): Promise<IncomeWritePlan> {
  const decision = decideIncomeCreate(ctx.today, args);
  const leg = decision.leg === null ? null : await resolveTrackedCashLegIn(tx, decision.leg);
  return planIncomeCreate(decision.columns, leg, occurrence);
}

/**
 * A correction of a stored income entry on its own terms: the version the
 * caller saw, then the corrected entry's date and settlement, exactly as a new
 * one would be judged. What the correction leaves out keeps its stored value;
 * `grossAmount: null` clears the gross, and the currency never moves.
 */
export function decideIncomeUpdate(
  today: PlainDate,
  existing: IncomeEntryRow,
  args: UpdateIncomeEntryArgs,
): IncomeDecision {
  if (existing.version !== args.expectedVersion) {
    // Asked here as well as by the update, so a preview — which writes nothing
    // and never reaches the update — refuses a stale draft for the same reason
    // a save does (§59 of the slice prompt).
    throw new VersionConflictError('This entry changed while you were editing it.');
  }

  const kind = args.kind ?? existing.kind;
  const settlement = args.settlement ?? existing.settlement;
  const receivedOn = args.receivedOn ?? existing.receivedOn;
  const netAmount = args.netAmount ?? existing.netAmount;

  assertNotFuture({ today }, receivedOn, 'receivedOn');
  assertIncomeSettlementAllowed(kind, settlement);

  const requestedCash =
    args.cashPositionId === undefined ? existing.cashPositionId : args.cashPositionId;

  const columns: IncomeColumns = {
    kind,
    receivedOn,
    netAmount,
    grossAmount: args.grossAmount === undefined ? existing.grossAmount : args.grossAmount,
    currency: existing.currency,
    settlement,
    cashPositionId: settlement === 'tracked_cash' ? requestedCash : null,
    description: args.description === undefined ? existing.description : args.description,
    tags: args.tags,
    isOneOff: args.isOneOff,
  };
  return { columns, leg: incomeLegOf(columns) };
}

/**
 * The resolved correction, given the stored row, the columns its decision
 * produced and its judged cash leg.
 *
 * `occurrence_date` is the scheduling identity of the occurrence the row
 * fulfilled, so moving the financial date must not move it (§30.9 item 2): the
 * facts carry the stored pair, and the columns have no field for it.
 */
export function planIncomeUpdate(
  existing: IncomeEntryRow,
  columns: IncomeColumns,
  leg: PositionRow | null,
): IncomeWritePlan {
  assertLegMatches(columns, leg);
  const dormancy = realDormancyEffects(leg === null ? [] : [clearDormancyEffect(leg)]);
  const occurrence = occurrenceOfRow(existing);

  return {
    operation: 'update',
    existing,
    // `decideIncomeUpdate` has already held the caller to this version.
    expectedVersion: existing.version,
    columns,
    occurrence,
    revision: true,
    changes: [
      updated(
        { scope: 'existing', kind: 'income', id: existing.id },
        incomeFacts(existing),
        incomeFactsOf(columns, occurrence),
      ),
      ...dormancy.map(dormancyChange),
    ],
    dormancy,
    support: mergeSupport([
      { currency: existing.currency, from: columns.receivedOn },
      { currency: existing.currency, from: existing.receivedOn },
    ]),
  };
}

export async function resolveIncomeUpdateIn(
  tx: Transaction,
  ctx: RequestContext,
  args: UpdateIncomeEntryArgs,
  options: ResolveOptions = { lock: true },
): Promise<IncomeWritePlan> {
  const existing = await findIncomeEntryIn(
    tx,
    args.entryId,
    options.lock ? { lock: 'update' } : {},
  );
  if (existing === undefined) throw new NotFoundError('That income entry no longer exists.');

  const decision = decideIncomeUpdate(ctx.today, existing, args);
  const leg = decision.leg === null ? null : await resolveTrackedCashLegIn(tx, decision.leg);
  return planIncomeUpdate(existing, decision.columns, leg);
}

/** The resolved delete of a stored income entry, at the version the caller saw. */
export function decideIncomeDelete(
  existing: IncomeEntryRow,
  args: DeleteIncomeEntryArgs,
): IncomeWritePlan {
  if (existing.version !== args.expectedVersion) {
    throw new VersionConflictError(
      'This entry changed after you opened it. Reload to see what it says now.',
    );
  }

  return {
    operation: 'delete',
    existing,
    expectedVersion: args.expectedVersion,
    columns: null,
    occurrence: undefined,
    revision: true,
    // Deleting an attributed flow restores no dormancy (8.8).
    changes: [deleted({ scope: 'existing', kind: 'income', id: existing.id }, incomeFacts(existing))],
    dormancy: [],
    support: [],
  };
}

export async function resolveIncomeDeleteIn(
  tx: Transaction,
  args: DeleteIncomeEntryArgs,
  options: ResolveOptions = { lock: true },
): Promise<IncomeWritePlan> {
  const existing = await findIncomeEntryIn(
    tx,
    args.entryId,
    options.lock ? { lock: 'update' } : {},
  );
  if (existing === undefined) throw new NotFoundError('That income entry no longer exists.');
  return decideIncomeDelete(existing, args);
}

/** The one writer for all three income operations, and for both callers. */
export async function applyIncomePlanIn(
  tx: Transaction,
  ctx: RequestContext,
  plan: IncomeWritePlan,
  reason?: string,
): Promise<IncomeEntryRow> {
  const audit = auditContextOf(ctx, reason);

  const written = await (async (): Promise<IncomeEntryRow> => {
    if (plan.operation === 'delete') {
      /* v8 ignore next 2 -- a delete plan always carries the row it removes. */
      if (plan.existing === null) throw new NotFoundError('That income entry no longer exists.');
      const removed = await deleteIncomeEntryRowIn(tx, audit, plan.existing.id);
      /* v8 ignore next -- the row is held under FOR UPDATE in this transaction. */
      if (removed === undefined) throw new NotFoundError('That income entry no longer exists.');
      return removed;
    }

    /* v8 ignore next 2 -- create and update plans always carry their columns. */
    if (plan.columns === null) throw new NotFoundError('That income entry no longer exists.');
    const columns = plan.columns;

    if (plan.operation === 'create') {
      return insertIncomeEntryIn(tx, audit, {
        kind: columns.kind,
        receivedOn: columns.receivedOn,
        netAmount: columns.netAmount,
        grossAmount: columns.grossAmount,
        currency: columns.currency,
        settlement: columns.settlement,
        cashPositionId: columns.cashPositionId,
        description: columns.description,
        tags: columns.tags ?? [],
        isOneOff: columns.isOneOff ?? false,
        ...(plan.occurrence === undefined ? {} : { occurrence: plan.occurrence }),
      });
    }

    /* v8 ignore next 2 -- an update plan always carries a row and a version. */
    if (plan.existing === null || plan.expectedVersion === null) throw new VersionConflictError();
    const row = await updateIncomeEntryRowIn(tx, audit, plan.existing.id, plan.expectedVersion, {
      kind: columns.kind,
      receivedOn: columns.receivedOn,
      netAmount: columns.netAmount,
      settlement: columns.settlement,
      cashPositionId: columns.cashPositionId,
      grossAmount: columns.grossAmount,
      description: columns.description,
      ...(columns.tags === undefined ? {} : { tags: columns.tags }),
      ...(columns.isOneOff === undefined ? {} : { isOneOff: columns.isOneOff }),
    });
    if (row === undefined) {
      throw new VersionConflictError('This entry changed while you were editing it.');
    }
    return row;
  })();

  await applyDormancyClearsIn(tx, ctx, plan.dormancy);
  return written;
}

export async function createIncomeEntryIn(
  tx: Transaction,
  ctx: RequestContext,
  args: IncomeEntryArgs,
): Promise<IncomeEntryRow> {
  const plan = await resolveIncomeCreateIn(tx, ctx, args);
  assertNoHistoricalReview(plan, ctx.today);
  return applyIncomePlanIn(tx, ctx, plan);
}

export async function createIncomeEntry(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: IncomeEntryArgs,
): Promise<IncomeEntryRow> {
  const created = await withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    createIncomeEntryIn(tx, ctx, args),
  );

  await deps.fx.ensureHistory(args.currency, args.receivedOn);
  return created;
}

export interface UpdateIncomeEntryArgs {
  readonly entryId: string;
  readonly expectedVersion: number;
  readonly kind?: IncomeKind | undefined;
  readonly receivedOn?: string | undefined;
  readonly netAmount?: string | undefined;
  readonly grossAmount?: string | null | undefined;
  readonly settlement?: IncomeSettlement | undefined;
  readonly cashPositionId?: string | null | undefined;
  readonly description?: string | null | undefined;
  readonly tags?: string[] | undefined;
  readonly isOneOff?: boolean | undefined;
  readonly reason?: string | undefined;
}

async function updateIncomeEntryIn(
  tx: Transaction,
  ctx: RequestContext,
  args: UpdateIncomeEntryArgs,
): Promise<IncomeEntryRow> {
  const plan = await resolveIncomeUpdateIn(tx, ctx, args);
  assertNoHistoricalReview(plan, ctx.today);
  return applyIncomePlanIn(tx, ctx, plan, args.reason);
}

/**
 * Correct an income entry.
 *
 * `occurrence_date` is absent from the patch on purpose: it is the scheduling
 * identity of the occurrence this row fulfilled, so moving the financial date
 * must not move it (§30.9 item 2). The repository type does not carry the
 * field, so this is enforced by the compiler rather than by remembering.
 *
 * One scope, as creation already does: the row it was judged from, the
 * corrected row, its audit entry and the dormancy the correction clears are one
 * fact (ADR 0005 §2, ADR 0010 §5). Moving an entry onto a dormant account in
 * two transactions could commit the attribution and then lose the clear,
 * leaving the account asserting "no movement" while a flow it owns says
 * otherwise — and nothing would report it, because each half succeeded.
 *
 * A correction whose before or after date lands in a completed month, or whose
 * dormancy consequence reaches one, is a Historical Correction and is refused
 * here: it goes through Preview → Confirm instead (30.22 item 1).
 */
export async function updateIncomeEntry(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: UpdateIncomeEntryArgs,
): Promise<IncomeEntryRow> {
  return withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    updateIncomeEntryIn(tx, ctx, args),
  );
}

export interface DeleteIncomeEntryArgs {
  readonly entryId: string;
  /** The version the client rendered (6.3, 20.3, 30.22 item 10). */
  readonly expectedVersion: number;
  readonly reason?: string | undefined;
}

async function deleteIncomeEntryIn(
  tx: Transaction,
  ctx: RequestContext,
  args: DeleteIncomeEntryArgs,
): Promise<IncomeEntryRow> {
  const plan = await resolveIncomeDeleteIn(tx, args);
  assertNoHistoricalReview(plan, ctx.today);
  return applyIncomePlanIn(tx, ctx, plan, args.reason);
}

/**
 * Delete an income entry at the version the client saw (6.3, 30.22 item 10).
 *
 * A stale version refuses and deletes nothing, so a row corrected in another
 * tab — or in another month's editor — is never removed by a request that was
 * about the version before it. The refusal happens before the delete, so no
 * audit row records a deletion that did not happen.
 *
 * Deleting an entry out of a completed month is a Historical Correction; the
 * current month's own delete stays one short confirmation (§71).
 */
export async function deleteIncomeEntry(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: DeleteIncomeEntryArgs,
): Promise<IncomeEntryRow> {
  return withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    deleteIncomeEntryIn(tx, ctx, args),
  );
}
