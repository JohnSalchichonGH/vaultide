import {
  countValuationsIn,
  deletePositionIn,
  findLatestValuationIn,
  findPositionIn,
  findUsableCurrencyCodesIn,
  insertCashAccountIn,
  insertOtherAssetIn,
  latestAttributedFlowDateIn,
  lockCashPositionsIn,
  updatePositionIn,
  type CashAccountPatch,
  type Database,
  type PositionRecord as PositionRow,
  type Transaction,
} from '@vaultide/db';
import { Decimal, plainDate } from '@vaultide/finance';
import type { RequestContext } from '../context';
import { withUserWrite } from '../coordination';
import { assertNoHistoricalReview } from '../corrections/guard';
import {
  ImpossibleOperationError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
} from '../errors';
import { auditContextOf, dormancyStateOf } from '../flows/shared';
import type { FxService } from '../fx/service';
import {
  dormancyChange,
  realDormancyEffects,
  type DormancyEffect,
  type ResolvedWrite,
  type ResolveOptions,
} from '../write-plan';

/**
 * Position lifecycle services (blueprint 5.2, 6.2, 6.3, 20.3, 30.22, M6, R22).
 *
 * Creating, editing, **closing** and deleting. Not archiving: §25 gives Phase 2
 * "create/edit/close cash accounts", and what archiving means for net worth is
 * 12.3's "removed from tracking" bucket — which needs a date the position was
 * removed on, and that belongs with the decomposition in Phase 7. Building the
 * button now would mean choosing between two wrong answers: an archived account
 * that still counts (so the button does nothing a user can see) or one that
 * retroactively vanishes from every past figure. `position_status` keeps its
 * `archived` value, because the enum is the closed set of 6.2 and later phases
 * extend it rather than re-create it.
 *
 * Every function here is reached only through `financialAction`, whose session
 * is validated against the store rather than the signed cookie cache (ADR
 * 0003). These are the writes that change what somebody's net worth says.
 *
 * And every one of them is **one** `withUserWrite` transaction: the mutex is
 * taken before the first authoritative read, so the state a decision is made
 * from is the state the write lands on (ADR 0010 §5). The only work left
 * outside is the FX warming below, which refreshes support data and decides
 * nothing (ADR 0010 §7, blueprint 10.4).
 *
 * What they deliberately do **not** do is explain a balance change. A valuation
 * is a snapshot; income, spending and transfers are Phase 3's tables, and no
 * function here invents one from a difference between two snapshots.
 */

export interface PositionDependencies {
  readonly db: Database;
  readonly fx: FxService;
}

/** A currency must exist, be active and be one we hold rates for (10.5, R28). */
async function assertUsableCurrencyIn(tx: Transaction, currency: string): Promise<string> {
  const code = currency.trim().toUpperCase();
  const usable = new Set(await findUsableCurrencyCodesIn(tx, [code]));
  if (!usable.has(code)) {
    throw new ValidationError(
      `${code} is not a currency Vaultide can value. It supports the official currencies its approved rate sources publish daily reference rates for; crypto is tracked as an investment, not as a currency.`,
      { currency: [code] },
    );
  }
  return code;
}

/**
 * Make a newly used currency convertible for the dates it will be asked about
 * (10.4).
 *
 * The earliest date passed is the position's own earliest financial date, so
 * the backfill covers what this account actually needs and no more. Failure is
 * swallowed inside `ensureHistory`: a rate publisher being slow must never undo
 * an account somebody just created.
 *
 * It takes the rate service alone rather than the dependency bundle, so this
 * post-commit step cannot reach a database handle even by accident (ADR 0010
 * §16 item 6).
 */
async function warmRates(fx: FxService, currency: string, earliest: string): Promise<void> {
  await fx.ensureHistory(currency, earliest);
}

export interface CreateCashAccountArgs {
  readonly name: string;
  readonly currency: string;
  readonly accountType: PositionRow['accountType'];
  readonly institution?: string | undefined;
  readonly notes?: string | undefined;
  /** `openedOn` set = "new account, started empty then"; `null` = pre-existing. */
  readonly openedOn: string | null;
  readonly openingBalance?: string | undefined;
  readonly openingBalanceOn?: string | undefined;
}

async function createCashAccountIn(
  tx: Transaction,
  ctx: RequestContext,
  args: CreateCashAccountArgs,
): Promise<PositionRow> {
  const currency = await assertUsableCurrencyIn(tx, args.currency);
  assertNotFuture(ctx, args.openedOn);
  assertNotFuture(ctx, args.openingBalanceOn);

  if (
    args.openedOn !== null &&
    args.openingBalanceOn !== undefined &&
    args.openingBalanceOn < args.openedOn
  ) {
    throw new ValidationError('A balance cannot predate the day the account opened.', {
      openingBalanceOn: ['This date is before the account opened.'],
    });
  }

  return insertCashAccountIn(
    tx,
    { userId: ctx.userId, requestId: ctx.requestId },
    {
      name: args.name,
      currency,
      accountType: args.accountType as NonNullable<PositionRow['accountType']>,
      institution: args.institution ?? null,
      notes: args.notes ?? null,
      openedOn: args.openedOn,
      ...(args.openingBalance === undefined || args.openingBalanceOn === undefined
        ? {}
        : {
            openingBalance: { amount: args.openingBalance, valuedOn: args.openingBalanceOn },
          }),
    },
  );
}

export async function createCashAccount(
  deps: PositionDependencies,
  ctx: RequestContext,
  args: CreateCashAccountArgs,
): Promise<PositionRow> {
  const created = await withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    createCashAccountIn(tx, ctx, args),
  );

  await warmRates(deps.fx, created.currency, args.openingBalanceOn ?? args.openedOn ?? ctx.today);
  return created;
}

export interface CreateOtherAssetArgs {
  readonly name: string;
  readonly currency: string;
  readonly assetType: PositionRow['assetType'];
  readonly notes?: string | undefined;
  readonly acquisitionDate?: string | undefined;
  readonly acquisitionValue?: string | undefined;
  readonly includeInFinancialNetWorth: boolean;
  readonly currentValue?: string | undefined;
  readonly currentValueOn?: string | undefined;
}

async function createOtherAssetIn(
  tx: Transaction,
  ctx: RequestContext,
  args: CreateOtherAssetArgs,
): Promise<PositionRow> {
  const currency = await assertUsableCurrencyIn(tx, args.currency);
  assertNotFuture(ctx, args.acquisitionDate);
  assertNotFuture(ctx, args.currentValueOn);

  return insertOtherAssetIn(
    tx,
    { userId: ctx.userId, requestId: ctx.requestId },
    {
      name: args.name,
      currency,
      assetType: args.assetType as NonNullable<PositionRow['assetType']>,
      notes: args.notes ?? null,
      acquisitionDate: args.acquisitionDate ?? null,
      acquisitionValue: args.acquisitionValue ?? null,
      includeInFinancialNetWorth: args.includeInFinancialNetWorth,
      ...(args.currentValue === undefined || args.currentValueOn === undefined
        ? {}
        : { currentValue: { amount: args.currentValue, valuedOn: args.currentValueOn } }),
    },
  );
}

export async function createOtherAsset(
  deps: PositionDependencies,
  ctx: RequestContext,
  args: CreateOtherAssetArgs,
): Promise<PositionRow> {
  const created = await withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    createOtherAssetIn(tx, ctx, args),
  );

  await warmRates(deps.fx, created.currency, args.currentValueOn ?? ctx.today);
  return created;
}

function assertNotFuture(ctx: RequestContext, date: string | null | undefined): void {
  if (date === null || date === undefined) return;
  // The schemas already refuse a future date; this is the domain saying the
  // same thing, so a service called from anywhere is judged by the same rule
  // (M5, R17, 20.1).
  if (plainDate(date) > ctx.today) {
    throw new ValidationError('This date is in the future. Records can only be dated up to today.');
  }
}

async function requirePositionIn(tx: Transaction, positionId: string): Promise<PositionRow> {
  const row = await findPositionIn(tx, positionId);
  if (row === undefined) throw new NotFoundError('That account no longer exists.');
  return row;
}

export interface UpdateCashAccountArgs {
  readonly positionId: string;
  readonly expectedVersion: number;
  readonly name?: string | undefined;
  readonly accountType?: PositionRow['accountType'] | undefined;
  readonly institution?: string | null | undefined;
  readonly notes?: string | null | undefined;
  readonly isDormant?: boolean | undefined;
}

/**
 * What an edit does to the account's dormant episode (8.8, v2.1.17 30.20).
 *
 * Only a **transition** writes anything. The account form sends the checkbox
 * with every save, so a rename of a dormant account arrives saying "dormant"
 * again; that must not move the date the episode starts from.
 *
 * Starting an episode needs evidence, read here from rows the caller has
 * already locked: the latest balance on or before today must be exactly zero,
 * and no attributed flow may be dated after it — a zero that money has since
 * moved past says nothing about the account now. A flow dated the same day is
 * already reflected in that balance (8.1). The episode starts on that balance's
 * date, not today: the carry is a statement about the balance, so it begins
 * where the balance is known.
 *
 * And that date is exactly why this is part of Historical Correction. An
 * episode anchored to a zero balance dated in a month that has already closed
 * reinterprets that month, so the transition goes through Preview → Confirm
 * however ordinary the rest of the save is (30.22 item 1; §10 of the slice
 * prompt). Renaming the account is still just a rename.
 */
async function dormancyTransitionIn(
  tx: Transaction,
  ctx: RequestContext,
  existing: PositionRow,
  requested: boolean | undefined,
): Promise<CashAccountPatch['dormancy']> {
  if (requested === undefined || requested === (existing.isDormant === true)) return undefined;
  if (!requested) return { isDormant: false, dormantFrom: null };

  const latest = await findLatestValuationIn(tx, existing.id, ctx.today);
  if (latest === undefined || !new Decimal(latest.amount).isZero()) {
    throw new ImpossibleOperationError(
      'An account can only be marked dormant once its balance is exactly zero. Record a zero balance first, or transfer what is left.',
    );
  }

  const lastActivity = await latestAttributedFlowDateIn(tx, existing.id);
  if (lastActivity !== undefined && lastActivity > latest.valuedOn) {
    throw new ImpossibleOperationError(
      `Money has moved through this account since its last balance, which is zero on ${latest.valuedOn}. Record a zero balance dated ${lastActivity} or later first, and then mark it dormant.`,
    );
  }

  return { isDormant: true, dormantFrom: latest.valuedOn };
}

/** A resolved cash-account edit, and the dormant episode it would move. */
export interface CashAccountWritePlan extends ResolvedWrite {
  readonly existing: PositionRow;
  readonly expectedVersion: number;
  readonly dormancyPatch: CashAccountPatch['dormancy'];
  readonly patch: {
    readonly name?: string;
    readonly notes?: string | null;
    readonly accountType?: PositionRow['accountType'];
    readonly institution?: string | null;
  };
}

export async function resolveUpdateCashAccountIn(
  tx: Transaction,
  ctx: RequestContext,
  args: UpdateCashAccountArgs,
  options: ResolveOptions = { lock: true },
): Promise<CashAccountWritePlan> {
  // Over the locked account (20.3, 30.20 item 5). The evidence for a dormant
  // episode and the write that starts it must not come apart: a flow recorded
  // between a check made outside and the update would leave an account dormant
  // on a zero it had already moved past. `lockCashPositionsIn` holds the
  // `positions` row a flow's foreign key needs and the `cash_accounts` row a
  // wake locks, so such a flow either commits before the evidence is read or
  // waits, and then wakes the account.
  //
  // The correction preview reads the same row without the lock, because a
  // `READ ONLY` transaction cannot take one; Confirm takes it for real before
  // anything is applied (ADR 0010 §8).
  //
  // Another user's id, a nonexistent one and a position of another kind are
  // all simply absent from the locked set, and read the same (17.2, 17.3).
  const existing = options.lock
    ? (await lockCashPositionsIn(tx, [args.positionId]))[0]
    : await cashPositionIn(tx, args.positionId);
  if (existing === undefined) throw new NotFoundError('That account no longer exists.');
  if (existing.version !== args.expectedVersion) throw new VersionConflictError();

  const dormancyPatch = await dormancyTransitionIn(tx, ctx, existing, args.isDormant);
  const dormancy: readonly DormancyEffect[] = realDormancyEffects(
    dormancyPatch === undefined
      ? []
      : [
          {
            positionId: existing.id,
            before: dormancyStateOf(existing),
            after: { isDormant: dormancyPatch.isDormant, dormantFrom: dormancyPatch.dormantFrom },
            via: 'account_update',
          },
        ],
  );

  return {
    existing,
    expectedVersion: args.expectedVersion,
    dormancyPatch,
    patch: {
      ...(args.name === undefined ? {} : { name: args.name }),
      ...(args.notes === undefined ? {} : { notes: args.notes }),
      ...(args.accountType === undefined ? {} : { accountType: args.accountType }),
      ...(args.institution === undefined ? {} : { institution: args.institution }),
    },
    // The account's own columns are not dated financial facts, so a rename or
    // an institution change is never a revision of history. Only the dormancy
    // rule can make this a correction.
    revision: false,
    changes: dormancy.map(dormancyChange),
    dormancy,
    support: [],
  };
}

/** A cash position read without a lock, for the correction preview alone. */
async function cashPositionIn(
  tx: Transaction,
  positionId: string,
): Promise<PositionRow | undefined> {
  const row = await findPositionIn(tx, positionId);
  return row === undefined || row.kind !== 'cash' ? undefined : row;
}

export async function applyCashAccountPlanIn(
  tx: Transaction,
  ctx: RequestContext,
  plan: CashAccountWritePlan,
  reason?: string,
): Promise<PositionRow> {
  const updated = await updatePositionIn(
    tx,
    auditContextOf(ctx, reason),
    plan.existing.id,
    plan.expectedVersion,
    {
      ...(plan.patch.name === undefined ? {} : { name: plan.patch.name }),
      ...(plan.patch.notes === undefined ? {} : { notes: plan.patch.notes }),
    },
    {
      cash: {
        ...(plan.patch.accountType === undefined ? {} : { accountType: plan.patch.accountType }),
        ...(plan.patch.institution === undefined ? {} : { institution: plan.patch.institution }),
        ...(plan.dormancyPatch === undefined ? {} : { dormancy: plan.dormancyPatch }),
      },
    },
  );
  if (updated === undefined) throw new VersionConflictError();
  return updated;
}

async function updateCashAccountIn(
  tx: Transaction,
  ctx: RequestContext,
  args: UpdateCashAccountArgs,
): Promise<PositionRow> {
  const plan = await resolveUpdateCashAccountIn(tx, ctx, args);
  assertNoHistoricalReview(plan, ctx.today);
  return applyCashAccountPlanIn(tx, ctx, plan);
}

/**
 * Edit a cash account.
 *
 * The name, the institution, the account type and the notes are ordinary
 * account housekeeping and stay ordinary. The dormant checkbox is not: the
 * episode it starts or ends is dated evidence, and one whose date reaches a
 * closed month goes through Historical Correction instead (§10 of the slice
 * prompt).
 */
export async function updateCashAccount(
  deps: PositionDependencies,
  ctx: RequestContext,
  args: UpdateCashAccountArgs,
): Promise<PositionRow> {
  return withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    updateCashAccountIn(tx, ctx, args),
  );
}

export interface UpdateOtherAssetArgs {
  readonly positionId: string;
  readonly expectedVersion: number;
  readonly name?: string | undefined;
  readonly assetType?: PositionRow['assetType'] | undefined;
  readonly notes?: string | null | undefined;
  readonly acquisitionDate?: string | null | undefined;
  readonly acquisitionValue?: string | null | undefined;
  readonly includeInFinancialNetWorth?: boolean | undefined;
}

async function updateOtherAssetIn(
  tx: Transaction,
  ctx: RequestContext,
  args: UpdateOtherAssetArgs,
): Promise<PositionRow | undefined> {
  const existing = await requirePositionIn(tx, args.positionId);
  if (existing.kind !== 'other_asset') throw new NotFoundError('That asset no longer exists.');
  assertNotFuture(ctx, args.acquisitionDate);

  return updatePositionIn(
    tx,
    { userId: ctx.userId, requestId: ctx.requestId },
    args.positionId,
    args.expectedVersion,
    {
      ...(args.name === undefined ? {} : { name: args.name }),
      ...(args.notes === undefined ? {} : { notes: args.notes }),
    },
    {
      otherAsset: {
        ...(args.assetType === undefined ? {} : { assetType: args.assetType }),
        ...(args.acquisitionDate === undefined ? {} : { acquisitionDate: args.acquisitionDate }),
        ...(args.acquisitionValue === undefined
          ? {}
          : { acquisitionValue: args.acquisitionValue }),
        ...(args.includeInFinancialNetWorth === undefined
          ? {}
          : { includeInFinancialNetWorth: args.includeInFinancialNetWorth }),
      },
    },
  );
}

/**
 * Edit an other asset, including its inclusion preference.
 *
 * Toggling `includeInFinancialNetWorth` is a financial change: it moves an
 * asset in or out of the headline metric across **all** history at once,
 * because the preference is not dated (12.1). It is audited for that reason,
 * and it can never take the asset out of total net worth.
 */
export async function updateOtherAsset(
  deps: PositionDependencies,
  ctx: RequestContext,
  args: UpdateOtherAssetArgs,
): Promise<PositionRow> {
  const updated = await withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    updateOtherAssetIn(tx, ctx, args),
  );

  if (updated === undefined) throw new VersionConflictError();
  return updated;
}

export interface ClosePositionArgs {
  readonly positionId: string;
  readonly expectedVersion: number;
  readonly closedOn: string;
}

async function closePositionIn(
  tx: Transaction,
  ctx: RequestContext,
  args: ClosePositionArgs,
): Promise<PositionRow | undefined> {
  const existing = await requirePositionIn(tx, args.positionId);
  assertNotFuture(ctx, args.closedOn);

  if (existing.status === 'closed') {
    throw new ImpossibleOperationError('That account is already closed.');
  }
  if (existing.openedOn !== null && args.closedOn < existing.openedOn) {
    throw new ValidationError('An account cannot close before it opened.', {
      closedOn: ['This date is before the account opened.'],
    });
  }

  const latest = await findLatestValuationIn(tx, args.positionId, args.closedOn);
  if (latest === undefined || !new Decimal(latest.amount).isZero()) {
    throw new ImpossibleOperationError(
      existing.kind === 'cash'
        ? 'This account still holds a balance. Record where the money went — a balance of zero on the closing date — and then close it.'
        : 'This asset still has a value. Record a final value of zero on the closing date, and then close it.',
    );
  }

  return updatePositionIn(
    tx,
    { userId: ctx.userId, requestId: ctx.requestId },
    args.positionId,
    args.expectedVersion,
    { status: 'closed', closedOn: args.closedOn },
  );
}

/**
 * Close a position (M6).
 *
 * Closing requires a final valuation of **zero** on the closing date. That is
 * not bureaucracy: an account closed while it still shows €4,000 would drop
 * that money out of net worth with no record of where it went, which is exactly
 * the kind of silent loss this product exists to prevent. The message says what
 * to do instead.
 *
 * The zero it requires and the close it writes are one transaction: a balance
 * recorded between the two would otherwise close an account over money that had
 * just arrived (30.22 item 5).
 */
export async function closePosition(
  deps: PositionDependencies,
  ctx: RequestContext,
  args: ClosePositionArgs,
): Promise<PositionRow> {
  const updated = await withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    closePositionIn(tx, ctx, args),
  );

  if (updated === undefined) throw new VersionConflictError();
  return updated;
}

async function removePositionIn(
  tx: Transaction,
  ctx: RequestContext,
  positionId: string,
): Promise<void> {
  await requirePositionIn(tx, positionId);

  const valuations = await countValuationsIn(tx, positionId);
  if (valuations > 0) {
    throw new ImpossibleOperationError(
      'This account has recorded balances, so deleting it would delete history. Close it instead — it keeps everything and stops counting towards net worth.',
    );
  }

  const deleted = await deletePositionIn(
    tx,
    { userId: ctx.userId, requestId: ctx.requestId },
    positionId,
  );
  /* v8 ignore next -- `requirePositionIn` has already established it exists. */
  if (!deleted) throw new NotFoundError('That account no longer exists.');
}

/**
 * Delete a position outright — only while it has no history at all (6.3).
 *
 * The database enforces it too: the `NO ACTION` foreign key from
 * `position_valuations` refuses. This check exists so the answer is a sentence
 * rather than a constraint violation — and it is read in the same transaction
 * as the delete, so a balance recorded in between cannot be deleted by a
 * request that was told there were none.
 */
export async function removePosition(
  deps: PositionDependencies,
  ctx: RequestContext,
  positionId: string,
): Promise<void> {
  await withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    removePositionIn(tx, ctx, positionId),
  );
}
