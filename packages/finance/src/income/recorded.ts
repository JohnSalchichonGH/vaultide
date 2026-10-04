import {
  addMonths,
  endOfMonthKey,
  isMonthCompleted,
  monthKey,
  monthKeyOf,
  startOfMonthKey,
  type MonthKey,
  type PlainDate,
} from '../dates/plain-date';
import type { IncomeKind, IncomeSettlement } from '../flows/types';
import type { FxTable } from '../fx/types';
import { add } from '../money/money';
import type { CurrencyCode, Money } from '../money/types';
import { missingIncomeOccurrences } from '../reconciliation/completeness';
import type { CompletenessTemplate } from '../reconciliation/types';
import { occurrencesInRange } from '../recurring/occurrences';
import { sumAmountsOf, type ReportingAmount } from '../reporting/aggregate';
import { convertContribution } from '../reporting/cash-flow';
import { isExternalIncomeKind } from '../savings/classify';

/**
 * Income recorded (blueprint 15.2 "Income", v2.1.20 30.23; ADR 0012 D1–D3, D7).
 *
 * What the Income pages count, and how they total it. It is **record-based**:
 * every income entry of a counted kind, settled into a tracked account or
 * outside one, placed in the month of its financial date. Nothing here is
 * reconciliation-scoped — no bucket, no balance, no `first_balance` exclusion
 * and no month-to-date `D` — which is why it is a different figure from
 * `ExternalIncome`, the one Monthly shows (30.23 item 3). Neither is derived
 * from the other.
 *
 * Every entry converts on its own date with the dated conversion a known
 * spending row gets (`convertContribution`), and every total is a sum of those
 * conversions by 7.6's algebra (`sumAmountsOf`): a missing rate leaves the
 * total partial and names the currency, and never stands in as a zero (30.23
 * item 6). Native amounts stay native beside it. Nothing is rounded.
 *
 * Pure and deterministic: today, the rates and the records are passed in.
 */

/* -------------------------------------------------------------------------- */
/* What counts                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The seven kinds the Income pages count (30.23 item 1), salary first.
 *
 * The same seven 12.5 counts as income, for the same reason:
 * `external_inflow` is money coming back from an untracked account and
 * `adjustment` a reconciliation record standing in for an unexplained inflow.
 * Neither was earned, so neither is income anywhere.
 */
export const INCOME_RECORDED_KINDS = [
  'employment',
  'bonus',
  'freelance',
  'rental',
  'dividend',
  'interest',
  'other',
] as const satisfies readonly IncomeKind[];
export type IncomeRecordedKind = (typeof INCOME_RECORDED_KINDS)[number];

/** Whether an income kind is one the Income pages count — `isExternalIncomeKind`'s answer. */
export const isIncomeRecordedKind = (kind: IncomeKind): kind is IncomeRecordedKind =>
  isExternalIncomeKind(kind);

/**
 * Whether an entry is income recorded (30.23 item 1): a counted kind, settled
 * into a tracked account or outside every tracked account. `reinvested` is
 * Phase 4's, with the investment it belongs to.
 */
export function isIncomeRecorded<E extends Pick<RecordedIncomeEntry, 'kind' | 'settlement'>>(
  entry: E,
): entry is E & { readonly kind: IncomeRecordedKind } {
  return (
    isIncomeRecordedKind(entry.kind) &&
    (entry.settlement === 'tracked_cash' || entry.settlement === 'external')
  );
}

/** 30.23 item 5: base is `employment`, bonus is `bonus`, everything else is other. */
export type IncomeGroup = 'salary' | 'bonus' | 'other';

export const INCOME_GROUPS = ['salary', 'bonus', 'other'] as const satisfies readonly IncomeGroup[];

export function incomeGroupOf(kind: IncomeRecordedKind): IncomeGroup {
  switch (kind) {
    case 'employment':
      return 'salary';
    case 'bonus':
      return 'bonus';
    case 'freelance':
    case 'rental':
    case 'dividend':
    case 'interest':
    case 'other':
      return 'other';
  }
}

/** 30.23 item 1: into a tracked account, or outside them. */
export type IncomeSide = 'tracked' | 'outside';

/* -------------------------------------------------------------------------- */
/* Entries, one at a time                                                      */
/* -------------------------------------------------------------------------- */

/** One income entry as recorded, in its own currency. */
export interface RecordedIncomeEntry {
  readonly id: string;
  readonly kind: IncomeKind;
  readonly settlement: IncomeSettlement;
  /** The financial date: the month an entry belongs to and the date it converts at (30.23 items 2, 6). */
  readonly receivedOn: PlainDate;
  readonly net: Money;
  /** `null` when no gross was recorded, which is never a zero (30.23 item 4). */
  readonly gross: Money | null;
  /** The recurring source it materializes, or `null` for a one-off payment. */
  readonly templateId: string | null;
}

/** One counted entry, with its own conversions. */
export interface IncomeItem {
  readonly entry: RecordedIncomeEntry;
  readonly kind: IncomeRecordedKind;
  readonly group: IncomeGroup;
  readonly side: IncomeSide;
  /** The net amount on `receivedOn`'s rate, or why it could not be stated. */
  readonly net: ReportingAmount;
  /** The gross the same way, or `null` when the entry has none. */
  readonly gross: ReportingAmount | null;
}

const dated = (amount: Money, on: PlainDate, reporting: CurrencyCode, fx: FxTable): ReportingAmount =>
  convertContribution({ amount, basis: { kind: 'dated', on } }, reporting, fx);

/**
 * Every counted entry, each converted at its own financial date, in the order
 * given. Entries the pages do not count are left out here and nowhere else.
 */
export function incomeItemsOf(
  entries: readonly RecordedIncomeEntry[],
  reporting: CurrencyCode,
  fx: FxTable,
): IncomeItem[] {
  const items: IncomeItem[] = [];
  for (const entry of entries) {
    if (!isIncomeRecorded(entry)) continue;
    items.push({
      entry,
      kind: entry.kind,
      group: incomeGroupOf(entry.kind),
      side: entry.settlement === 'tracked_cash' ? 'tracked' : 'outside',
      net: dated(entry.net, entry.receivedOn, reporting, fx),
      gross: entry.gross === null ? null : dated(entry.gross, entry.receivedOn, reporting, fx),
    });
  }
  return items;
}

/* -------------------------------------------------------------------------- */
/* Totals                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A gross over some entries (30.23 item 4; ADR 0012 D3).
 *
 * `recorded` sums only the grosses that exist, and is `null` when none of the
 * entries has one: there is then no gross to state at all, not a gross of zero.
 * `withoutGross` says how many entries the gross does not cover; whenever it is
 * above zero the gross is partial, whatever its conversion says.
 */
export interface GrossAggregate {
  readonly recorded: ReportingAmount | null;
  readonly withoutGross: number;
}

export interface IncomeTotal {
  /** The net in the reporting currency, by 7.6's algebra. */
  readonly net: ReportingAmount;
  readonly gross: GrossAggregate;
  /** The net per native currency, in currency order: exact, and never converted. */
  readonly native: readonly Money[];
  /** How many payments are inside the total. */
  readonly count: number;
}

/** Code-point order, for keys that are unique within the list being sorted. */
function byCode(a: string, b: string): number {
  if (a < b) return -1;
  /* v8 ignore next -- unreachable: currencies, template ids and entry ids are
     each unique where they are sorted, so two keys are never equal. */
  if (a === b) return 0;
  return 1;
}

function nativeSums(items: readonly IncomeItem[]): Money[] {
  const byCurrency = new Map<string, Money>();
  for (const item of items) {
    const current = byCurrency.get(item.entry.net.currency);
    byCurrency.set(
      item.entry.net.currency,
      current === undefined ? item.entry.net : add(current, item.entry.net),
    );
  }
  return [...byCurrency.entries()]
    .sort(([a], [b]) => byCode(a, b))
    .map(([, value]) => value);
}

/** The total of some counted entries, summed in the order given. */
export function incomeTotalOf(items: readonly IncomeItem[], reporting: CurrencyCode): IncomeTotal {
  const grosses: ReportingAmount[] = [];
  for (const item of items) if (item.gross !== null) grosses.push(item.gross);
  return {
    net: sumAmountsOf(
      items.map((item) => item.net),
      reporting,
    ),
    gross: {
      recorded: grosses.length === 0 ? null : sumAmountsOf(grosses, reporting),
      withoutGross: items.length - grosses.length,
    },
    native: nativeSums(items),
    count: items.length,
  };
}

/* -------------------------------------------------------------------------- */
/* Missing occurrences                                                         */
/* -------------------------------------------------------------------------- */

/** One source's missing occurrences over a year's completed months (ADR 0012 D2). */
export interface MissingIncomeFlag {
  readonly templateId: string;
  readonly templateName: string;
  readonly currency: string;
  /** Each missing occurrence's scheduled date, in date order. */
  readonly occurrences: readonly PlainDate[];
}

/**
 * The completed months of `year` on `today`, January first: none for a year
 * that has not begun, up to the last completed month for the current one.
 */
function completedMonthsOf(year: number, today: PlainDate): MonthKey[] {
  const months: MonthKey[] = [];
  for (let month = 1; month <= 12; month += 1) {
    const key = monthKeyOf(year, month);
    if (isMonthCompleted(key, today)) months.push(key);
  }
  return months;
}

/**
 * The missing occurrences of `year`, grouped one line per source (ADR 0012 D2).
 *
 * Each month's list is `missingIncomeOccurrences`'s own — the computation
 * `suggested_income_missing` uses (30.23 item 8) — over completed months only,
 * because a current-month occurrence may still arrive. The templates are taken
 * as given, archived or not: archiving is present-tense visibility and the
 * schedule decides what a past month expected (30.10 item 2), so nothing here
 * filters on it. No bucket is consulted.
 */
export function missingIncomeInYear(
  templates: readonly CompletenessTemplate[],
  resolved: ReadonlySet<string>,
  year: number,
  today: PlainDate,
): MissingIncomeFlag[] {
  const byTemplate = new Map<string, { flag: MissingIncomeFlag; dates: PlainDate[] }>();
  for (const month of completedMonthsOf(year, today)) {
    for (const missing of missingIncomeOccurrences(templates, resolved, month)) {
      const found = byTemplate.get(missing.templateId);
      if (found === undefined) {
        const dates = [missing.occurrenceDate];
        byTemplate.set(missing.templateId, {
          flag: {
            templateId: missing.templateId,
            templateName: missing.templateName,
            currency: missing.currency,
            occurrences: dates,
          },
          dates,
        });
      } else {
        found.dates.push(missing.occurrenceDate);
      }
    }
  }
  return [...byTemplate.values()]
    .map((entry) => entry.flag)
    .sort((a, b) => byName(a.templateName, a.templateId, b.templateName, b.templateId));
}

/* -------------------------------------------------------------------------- */
/* The year view                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A fixed order that needs no conversion: by name, ignoring case and accents,
 * then by id, so two sources with one name never swap places between reads.
 */
function byName(nameA: string, idA: string, nameB: string, idB: string): number {
  const order = nameA.localeCompare(nameB, 'en', { sensitivity: 'base' });
  return order !== 0 ? order : byCode(idA, idB);
}

export interface IncomeMonth {
  readonly month: MonthKey;
  /** The current month, whose figures run to today: "so far" (30.23 item 7). */
  readonly current: boolean;
  readonly total: IncomeTotal;
  /** Salary, bonus and other, each in the reporting currency (30.23 item 5). */
  readonly groups: Readonly<Record<IncomeGroup, ReportingAmount>>;
}

export interface IncomeSourceTotal {
  readonly templateId: string;
  readonly total: IncomeTotal;
}

/**
 * How the source rows were ordered (ADR 0012 D1).
 *
 * `amount` — every row's net, the one-off row's included, was complete, so the
 * rows are by reporting-currency net, largest first. `name` — some row was
 * partial, and a ranking resting on a conversion that does not exist would be a
 * guess, so the rows are by name instead.
 */
export type IncomeSourceOrder = 'amount' | 'name';

export interface IncomeOneOffKind {
  readonly kind: IncomeRecordedKind;
  readonly total: IncomeTotal;
  /** The payments, by date and then id. */
  readonly items: readonly IncomeItem[];
}

/** Entries with no recurring source — "one-off" means exactly that, whatever `is_one_off` says. */
export interface IncomeOneOff {
  readonly total: IncomeTotal;
  /** The kinds that have a payment, in `INCOME_RECORDED_KINDS` order. */
  readonly kinds: readonly IncomeOneOffKind[];
}

export interface IncomeYear {
  readonly year: number;
  /** The current year: its figures run to today, "so far". */
  readonly current: boolean;
  /** The months that have begun, January first. */
  readonly months: readonly IncomeMonth[];
  readonly total: IncomeTotal;
  /** The total split by settlement (30.23 item 1). The two add up to `total`. */
  readonly tracked: IncomeTotal;
  readonly outside: IncomeTotal;
  readonly sourceOrder: IncomeSourceOrder;
  /**
   * Every source with a payment received in the year or an occurrence scheduled
   * in it. The one-off row is not here and is never ranked among them.
   */
  readonly sources: readonly IncomeSourceTotal[];
  /** `null` when the year has no one-off payment. */
  readonly oneOff: IncomeOneOff | null;
  readonly missing: readonly MissingIncomeFlag[];
}

export interface IncomeYearTotal {
  readonly year: number;
  readonly current: boolean;
  readonly total: IncomeTotal;
}

export interface IncomeLastTwelveMonths {
  /** The first and last of the twelve months; `to` is the current month. */
  readonly from: MonthKey;
  readonly to: MonthKey;
  readonly total: IncomeTotal;
}

export interface IncomeOverview {
  readonly reportingCurrency: CurrencyCode;
  readonly year: IncomeYear;
  /** Every year with a counted payment, newest first. */
  readonly years: readonly IncomeYearTotal[];
  /** Always the twelve months ending with the current one, whichever year is shown (30.23 item 7). */
  readonly lastTwelveMonths: IncomeLastTwelveMonths;
}

export interface IncomeOverviewInput {
  /** The calendar year in view, in the user's timezone. */
  readonly year: number;
  /** Injected; no engine reads a clock (7.7). */
  readonly today: PlainDate;
  readonly reportingCurrency: CurrencyCode;
  readonly fx: FxTable;
  /** Every income entry, of any kind, received on or before today. */
  readonly entries: readonly RecordedIncomeEntry[];
  /** Every recurring template, archived or not; only income ones are scheduled here. */
  readonly templates: readonly CompletenessTemplate[];
  /** `${templateId}#${occurrenceDate}` for every occurrence recorded or skipped in the year. */
  readonly resolvedOccurrences: ReadonlySet<string>;
}

const yearOf = (date: PlainDate): number => Number.parseInt(date.slice(0, 4), 10);

function groupsOf(items: readonly IncomeItem[], reporting: CurrencyCode): Record<IncomeGroup, ReportingAmount> {
  const sum = (group: IncomeGroup): ReportingAmount =>
    sumAmountsOf(
      items.filter((item) => item.group === group).map((item) => item.net),
      reporting,
    );
  return { salary: sum('salary'), bonus: sum('bonus'), other: sum('other') };
}

function byDateThenId(a: IncomeItem, b: IncomeItem): number {
  if (a.entry.receivedOn !== b.entry.receivedOn) return a.entry.receivedOn < b.entry.receivedOn ? -1 : 1;
  return byCode(a.entry.id, b.entry.id);
}

/** Whether a template's schedule places an occurrence in the year. */
function scheduledIn(template: CompletenessTemplate, year: number): boolean {
  return (
    occurrencesInRange(
      template.schedule,
      startOfMonthKey(monthKeyOf(year, 1)),
      endOfMonthKey(monthKeyOf(year, 12)),
    ).length > 0
  );
}

function yearView(
  input: IncomeOverviewInput,
  all: readonly IncomeItem[],
  current: MonthKey,
): IncomeYear {
  const { year, reportingCurrency: reporting } = input;
  const items = all.filter((item) => yearOf(item.entry.receivedOn) === year);
  const total = (list: readonly IncomeItem[]): IncomeTotal => incomeTotalOf(list, reporting);

  const months: IncomeMonth[] = [];
  for (let index = 1; index <= 12; index += 1) {
    const month = monthKeyOf(year, index);
    if (month > current) break;
    const inMonth = items.filter((item) => monthKey(item.entry.receivedOn) === month);
    months.push({
      month,
      current: month === current,
      total: total(inMonth),
      groups: groupsOf(inMonth, reporting),
    });
  }

  // Every source with a payment in the year or an occurrence scheduled in it.
  const names = new Map(input.templates.map((template) => [template.templateId, template.name]));
  const shown = new Set<string>();
  for (const template of input.templates) {
    if (template.kind === 'income' && scheduledIn(template, year)) shown.add(template.templateId);
  }
  for (const item of items) if (item.entry.templateId !== null) shown.add(item.entry.templateId);

  const nameOf = (templateId: string): string => names.get(templateId) ?? templateId;
  const sources: IncomeSourceTotal[] = [...shown].map((templateId) => ({
    templateId,
    total: total(items.filter((item) => item.entry.templateId === templateId)),
  }));

  const oneOffItems = items.filter((item) => item.entry.templateId === null);
  const oneOff: IncomeOneOff | null =
    oneOffItems.length === 0
      ? null
      : {
          total: total(oneOffItems),
          kinds: INCOME_RECORDED_KINDS.flatMap((kind) => {
            const list = oneOffItems.filter((item) => item.kind === kind).sort(byDateThenId);
            return list.length === 0 ? [] : [{ kind, total: total(list), items: list }];
          }),
        };

  const complete =
    sources.every((row) => row.total.net.availability === 'available') &&
    (oneOff === null || oneOff.total.net.availability === 'available');
  const named = (a: IncomeSourceTotal, b: IncomeSourceTotal): number =>
    byName(nameOf(a.templateId), a.templateId, nameOf(b.templateId), b.templateId);
  sources.sort(
    complete
      ? (a, b) => {
          const order = b.total.net.value.amount.comparedTo(a.total.net.value.amount);
          return order !== 0 ? order : named(a, b);
        }
      : named,
  );

  return {
    year,
    current: yearOf(input.today) === year,
    months,
    total: total(items),
    tracked: total(items.filter((item) => item.side === 'tracked')),
    outside: total(items.filter((item) => item.side === 'outside')),
    sourceOrder: complete ? 'amount' : 'name',
    sources,
    oneOff,
    missing: missingIncomeInYear(input.templates, input.resolvedOccurrences, year, input.today),
  };
}

/**
 * The Income year view's figures (ADR 0012 D1–D3): one year's months, total,
 * sources, one-off payments and missing occurrences, every year's total, and
 * the last twelve months — all from one conversion of each counted entry.
 */
export function incomeOverview(input: IncomeOverviewInput): IncomeOverview {
  const reporting = input.reportingCurrency;
  const current = monthKey(input.today);
  // The pages run to today (30.23 items 3, 7). An actual entry is never dated
  // later (M5), and one that were would sit in a year total and in no month.
  const all = incomeItemsOf(
    input.entries.filter((entry) => entry.receivedOn <= input.today),
    reporting,
    input.fx,
  );

  const byYear = new Map<number, IncomeItem[]>();
  for (const item of all) {
    const year = yearOf(item.entry.receivedOn);
    const list = byYear.get(year);
    if (list === undefined) byYear.set(year, [item]);
    else list.push(item);
  }
  const thisYear = yearOf(input.today);
  const years: IncomeYearTotal[] = [...byYear.entries()]
    .sort(([a], [b]) => b - a)
    .map(([year, list]) => ({ year, current: year === thisYear, total: incomeTotalOf(list, reporting) }));

  const from = monthKey(addMonths(startOfMonthKey(current), -11));
  const window = all.filter(
    (item) => item.entry.receivedOn >= startOfMonthKey(from) && item.entry.receivedOn <= input.today,
  );

  return {
    reportingCurrency: reporting,
    year: yearView(input, all, current),
    years,
    lastTwelveMonths: { from, to: current, total: incomeTotalOf(window, reporting) },
  };
}
