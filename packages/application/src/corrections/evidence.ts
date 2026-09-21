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
  /** Valuations by position id, ascending by date. No lower bound (ADR 0004 §3). */
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
/* The window                                                                  */
/* -------------------------------------------------------------------------- */

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
 *  - a **valuation** is opening evidence for the months after it and carries
 *    until the next authoritative balance, so it reaches forward;
 *  - a **dormant episode** is open-ended until something wakes the account, so
 *    it reaches forward too.
 *
 * Forward means "to the current month", which is where the evidence itself
 * stops. It is not an arbitrary horizon: nothing after today exists to change.
 * The months that turn out to be unaffected are dropped from the result later,
 * so a wide candidate range costs in-memory work, never a wider read.
 */
/**
 * The window one correction is evaluated over: which months, and the exact
 * dates the flow reads are bounded by.
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
  /** The last day of the latest of them: the flow reads stop here. */
  readonly through: PlainDate;
}

export function correctionWindow(write: ResolvedWrite, today: PlainDate): CorrectionWindow {
  const periods = candidatePeriods(write, today);
  const first = periods[0] ?? monthLabel(monthKey(today));
  const last = periods[periods.length - 1] ?? first;
  return {
    periods,
    from: startOfMonthKey(monthKeyOfPeriod(first)),
    through: endOfMonthKey(monthKeyOfPeriod(last)),
  };
}

export function candidatePeriods(write: ResolvedWrite, today: PlainDate): readonly string[] {
  const current = monthLabel(monthKey(today));
  const touched = new Set<string>();
  let reachesForward = false;

  for (const change of write.changes) {
    for (const facts of [change.before, change.after]) {
      if (facts === null) continue;
      const date = financialDateOfFacts(facts);
      if (date !== null) touched.add(periodOf(date));
      if (facts.kind === 'valuation') reachesForward = true;
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
      reachesForward = true;
    }
  }

  if (touched.size === 0) touched.add(current);
  const sorted = [...touched].sort();
  const first = sorted[0] as string;
  const last = reachesForward ? current : (sorted[sorted.length - 1] as string);

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
 * Load the window, in a fixed number of bulk reads (23.2).
 *
 * Eight statements, none of them per month, per position, per flow or per
 * template. They are issued one after another rather than in parallel, because
 * one transaction is one connection (ADR 0010 §8).
 *
 * The flows are bounded on **both** sides by the correction's own window: from
 * the first day of the earliest month it could change to the last day of the
 * latest. A 2021 expense correction is judged over 2021 alone, so reading
 * through today would pull five years of rows no part of the derivation can
 * look at. A balance or a dormant episode legitimately reaches the current
 * month, and its window says so.
 *
 * The valuations keep ADR 0004 §3's no-lower-bound rule instead: a month's
 * opening may be a balance carried from years earlier, and windowing them would
 * turn a carried balance into `missing` and a reconcilable month into
 * `unavailable`. They are bounded above by today, not by the window, because
 * `findSpanIntervals` reads every account's whole history (8.7).
 */
export async function loadCorrectionEvidenceIn(
  tx: Transaction,
  today: PlainDate,
  window: CorrectionWindow,
): Promise<CorrectionEvidence> {
  const { from, through } = window;

  const financial = await loadFinancialWindowIn(tx, today);
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

  const valuations = new Map<string, ValuationRecord[]>();
  for (const row of financial.valuations) {
    const list = valuations.get(row.positionId);
    const record = toValuationRecord(row);
    if (list === undefined) valuations.set(row.positionId, [record]);
    else list.push(record);
  }

  const kindOf = new Map(categories.map((category) => [category.id, category.kind]));

  return {
    today: plainDate(today),
    positions: financial.positions.map(toPositionRecord),
    valuations,
    accountTypes: new Map(
      financial.positions.map((row) => [row.id, row.accountType ?? 'checking']),
    ),
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
        type Valuation = Extract<SourceFacts, { kind: 'valuation' }>;
        const before = change.before === null ? null : (change.before as Valuation);
        const after = change.after === null ? null : (change.after as Valuation);
        const positionId = (after ?? before)?.positionId ?? '';
        const existing = valuations.get(positionId) ?? [];

        // Out by the date it had, in at the date it will have. M1 makes the
        // date the row's identity within an account, so a re-dated balance is
        // one row moving rather than two rows existing.
        const kept = existing.filter(
          (record) => before === null || record.valuedOn !== before.valuedOn,
        );
        const next =
          after === null
            ? kept
            : [
                ...kept.filter((record) => record.valuedOn !== after.valuedOn),
                valuationRecordOf(after, id),
              ];
        valuations.set(
          positionId,
          [...next].sort((a, b) => (a.valuedOn < b.valuedOn ? -1 : a.valuedOn > b.valuedOn ? 1 : 0)),
        );
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
