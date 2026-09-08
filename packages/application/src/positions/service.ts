import {
  countValuations,
  deletePosition,
  findLatestValuation,
  findPosition,
  insertCashAccount,
  insertOtherAsset,
  updatePosition,
  type Database,
  type PositionRecord as PositionRow,
} from '@vaultide/db';
import { Decimal, plainDate } from '@vaultide/finance';
import { usableCurrencyCodes } from '../currencies/service';
import type { RequestContext } from '../context';
import {
  ImpossibleOperationError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
} from '../errors';
import type { FxService } from '../fx/service';

/**
 * Position lifecycle services (blueprint 5.2, 6.2, 6.3, M6, R22).
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
 * What they deliberately do **not** do is explain a balance change. A valuation
 * is a snapshot; income, spending and transfers are Phase 3's tables, and no
 * function here invents one from a difference between two snapshots.
 */

export interface PositionDependencies {
  readonly db: Database;
  readonly fx: FxService;
}

/** A currency must exist, be active and be one we hold rates for (10.5, R28). */
async function assertUsableCurrency(db: Database, currency: string): Promise<string> {
  const code = currency.trim().toUpperCase();
  const usable = await usableCurrencyCodes(db, [code]);
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
 */
async function warmRates(deps: PositionDependencies, currency: string, earliest: string): Promise<void> {
  await deps.fx.ensureHistory(currency, earliest);
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

export async function createCashAccount(
  deps: PositionDependencies,
  ctx: RequestContext,
  args: CreateCashAccountArgs,
): Promise<PositionRow> {
  const currency = await assertUsableCurrency(deps.db, args.currency);
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

  const created = await insertCashAccount(
    deps.db,
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

  await warmRates(deps, currency, args.openingBalanceOn ?? args.openedOn ?? ctx.today);
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

export async function createOtherAsset(
  deps: PositionDependencies,
  ctx: RequestContext,
  args: CreateOtherAssetArgs,
): Promise<PositionRow> {
  const currency = await assertUsableCurrency(deps.db, args.currency);
  assertNotFuture(ctx, args.acquisitionDate);
  assertNotFuture(ctx, args.currentValueOn);

  const created = await insertOtherAsset(
    deps.db,
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

  await warmRates(deps, currency, args.currentValueOn ?? ctx.today);
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

async function requirePosition(
  deps: PositionDependencies,
  ctx: RequestContext,
  positionId: string,
): Promise<PositionRow> {
  const row = await findPosition(deps.db, ctx.userId, positionId);
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

export async function updateCashAccount(
  deps: PositionDependencies,
  ctx: RequestContext,
  args: UpdateCashAccountArgs,
): Promise<PositionRow> {
  const existing = await requirePosition(deps, ctx, args.positionId);
  if (existing.kind !== 'cash') throw new NotFoundError('That account no longer exists.');

  if (args.isDormant === true) {
    // 6.2: dormant is settable only while the latest balance is exactly zero.
    // Otherwise a forgotten flag would assert "still zero" about an account
    // that is not, and carry it silently through every month (R22).
    const latest = await findLatestValuation(deps.db, ctx.userId, args.positionId, ctx.today);
    if (latest === undefined || !new Decimal(latest.amount).isZero()) {
      throw new ImpossibleOperationError(
        'An account can only be marked dormant once its balance is exactly zero. Record a zero balance first, or transfer what is left.',
      );
    }
  }

  const updated = await updatePosition(
    deps.db,
    { userId: ctx.userId, requestId: ctx.requestId },
    args.positionId,
    args.expectedVersion,
    {
      ...(args.name === undefined ? {} : { name: args.name }),
      ...(args.notes === undefined ? {} : { notes: args.notes }),
    },
    {
      cash: {
        ...(args.accountType === undefined
          ? {}
          : { accountType: args.accountType }),
        ...(args.institution === undefined ? {} : { institution: args.institution }),
        ...(args.isDormant === undefined ? {} : { isDormant: args.isDormant }),
      },
    },
  );

  if (updated === undefined) throw new VersionConflictError();
  return updated;
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
  const existing = await requirePosition(deps, ctx, args.positionId);
  if (existing.kind !== 'other_asset') throw new NotFoundError('That asset no longer exists.');
  assertNotFuture(ctx, args.acquisitionDate);

  const updated = await updatePosition(
    deps.db,
    { userId: ctx.userId, requestId: ctx.requestId },
    args.positionId,
    args.expectedVersion,
    {
      ...(args.name === undefined ? {} : { name: args.name }),
      ...(args.notes === undefined ? {} : { notes: args.notes }),
    },
    {
      otherAsset: {
        ...(args.assetType === undefined
          ? {}
          : { assetType: args.assetType }),
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

  if (updated === undefined) throw new VersionConflictError();
  return updated;
}

export interface ClosePositionArgs {
  readonly positionId: string;
  readonly expectedVersion: number;
  readonly closedOn: string;
}

/**
 * Close a position (M6).
 *
 * Closing requires a final valuation of **zero** on the closing date. That is
 * not bureaucracy: an account closed while it still shows €4,000 would drop
 * that money out of net worth with no record of where it went, which is exactly
 * the kind of silent loss this product exists to prevent. The message says what
 * to do instead.
 */
export async function closePosition(
  deps: PositionDependencies,
  ctx: RequestContext,
  args: ClosePositionArgs,
): Promise<PositionRow> {
  const existing = await requirePosition(deps, ctx, args.positionId);
  assertNotFuture(ctx, args.closedOn);

  if (existing.status === 'closed') {
    throw new ImpossibleOperationError('That account is already closed.');
  }
  if (existing.openedOn !== null && args.closedOn < existing.openedOn) {
    throw new ValidationError('An account cannot close before it opened.', {
      closedOn: ['This date is before the account opened.'],
    });
  }

  const latest = await findLatestValuation(deps.db, ctx.userId, args.positionId, args.closedOn);
  if (latest === undefined || !new Decimal(latest.amount).isZero()) {
    throw new ImpossibleOperationError(
      existing.kind === 'cash'
        ? 'This account still holds a balance. Record where the money went — a balance of zero on the closing date — and then close it.'
        : 'This asset still has a value. Record a final value of zero on the closing date, and then close it.',
    );
  }

  const updated = await updatePosition(
    deps.db,
    { userId: ctx.userId, requestId: ctx.requestId },
    args.positionId,
    args.expectedVersion,
    { status: 'closed', closedOn: args.closedOn },
  );
  if (updated === undefined) throw new VersionConflictError();
  return updated;
}

/**
 * Delete a position outright — only while it has no history at all (6.3).
 *
 * The database enforces it too: the `NO ACTION` foreign key from
 * `position_valuations` refuses. This check exists so the answer is a sentence
 * rather than a constraint violation.
 */
export async function removePosition(
  deps: PositionDependencies,
  ctx: RequestContext,
  positionId: string,
): Promise<void> {
  await requirePosition(deps, ctx, positionId);

  const valuations = await countValuations(deps.db, ctx.userId, positionId);
  if (valuations > 0) {
    throw new ImpossibleOperationError(
      'This account has recorded balances, so deleting it would delete history. Close it instead — it keeps everything and stops counting towards net worth.',
    );
  }

  const deleted = await deletePosition(
    deps.db,
    { userId: ctx.userId, requestId: ctx.requestId },
    positionId,
  );
  /* v8 ignore next -- `requirePosition` has already established it exists. */
  if (!deleted) throw new NotFoundError('That account no longer exists.');
}
