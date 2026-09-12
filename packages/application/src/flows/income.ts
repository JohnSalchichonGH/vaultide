import {
  deleteIncomeEntry as deleteIncomeEntryRow,
  findIncomeEntry,
  insertIncomeEntryIn,
  updateIncomeEntryIn,
  withUser,
  type IncomeEntryRow,
} from '@vaultide/db';
import { allowedIncomeSettlements, type IncomeKind, type IncomeSettlement } from '@vaultide/validation';
import type { RequestContext } from '../context';
import { NotFoundError, ValidationError, VersionConflictError } from '../errors';
import {
  assertNotFuture,
  auditContextOf,
  clearDormancyForFlowIn,
  resolveTrackedCashLeg,
  type FlowDependencies,
} from './shared';

/**
 * Income entries (blueprint 6.2, 7.4, 12.5, v2.1.6 §30.9 item 5).
 *
 * Money arriving, and the settlement that says what it means. Every function
 * here is reached only through `financialAction`, whose session is validated
 * against the store rather than the cookie cache (ADR 0003).
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

export async function createIncomeEntry(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: IncomeEntryArgs,
): Promise<IncomeEntryRow> {
  assertNotFuture(ctx, args.receivedOn, 'receivedOn');
  assertIncomeSettlementAllowed(args.kind, args.settlement);

  const cashPositionId = args.settlement === 'tracked_cash' ? (args.cashPositionId ?? null) : null;

  if (args.settlement === 'tracked_cash') {
    await resolveTrackedCashLeg(deps, ctx, {
      cashPositionId,
      currency: args.currency,
      on: args.receivedOn,
      dateField: 'receivedOn',
    });
  }

  const audit = auditContextOf(ctx);
  const created = await withUser(deps.db, { userId: ctx.userId }, async (tx) => {
    const row = await insertIncomeEntryIn(tx, audit, {
      kind: args.kind,
      receivedOn: args.receivedOn,
      netAmount: args.netAmount,
      grossAmount: args.grossAmount ?? null,
      currency: args.currency,
      settlement: args.settlement,
      cashPositionId,
      description: args.description ?? null,
      tags: args.tags ?? [],
      isOneOff: args.isOneOff ?? false,
    });
    await clearDormancyForFlowIn(tx, ctx, [cashPositionId]);
    return row;
  });

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

/**
 * Correct an income entry.
 *
 * `occurrence_date` is absent from the patch on purpose: it is the scheduling
 * identity of the occurrence this row fulfilled, so moving the financial date
 * must not move it (§30.9 item 2). The repository type does not carry the
 * field, so this is enforced by the compiler rather than by remembering.
 */
export async function updateIncomeEntry(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: UpdateIncomeEntryArgs,
): Promise<IncomeEntryRow> {
  const existing = await findIncomeEntry(deps.db, ctx.userId, args.entryId);
  if (existing === undefined) throw new NotFoundError('That income entry no longer exists.');

  const kind = args.kind ?? existing.kind;
  const settlement = args.settlement ?? existing.settlement;
  const receivedOn = args.receivedOn ?? existing.receivedOn;
  const netAmount = args.netAmount ?? existing.netAmount;

  assertNotFuture(ctx, receivedOn, 'receivedOn');
  assertIncomeSettlementAllowed(kind, settlement);

  const requestedCash =
    args.cashPositionId === undefined ? existing.cashPositionId : args.cashPositionId;
  const cashPositionId = settlement === 'tracked_cash' ? requestedCash : null;

  if (settlement === 'tracked_cash') {
    await resolveTrackedCashLeg(deps, ctx, {
      cashPositionId,
      currency: existing.currency,
      on: receivedOn,
      dateField: 'receivedOn',
    });
  }

  // One scope, as creation already does: the corrected row, its audit entry and
  // the dormancy the correction clears are one fact (ADR 0005 §2). Moving an
  // entry onto a dormant account in two transactions could commit the
  // attribution and then lose the clear, leaving the account asserting "no
  // movement" while a flow it owns says otherwise — and nothing would report it,
  // because each half succeeded.
  const audit = auditContextOf(ctx, args.reason);
  const updated = await withUser(deps.db, { userId: ctx.userId }, async (tx) => {
    const row = await updateIncomeEntryIn(tx, audit, args.entryId, args.expectedVersion, {
      kind,
      receivedOn,
      netAmount,
      settlement,
      cashPositionId,
      ...(args.grossAmount === undefined ? {} : { grossAmount: args.grossAmount }),
      ...(args.description === undefined ? {} : { description: args.description }),
      ...(args.tags === undefined ? {} : { tags: args.tags }),
      ...(args.isOneOff === undefined ? {} : { isOneOff: args.isOneOff }),
    });
    if (row === undefined) return undefined;
    await clearDormancyForFlowIn(tx, ctx, [cashPositionId]);
    return row;
  });

  if (updated === undefined) {
    throw new VersionConflictError('This entry changed while you were editing it.');
  }

  return updated;
}

export async function deleteIncomeEntry(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: { entryId: string; reason?: string | undefined },
): Promise<IncomeEntryRow> {
  const removed = await deleteIncomeEntryRow(
    deps.db,
    auditContextOf(ctx, args.reason),
    args.entryId,
  );
  if (removed === undefined) throw new NotFoundError('That income entry no longer exists.');
  return removed;
}
