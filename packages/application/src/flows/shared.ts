import {
  clearCashDormancyIn,
  findPositionIn,
  hasParticipatingCashAccountIn,
  type AuditContext,
  type Database,
  type PositionRecord as PositionRow,
  type Transaction,
} from '@vaultide/db';
import type { RequestContext } from '../context';
import { NotFoundError, ValidationError } from '../errors';
import type { FxService } from '../fx/service';
import { dormancyChanged, type DormancyEffect, type DormancyState } from '../write-plan';

/**
 * The rules every Phase 3 flow obeys, in one place (blueprint 8.1, 8.8, M5).
 *
 * Income, expenses and transfers differ in what they mean and agree completely
 * on where they may attach: a cash account the user owns, of the flow's own
 * currency, open on the flow's date — or no account at all, which is a tracked
 * flow awaiting attribution and **not** an untracked one.
 *
 * Every helper here that touches the database takes a `Transaction`, never a
 * `Database`: these are the reads a flow's decision rests on, and they belong
 * inside the write's own mutex-owned transaction (20.3, 30.22 item 5).
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
export async function requireCashAccountIn(
  tx: Transaction,
  positionId: string,
): Promise<PositionRow> {
  const position = await findPositionIn(tx, positionId);
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
 *
 * Inside the caller's transaction, so an account closed or deleted between the
 * check and the write cannot make the flow land in a bucket nothing reconciles.
 */
export async function resolveTrackedCashLegIn(
  tx: Transaction,
  args: { cashPositionId: string | null; currency: string; on: string; dateField: string },
): Promise<PositionRow | null> {
  if (args.cashPositionId === null) {
    const participates = await hasParticipatingCashAccountIn(tx, args.currency, args.on);
    if (!participates) {
      throw new ValidationError(
        `You have no ${args.currency} cash account open on ${args.on}, so this flow has nothing to reconcile against. Choose an account, or add one.`,
        { cashPositionId: ['Choose the account this went through.'] },
      );
    }
    return null;
  }

  const position = await requireCashAccountIn(tx, args.cashPositionId);
  assertCurrencyMatches(position, args.currency);
  assertAccountParticipates(position, args.on, args.dateField);
  return position;
}

/* -------------------------------------------------------------------------- */
/* Dormancy, as a resolved consequence                                         */
/* -------------------------------------------------------------------------- */

/** A cash account's dormant episode as a row carries it (8.8, 30.20). */
export function dormancyStateOf(position: PositionRow): DormancyState {
  return {
    isDormant: position.isDormant === true,
    dormantFrom: position.dormantFrom ?? null,
  };
}

const AWAKE: DormancyState = { isDormant: false, dormantFrom: null };

/**
 * The consequence clear, as the plan that describes it.
 *
 * A clear only ever moves a dormant account to awake, so the effect is fully
 * determined by the row it was read from. An account that is already awake
 * produces an effect that changes nothing, which `dormancyChanged` filters and
 * `classifyHistorical` ignores.
 */
export function clearDormancyEffect(position: PositionRow): DormancyEffect {
  return {
    positionId: position.id,
    before: dormancyStateOf(position),
    after: AWAKE,
    via: 'clear',
  };
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
 *
 * What changed with Historical Correction is **when** the consequence is known,
 * not what it is: it is now resolved before the write, as a `DormancyEffect`,
 * so a save that would end an episode anchored in a closed month can be refused
 * before a single row moves (ADR 0010 §1). This applies what was resolved.
 */
export async function applyDormancyClearsIn(
  tx: Transaction,
  ctx: RequestContext,
  effects: readonly DormancyEffect[],
): Promise<void> {
  const seen = new Set<string>();
  for (const effect of effects) {
    if (effect.via !== 'clear' || !dormancyChanged(effect)) continue;
    if (seen.has(effect.positionId)) continue;
    seen.add(effect.positionId);
    await clearCashDormancyIn(
      tx,
      { userId: ctx.userId, requestId: ctx.requestId },
      effect.positionId,
    );
  }
}

/**
 * The user's own explanation of a correction, as the audit trail should hold it
 * (blueprint 18.1; ADR 0010 §11).
 *
 * One normalization, in one place. A reason that is absent, empty, or nothing
 * but whitespace is the *same fact* — the user did not give one — and an audit
 * row that stored `''` or `'   '` would record that fact as a string somebody
 * has to squint at. It becomes `undefined` here, and `recordAudit` writes
 * `NULL`.
 *
 * Length is not judged here: the input schemas already bound it, and silently
 * truncating somebody's explanation would be worse than refusing it.
 */
export function normalizeReason(reason: string | null | undefined): string | undefined {
  if (reason === null || reason === undefined) return undefined;
  const trimmed = reason.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** The audit context every financial write passes to the repositories. */
export function auditContextOf(ctx: RequestContext, reason?: string | null): AuditContext {
  const explanation = normalizeReason(reason);
  return {
    userId: ctx.userId,
    requestId: ctx.requestId,
    ...(explanation === undefined ? {} : { reason: explanation }),
  };
}
