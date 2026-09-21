import {
  findUserSettingsIn,
  listCategoryRecordsIn,
  listExpenseEntriesIn,
  listIncomeEntriesIn,
  listResolvedOccurrencesInRangeIn,
  listTemplatesForRangeIn,
  listTransfersIn,
  loadFinancialWindowIn,
  type Transaction,
} from '@vaultide/db';
import {
  Decimal,
  addMonths,
  currencyCode,
  endOfMonthKey,
  monthKey,
  monthLabel,
  occurrenceKey,
  plainDate,
  startOfMonthKey,
  type CashAccountInput,
  type CompletedMonthCompletenessInput,
  type CompletedMonthInput,
  type CompletenessTemplate,
  type ExpenseFlow,
  type IncomeFlow,
  type MonthKey,
  type MonthToDateInput,
  type PlainDate,
  type PositionRecord,
  type PositionWithValuations,
  type TransferFlow,
  type ValuationRecord,
} from '@vaultide/finance';
import { toCompletenessTemplate, toExpenseFlow, toIncomeFlow, toTransferFlow } from '../reconciliation/loader';
import { toPositionRecord, toValuationRecord } from '../positions/mapping';
import type { IdentifiedSourceChange, ResolvedWrite, SourceFacts } from '../write-plan';
import { identityKey } from '../write-plan';
import { periodOf, monthKeyOfPeriod } from './classify';

/**
 * The evidence a correction preview reasons over, and the overlay that turns
 * BEFORE into AFTER (§27, §32, §33, §76 of the slice prompt; ADR 0010 §2).
 *
 * Three rules shape this module, and each of them removes a way of getting the
 * answer wrong:
 *
 *  - **one read, one world.** Everything is loaded once, inside the single
 *    `REPEATABLE READ READ ONLY` transaction, and BEFORE and AFTER are derived
 *    from the same loaded rows with only the overlay different. Two loads could
 *    compose a before from one world and an after from another.
 *  - **the overlay is in memory, never a write-and-roll-back.** The preview
 *    transaction is read only; there is no savepoint, no temporary row and
 *    nothing to undo.
 *  - **it overlays the engines' own inputs, not database rows.** A prospective
 *    fee has no database id, and fabricating one to insert into a row array
 *    would put a value in the preview that the commit could never reproduce.
 *    The engines take flows, valuations and positions, so those are what the
 *    overlay produces, with a deterministic semantic id for anything that does
 *    not exist yet (§19).
 *
 * No arithmetic lives here: the engines are the authority for every figure, and
 * this module only decides which rows they are given.
 */

/** Every source fact one correction's impact could depend on, as the engines see it. */
export interface CorrectionEvidence {
  readonly today: PlainDate;
  readonly positions: readonly PositionRecord[];
  /**
   * Valuations by position id, in **no guaranteed order**. No lower bound (ADR
   * 0004 §3).
   *
   * The loader returns each position's rows newest first, and the overlay
   * re-sorts a corrected position's rows oldest first. Nothing may depend on
   * either: every reader asks by date — the latest on or before one, the row
   * on one, whether any exists before or inside one — never by position in the
   * list.
   */
  readonly valuations: ReadonlyMap<string, readonly ValuationRecord[]>;
  readonly accountTypes: ReadonlyMap<string, string>;
  readonly income: readonly IncomeFlow[];
  readonly expenses: readonly ExpenseFlow[];
  /**
   * Each expense's own category, by flow id.
   *
   * `ExpenseFlow` carries the category's **kind**, because that is all 7.4
   * needs to classify it. The by-category decomposition the Spending page
   * shows is keyed on the category itself (30.14), and two categories of the
   * same kind are two rows there, so the identity travels beside the flow
   * rather than inside a finance type that has no use for it.
   */
  readonly categoryIds: ReadonlyMap<string, string>;
  readonly transfers: readonly TransferFlow[];
  readonly templates: readonly CompletenessTemplate[];
  readonly resolvedOccurrences: readonly { templateId: string; occurrenceDate: string }[];
  /** 12.5: a financial input, so a correction's savings impact can depend on it. */
  readonly countAdditionalSpending: boolean;
}

/* -------------------------------------------------------------------------- */
/* The valuation history                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every position and every balance through today — the part of the evidence a
 * correction's window is computed **from**.
 *
 * Loaded first and once, because the window cannot be known without it: how
 * far a corrected balance reaches depends on which balances come after it, in
 * both the world before the correction and the world after. It is then handed
 * on unchanged to become part of the evidence, so the rows the window was
 * judged from and the rows the engines read are the same rows.
 *
 * No lower bound (ADR 0004 §3): a month's opening may be a balance carried from
 * years earlier, and windowing them would turn a carried balance into `missing`
 * and a reconcilable month into `unavailable`. Bounded above by today, because
 * `findSpanIntervals` reads every account's whole history (8.7).
 */
export interface ValuationHistory {
  readonly positions: readonly PositionRecord[];
  /** Valuations by position id, in no guaranteed order: see `CorrectionEvidence.valuations`. */
  readonly valuations: ReadonlyMap<string, readonly ValuationRecord[]>;
  readonly accountTypes: ReadonlyMap<string, string>;
}

export async function loadValuationHistoryIn(
  tx: Transaction,
  today: PlainDate,
): Promise<ValuationHistory> {
  const financial = await loadFinancialWindowIn(tx, today);

  const valuations = new Map<string, ValuationRecord[]>();
  for (const row of financial.valuations) {
    const list = valuations.get(row.positionId);
    const record = toValuationRecord(row);
    if (list === undefined) valuations.set(row.positionId, [record]);
    else list.push(record);
  }

  return {
    positions: financial.positions.map(toPositionRecord),
    valuations,
    accountTypes: new Map(
      financial.positions.map((row) => [row.id, row.accountType ?? 'checking']),
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* How far a corrected balance reaches                                         */
/* -------------------------------------------------------------------------- */

/**
 * The last month in which a balance correction can still change anything, or
 * `current` when no earlier month can be proved.
 *
 * ## What the engines read from a position's balances
 *
 * Every engine a preview asks — `reconcileCompletedMonth`,
 * `reconcileMonthToDate`, `completedMonthCompleteness` — reads one account's
 * balances for a month `M` in exactly four ways, all through the Phase 2 state
 * machine in `positions/cash-state.ts`:
 *
 *  1. **by exact date** — the statement balance at `end(M)` and, for the
 *     opening, at `end(M−1)`; the current month's snapshots at a candidate
 *     `D`;
 *  2. **the latest on or before a date** — any precision — which decides
 *     `carried` against `missing` and whether a dormant zero is the episode's
 *     own evidence;
 *  3. **whether any balance exists before a date** — `first_balance`, in both
 *     the completed and the month-to-date opening;
 *  4. **whether any balance exists inside `M`** — 12.6's `stale`.
 *
 * ## When those reads stop seeing the corrected row
 *
 * Take the first balance of the position that is present, **unchanged**, in
 * both worlds and dated after every row the correction adds, moves or removes.
 * Call its date `s`. From `s` on, reads 2 and 3 answer the same in both worlds
 * — the latest balance is `s` or later, and `s` itself proves something earlier
 * exists — and reads 1 and 4 only ever ask about dates the correction does not
 * touch. So every month after `month(s)` is identical before and after.
 *
 * `month(s)` itself is **not** safe to drop, and that is why this is not "stop
 * at the next balance". Its opening reads the statement at `end(month(s) − 1)`
 * by exact date, and an ordinary snapshot on the 1st does nothing to that read:
 * an April statement followed by a snapshot on 1 May still opens May. The carry
 * interval of that April statement ends on 30 April; its reach ends with May.
 *
 * ## Both worlds, not one
 *
 * `s` is taken after the **latest** row that differs between the two worlds,
 * so a balance moved from April to August past an untouched June balance is
 * still judged through the first untouched balance after August — the world
 * before the correction stops at June, the world after does not. A deleted
 * balance leaves its predecessor carrying further, and the same rule covers
 * it: the rows that differ are the deleted one's, and nothing unchanged after
 * it has moved.
 *
 * With no such balance there is nothing to stop at, and the reach runs to the
 * current month, where the evidence itself ends. That fallback is what keeps
 * this an optimisation rather than a rule the correctness depends on.
 */
export type ValuationReach =
  | { readonly kind: 'none' }
  | { readonly kind: 'through'; readonly period: string }
  | { readonly kind: 'current' };

/** Everything an engine could read from one balance, as one comparable string. */
const valuationKey = (record: ValuationRecord): string =>
  [
    record.id,
    record.positionId,
    record.valuedOn,
    record.amount.toString(),
    record.datePrecision,
    record.source,
  ].join('|');

export function valuationReachOf(
  write: ResolvedWrite,
  valuations: ReadonlyMap<string, readonly ValuationRecord[]>,
): ValuationReach {
  const positions = new Set<string>();
  for (const change of write.changes) {
    for (const facts of [change.before, change.after]) {
      if (facts?.kind === 'valuation') positions.add(facts.positionId);
    }
  }
  if (positions.size === 0) return { kind: 'none' };

  // The world after, through the one overlay the impact itself uses.
  const after = overlayValuations(valuations, write.changes);

  let reach: string | null = null;
  for (const positionId of [...positions].sort()) {
    const left = new Map((valuations.get(positionId) ?? []).map((row) => [valuationKey(row), row]));
    const right = new Map((after.get(positionId) ?? []).map((row) => [valuationKey(row), row]));

    const differing = [
      ...[...left].filter(([key]) => !right.has(key)),
      ...[...right].filter(([key]) => !left.has(key)),
    ].map(([, row]) => row.valuedOn as string);
    if (differing.length === 0) continue;

    const last = differing.sort().at(-1) as string;
    const reset = [...left]
      .filter(([key, row]) => right.has(key) && row.valuedOn > last)
      .map(([, row]) => row.valuedOn as string)
      .sort()[0];
    if (reset === undefined) return { kind: 'current' };

    const period = periodOf(reset);
    if (reach === null || period > reach) reach = period;
  }
  return reach === null ? { kind: 'none' } : { kind: 'through', period: reach };
}

/* -------------------------------------------------------------------------- */
/* The window                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The window one correction is evaluated over: which months, and the exact
 * dates the dated reads are bounded by.
 *
 * One value, computed once and handed to both the loader and the impact, so
 * the rows that are read and the months that are judged cannot drift apart.
 * A month that is never judged must not be read, and a month that is judged
 * must never be missing its rows.
 */
export interface CorrectionWindow {
  /** Every month this correction could change, ascending. */
  readonly periods: readonly string[];
  /** The first day of the earliest of them. */
  readonly from: PlainDate;
  /** The last day of the latest of them: the dated reads stop here. */
  readonly through: PlainDate;
}

export function correctionWindow(
  write: ResolvedWrite,
  today: PlainDate,
  history: ValuationHistory,
): CorrectionWindow {
  const periods = candidatePeriods(write, today, history.valuations);
  const first = periods[0] ?? monthLabel(monthKey(today));
  const last = periods[periods.length - 1] ?? first;
  return {
    periods,
    from: startOfMonthKey(monthKeyOfPeriod(first)),
    through: endOfMonthKey(monthKeyOfPeriod(last)),
  };
}

/**
 * Every month a correction could conceivably change, ascending.
 *
 * The first is the earliest month any of its source facts touches — a financial
 * date on either side, a fee's own date, a dormant episode's anchor, or the
 * scheduled date of an occurrence whose satisfaction moves.
 *
 * The last depends on what kind of fact moved, because the engines propagate
 * them differently:
 *
 *  - a **flow** changes its own month's reconciliation and nothing later. A
 *    month is reconciled between two statement balances, and a flow is neither;
 *  - a **balance** is opening evidence for the months after it, until the
 *    balances that follow it make both worlds read the same again — see
 *    `valuationReachOf`, which proves that month from the history or falls
 *    back to the current one;
 *  - a **dormant episode** is open-ended until something wakes the account, so
 *    it reaches the current month.
 *
 * Nothing reaches past the current month: nothing after today exists to
 * change. The months that turn out to be unaffected are dropped from the
 * result later, so a wide candidate range costs in-memory work, never a wider
 * read than the window.
 */
export function candidatePeriods(
  write: ResolvedWrite,
  today: PlainDate,
  valuations: ReadonlyMap<string, readonly ValuationRecord[]>,
): readonly string[] {
  const current = monthLabel(monthKey(today));
  const touched = new Set<string>();
  let reachesCurrent = false;

  for (const change of write.changes) {
    for (const facts of [change.before, change.after]) {
      if (facts === null) continue;
      const date = financialDateOfFacts(facts);
      if (date !== null) touched.add(periodOf(date));
      // The scheduled date of an occurrence is not a financial period, but
      // whether that occurrence is satisfied decides its own month's
      // completeness and its `suggested_income_missing` (12.6, 30.10).
      if (
        (facts.kind === 'income' || facts.kind === 'expense') &&
        facts.occurrenceDate !== null
      ) {
        touched.add(periodOf(facts.occurrenceDate));
      }
    }
  }
  for (const effect of write.dormancy) {
    for (const anchor of [effect.before.dormantFrom, effect.after.dormantFrom]) {
      if (anchor === null) continue;
      touched.add(periodOf(anchor));
      reachesCurrent = true;
    }
  }

  const reach = valuationReachOf(write, valuations);
  if (reach.kind === 'current') reachesCurrent = true;
  if (reach.kind === 'through') touched.add(reach.period);

  if (touched.size === 0) touched.add(current);
  const sorted = [...touched].sort();
  const first = sorted[0] as string;
  const last = reachesCurrent ? current : (sorted[sorted.length - 1] as string);

  const months: string[] = [];
  for (
    let month = monthKeyOfPeriod(first);
    monthLabel(month) <= last && monthLabel(month) <= current;
    month = monthKey(addMonths(startOfMonthKey(month), 1))
  ) {
    months.push(monthLabel(month));
  }
  return months;
}

function financialDateOfFacts(facts: SourceFacts): string | null {
  switch (facts.kind) {
    case 'income':
      return facts.receivedOn;
    case 'expense':
      return facts.incurredOn;
    case 'transfer':
      return facts.occurredOn;
    case 'valuation':
      return facts.valuedOn;
    case 'cash_dormancy':
      return facts.dormantFrom;
  }
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Load the rest of the evidence over the window, in a fixed number of bulk
 * statements (23.2).
 *
 * None of them is per month, per position, per flow or per template, so the
 * count does not grow with the window. They are issued one after another
 * rather than in parallel, because one transaction is one connection (ADR 0010
 * §8). The valuation history is **not** read again here: it was read once to
 * compute the window, and it is the same history the engines reason over.
 *
 * The flows, templates and resolved occurrences are bounded on **both** sides
 * by the window: from the first day of the earliest month it could change to
 * the last day of the latest. A 2021 expense correction is judged over 2021
 * alone, and a 2021 balance correction over the months up to the first
 * untouched balance after it, so reading through today would pull years of
 * rows no part of the derivation can look at.
 */
export async function loadCorrectionEvidenceIn(
  tx: Transaction,
  today: PlainDate,
  history: ValuationHistory,
  window: CorrectionWindow,
): Promise<CorrectionEvidence> {
  const { from, through } = window;

  const income = await listIncomeEntriesIn(tx, from, through);
  const expenses = await listExpenseEntriesIn(tx, from, through);
  const transfers = await listTransfersIn(tx, from, through);
  // Archived categories included: an expense keeps its category, and the kind
  // of an archived one still decides how that expense is classified (R12).
  const categories = await listCategoryRecordsIn(tx, { includeArchived: true });
  // Templates regardless of `archived_at` (30.10): archiving is present-tense
  // visibility, and a template archived today still expected a salary last
  // September.
  const templates = await listTemplatesForRangeIn(tx, from, through);
  const resolved = await listResolvedOccurrencesInRangeIn(tx, from, through);
  const settings = await findUserSettingsIn(tx);

  const kindOf = new Map(categories.map((category) => [category.id, category.kind]));

  return {
    today: plainDate(today),
    positions: history.positions,
    valuations: history.valuations,
    accountTypes: history.accountTypes,
    income: income.map(toIncomeFlow),
    expenses: expenses.map((row) => toExpenseFlow(row, kindOf)),
    categoryIds: new Map(expenses.map((row) => [row.id, row.categoryId])),
    transfers: transfers.map(toTransferFlow),
    templates: templates.map(toCompletenessTemplate),
    resolvedOccurrences: resolved.map((row) => ({
      templateId: row.templateId,
      occurrenceDate: row.occurrenceDate,
    })),
    countAdditionalSpending: settings?.countAdditionalSpending ?? true,
  };
}

/* -------------------------------------------------------------------------- */
/* The overlay                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The id a row carries inside the overlay.
 *
 * An existing row keeps its real database id, because that is what the loaded
 * evidence holds it under. A prospective one — a fee the correction would add,
 * a flow an acceptance would materialize — has none, so it carries its
 * deterministic semantic identity instead (§19). Neither ever leaves this
 * module as a financial fact: the engines use ids to group and to name, and the
 * only place one reaches the preview is an issue that is about a specific
 * record, where the semantic identity is exactly the right answer.
 */
const overlayId = (change: IdentifiedSourceChange): string =>
  change.identity.scope === 'existing' ? change.identity.id : identityKey(change.identity);

function incomeFlowOf(facts: Extract<SourceFacts, { kind: 'income' }>, id: string): IncomeFlow {
  return {
    id,
    kind: facts.incomeKind as IncomeFlow['kind'],
    receivedOn: plainDate(facts.receivedOn),
    netAmount: new Decimal(facts.netAmount),
    currency: currencyCode(facts.currency),
    settlement: facts.settlement as IncomeFlow['settlement'],
    cashPositionId: facts.cashPositionId,
    investmentPositionId: null,
  };
}

function expenseFlowOf(facts: Extract<SourceFacts, { kind: 'expense' }>, id: string): ExpenseFlow {
  return {
    id,
    categoryKind: facts.categoryKind as ExpenseFlow['categoryKind'],
    incurredOn: plainDate(facts.incurredOn),
    amount: new Decimal(facts.amount),
    currency: currencyCode(facts.currency),
    settlement: facts.settlement as ExpenseFlow['settlement'],
    cashPositionId: facts.cashPositionId,
    transferId: facts.transferId,
  };
}

function transferFlowOf(
  facts: Extract<SourceFacts, { kind: 'transfer' }>,
  id: string,
): TransferFlow {
  return {
    id,
    kind: 'cash_transfer',
    occurredOn: plainDate(facts.occurredOn),
    fromPositionId: facts.fromPositionId,
    fromCurrency: currencyCode(facts.fromCurrency),
    fromAmount: new Decimal(facts.fromAmount),
    toPositionId: facts.toPositionId,
    toCurrency: currencyCode(facts.toCurrency),
    toAmount: new Decimal(facts.toAmount),
  };
}

function valuationRecordOf(
  facts: Extract<SourceFacts, { kind: 'valuation' }>,
  id: string,
): ValuationRecord {
  return {
    id,
    positionId: facts.positionId,
    valuedOn: plainDate(facts.valuedOn),
    amount: new Decimal(facts.amount),
    // Provenance is not a consent-relevant fact and no engine reads it; the
    // date, the amount and the precision are what a balance means (8.1, 8.8).
    source: 'entered',
    datePrecision: facts.datePrecision,
  };
}

/**
 * One balance change, applied to a position's history in place.
 *
 * Out by the date it had, in at the date it will have. M1 makes the date the
 * row's identity within an account, so a re-dated balance is one row moving
 * rather than two rows existing.
 */
function applyValuationChange(
  valuations: Map<string, readonly ValuationRecord[]>,
  change: IdentifiedSourceChange,
  id: string,
): void {
  const before = change.before?.kind === 'valuation' ? change.before : null;
  const after = change.after?.kind === 'valuation' ? change.after : null;
  const positionId = (after ?? before)?.positionId ?? '';
  const existing = valuations.get(positionId) ?? [];

  const kept = existing.filter((record) => before === null || record.valuedOn !== before.valuedOn);
  const next =
    after === null
      ? kept
      : [...kept.filter((record) => record.valuedOn !== after.valuedOn), valuationRecordOf(after, id)];
  valuations.set(
    positionId,
    [...next].sort((a, b) => (a.valuedOn < b.valuedOn ? -1 : a.valuedOn > b.valuedOn ? 1 : 0)),
  );
}

/**
 * The balance histories after a correction, and nothing else.
 *
 * The same arm `overlayCorrection` applies — not a second statement of it — for
 * the one caller that needs the after-world's balances before the rest of the
 * evidence exists: the window.
 */
export function overlayValuations(
  valuations: ReadonlyMap<string, readonly ValuationRecord[]>,
  changes: readonly IdentifiedSourceChange[],
): ReadonlyMap<string, readonly ValuationRecord[]> {
  const next = new Map<string, readonly ValuationRecord[]>(valuations);
  for (const change of changes) {
    const facts = change.after ?? change.before;
    if (facts.kind === 'valuation') applyValuationChange(next, change, overlayId(change));
  }
  return next;
}

function replace<T>(list: readonly T[], id: string, next: T | null, idOf: (item: T) => string): T[] {
  const without = list.filter((item) => idOf(item) !== id);
  return next === null ? without : [...without, next];
}

/**
 * Apply a resolved correction to the loaded evidence, in memory.
 *
 * Every arm is the same shape: take the row out by the identity the change
 * names, and put the after-state back when there is one. A creation has nothing
 * to take out; a deletion puts nothing back.
 *
 * The occurrence set moves with the flows that carry one, because a deleted
 * occurrence is an unsatisfied requirement again (12.6) and a materialized one
 * is satisfied.
 */
export function overlayCorrection(
  evidence: CorrectionEvidence,
  write: ResolvedWrite,
): CorrectionEvidence {
  let income = [...evidence.income];
  let expenses = [...evidence.expenses];
  const categoryIds = new Map(evidence.categoryIds);
  let transfers = [...evidence.transfers];
  const valuations = new Map<string, readonly ValuationRecord[]>(evidence.valuations);
  let positions = [...evidence.positions];
  let resolvedOccurrences = [...evidence.resolvedOccurrences];

  const occurrenceOf = (facts: SourceFacts): { templateId: string; occurrenceDate: string } | null =>
    (facts.kind === 'income' || facts.kind === 'expense') &&
    facts.templateId !== null &&
    facts.occurrenceDate !== null
      ? { templateId: facts.templateId, occurrenceDate: facts.occurrenceDate }
      : null;

  for (const change of write.changes) {
    const id = overlayId(change);

    if (change.before !== null) {
      const occurrence = occurrenceOf(change.before);
      if (change.operation === 'delete' && occurrence !== null) {
        resolvedOccurrences = resolvedOccurrences.filter(
          (item) =>
            item.templateId !== occurrence.templateId ||
            item.occurrenceDate !== occurrence.occurrenceDate,
        );
      }
    }

    switch (change.operation === 'delete' ? change.before.kind : change.after.kind) {
      case 'income': {
        const after =
          change.after === null
            ? null
            : incomeFlowOf(change.after as Extract<SourceFacts, { kind: 'income' }>, id);
        income = replace(income, id, after, (flow) => flow.id);
        break;
      }
      case 'expense': {
        const facts =
          change.after === null ? null : (change.after as Extract<SourceFacts, { kind: 'expense' }>);
        const after = facts === null ? null : expenseFlowOf(facts, id);
        expenses = replace(expenses, id, after, (flow) => flow.id);
        if (facts === null) categoryIds.delete(id);
        else categoryIds.set(id, facts.categoryId);
        break;
      }
      case 'transfer': {
        const after =
          change.after === null
            ? null
            : transferFlowOf(change.after as Extract<SourceFacts, { kind: 'transfer' }>, id);
        transfers = replace(transfers, id, after, (flow) => flow.id);
        break;
      }
      case 'valuation': {
        applyValuationChange(valuations, change, id);
        break;
      }
      case 'cash_dormancy': {
        const facts = change.after as Extract<SourceFacts, { kind: 'cash_dormancy' }>;
        positions = positions.map((position) => {
          if (position.id !== facts.positionId) return position;
          // The anchor is **absent** rather than null when the episode is over:
          // the engines read the field's presence (8.8, 30.20), and
          // `exactOptionalPropertyTypes` keeps the two apart for us.
          const { dormantFrom: _dropped, ...rest } = position;
          return facts.dormantFrom === null
            ? { ...rest, isDormant: facts.isDormant }
            : {
                ...rest,
                isDormant: facts.isDormant,
                dormantFrom: plainDate(facts.dormantFrom),
              };
        });
        break;
      }
    }

    if (change.after !== null) {
      const occurrence = occurrenceOf(change.after);
      if (
        change.operation === 'create' &&
        occurrence !== null &&
        !resolvedOccurrences.some(
          (item) =>
            item.templateId === occurrence.templateId &&
            item.occurrenceDate === occurrence.occurrenceDate,
        )
      ) {
        resolvedOccurrences = [...resolvedOccurrences, occurrence];
      }
    }
  }

  return {
    ...evidence,
    income,
    expenses,
    categoryIds,
    transfers,
    valuations,
    positions,
    resolvedOccurrences,
  };
}

/* -------------------------------------------------------------------------- */
/* Engine inputs                                                               */
/* -------------------------------------------------------------------------- */

function cashAccountsOf(evidence: CorrectionEvidence, through: PlainDate): CashAccountInput[] {
  return evidence.positions
    .filter((position) => position.kind === 'cash')
    .map((position) => ({
      position,
      valuations: (evidence.valuations.get(position.id) ?? []).filter(
        (record) => record.valuedOn <= through,
      ),
      accountType: evidence.accountTypes.get(position.id) ?? 'checking',
    }));
}

export function positionsWithValuationsOf(
  evidence: CorrectionEvidence,
  through: PlainDate,
): PositionWithValuations[] {
  return evidence.positions.map((position) => ({
    position,
    valuations: (evidence.valuations.get(position.id) ?? []).filter(
      (record) => record.valuedOn <= through,
    ),
  }));
}

function templatesOverlapping(
  evidence: CorrectionEvidence,
  month: MonthKey,
): CompletenessTemplate[] {
  const from = startOfMonthKey(month);
  const to = endOfMonthKey(month);
  return evidence.templates.filter(
    (template) =>
      template.schedule.startDate <= to &&
      (template.schedule.endDate === null || template.schedule.endDate >= from),
  );
}

function resolvedIn(evidence: CorrectionEvidence, month: MonthKey): ReadonlySet<string> {
  const from = startOfMonthKey(month);
  const to = endOfMonthKey(month);
  return new Set(
    evidence.resolvedOccurrences
      .filter((item) => item.occurrenceDate >= from && item.occurrenceDate <= to)
      .map((item) => occurrenceKey(item.templateId, item.occurrenceDate)),
  );
}

/** One completed month's engine input, sliced from the overlaid evidence. */
export function completedInputOf(
  evidence: CorrectionEvidence,
  month: MonthKey,
): CompletedMonthInput {
  const from = startOfMonthKey(month);
  const to = endOfMonthKey(month);
  const within = (on: PlainDate): boolean => on >= from && on <= to;

  return {
    month,
    today: evidence.today,
    cashAccounts: cashAccountsOf(evidence, to),
    income: evidence.income.filter((flow) => within(flow.receivedOn)),
    expenses: evidence.expenses.filter((flow) => within(flow.incurredOn)),
    transfers: evidence.transfers.filter((flow) => within(flow.occurredOn)),
    templates: templatesOverlapping(evidence, month),
    resolvedOccurrences: resolvedIn(evidence, month),
  };
}

/** The same month's completeness input (12.6, 30.18). */
export function completenessInputOf(
  evidence: CorrectionEvidence,
  month: MonthKey,
): CompletedMonthCompletenessInput {
  return {
    month,
    today: evidence.today,
    positions: positionsWithValuationsOf(evidence, endOfMonthKey(month)),
    templates: templatesOverlapping(evidence, month),
    resolvedOccurrences: resolvedIn(evidence, month),
  };
}

/** The current month's engine input, through today (8.6). */
export function monthToDateInputOf(evidence: CorrectionEvidence): MonthToDateInput {
  const from = startOfMonthKey(monthKey(evidence.today));
  const within = (on: PlainDate): boolean => on >= from && on <= evidence.today;

  return {
    today: evidence.today,
    cashAccounts: cashAccountsOf(evidence, evidence.today),
    income: evidence.income.filter((flow) => within(flow.receivedOn)),
    expenses: evidence.expenses.filter((flow) => within(flow.incurredOn)),
    transfers: evidence.transfers.filter((flow) => within(flow.occurredOn)),
  };
}

/** Every cash account with its whole valuation history, for span discovery (8.7). */
export function spanAccountsOf(evidence: CorrectionEvidence): CashAccountInput[] {
  return cashAccountsOf(evidence, evidence.today);
}
