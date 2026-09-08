import {
  findPosition,
  hasParticipatingCashAccount,
  updateCashDormantFlagIn,
  type Database,
  type PositionRecord as PositionRow,
  type Transaction,
} from '@vaultide/db';
import type { RequestContext } from '../context';
import { NotFoundError, ValidationError } from '../errors';
import type { FxService } from '../fx/service';

/**
 * The rules every Phase 3 flow obeys, in one place (blueprint 8.1, 8.8, M5).
 *
 * Income, expenses and transfers differ in what they mean and agree completely
 * on where they may attach: a cash account the user owns, of the flow's own
 * currency, open on the flow's date — or no account at all, which is a tracked
 * flow awaiting attribution and **not** an untracked one.
 */

export interface FlowDependencies {
  readonly db: Database;
  readonly fx: FxService;
}

/**
 * A cash account of this user, or `NOT_FOUND`.
 *
 * Another user's id and a nonexistent id produce the same error with the same
 * message, so an id cannot be probed for existence (17.3). RLS makes the read
 * return nothing either way; this turns that into the right error.
 */
export async function requireCashAccount(
  db: Database,
  ctx: RequestContext,
  positionId: string,
): Promise<PositionRow> {
  const position = await findPosition(db, ctx.userId, positionId);
  if (position === undefined || position.kind !== 'cash') {
    throw new NotFoundError('That account no longer exists.');
  }
  return position;
}

/** No actual financial record may be dated after today (M5, R17). */
export function assertNotFuture(ctx: RequestContext, date: string, field: string): void {
  if (date > ctx.today) {
    throw new ValidationError('This date is in the future. Records can only be dated up to today.', {
      [field]: ['This date is in the future.'],
    });
  }
}

/**
 * The account must be able to participate on the flow's date (8.1, M4).
 *
 * A flow attributed to an account before it opened or after it closed has no
 * bucket to belong to: 8.1 defines participation by exactly this window, so
 * reconciliation would either drop the flow or attribute it to a month the
 * account was not part of. Rejecting it at the source is the only honest
 * answer — the alternative is a residual nobody can explain.
 */
export function assertAccountParticipates(
  position: PositionRow,
  on: string,
  field: string,
): void {
  if (position.openedOn !== null && on < position.openedOn) {
    throw new ValidationError('This date is before the account opened.', {
      [field]: [`${position.name} opened on ${position.openedOn}.`],
    });
  }
  if (position.closedOn !== null && on > position.closedOn) {
    throw new ValidationError('This date is after the account closed.', {
      [field]: [`${position.name} closed on ${position.closedOn}.`],
    });
  }
}

/** A flow's cash leg is in the account's own currency (8.1, R4). */
export function assertCurrencyMatches(position: PositionRow, currency: string): void {
  if (position.currency !== currency) {
    throw new ValidationError(
      `${position.name} is held in ${position.currency}, so it cannot hold a ${currency} flow.`,
      { currency: [`Choose a ${position.currency} account, or change the currency.`] },
    );
  }
}

/**
 * Resolve the cash leg of a tracked flow.
 *
 * With an account: check ownership, currency and the participation window.
 * Without one: check that *some* cash account of that currency participates on
 * the date, because 8.1 requires it and a null-leg flow in a currency with no
 * account is the blocking `flow_without_cash_account` issue. What this never
 * does is treat the missing account as evidence the flow was untracked —
 * settlement is a stated fact, never an inference (§30.9 item 1).
 */
export async function resolveTrackedCashLeg(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: { cashPositionId: string | null; currency: string; on: string; dateField: string },
): Promise<PositionRow | null> {
  if (args.cashPositionId === null) {
    const participates = await hasParticipatingCashAccount(
      deps.db,
      ctx.userId,
      args.currency,
      args.on,
    );
    if (!participates) {
      throw new ValidationError(
        `You have no ${args.currency} cash account open on ${args.on}, so this flow has nothing to reconcile against. Choose an account, or add one.`,
        { cashPositionId: ['Choose the account this went through.'] },
      );
    }
    return null;
  }

  const position = await requireCashAccount(deps.db, ctx, args.cashPositionId);
  assertCurrencyMatches(position, args.currency);
  assertAccountParticipates(position, args.on, args.dateField);
  return position;
}

/**
 * An attributed flow clears dormancy (8.8, v2.1.6 §30.9 item 6).
 *
 * Three things this deliberately does:
 *
 *  - it runs **inside the flow's transaction**, so the flow and the cleared
 *    flag cannot come apart;
 *  - it does **not** consume the position's optimistic version, because the
 *    clear is a consequence rather than a user edit, and an account form
 *    somebody has open must not be invalidated by it (the Phase 2 rule);
 *  - it clears for a **back-dated** flow too. That is the conservative
 *    direction: clearing only ever asks for more evidence, whereas leaving the
 *    flag set would let an assumption make a past month look reliable.
 *
 * Deleting the last attributed flow does not restore dormancy. Dormancy is a
 * user assertion, re-made only through the explicit action, which still
 * requires the latest balance to be exactly zero.
 */
export async function clearDormancyForFlowIn(
  tx: Transaction,
  ctx: RequestContext,
  positionIds: readonly (string | null)[],
): Promise<void> {
  const seen = new Set<string>();
  for (const positionId of positionIds) {
    // A null leg attributes to no account, so it clears nothing.
    if (positionId === null || seen.has(positionId)) continue;
    seen.add(positionId);
    await updateCashDormantFlagIn(
      tx,
      { userId: ctx.userId, requestId: ctx.requestId },
      positionId,
      false,
    );
  }
}

/** The audit context every flow write passes to the repositories. */
export function auditContextOf(ctx: RequestContext, reason?: string) {
  return {
    userId: ctx.userId,
    requestId: ctx.requestId,
    ...(reason === undefined ? {} : { reason }),
  };
}
