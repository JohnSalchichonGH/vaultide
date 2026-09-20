import {
  deleteExpenseEntryIn,
  deleteTransferIn,
  findCategoryIn,
  findTransferFeesIn,
  findTransferIn,
  insertExpenseEntryIn,
  insertTransferIn,
  listCategoryRecordsIn,
  lockCategoryIn,
  updateExpenseEntryIn,
  updateTransferIn,
  type AuditContext,
  type CategoryRecord,
  type ExpenseEntryRow,
  type PositionRecord as PositionRow,
  type Transaction,
  type TransferRow,
} from '@vaultide/db';
import { Decimal } from '@vaultide/finance';
import type { RequestContext } from '../context';
import { withUserWrite } from '../coordination';
import { assertNoHistoricalReview } from '../corrections/guard';
import {
  ImpossibleOperationError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
} from '../errors';
import {
  canonicalAmount,
  created,
  deleted,
  dormancyChange,
  mergeSupport,
  updated,
  type ExpenseSourceFacts,
  type IdentifiedSourceChange,
  type ResolvedWrite,
  type ResolveOptions,
  type SourceIdentity,
  type SupportWarm,
  type TransferSourceFacts,
} from '../write-plan';
import { expenseFacts } from './expenses';
import {
  applyDormancyClearsIn,
  assertAccountParticipates,
  assertNotFuture,
  auditContextOf,
  clearDormancyEffect,
  requireCashAccountIn,
  type FlowDependencies,
} from './shared';

/**
 * Cash transfers and their fee (blueprint 6.2, 7.4, 7.5, 8.8, M13, M14; ADR
 * 0006).
 *
 * A transfer is value the user already owned, moving. It is never income and
 * never spending: `Nout` on the source, `Nin` on the destination, cancelling
 * exactly inside one currency bucket and reconciling independently across two.
 *
 * Phase 3 exposes `cash_transfer` only, and always writes `template_id` and
 * `occurrence_date` as NULL — the columns exist for the contribution workflow
 * Phase 4 owns.
 *
 * ## The fee is one row, and it is its own row
 *
 * M14: a fee is an `expense_entries` row of the `transfer_fee` category linked
 * by `transfer_id`. There is no fee column on the transfer, because two
 * representations of one fact is how a fee gets counted twice.
 *
 * The fee is nonetheless its own source fact, with its own financial date (ADR
 * 0006 §4, §5). Its `incurred_on` may fall on another day than the transfer's
 * `occurred_on` — in another month included — and nothing here derives one from
 * the other: moving a transfer never moves its fee.
 *
 * What the caller does **not** choose is what a fee means. It is tracked cash
 * paid by one of the transfer's two endpoints, in that account's currency, and
 * filed under the user's `transfer_fee` category, which this module looks up
 * rather than accepting an identifier for (ADR 0006 §6).
 *
 * ## A correction is the whole aggregate
 *
 * An edit states the complete transfer it should become — its date, both
 * endpoints, both amounts, its description, and its fee or the absence of one —
 * and commits all of it or none of it (ADR 0006 §2). Beside the transfer's own
 * version it carries what the caller saw of the fee, so a fee added, changed or
 * removed elsewhere is a conflict rather than something to overwrite (20.3).
 *
 * Every mutation locks the transfer's row before its fee rows. A fee is only
 * ever written by a caller holding that lock, so a fee that appears after
 * another writer read the aggregate cannot slip past it, and the two orders that
 * could deadlock never meet.
 *
 * ## Why deletion does not lean on the cascade
 *
 * `expense_entries.transfer_id` is `ON DELETE CASCADE`, which would remove a
 * fee without any application code running — and therefore without its audit
 * before-image. So the ordinary path deletes every fee explicitly first, each
 * with its own audit row, and the cascade finds nothing left to do. The
 * constraint stays because it is the right behaviour for account deletion,
 * where the audit rows are being removed in the same cascade anyway.
 */

/** A transfer's fee, as its facts are stated: the amount, who paid it, and when. */
export interface TransferFeeArgs {
  readonly amount: string;
  /** Which side paid it. Must be one of the transfer's own endpoints. */
  readonly cashPositionId: string;
  /** The fee's own financial date (ADR 0006 §5), never derived from the transfer's. */
  readonly incurredOn: string;
}

export interface CreateTransferArgs {
  readonly occurredOn: string;
  readonly fromPositionId: string;
  readonly toPositionId: string;
  readonly fromAmount: string;
  readonly toAmount: string;
  readonly description?: string | undefined;
  readonly tags?: string[] | undefined;
  readonly fee?: TransferFeeArgs | undefined;
}

export interface TransferWithFee {
  readonly transfer: TransferRow;
  readonly fee: ExpenseEntryRow | null;
}

/**
 * What the caller saw of the fee when it began the edit (20.3).
 *
 * `absent` is "there was no fee"; `version` is "there was this exact row": that
 * id, at that version. A correction is judged against it, never against a read
 * the server takes for itself, so two people editing the same transfer cannot
 * both succeed with the later save silently undoing the earlier one.
 *
 * The id is needed because a version alone cannot say which row it counts.
 * Removing a fee and adding another leaves the transfer's version where it was,
 * and the new row starts again at the version the removed one had.
 */
export type TransferFeeExpectation =
  | { readonly state: 'absent' }
  | { readonly state: 'version'; readonly feeId: string; readonly version: number };

export interface UpdateTransferArgs {
  readonly transferId: string;
  readonly expectedVersion: number;
  readonly occurredOn: string;
  readonly fromPositionId: string;
  readonly toPositionId: string;
  readonly fromAmount: string;
  readonly toAmount: string;
  /** `null` clears it. */
  readonly description: string | null;
  /** Absent keeps the stored tags; Monthly does not edit them. */
  readonly tags?: string[] | undefined;
  /** The fee the transfer should carry once this lands, or `null` for none. */
  readonly fee: TransferFeeArgs | null;
  readonly expectedFee: TransferFeeExpectation;
  readonly reason?: string | undefined;
}

/** The facts of a transfer aggregate, as a create or a correction states them. */
interface TransferFacts {
  readonly occurredOn: string;
  readonly fromPositionId: string;
  readonly toPositionId: string;
  readonly fromAmount: string;
  readonly toAmount: string;
  readonly fee: TransferFeeArgs | null;
}

/** Those facts with the accounts they name, once every rule has passed. */
interface ResolvedFacts {
  readonly from: PositionRow;
  readonly to: PositionRow;
  /** The fee with the endpoint that pays it, or `null` for none. */
  readonly fee: { readonly facts: TransferFeeArgs; readonly payer: PositionRow } | null;
}

/** A fee about to be written, with the category it is filed under. */
interface FeeToSave {
  readonly facts: TransferFeeArgs;
  readonly payer: PositionRow;
  readonly category: CategoryRecord;
}

/** Two amounts compared as the exact decimals they are, never as their spelling. */
const sameAmount = (a: string, b: string): boolean => new Decimal(a).equals(new Decimal(b));

/** M13: within one currency a transfer moves one amount, not two. */
function assertAmountsAgree(
  fromCurrency: string,
  toCurrency: string,
  fromAmount: string,
  toAmount: string,
): void {
  if (fromCurrency !== toCurrency) return;
  if (fromAmount === toAmount) return;
  throw new ValidationError(
    'A transfer within one currency moves the same amount out and in.',
    { toAmount: ['This must match the amount sent.'] },
  );
}

/**
 * A corrected endpoint keeps its leg's stored currency (20.1; ADR 0006 §3).
 *
 * The amount on each side is a native fact in that side's currency. Pointing a
 * dollar leg at a euro account would turn 100 USD into 100 EUR without anybody
 * saying so, so a leg's currency is corrected by recording the right transfer,
 * never by moving an endpoint.
 */
function assertLegCurrency(
  account: PositionRow,
  currency: string,
  field: 'fromPositionId' | 'toPositionId',
): void {
  if (account.currency === currency) return;
  throw new ValidationError(
    `This side of the transfer was recorded in ${currency}, and ${account.name} holds ${account.currency}. To change a transfer’s currency, delete it and record the right one.`,
    { [field]: [`Choose a ${currency} account.`] },
  );
}

/**
 * Everything a transfer aggregate must satisfy that is not already decided by
 * its stored rows (7.5, 8.1, M5, M13; ADR 0006 §3, §5, §6).
 *
 * Judged on the facts as they would be saved, never on what is stored, so a
 * correction that repairs an inconsistent transfer succeeds and one that keeps
 * the inconsistency fails. `legCurrencies` is the stored pair when correcting:
 * an endpoint may move, a currency may not.
 */
async function resolveFactsIn(
  tx: Transaction,
  ctx: RequestContext,
  facts: TransferFacts,
  legCurrencies?: { readonly from: string; readonly to: string },
): Promise<ResolvedFacts> {
  assertNotFuture(ctx, facts.occurredOn, 'occurredOn');
  if (facts.fee !== null) assertNotFuture(ctx, facts.fee.incurredOn, 'fee.incurredOn');

  if (facts.fromPositionId === facts.toPositionId) {
    throw new ValidationError('A transfer needs two different accounts.', {
      toPositionId: ['Choose a different account.'],
    });
  }

  const from = await requireCashAccountIn(tx, facts.fromPositionId);
  const to = await requireCashAccountIn(tx, facts.toPositionId);
  if (legCurrencies !== undefined) {
    assertLegCurrency(from, legCurrencies.from, 'fromPositionId');
    assertLegCurrency(to, legCurrencies.to, 'toPositionId');
  }
  assertAccountParticipates(from, facts.occurredOn, 'occurredOn');
  assertAccountParticipates(to, facts.occurredOn, 'occurredOn');
  assertAmountsAgree(from.currency, to.currency, facts.fromAmount, facts.toAmount);

  if (facts.fee === null) return { from, to, fee: null };

  const payer =
    facts.fee.cashPositionId === from.id ? from : facts.fee.cashPositionId === to.id ? to : null;
  if (payer === null) {
    throw new ValidationError(
      'The fee has to come out of one of the two accounts this transfer touches.',
      { 'fee.cashPositionId': ['Choose the account that paid the fee.'] },
    );
  }
  // 8.1 on the fee's own date: the day it was charged, whichever day the
  // transfer moved on.
  assertAccountParticipates(payer, facts.fee.incurredOn, 'fee.incurredOn');
  return { from, to, fee: { facts: facts.fee, payer } };
}

/**
 * The user's transfer-fee category, looked up rather than trusted (7.4; ADR
 * 0006 §6).
 *
 * One category of each system kind per user is an application invariant —
 * provisioned at sign-up, never created a second time, never archivable (6.2) —
 * and not a database constraint. So it is checked rather than assumed: exactly
 * one `transfer_fee` category, and live. Anything else refuses the write,
 * because choosing among several, or filing under an archived one, would be
 * guessing what a fee means.
 */
async function transferFeeCategoryIn(
  tx: Transaction,
  categories: readonly CategoryRecord[],
  options: ResolveOptions = { lock: true },
): Promise<CategoryRecord> {
  const candidates = categories.filter((row) => row.kind === 'transfer_fee');
  const only = candidates[0];
  if (candidates.length !== 1 || only === undefined) {
    throw new ImpossibleOperationError(
      'Your transfer-fee category is missing or not unique, so this fee cannot be filed. Nothing was saved.',
    );
  }

  // The fee's category is chosen afresh by this write, so it is a reference
  // dependency like any other: held `FOR SHARE` until the transfer commits
  // (30.22 item 8; ADR 0010 §9). No application path can archive a system
  // category today, and the lock states the dependency rather than relying on
  // the absence of a feature.
  // The correction preview asks the same question without the lock, because a
  // `READ ONLY` transaction cannot take one (ADR 0010 §8). Confirm takes it.
  const held = options.lock ? await lockCategoryIn(tx, only.id) : await findCategoryIn(tx, only.id);
  if (held === undefined || held.archivedAt !== null) {
    throw new ImpossibleOperationError(
      'Your transfer-fee category is missing or not unique, so this fee cannot be filed. Nothing was saved.',
    );
  }
  return held;
}

/**
 * The fee a correction works from: none, or one row that is a transfer fee
 * (M14; ADR 0006 §6).
 *
 * The database can hold more than one: 6.2 gives `expense_entries.transfer_id`
 * a plain index, and M14 assigns cardinality to "schema (no duplicate columns)
 * + service design" rather than to a constraint. No application path creates a
 * second fee, so two rows mean the data was changed from outside the product.
 * Picking `fees[0]` would update one fee and leave the other, and report the
 * transfer as though it had one; that turns a visible inconsistency into a
 * wrong number. Failing here is deterministic, names the transfer, and leaves
 * every row intact for whoever has to look.
 *
 * A single linked row that is not tracked cash under the `transfer_fee` kind is
 * refused the same way: it is not a fee this aggregate may rewrite into one, and
 * saving around it would keep a transfer that reads as having a fee.
 *
 * Deletion is deliberately **not** guarded like this: it removes *every* linked
 * row, each with its own audit before-image, so it leaves nothing dangling and
 * nothing unrecorded.
 */
function editableFeeOf(
  transferId: string,
  fees: readonly ExpenseEntryRow[],
  kindOf: ReadonlyMap<string, string>,
): ExpenseEntryRow | null {
  if (fees.length > 1) {
    throw new ImpossibleOperationError(
      `Transfer ${transferId} has ${String(fees.length)} linked fees, and a transfer may have at most one. It cannot be edited until that is corrected.`,
    );
  }
  const fee = fees[0];
  if (fee === undefined) return null;
  if (kindOf.get(fee.categoryId) !== 'transfer_fee' || fee.settlement !== 'tracked_cash') {
    throw new ImpossibleOperationError(
      'The record linked to this transfer is not a transfer fee paid from a tracked account, so the transfer cannot be edited. It can still be deleted.',
    );
  }
  return fee;
}

function assertFeeAsExpected(
  expected: TransferFeeExpectation,
  stored: ExpenseEntryRow | null,
): void {
  if (expected.state === 'absent') {
    if (stored === null) return;
    throw new VersionConflictError(
      'A fee was added to this transfer while you were editing it. Reload to see it.',
    );
  }
  if (stored !== null && stored.id === expected.feeId && stored.version === expected.version) return;
  throw new VersionConflictError(
    'This transfer’s fee changed while you were editing it. Reload to see the current values.',
  );
}

/** Whether a correction changes anything the transfer's own row holds. */
function transferChanged(
  stored: TransferRow,
  facts: TransferFacts,
  description: string | null,
  tags: string[] | undefined,
): boolean {
  return (
    stored.occurredOn !== facts.occurredOn ||
    stored.fromPositionId !== facts.fromPositionId ||
    stored.toPositionId !== facts.toPositionId ||
    !sameAmount(stored.fromAmount, facts.fromAmount) ||
    !sameAmount(stored.toAmount, facts.toAmount) ||
    stored.description !== description ||
    (tags !== undefined &&
      (tags.length !== stored.tags.length ||
        tags.some((tag, index) => tag !== stored.tags[index])))
  );
}

/** The columns a fee's facts decide: its payer's currency, never one it was sent. */
function feeColumnsOf(fee: FeeToSave) {
  return {
    amount: fee.facts.amount,
    currency: fee.payer.currency,
    cashPositionId: fee.payer.id,
    incurredOn: fee.facts.incurredOn,
  };
}

async function insertFeeIn(
  tx: Transaction,
  audit: AuditContext,
  transferId: string,
  fee: FeeToSave,
): Promise<ExpenseEntryRow> {
  return insertExpenseEntryIn(tx, audit, {
    ...feeColumnsOf(fee),
    categoryId: fee.category.id,
    settlement: 'tracked_cash',
    transferId,
    description: null,
  });
}

/**
 * The fee half of a correction: insert, update or delete, and only what changed.
 *
 * A fee whose facts are unchanged is not written at all, so correcting the
 * transfer alone neither consumes the fee's version nor adds to its audit trail.
 */
async function saveFeeIn(
  tx: Transaction,
  audit: AuditContext,
  transferId: string,
  stored: ExpenseEntryRow | null,
  desired: FeeToSave | null,
): Promise<ExpenseEntryRow | null> {
  if (desired === null) {
    // Removed explicitly, with its before-image, never left to the cascade.
    if (stored !== null) await deleteExpenseEntryIn(tx, audit, stored.id);
    return null;
  }
  if (stored === null) return insertFeeIn(tx, audit, transferId, desired);

  const columns = feeColumnsOf(desired);
  if (
    sameAmount(stored.amount, columns.amount) &&
    stored.currency === columns.currency &&
    stored.cashPositionId === columns.cashPositionId &&
    stored.incurredOn === columns.incurredOn
  ) {
    return stored;
  }

  const updated = await updateExpenseEntryIn(tx, audit, stored.id, stored.version, columns);
  /* v8 ignore next 3 -- the row is held under FOR UPDATE at the version just checked. */
  if (updated === undefined) {
    throw new VersionConflictError('The fee changed while you were editing it.');
  }
  return updated;
}

/**
 * Warm exchange-rate history for the dates the saved aggregate carries (10.4).
 *
 * Neither leg needs a rate — both amounts are native facts — so this is for the
 * reporting that reads them later, and a publisher being down never undoes a
 * committed transfer: `ensureHistory` swallows its own failure. Each currency is
 * fetched from the earliest date the aggregate gives it, which is the fee's
 * date for its payer's currency when the fee was charged before the transfer.
 */
async function warmHistory(
  fx: FlowDependencies['fx'],
  occurredOn: string,
  resolved: ResolvedFacts,
): Promise<void> {
  const earliest = new Map<string, string>();
  const need = (currency: string, date: string): void => {
    const known = earliest.get(currency);
    if (known === undefined || date < known) earliest.set(currency, date);
  };
  need(resolved.from.currency, occurredOn);
  need(resolved.to.currency, occurredOn);
  if (resolved.fee !== null) need(resolved.fee.payer.currency, resolved.fee.facts.incurredOn);

  for (const [currency, date] of earliest) await fx.ensureHistory(currency, date);
}

interface SavedTransfer extends TransferWithFee {
  /** What the post-commit FX warming needs, resolved inside the transaction. */
  readonly resolved: ResolvedFacts;
}

/* -------------------------------------------------------------------------- */
/* Resolved transfer writes                                                    */
/* -------------------------------------------------------------------------- */

/** A transfer row as its consent-relevant facts. */
function transferFacts(row: TransferRow): TransferSourceFacts {
  return {
    kind: 'transfer',
    occurredOn: row.occurredOn,
    fromPositionId: row.fromPositionId,
    fromCurrency: row.fromCurrency,
    fromAmount: canonicalAmount(row.fromAmount),
    toPositionId: row.toPositionId,
    toCurrency: row.toCurrency,
    toAmount: canonicalAmount(row.toAmount),
    description: row.description,
  };
}

/** The same facts from what a create or a correction states. */
function transferFactsOf(facts: TransferFacts, resolved: ResolvedFacts, description: string | null): TransferSourceFacts {
  return {
    kind: 'transfer',
    occurredOn: facts.occurredOn,
    fromPositionId: resolved.from.id,
    fromCurrency: resolved.from.currency,
    fromAmount: canonicalAmount(facts.fromAmount),
    toPositionId: resolved.to.id,
    toCurrency: resolved.to.currency,
    toAmount: canonicalAmount(facts.toAmount),
    description,
  };
}

/** A fee as the aggregate would save it, with the category it is filed under. */
function feeFactsOf(fee: FeeToSave, transferId: string | null): ExpenseSourceFacts {
  const columns = feeColumnsOf(fee);
  return {
    kind: 'expense',
    categoryId: fee.category.id,
    categoryKind: fee.category.kind,
    incurredOn: columns.incurredOn,
    amount: canonicalAmount(columns.amount),
    currency: columns.currency,
    settlement: 'tracked_cash',
    cashPositionId: columns.cashPositionId,
    description: null,
    transferId,
    templateId: null,
    occurrenceDate: null,
  };
}

/**
 * The identity a fee row carries in a correction preview (§19 of the slice
 * prompt).
 *
 * An existing fee is named by its real database id. A fee the correction would
 * **add** has none — PostgreSQL generates it on insert — so it is named by what
 * it is in the aggregate: the `transfer_fee` role of this transfer. A preview
 * that invented a UUID would be fingerprinting a value the commit could never
 * reproduce, and would force Confirm to preserve an id it does not own.
 */
function feeIdentity(transferId: string, stored: ExpenseEntryRow | null): SourceIdentity {
  return stored === null
    ? { scope: 'prospective', kind: 'expense', role: 'transfer_fee', owner: transferId }
    : { scope: 'existing', kind: 'expense', id: stored.id };
}

/** A resolved transfer write: the aggregate, its fee, and their consequences. */
export interface TransferWritePlan extends ResolvedWrite {
  readonly operation: 'create' | 'update' | 'delete';
  /** The locked transfer row, for an update or a delete. */
  readonly existing: TransferRow | null;
  readonly expectedVersion: number | null;
  /** What the transfer should become, and `null` for a delete. */
  readonly facts: TransferFacts | null;
  readonly resolved: ResolvedFacts | null;
  readonly description: string | null;
  readonly tags: string[] | undefined;
  /** The single editable fee this aggregate has now, if any. */
  readonly storedFee: ExpenseEntryRow | null;
  /** The fee it should carry once this lands, or `null` for none. */
  readonly desiredFee: FeeToSave | null;
  /** Every linked row, for a delete — the malformed several-fee case included. */
  readonly allFees: readonly ExpenseEntryRow[];
}

export async function resolveCreateTransferIn(
  tx: Transaction,
  ctx: RequestContext,
  args: CreateTransferArgs,
  options: ResolveOptions = { lock: true },
): Promise<TransferWritePlan> {
  const facts: TransferFacts = { ...args, fee: args.fee ?? null };
  const resolved = await resolveFactsIn(tx, ctx, facts);
  const desiredFee: FeeToSave | null =
    resolved.fee === null
      ? null
      : {
          ...resolved.fee,
          category: await transferFeeCategoryIn(
            tx,
            await listCategoryRecordsIn(tx, { includeArchived: true }),
            options,
          ),
        };

  const description = args.description ?? null;
  const dormancy = [
    clearDormancyEffect(resolved.from),
    clearDormancyEffect(resolved.to),
  ];

  return {
    operation: 'create',
    existing: null,
    expectedVersion: null,
    facts,
    resolved,
    description,
    tags: args.tags,
    storedFee: null,
    desiredFee,
    allFees: [],
    revision: false,
    changes: [
      created(
        { scope: 'prospective', kind: 'transfer', role: 'transfer', owner: null },
        transferFactsOf(facts, resolved, description),
      ),
      ...(desiredFee === null
        ? []
        : [
            created(
              { scope: 'prospective', kind: 'expense', role: 'transfer_fee', owner: null },
              feeFactsOf(desiredFee, null),
            ),
          ]),
      ...dormancy.map(dormancyChange),
    ],
    dormancy,
    support: supportOf(args.occurredOn, resolved),
  };
}

/**
 * Resolve a correction of the whole aggregate (ADR 0006 §2–§6, §8).
 *
 * In this order, and the order is the contract: lock the transfer and check its
 * version; resolve the facts the correction states against the accounts they
 * name; read the linked fee rows and refuse any the aggregate cannot edit;
 * check the fee against what the caller saw.
 *
 * The transfer **and** its fee are both reported as changes even where their
 * values are identical, because the aggregate's historical qualification is
 * about every financial date it carries, not only the ones that move (§14 of
 * the slice prompt). A September transfer with an August fee is a correction of
 * August whichever half the user actually edited.
 */
export async function resolveUpdateTransferIn(
  tx: Transaction,
  ctx: RequestContext,
  args: UpdateTransferArgs,
  options: ResolveOptions = { lock: true },
): Promise<TransferWritePlan> {
  // The aggregate's own lock first: every fee read and every fee write in this
  // service happens behind it, so the two orders that could deadlock never meet
  // (M14, ADR 0006).
  const locked = await findTransferIn(tx, args.transferId, options.lock ? { lock: 'update' } : {});
  if (locked === undefined) throw new NotFoundError('That transfer no longer exists.');
  if (locked.kind !== 'cash_transfer') {
    throw new ImpossibleOperationError('Only cash transfers can be edited here.');
  }
  if (locked.version !== args.expectedVersion) {
    throw new VersionConflictError(
      'This transfer changed while you were editing it. Reload to see the current values.',
    );
  }

  const resolved = await resolveFactsIn(tx, ctx, args, {
    from: locked.fromCurrency,
    to: locked.toCurrency,
  });
  // Every category, archived included: the stored fee's kind is checked from
  // the same read that resolves the one a fee is filed under.
  const categories = await listCategoryRecordsIn(tx, { includeArchived: true });
  const kindOf = new Map(categories.map((row) => [row.id, row.kind]));
  const desiredFee: FeeToSave | null =
    resolved.fee === null
      ? null
      : { ...resolved.fee, category: await transferFeeCategoryIn(tx, categories, options) };

  const linked = await findTransferFeesIn(
    tx,
    args.transferId,
    options.lock ? {} : { lock: 'none' },
  );
  const storedFee = editableFeeOf(args.transferId, linked, kindOf);
  assertFeeAsExpected(args.expectedFee, storedFee);

  const dormancy = [clearDormancyEffect(resolved.from), clearDormancyEffect(resolved.to)];

  const feeChange: IdentifiedSourceChange | null =
    storedFee === null && desiredFee === null
      ? null
      : storedFee === null
        ? created(feeIdentity(args.transferId, null), feeFactsOf(desiredFee as FeeToSave, args.transferId))
        : desiredFee === null
          ? deleted(
              feeIdentity(args.transferId, storedFee),
              expenseFacts(storedFee, kindOf.get(storedFee.categoryId) ?? 'transfer_fee'),
            )
          : updated(
              feeIdentity(args.transferId, storedFee),
              expenseFacts(storedFee, kindOf.get(storedFee.categoryId) ?? 'transfer_fee'),
              feeFactsOf(desiredFee, args.transferId),
            );

  return {
    operation: 'update',
    existing: locked,
    expectedVersion: args.expectedVersion,
    facts: args,
    resolved,
    description: args.description,
    tags: args.tags,
    storedFee,
    desiredFee,
    allFees: linked,
    revision: true,
    changes: [
      updated(
        { scope: 'existing', kind: 'transfer', id: locked.id },
        transferFacts(locked),
        transferFactsOf(args, resolved, args.description),
      ),
      ...(feeChange === null ? [] : [feeChange]),
      ...dormancy.map(dormancyChange),
    ],
    dormancy,
    support: supportOf(args.occurredOn, resolved),
  };
}

export async function resolveDeleteTransferIn(
  tx: Transaction,
  args: DeleteTransferArgs,
  options: ResolveOptions = { lock: true },
): Promise<TransferWritePlan> {
  const locked = await findTransferIn(tx, args.transferId, options.lock ? { lock: 'update' } : {});
  if (locked === undefined) throw new NotFoundError('That transfer no longer exists.');
  if (locked.kind !== 'cash_transfer') {
    throw new ImpossibleOperationError('Only cash transfers can be deleted here.');
  }
  if (locked.version !== args.expectedVersion) {
    throw new VersionConflictError(
      'This transfer changed after you opened it. Reload to see what it says now.',
    );
  }

  // Every linked row, compared as a whole set before a single row is touched.
  const fees = await findTransferFeesIn(
    tx,
    args.transferId,
    options.lock ? {} : { lock: 'none' },
  );
  assertFeesAsExpectedForDelete(args.expectedFees, fees);

  const categories = await listCategoryRecordsIn(tx, { includeArchived: true });
  const kindOf = new Map(categories.map((row) => [row.id, row.kind]));

  return {
    operation: 'delete',
    existing: locked,
    expectedVersion: args.expectedVersion,
    facts: null,
    resolved: null,
    description: null,
    tags: undefined,
    storedFee: null,
    desiredFee: null,
    allFees: fees,
    revision: true,
    changes: [
      deleted({ scope: 'existing', kind: 'transfer', id: locked.id }, transferFacts(locked)),
      // Every linked fee, whatever month it is dated in and however many there
      // are: deletion is how an inconsistent aggregate is cleared, so each of
      // them is a source fact this operation is about (30.22 item 10).
      ...fees.map((fee) =>
        deleted(
          { scope: 'existing', kind: 'expense', id: fee.id },
          expenseFacts(fee, kindOf.get(fee.categoryId) ?? 'transfer_fee'),
        ),
      ),
    ],
    // Deleting a transfer restores no account's dormancy (8.8).
    dormancy: [],
    support: [],
  };
}

/** The exchange-rate history the saved aggregate makes worth warming (10.4). */
function supportOf(occurredOn: string, resolved: ResolvedFacts): readonly SupportWarm[] {
  return mergeSupport([
    { currency: resolved.from.currency, from: occurredOn },
    { currency: resolved.to.currency, from: occurredOn },
    ...(resolved.fee === null
      ? []
      : [{ currency: resolved.fee.payer.currency, from: resolved.fee.facts.incurredOn }]),
  ]);
}

/** The one writer for all three transfer operations, and for both callers. */
export async function applyTransferPlanIn(
  tx: Transaction,
  ctx: RequestContext,
  plan: TransferWritePlan,
  reason?: string,
): Promise<{ transfer: TransferRow; fee: ExpenseEntryRow | null; fees: ExpenseEntryRow[] }> {
  const audit = auditContextOf(ctx, reason);

  if (plan.operation === 'delete') {
    const removedFees: ExpenseEntryRow[] = [];
    for (const fee of plan.allFees) {
      const removed = await deleteExpenseEntryIn(tx, audit, fee.id);
      /* v8 ignore next -- the row is held under FOR UPDATE in this transaction. */
      if (removed !== undefined) removedFees.push(removed);
    }
    /* v8 ignore next 2 -- a delete plan always carries the row it removes. */
    if (plan.existing === null) throw new NotFoundError('That transfer no longer exists.');
    const removed = await deleteTransferIn(tx, audit, plan.existing.id);
    /* v8 ignore next -- the row is held under FOR UPDATE in this transaction. */
    if (removed === undefined) throw new NotFoundError('That transfer no longer exists.');
    return { transfer: removed, fee: null, fees: removedFees };
  }

  /* v8 ignore next 2 -- create and update plans always carry resolved facts. */
  if (plan.facts === null || plan.resolved === null) throw new NotFoundError('That transfer no longer exists.');
  const { facts, resolved } = plan;

  if (plan.operation === 'create') {
    const transfer = await insertTransferIn(tx, audit, {
      kind: 'cash_transfer',
      occurredOn: facts.occurredOn,
      fromPositionId: resolved.from.id,
      fromCurrency: resolved.from.currency,
      fromAmount: facts.fromAmount,
      toPositionId: resolved.to.id,
      toCurrency: resolved.to.currency,
      toAmount: facts.toAmount,
      description: plan.description,
      tags: plan.tags ?? [],
      // Phase 3 materializes no recurring transfer occurrence.
    });
    const feeRow =
      plan.desiredFee === null ? null : await insertFeeIn(tx, audit, transfer.id, plan.desiredFee);
    await applyDormancyClearsIn(tx, ctx, plan.dormancy);
    return { transfer, fee: feeRow, fees: feeRow === null ? [] : [feeRow] };
  }

  /* v8 ignore next 2 -- an update plan always carries a row and a version. */
  if (plan.existing === null || plan.expectedVersion === null) throw new VersionConflictError();
  let transfer: TransferRow = plan.existing;
  if (transferChanged(plan.existing, facts, plan.description, plan.tags)) {
    const updatedRow = await updateTransferIn(tx, audit, plan.existing.id, plan.expectedVersion, {
      occurredOn: facts.occurredOn,
      fromPositionId: resolved.from.id,
      fromAmount: facts.fromAmount,
      toPositionId: resolved.to.id,
      toAmount: facts.toAmount,
      description: plan.description,
      ...(plan.tags === undefined ? {} : { tags: plan.tags }),
    });
    /* v8 ignore next 5 -- the row is held under FOR UPDATE at the version just checked. */
    if (updatedRow === undefined) {
      throw new VersionConflictError(
        'This transfer changed while you were editing it. Reload to see the current values.',
      );
    }
    transfer = updatedRow;
  }

  const fee = await saveFeeIn(tx, audit, plan.existing.id, plan.storedFee, plan.desiredFee);

  // 8.8 on the endpoints the transfer now has. An account the correction
  // moved away from keeps whatever flag it has: nothing restores dormancy.
  await applyDormancyClearsIn(tx, ctx, plan.dormancy);
  return { transfer, fee, fees: fee === null ? [] : [fee] };
}

async function createCashTransferIn(
  tx: Transaction,
  ctx: RequestContext,
  args: CreateTransferArgs,
): Promise<SavedTransfer> {
  const plan = await resolveCreateTransferIn(tx, ctx, args);
  assertNoHistoricalReview(plan, ctx.today);
  const saved = await applyTransferPlanIn(tx, ctx, plan);
  return { transfer: saved.transfer, fee: saved.fee, resolved: plan.resolved as ResolvedFacts };
}

export async function createCashTransfer(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: CreateTransferArgs,
): Promise<TransferWithFee> {
  const created = await withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    createCashTransferIn(tx, ctx, args),
  );

  await warmHistory(deps.fx, args.occurredOn, created.resolved);
  return { transfer: created.transfer, fee: created.fee };
}

async function updateCashTransferIn(
  tx: Transaction,
  ctx: RequestContext,
  args: UpdateTransferArgs,
): Promise<SavedTransfer> {
  const plan = await resolveUpdateTransferIn(tx, ctx, args);
  assertNoHistoricalReview(plan, ctx.today);
  const saved = await applyTransferPlanIn(tx, ctx, plan, args.reason);
  return { transfer: saved.transfer, fee: saved.fee, resolved: plan.resolved as ResolvedFacts };
}

/**
 * Correct a cash transfer as one aggregate (ADR 0006 §2–§6, §8).
 *
 * In one transaction, in this order: take the per-user write mutex; lock the
 * transfer and check its version; resolve the facts the correction states
 * against the accounts they name; lock its fee rows and refuse any the
 * aggregate cannot edit; check the fee against what the caller saw; write the
 * transfer and the fee where their facts changed; and clear dormancy on both
 * final endpoints. Any refusal on the way leaves every row exactly as it was.
 *
 * A correction is judged historical on **every** date the aggregate carries —
 * the transfer's `occurred_on` and the fee's own `incurred_on`, before and
 * after — so an edit whose visible date is current is still refused here when
 * the fee it re-states belongs to a closed month (§14).
 */
export async function updateCashTransfer(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: UpdateTransferArgs,
): Promise<TransferWithFee> {
  const saved = await withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    updateCashTransferIn(tx, ctx, args),
  );

  await warmHistory(deps.fx, args.occurredOn, saved.resolved);
  return { transfer: saved.transfer, fee: saved.fee };
}
/**
 * Delete a cash transfer and every fee linked to it, all audited (6.3, 18.1).
 *
 * The fees go first and explicitly. Leaving them to `ON DELETE CASCADE` would
 * remove a financial record with no before-image — the one thing the audit
 * trail exists to prevent. Every linked row goes, whatever month it is dated in
 * and however many there are: deletion is how an inconsistent aggregate is
 * cleared, so it is not refused for being one. Deleting a transfer restores no
 * account's dormancy (8.8).
 *
 * The transfer's own version and the complete set of linked fee rows the
 * caller saw come with the request, so a transfer corrected after the page was
 * rendered — or one where any linked fee gained, lost or changed a version —
 * refuses rather than taking the newest aggregate down with it (6.3, 20.3,
 * 30.22 item 10).
 */
/** One linked fee row as the caller rendered it: that row, at that version. */
export interface LinkedFeeExpectation {
  readonly feeId: string;
  readonly version: number;
}

export interface DeleteTransferArgs {
  readonly transferId: string;
  /** The transfer's version as the client rendered it (6.3, 30.22 item 10). */
  readonly expectedVersion: number;
  /**
   * **Every** linked fee row the caller rendered, or an empty list for none.
   *
   * Deliberately a set rather than the single `TransferFeeExpectation` a
   * correction uses. A correction may only proceed over an aggregate this
   * service could have created, so one fee is all it ever has to describe. A
   * delete removes every linked row and is the documented repair for an
   * aggregate the product could **not** have created — so it has to describe
   * every row it is about to take down, or a second fee could change, appear or
   * vanish between the render and the delete without the caller ever having
   * confirmed the aggregate that was actually removed.
   */
  readonly expectedFees: readonly LinkedFeeExpectation[];
  readonly reason?: string | undefined;
}

/**
 * The linked-fee set, canonicalized so two orderings of the same rows compare
 * equal.
 *
 * `findTransferFeesIn` already returns rows in id order and the presentation
 * builds its list from the same read, but neither is relied on: sorting here
 * means the comparison is about the **set** of `(id, version)` pairs and
 * nothing else, and a duplicate id in the request changes the length and so
 * fails rather than silently matching.
 */
function canonicalFees(entries: readonly { id: string; version: number }[]): string {
  return entries
    .map((entry) => `${entry.id}@${String(entry.version)}`)
    .sort()
    .join(',');
}

/**
 * Was the aggregate's **whole** linked-fee set what the caller was looking at
 * (30.22 item 10)?
 *
 * Deliberately not `assertFeeAsExpected`: that one judges a *correction*, which
 * `editableFeeOf` has already narrowed to an aggregate with at most one fee, so
 * one expectation is all it ever needs. A delete removes every linked row and
 * is the documented way to clear an aggregate the product could not have
 * created — the interface says so in as many words when a transfer carries more
 * than one fee. Describing only the first of them would let this happen:
 *
 * ```text
 * rendered:  T v3, fee A v1, fee B v1
 * meanwhile: B becomes v2, and fee C appears
 * delete remembering A v1 alone -> A, B v2, C and T all removed,
 *                                  over an aggregate nobody confirmed
 * ```
 *
 * So the comparison is the complete set: a fee that appeared, disappeared,
 * changed version, or was replaced by another one is a conflict, and nothing is
 * deleted or audited. Deleting an already-malformed aggregate stays possible —
 * but only the exact malformed aggregate the caller saw.
 */
function assertFeesAsExpectedForDelete(
  expected: readonly LinkedFeeExpectation[],
  stored: readonly ExpenseEntryRow[],
): void {
  const wanted = canonicalFees(expected.map((entry) => ({ id: entry.feeId, version: entry.version })));
  if (canonicalFees(stored) === wanted) return;

  throw new VersionConflictError(
    expected.length === 0
      ? 'A fee was added to this transfer after you opened it. Reload to see it.'
      : 'This transfer’s fees changed after you opened it. Reload to see the current values.',
  );
}

async function deleteCashTransferIn(
  tx: Transaction,
  ctx: RequestContext,
  args: DeleteTransferArgs,
): Promise<{ transfer: TransferRow; fees: ExpenseEntryRow[] }> {
  const plan = await resolveDeleteTransferIn(tx, args);
  assertNoHistoricalReview(plan, ctx.today);
  const removed = await applyTransferPlanIn(tx, ctx, plan, args.reason);
  return { transfer: removed.transfer, fees: removed.fees };
}

export async function deleteCashTransfer(
  deps: FlowDependencies,
  ctx: RequestContext,
  args: DeleteTransferArgs,
): Promise<{ transfer: TransferRow; fees: ExpenseEntryRow[] }> {
  return withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    deleteCashTransferIn(tx, ctx, args),
  );
}
