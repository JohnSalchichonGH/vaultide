import {
  findIncomeEntriesIn,
  findTemplatesIn,
  findValuationsIn,
  isUniqueViolation,
  listLatestValuationsIn,
  listMaterializedAtIn,
  listPositionsIn,
  listSkipsAtIn,
  listValuationsAtIn,
  loadTermsForRangeIn,
  type IncomeEntryRow,
  type OccurrenceRef,
  type PositionRecord as PositionRow,
  type RecurringTemplateRow,
  type RecurringTemplateSkipRow,
  type RecurringTemplateTermRow,
  type Transaction,
  type ValuationBound,
  type ValuationRow,
} from '@vaultide/db';
import {
  Decimal,
  endOfMonthKey,
  monthKey,
  plainDate,
  termForOccurrence,
  type PlainDate,
} from '@vaultide/finance';
import { bulkHistoryInput } from '@vaultide/validation';
import type { RequestContext } from '../context';
import type { BulkHistoryDraft, BulkHistoryOperation } from '../corrections/draft';
import { assertInputScaleIn, type StatedAmount } from '../currencies/scale';
import {
  DuplicateConflictError,
  ImpossibleOperationError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
} from '../errors';
import {
  decideIncomeCreate,
  decideIncomeDelete,
  decideIncomeUpdate,
  planIncomeCreate,
  planIncomeUpdate,
  writeIncomeRowIn,
  type IncomeWritePlan,
} from '../flows/income';
import {
  applyDormancyClearsIn,
  decideTrackedCashLeg,
  trackedCashLegEvidenceFrom,
  type TrackedCashLegRequest,
} from '../flows/shared';
import {
  FINAL_ZERO_MESSAGE,
  decideCorrectValuation,
  decideRecordValuation,
  decideRemoveValuation,
  finalBalanceBreachOf,
  monthName,
  writeValuationRowIn,
  type ValuationWritePlan,
} from '../positions/valuations';
import {
  assertClaimableOccurrence,
  assertNotMaterialized,
  assertNotSkipped,
  decideAcceptedAmounts,
} from '../recurring/suggestions';
import {
  dormancyChange,
  dormancyChanged,
  identityKey,
  mergeSupport,
  type DormancyEffect,
  type IdentifiedSourceChange,
  type ResolvedWrite,
  type ResolveOptions,
} from '../write-plan';

/**
 * One Bulk History save, resolved (blueprint 15.3 "Bulk history", 18.1, 20.3,
 * 30.22 item 2; ADR 0011).
 *
 * A save is many cells and **one** act: one review, one transaction, one audit
 * request id, and nothing written unless every cell is valid. So it resolves in
 * three steps, and only the middle one reads:
 *
 * ```text
 * prepareBulkHistory    the draft's own rules, canonical order       (pure)
 * resolveBulkHistoryIn  locks, then a fixed set of set-wise reads    (reads)
 * decideBulkHistory     every cell through the existing decisions,
 *                       then one plan for the whole batch            (pure)
 * ```
 *
 * ## No shadow rules
 *
 * Every cell goes through the decision its ordinary single-row path uses —
 * `decideRecordValuation`, `decideCorrectValuation`, `decideRemoveValuation`,
 * the occurrence claim rules, `decideAcceptedAmounts`, `decideIncomeCreate`,
 * `decideIncomeUpdate`, `decideIncomeDelete`, `decideTrackedCashLeg` — handed
 * rows that were loaded once for the whole batch rather than once per cell. A
 * rule added to one of those is a rule Bulk History gets.
 *
 * What this module adds is only what a batch needs and a single row does not:
 *
 *  - **the cell is the identity.** An update or clear names a stored row and the
 *    cell it believes that row is; the row must be exactly that cell, or the
 *    save is refused;
 *  - **a canonical order** — family, then the semantic date, then the owner —
 *    so the same batch resolves, previews, fingerprints and writes identically
 *    whatever order the browser sent it in;
 *  - **one dormancy consequence per account**, however many of its cells the
 *    batch touches;
 *  - **one final balance per closed account** (M6, 5.2): it must still be zero
 *    once every cell is written, so it is judged on the batch as a whole. Two
 *    cells can each leave the zero standing on their own and remove it
 *    together, and the reverse.
 */

/* -------------------------------------------------------------------------- */
/* The request                                                                 */
/* -------------------------------------------------------------------------- */

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/u;

const isValuation = (
  operation: BulkHistoryOperation,
): operation is Extract<BulkHistoryOperation, { positionId: string }> => 'positionId' in operation;

/** The date an operation's cell is about: a month end, or a scheduled occurrence. */
export function bulkCellDateOf(operation: BulkHistoryOperation): string {
  return isValuation(operation)
    ? endOfMonthKey(monthKey(plainDate(`${operation.month}-01`)))
    : operation.occurrenceDate;
}

/** The account or source that owns an operation's cell. */
const ownerOf = (operation: BulkHistoryOperation): string =>
  isValuation(operation) ? operation.positionId : operation.templateId;

/** One string per semantic cell: `positionId#end(month)` or `templateId#occurrenceDate`. */
export const bulkCellKeyOf = (operation: BulkHistoryOperation): string =>
  `${ownerOf(operation)}#${bulkCellDateOf(operation)}`;

const familyRank = (operation: BulkHistoryOperation): number => (isValuation(operation) ? 0 : 1);

/** Family, then semantic date, then owner id: a total order over distinct cells. */
export function compareBulkOperations(a: BulkHistoryOperation, b: BulkHistoryOperation): number {
  const byFamily = familyRank(a) - familyRank(b);
  if (byFamily !== 0) return byFamily;
  const left = `${bulkCellDateOf(a)}#${ownerOf(a)}`;
  const right = `${bulkCellDateOf(b)}#${ownerOf(b)}`;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** A draft that passed every rule needing no database state, in canonical order. */
export interface BulkHistoryRequest {
  readonly startMonth: string;
  readonly operations: readonly BulkHistoryOperation[];
}

function refuse(message: string): never {
  throw new ValidationError(message, { operations: [message] });
}

/**
 * The draft's own rules, asked again on the server.
 *
 * The input schema already holds every one of them; the service asks them too,
 * because a service is callable from anywhere and the rule belongs to the domain
 * (20.1). A batch with a cell twice is refused — never de-duplicated, never
 * "last one wins" — and so is one past the per-save limit.
 */
export function prepareBulkHistory(today: PlainDate, draft: BulkHistoryDraft): BulkHistoryRequest {
  const currentMonth = (today as string).slice(0, 7);
  if (!MONTH_PATTERN.test(draft.startMonth) || draft.startMonth >= currentMonth) {
    refuse('The first row has to be a month that has ended.');
  }
  if (draft.operations.length === 0) refuse('There is nothing to save.');
  if (draft.operations.length > bulkHistoryInput.BULK_HISTORY_MAX_OPERATIONS) {
    refuse(
      `One save can carry at most ${String(bulkHistoryInput.BULK_HISTORY_MAX_OPERATIONS)} changed cells. Save these, then continue.`,
    );
  }

  const seen = new Set<string>();
  for (const operation of draft.operations) {
    const month = isValuation(operation) ? operation.month : operation.occurrenceDate.slice(0, 7);
    if (!MONTH_PATTERN.test(month) || month >= currentMonth) {
      refuse('Only months that have ended can be edited here.');
    }
    if (month < draft.startMonth) refuse('That cell is above the first row of this grid.');

    const amount =
      operation.kind === 'valuation_create' || operation.kind === 'valuation_update'
        ? operation.amount
        : operation.kind === 'income_create' || operation.kind === 'income_update'
          ? operation.netAmount
          : null;
    if (amount !== null && !bulkHistoryInput.isCanonicalDecimal(amount)) {
      refuse('Send each amount in its canonical form.');
    }

    const cell = bulkCellKeyOf(operation);
    if (seen.has(cell)) refuse('Each cell may appear only once in a save.');
    seen.add(cell);
  }

  return {
    startMonth: draft.startMonth,
    operations: [...draft.operations].sort(compareBulkOperations),
  };
}

/* -------------------------------------------------------------------------- */
/* What the batch reads                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Everything a batch's decisions rest on, loaded once for the whole batch.
 *
 * Each list is one set-wise read; none of them is per cell. The decisions below
 * look rows up by identity and check what they find against the cell they are
 * deciding, so a row of another cell can never answer for this one.
 */
export interface BulkHistoryEvidence {
  /** Every position of the user: the accounts the cells name, and the null leg's bucket. */
  readonly positions: readonly PositionRow[];
  /** The stored balances the batch updates or clears, by the ids it names. */
  readonly valuations: readonly ValuationRow[];
  /** Whatever already sits on a cell the batch creates a balance in. */
  readonly occupants: readonly ValuationRow[];
  /** The stored income entries the batch updates or clears, by the ids it names. */
  readonly entries: readonly IncomeEntryRow[];
  /** The sources whose occurrences the batch materializes. */
  readonly templates: readonly RecurringTemplateRow[];
  readonly terms: readonly RecurringTemplateTermRow[];
  readonly skips: readonly RecurringTemplateSkipRow[];
  /** The claimed occurrences a flow already carries, each by its own identity. */
  readonly materialized: readonly OccurrenceRef[];
  /**
   * For each closed account a balance cell names, its latest stored balance on
   * or before `closed_on` that the batch neither corrects nor clears — absent
   * when there is none (M6).
   */
  readonly finals: readonly ValuationRow[];
}

const occurrenceKey = (item: OccurrenceRef): string => `${item.templateId}#${item.occurrenceDate}`;

/** The ids and cells a request names, by family, sorted: what the reads are keyed on. */
export function bulkRequestKeysOf(request: BulkHistoryRequest): {
  readonly valuationIds: readonly string[];
  readonly entryIds: readonly string[];
  readonly claimedTemplateIds: readonly string[];
  readonly createCells: readonly { readonly positionId: string; readonly valuedOn: string }[];
  readonly claims: readonly OccurrenceRef[];
  readonly needsPositions: boolean;
} {
  const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();
  const { operations } = request;

  const claims = operations.flatMap((operation) =>
    operation.kind === 'income_create'
      ? [{ templateId: operation.templateId, occurrenceDate: operation.occurrenceDate }]
      : [],
  );
  return {
    valuationIds: sorted(
      operations.flatMap((operation) =>
        operation.kind === 'valuation_update' || operation.kind === 'valuation_clear'
          ? [operation.valuationId]
          : [],
      ),
    ),
    entryIds: sorted(
      operations.flatMap((operation) =>
        operation.kind === 'income_update' || operation.kind === 'income_clear'
          ? [operation.entryId]
          : [],
      ),
    ),
    claimedTemplateIds: sorted(claims.map((claim) => claim.templateId)),
    createCells: operations.flatMap((operation) =>
      operation.kind === 'valuation_create'
        ? [{ positionId: operation.positionId, valuedOn: bulkCellDateOf(operation) }]
        : [],
    ),
    claims,
    // An income clear names no account and needs none; everything else does.
    needsPositions: operations.some((operation) => operation.kind !== 'income_clear'),
  };
}

/**
 * The closed accounts a batch's balance cells name, each with its closing day:
 * the accounts whose final balance the batch must leave at zero (M6). Read only
 * for them, so a batch that names no closed account reads nothing more.
 */
export function bulkClosedBoundsOf(
  request: BulkHistoryRequest,
  positions: readonly PositionRow[],
): ValuationBound[] {
  const named = new Set(request.operations.filter(isValuation).map((operation) => operation.positionId));
  return positions
    .filter((position) => named.has(position.id) && position.status === 'closed')
    .flatMap((position) =>
      position.closedOn === null ? [] : [{ positionId: position.id, onOrBefore: position.closedOn }],
    );
}

/* -------------------------------------------------------------------------- */
/* The decisions                                                               */
/* -------------------------------------------------------------------------- */

/** One cell, resolved through the family plan its ordinary path produces. */
export type BulkHistoryStep =
  | {
      readonly family: 'valuation';
      readonly operation: BulkHistoryOperation;
      readonly plan: ValuationWritePlan;
    }
  | {
      readonly family: 'income';
      readonly operation: BulkHistoryOperation;
      readonly plan: IncomeWritePlan;
    };

/**
 * A resolved Bulk History save: every cell's plan in canonical order, and the
 * batch's aggregate facts — its source changes, one dormancy consequence per
 * account, and the exchange-rate history worth warming after the commit.
 */
export interface BulkHistoryWritePlan extends ResolvedWrite {
  readonly startMonth: string;
  readonly steps: readonly BulkHistoryStep[];
}

/**
 * Bulk History edits the two kinds of position Phase 3 creates (15.3; ADR 0011
 * D3). Investments, properties and liabilities have phases of their own, and a
 * request naming one was not built from the grid.
 */
function asBulkPosition(position: PositionRow | undefined): PositionRow {
  if (position === undefined) throw new NotFoundError('That account no longer exists.');
  if (position.kind !== 'cash' && position.kind !== 'other_asset') {
    throw new ValidationError('Bulk history edits cash accounts and other assets.', {
      positionId: ['Choose a cash account or another asset.'],
    });
  }
  return position;
}

/**
 * The stored balance an update or clear names **is** the cell it names: that
 * account's statement balance at that month's end.
 *
 * The version is asked first, because a row that moved since the grid showed it
 * is a conflict whatever it moved to. Only a row at the version the grid saw can
 * fail the rest, and only a request that was not built from the grid can make
 * it: that is refused. A last-day **snapshot** is not a statement and is not
 * Bulk History's to edit — Monthly confirms or replaces it (ADR 0011 D8).
 */
function assertNamedBalance(
  existing: ValuationRow | undefined,
  operation: Extract<BulkHistoryOperation, { valuationId: string }>,
): ValuationRow {
  if (existing === undefined) throw new NotFoundError('That balance no longer exists.');
  if (existing.version !== operation.expectedVersion) {
    throw new VersionConflictError(
      'A balance in this grid changed after you opened it. Reload to see what it says now.',
    );
  }
  if (existing.positionId !== operation.positionId || existing.valuedOn !== bulkCellDateOf(operation)) {
    throw new ValidationError('That balance does not belong to the cell it was sent for.');
  }
  if (existing.datePrecision !== 'month_end') {
    throw new ImpossibleOperationError(
      'That month ends on a snapshot rather than a statement. Confirm or replace it in Monthly.',
    );
  }
  return existing;
}

/** The same proof for a stored income entry: it is that source's occurrence. */
function assertNamedEntry(
  existing: IncomeEntryRow | undefined,
  operation: Extract<BulkHistoryOperation, { entryId: string }>,
): IncomeEntryRow {
  if (existing === undefined) throw new NotFoundError('That income entry no longer exists.');
  if (existing.version !== operation.expectedVersion) {
    throw new VersionConflictError(
      'An income entry in this grid changed after you opened it. Reload to see what it says now.',
    );
  }
  if (
    existing.templateId !== operation.templateId ||
    existing.occurrenceDate !== operation.occurrenceDate
  ) {
    throw new ValidationError('That income entry does not belong to the cell it was sent for.');
  }
  return existing;
}

/**
 * The gross a new occurrence inherits (ADR 0011 D6).
 *
 * The term for the occurrence's **scheduled** date (§30.9 item 4) is the
 * figure the grid's income column stands for. A net typed exactly equal to the
 * term's net — compared as decimals, never as numbers — is the term, so its
 * gross comes with it. A different net is a different payment the term's gross
 * says nothing about, and so is a term with no gross: either way the entry has
 * none, rather than a gross inherited from a net it does not have.
 *
 * Deliberately stricter than accepting a suggestion, which inherits the term's
 * gross whenever none is stated even if the amount was overridden: there the
 * user is looking at the suggestion's gross; in the grid nobody is.
 */
export function bulkIncomeGross(
  termRows: readonly RecurringTemplateTermRow[],
  occurrenceDate: string,
  netAmount: string,
): string | null {
  const term = termForOccurrence(
    termRows.map((row) => ({
      id: row.id,
      templateId: row.templateId,
      effectiveFrom: plainDate(row.effectiveFrom),
      amount: new Decimal(row.amount),
      grossAmount: row.grossAmount === null ? null : new Decimal(row.grossAmount),
    })),
    plainDate(occurrenceDate),
  );
  if (term === undefined || term.grossAmount === null) return null;
  return term.amount.equals(new Decimal(netAmount)) ? term.grossAmount.toString() : null;
}

/** Judge a tracked cash leg from the batch's positions — the batch twin of `resolveTrackedCashLegIn`. */
function legOf(
  request: TrackedCashLegRequest | null,
  positions: readonly PositionRow[],
): PositionRow | null {
  if (request === null) return null;
  return decideTrackedCashLeg(request, trackedCashLegEvidenceFrom(request, positions));
}

interface Lookup {
  readonly positions: ReadonlyMap<string, PositionRow>;
  readonly valuations: ReadonlyMap<string, ValuationRow>;
  readonly occupants: ReadonlyMap<string, ValuationRow>;
  readonly entries: ReadonlyMap<string, IncomeEntryRow>;
  readonly templates: ReadonlyMap<string, RecurringTemplateRow>;
  readonly terms: ReadonlyMap<string, readonly RecurringTemplateTermRow[]>;
  readonly skips: ReadonlyMap<string, RecurringTemplateSkipRow>;
  readonly materialized: ReadonlySet<string>;
}

function lookupOf(evidence: BulkHistoryEvidence): Lookup {
  const terms = new Map<string, RecurringTemplateTermRow[]>();
  for (const row of evidence.terms) {
    const list = terms.get(row.templateId);
    if (list === undefined) terms.set(row.templateId, [row]);
    else list.push(row);
  }
  return {
    positions: new Map(evidence.positions.map((row) => [row.id, row])),
    valuations: new Map(evidence.valuations.map((row) => [row.id, row])),
    occupants: new Map(evidence.occupants.map((row) => [`${row.positionId}#${row.valuedOn}`, row])),
    entries: new Map(evidence.entries.map((row) => [row.id, row])),
    templates: new Map(evidence.templates.map((row) => [row.id, row])),
    terms,
    skips: new Map(evidence.skips.map((row) => [occurrenceKey(row), row])),
    materialized: new Set(evidence.materialized.map(occurrenceKey)),
  };
}

function decideStep(
  today: PlainDate,
  operation: BulkHistoryOperation,
  lookup: Lookup,
  positions: readonly PositionRow[],
): BulkHistoryStep {
  switch (operation.kind) {
    case 'valuation_create': {
      const position = asBulkPosition(lookup.positions.get(operation.positionId));
      const valuedOn = bulkCellDateOf(operation);
      return {
        family: 'valuation',
        operation,
        plan: decideRecordValuation(
          today,
          position,
          { positionId: position.id, valuedOn, amount: operation.amount, datePrecision: 'month_end' },
          lookup.occupants.get(`${position.id}#${valuedOn}`),
        ),
      };
    }

    case 'valuation_update': {
      const existing = assertNamedBalance(lookup.valuations.get(operation.valuationId), operation);
      const position = asBulkPosition(lookup.positions.get(existing.positionId));
      // Only the amount changes: the date, the precision and the note are the
      // row's own, and the source is never written by a correction.
      return {
        family: 'valuation',
        operation,
        plan: decideCorrectValuation(
          today,
          position,
          existing,
          {
            valuationId: existing.id,
            expectedVersion: operation.expectedVersion,
            valuedOn: existing.valuedOn,
            amount: operation.amount,
            datePrecision: existing.datePrecision,
            note: existing.note,
          },
          undefined,
        ),
      };
    }

    case 'valuation_clear': {
      const existing = assertNamedBalance(lookup.valuations.get(operation.valuationId), operation);
      const position = asBulkPosition(lookup.positions.get(existing.positionId));
      return {
        family: 'valuation',
        operation,
        plan: decideRemoveValuation(position, existing, {
          valuationId: existing.id,
          expectedVersion: operation.expectedVersion,
        }),
      };
    }

    case 'income_create': {
      const claim: OccurrenceRef = {
        templateId: operation.templateId,
        occurrenceDate: operation.occurrenceDate,
      };
      // The claim rules of an acceptance, each asked of this occurrence's own
      // rows: an archived source refuses, the date must be scheduled, and an
      // occurrence a skip or a flow already resolves is not free.
      const template = assertClaimableOccurrence(lookup.templates.get(claim.templateId), claim);
      if (template.kind !== 'income' || template.incomeKind === null) {
        throw new ValidationError('That source is not income.', {
          templateId: ['Choose an income source.'],
        });
      }
      assertNotSkipped(lookup.skips.get(occurrenceKey(claim)), claim);
      assertNotMaterialized(lookup.materialized.has(occurrenceKey(claim)));

      const termRows = lookup.terms.get(template.id) ?? [];
      const amounts = decideAcceptedAmounts(template, termRows, {
        templateId: template.id,
        occurrenceDate: claim.occurrenceDate,
        amount: operation.netAmount,
        grossAmount: bulkIncomeGross(termRows, claim.occurrenceDate, operation.netAmount),
      });
      // An ordinary recurring occurrence (§30.9 items 1 and 4): received on its
      // scheduled date, into tracked cash, on the source's own account — or on
      // none, which is a tracked leg awaiting attribution, never `external`.
      const decision = decideIncomeCreate(today, {
        kind: template.incomeKind,
        receivedOn: claim.occurrenceDate,
        netAmount: amounts.amount,
        ...(amounts.grossAmount === null ? {} : { grossAmount: amounts.grossAmount }),
        currency: template.currency,
        settlement: 'tracked_cash',
        cashPositionId: amounts.cashPositionId,
      });
      return {
        family: 'income',
        operation,
        plan: planIncomeCreate(decision, legOf(decision.leg, positions), claim),
      };
    }

    case 'income_update': {
      const existing = assertNamedEntry(lookup.entries.get(operation.entryId), operation);
      // Only the net changes. Everything left out keeps its stored value — the
      // gross, the received date, the account, the settlement, the words.
      const decision = decideIncomeUpdate(today, existing, {
        entryId: existing.id,
        expectedVersion: operation.expectedVersion,
        netAmount: operation.netAmount,
      });
      return {
        family: 'income',
        operation,
        plan: planIncomeUpdate(decision, legOf(decision.leg, positions)),
      };
    }

    case 'income_clear': {
      const existing = assertNamedEntry(lookup.entries.get(operation.entryId), operation);
      // A hard delete with its audit image. No skip is written, so the
      // occurrence is due again, and no dormancy is restored (8.8).
      return {
        family: 'income',
        operation,
        plan: decideIncomeDelete(existing, {
          entryId: existing.id,
          expectedVersion: operation.expectedVersion,
        }),
      };
    }
  }
}

/**
 * One dormancy consequence per account (8.8; ADR 0011).
 *
 * Every cell of an account is decided against the same loaded row, so a batch
 * that wakes an account several times produces the same effect several times,
 * and it is applied once. Two different effects for one account would mean the
 * cells were decided against two different rows, which cannot happen here: that
 * is an internal invariant, not a user error.
 */
export function mergeBulkDormancy(effects: readonly DormancyEffect[]): readonly DormancyEffect[] {
  const byAccount = new Map<string, DormancyEffect>();
  for (const effect of effects) {
    if (!dormancyChanged(effect)) continue;
    const known = byAccount.get(effect.positionId);
    if (known === undefined) {
      byAccount.set(effect.positionId, effect);
      continue;
    }
    if (JSON.stringify(known) !== JSON.stringify(effect)) {
      throw new Error('a bulk history batch found conflicting dormancy evidence for one account');
    }
  }
  return [...byAccount.values()].sort((a, b) =>
    a.positionId < b.positionId ? -1 : a.positionId > b.positionId ? 1 : 0,
  );
}

/** Every change of a batch names a different source fact; two that do not are an internal fault. */
function assertDistinctIdentities(changes: readonly IdentifiedSourceChange[]): void {
  const keys = new Set(changes.map((change) => identityKey(change.identity)));
  if (keys.size !== changes.length) {
    throw new Error('a bulk history batch produced two changes with one identity');
  }
}

/** Compose the batch from its resolved cells. Pure: every fact is in the steps. */
export function composeBulkHistoryPlan(
  startMonth: string,
  steps: readonly BulkHistoryStep[],
): BulkHistoryWritePlan {
  // Each cell's plan carries its own copy of the dormancy change; the batch
  // states it once, from the merged effects, after the source facts.
  const primary = steps.flatMap((step) =>
    step.plan.changes.filter((change) => (change.after ?? change.before).kind !== 'cash_dormancy'),
  );
  const dormancy = mergeBulkDormancy(steps.flatMap((step) => step.plan.dormancy));
  const changes = [...primary, ...dormancy.map(dormancyChange)];
  assertDistinctIdentities(changes);

  return {
    startMonth,
    steps,
    // The truthful aggregate: true when any cell revises stored evidence.
    // Review does not depend on it — every Bulk save is reviewed (ADR 0011 D7).
    revision: steps.some((step) => step.plan.revision),
    changes,
    dormancy,
    support: mergeSupport(steps.flatMap((step) => step.plan.support)),
  };
}

/**
 * Every closed account's final balance, once the whole batch is written (M6,
 * 5.2), through the rule the single-row paths ask of their one balance.
 *
 * A refusal names one cell, the way the grid names one: the cell whose figure
 * would be the final balance, or else the account's latest cell in the batch —
 * the clear or correction that uncovered an earlier figure.
 */
function assertFinalBalancesKept(steps: readonly BulkHistoryStep[], finals: readonly ValuationRow[]): void {
  const balances = steps.filter(
    (step): step is Extract<BulkHistoryStep, { family: 'valuation' }> => step.family === 'valuation',
  );
  const breach = finalBalanceBreachOf(
    balances.map((step) => step.plan),
    finals,
  );
  if (breach === undefined) return;

  /* v8 ignore next 2 -- the breach names one of the plans it was handed. */
  const step = balances.find((candidate) => candidate.plan === breach.write);
  if (step === undefined) throw new Error('a final-balance breach named no cell of the batch');
  const date = bulkCellDateOf(step.operation);
  throw new ValidationError(
    `${breach.position.name}, ${monthName(monthKey(plainDate(date)))}: the account is closed, so its final balance has to stay zero. Nothing was saved.`,
    { [bulkCellKeyOf(step.operation)]: [FINAL_ZERO_MESSAGE] },
  );
}

/**
 * Decide a whole batch from what was loaded for it. Pure.
 *
 * Every cell is decided before anything is returned, so the first refusal —
 * cell 1 or cell 500 — leaves no plan at all, and nothing can be written. Then
 * the batch as a whole: each closed account's final balance.
 */
export function decideBulkHistory(
  today: PlainDate,
  request: BulkHistoryRequest,
  evidence: BulkHistoryEvidence,
): BulkHistoryWritePlan {
  const lookup = lookupOf(evidence);
  const steps = request.operations.map((operation) =>
    decideStep(today, operation, lookup, evidence.positions),
  );
  assertFinalBalancesKept(steps, evidence.finals);
  return composeBulkHistoryPlan(request.startMonth, steps);
}

/**
 * The amounts a batch's cells state, each keyed to its cell and in the currency
 * its own plan stores it in: a balance in its account's, an income cell in its
 * entry's (7.2). A gross an income cell inherits from its term is carried from
 * a stored row rather than typed, so it is not among them.
 */
export function bulkStatedAmountsOf(steps: readonly BulkHistoryStep[]): StatedAmount[] {
  return steps.flatMap((step): StatedAmount[] => {
    const { operation } = step;
    const field = bulkCellKeyOf(operation);
    if (step.family === 'valuation') {
      return 'amount' in operation
        ? [{ field, amount: operation.amount, currency: step.plan.position.currency }]
        : [];
    }
    return 'netAmount' in operation && step.plan.columns !== null
      ? [{ field, amount: operation.netAmount, currency: step.plan.columns.currency }]
      : [];
  });
}

/* -------------------------------------------------------------------------- */
/* Resolve and apply                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a Bulk History save inside the caller's transaction.
 *
 * `lock: true` is Historical Confirm, already under the per-user write mutex.
 * It takes exactly the row locks the ordinary single-row paths take for these
 * operations, set-wise and in one fixed order — the stored balances it revises,
 * then the stored income entries it revises, then the templates whose
 * occurrences it claims (§30.8 item 5) — and only then reads what the decisions
 * rest on. `lock: false` is the preview, which sends the same statements in the
 * same order without the locks its `READ ONLY` transaction could not take.
 *
 * The statements are per family, never per cell: a batch of five hundred cells
 * reads what a batch of five reads. A batch that names a closed account reads
 * one more, for all of them together.
 */
export async function resolveBulkHistoryIn(
  tx: Transaction,
  ctx: RequestContext,
  draft: BulkHistoryDraft,
  options: ResolveOptions,
): Promise<BulkHistoryWritePlan> {
  const request = prepareBulkHistory(ctx.today, draft);
  const keys = bulkRequestKeysOf(request);
  const lock = options.lock ? ({ lock: 'update' } as const) : {};

  const valuations = await findValuationsIn(tx, keys.valuationIds, lock);
  const entries = await findIncomeEntriesIn(tx, keys.entryIds, lock);
  const templates = await findTemplatesIn(tx, keys.claimedTemplateIds, lock);

  const positions = keys.needsPositions ? await listPositionsIn(tx, { includeArchived: true }) : [];
  const occupants = await listValuationsAtIn(tx, keys.createCells);
  // One statement for every closed account the batch names, and none when it
  // names no closed account. Every stored row the batch revises is left out:
  // what it leaves of them is in the batch itself.
  const finals = await listLatestValuationsIn(tx, bulkClosedBoundsOf(request, positions), {
    except: keys.valuationIds,
  });
  const dates = keys.claims.map((claim) => claim.occurrenceDate).sort();
  const terms =
    keys.claims.length === 0
      ? []
      : await loadTermsForRangeIn(
          tx,
          keys.claimedTemplateIds,
          dates[0] as string,
          dates[dates.length - 1] as string,
        );
  const skips = await listSkipsAtIn(tx, keys.claims);
  const materialized = await listMaterializedAtIn(tx, keys.claims);

  const plan = decideBulkHistory(ctx.today, request, {
    positions,
    valuations,
    occupants,
    entries,
    templates,
    terms,
    skips,
    materialized,
    finals,
  });
  // Once every cell is decided, so each amount is judged in the currency its
  // own plan stores it in; one statement for the whole batch, and a refusal
  // names the cell.
  await assertInputScaleIn(tx, bulkStatedAmountsOf(plan.steps));
  return plan;
}

/**
 * Apply a resolved save, in the caller's transaction. It decides nothing.
 *
 * Each cell is written in canonical order through its family's own row writer,
 * with exactly the audit entry the single-row write produces, all under the
 * request's one id (18.1). A new balance is `bulk_entered`. Then the batch's
 * dormancy consequences, once per account.
 *
 * A cell that became occupied after it was resolved — only a writer outside
 * the financial mutex could manage it, and the unique constraints on
 * `(position_id, valued_on)` and `(template_id, occurrence_date)` stop it — is
 * answered here as the duplicate conflict it is, so Historical Confirm, the one
 * caller, never surfaces it as an internal failure. The whole transaction rolls
 * back with it.
 */
export async function applyBulkHistoryPlanIn(
  tx: Transaction,
  ctx: RequestContext,
  plan: BulkHistoryWritePlan,
  reason?: string,
): Promise<void> {
  try {
    for (const step of plan.steps) {
      if (step.family === 'valuation') {
        await writeValuationRowIn(tx, ctx, step.plan, reason, 'bulk_entered');
      } else {
        await writeIncomeRowIn(tx, ctx, step.plan, reason);
      }
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new DuplicateConflictError(
        'One of these cells was filled in elsewhere in the meantime, so nothing was saved. Reload and try again.',
      );
    }
    throw error;
  }

  await applyDormancyClearsIn(tx, ctx, plan.dormancy);
}
