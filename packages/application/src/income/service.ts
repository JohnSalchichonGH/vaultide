import {
  listIncomeEntriesThroughIn,
  listPositionsIn,
  listResolvedOccurrencesInRangeIn,
  listTemplatesIn,
  type IncomeEntryRow,
} from '@vaultide/db';
import {
  INCOME_RECORDED_KINDS,
  currencyCode,
  endOfMonthKey,
  incomeOverview,
  isIncomeRecorded,
  money,
  monthKeyOf,
  occurrenceKey,
  plainDate,
  startOfMonthKey,
  type IncomeItem,
  type IncomeTotal,
  type Money,
  type MonthKey,
  type RecordedIncomeEntry,
} from '@vaultide/finance';
import type { RequestContext } from '../context';
import { withUserRead } from '../coordination';
import { currencyCatalogue } from '../currencies/service';
import { ValidationError } from '../errors';
import { moneyDto } from '../positions/mapping';
import { toCompletenessTemplate } from '../reconciliation/loader';
import {
  loadReportingRates,
  reportingAmountDto,
  type ReportingDependencies,
} from '../reconciliation/reporting-service';
import { readSettingsIn } from '../settings/service';
import type {
  IncomeOneOffPaymentDto,
  IncomePageDto,
  IncomeTotalDto,
} from './types';

/**
 * The Income year view's read (blueprint 15.2 "Income", v2.1.20 30.23; ADR
 * 0012 D1–D3, D5, D7).
 *
 * One call, a fixed number of set-wise reads whatever the years, sources and
 * entries, then one pure computation (`incomeOverview`). None of the reads is
 * per year, source, month or entry. The user's own rows are read in **one
 * snapshot** (`withUserRead`: repeatable read, read only, no mutex), as Bulk
 * History's grid read is, so the entries and the occurrences they resolve come
 * from the same state of the world — a payment recorded between two separate
 * reads could otherwise be counted while its occurrence is still flagged
 * missing:
 *
 *  - every income entry received on or before today, with no lower bound: the
 *    totals for every year with income span the whole history;
 *  - every recurring template, archived or not: a source's name and archived
 *    label, and the schedule the missing flags are judged against (30.10
 *    item 2);
 *  - the occurrences recorded or skipped in the year in view, by their
 *    scheduled date — the resolved set `suggested_income_missing` uses;
 *  - the settings, and the cash accounts the two forms offer.
 *
 * The currency catalogue, which is global, is read beside it. Then one rate
 * read for every currency an entry holds, stored rates only, over the entries'
 * own dates. Nothing here is reconciliation-scoped (30.23 item 3), so no
 * balance and no valuation is read, and no reconciliation runs.
 */

export type IncomeDependencies = ReportingDependencies;

export interface IncomeQuery {
  /** `YYYY`, from the address. Absent means the current year. */
  readonly year?: string | undefined;
}

const YEAR_PATTERN = /^\d{4}$/u;

/**
 * The first year the page answers for: the year of the date inputs' floor
 * (`EARLIEST_CORRECTABLE_DATE`, 1 January 1900, in the web app). Earlier
 * four-digit years are refused rather than computed — `Date.UTC`, which the
 * calendar helpers use, reads years 0–99 as 1900–1999.
 */
export const EARLIEST_INCOME_YEAR = 1900;

const yearOf = (date: string): number => Number.parseInt(date.slice(0, 4), 10);
const label = (month: MonthKey): string => (month as string).slice(0, 7);

/**
 * The year in view, or a validation error for one that is not a year, comes
 * before 1900, or has not begun.
 */
export function parseIncomeYear(query: IncomeQuery, currentYear: number): number {
  if (query.year === undefined) return currentYear;
  if (!YEAR_PATTERN.test(query.year)) {
    throw new ValidationError('That is not a year.', { year: ['Expected YYYY.'] });
  }
  const year = Number.parseInt(query.year, 10);
  if (year < EARLIEST_INCOME_YEAR) {
    throw new ValidationError('That year is too early.', {
      year: [`Income covers the years from ${String(EARLIEST_INCOME_YEAR)}.`],
    });
  }
  if (year > currentYear) {
    // A year that has not begun has no income of any kind; answering with an
    // empty one would be a synthetic result.
    throw new ValidationError('That year has not started yet.', {
      year: ['Income covers the years up to the current one.'],
    });
  }
  return year;
}

function recordedEntryOf(row: IncomeEntryRow): RecordedIncomeEntry {
  const currency = currencyCode(row.currency);
  return {
    id: row.id,
    kind: row.kind,
    settlement: row.settlement,
    receivedOn: plainDate(row.receivedOn),
    // NUMERIC arrives as an exact decimal string; no digit is lost (7.1).
    net: money(row.netAmount, currency),
    gross: row.grossAmount === null ? null : money(row.grossAmount, currency),
    templateId: row.templateId,
  };
}

const nativeDto = (value: Money) => moneyDto(value.amount.toString(), value.currency);

function totalDto(total: IncomeTotal): IncomeTotalDto {
  return {
    net: reportingAmountDto(total.net),
    gross: {
      recorded: total.gross.recorded === null ? null : reportingAmountDto(total.gross.recorded),
      withoutGross: total.gross.withoutGross,
    },
    native: total.native.map(nativeDto),
    count: total.count,
  };
}

export async function getIncomePage(
  deps: IncomeDependencies,
  ctx: RequestContext,
  query: IncomeQuery = {},
): Promise<IncomePageDto> {
  const today = plainDate(ctx.today);
  const currentYear = yearOf(today);
  const year = parseIncomeYear(query, currentYear);
  const yearFrom = startOfMonthKey(monthKeyOf(year, 1));
  const yearTo = endOfMonthKey(monthKeyOf(year, 12));

  const [snapshot, catalogue] = await Promise.all([
    withUserRead(deps.db, { userId: ctx.userId }, async (tx) => {
      const rows = await listIncomeEntriesThroughIn(tx, today);
      // Archived included: archiving is present-tense visibility, and a past
      // month's expectation and a source's own name both outlive it (30.10).
      const templates = await listTemplatesIn(tx, { includeArchived: true });
      const resolved = await listResolvedOccurrencesInRangeIn(tx, yearFrom, yearTo);
      const settings = await readSettingsIn(tx);
      const cash = await listPositionsIn(tx, { kinds: ['cash'] });
      return { rows, templates, resolved, settings, cash };
    }),
    currencyCatalogue(deps.db),
  ]);
  const { rows, templates, resolved, settings, cash } = snapshot;

  const reporting = currencyCode(settings.reportingCurrency);
  const entries = rows.map(recordedEntryOf);

  // One rate table for every currency a counted entry holds, from the earliest
  // one's date — the rows arrive in date order (10.2, 10.3).
  const counted = entries.filter((entry) => isIncomeRecorded(entry));
  const currencies = new Set<string>(counted.map((entry) => entry.net.currency));
  const earliest = counted[0]?.receivedOn ?? today;
  const fx = await loadReportingRates(deps, currencies, reporting, earliest, today, today);

  // The earliest year worth stepping back to: the first counted payment's, or
  // the first income source's start, and never before 1900.
  const starts = [
    ...(counted[0] === undefined ? [] : [yearOf(counted[0].receivedOn)]),
    ...templates.filter((row) => row.kind === 'income').map((row) => yearOf(row.startDate)),
  ];
  const firstYear =
    starts.length === 0 ? currentYear : Math.max(EARLIEST_INCOME_YEAR, Math.min(...starts));

  const overview = incomeOverview({
    year,
    today,
    reportingCurrency: reporting,
    fx,
    entries,
    templates: templates.map(toCompletenessTemplate),
    resolvedOccurrences: new Set(
      resolved.map((row) => occurrenceKey(row.templateId, row.occurrenceDate)),
    ),
  });

  const templatesById = new Map(templates.map((row) => [row.id, row]));
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const view = overview.year;

  const paymentOf = (item: IncomeItem): IncomeOneOffPaymentDto => ({
    entryId: item.entry.id,
    kind: item.kind,
    receivedOn: item.entry.receivedOn,
    settlement: item.side === 'tracked' ? 'tracked_cash' : 'external',
    description: rowsById.get(item.entry.id)?.description ?? null,
    net: nativeDto(item.entry.net),
    gross: item.entry.gross === null ? null : nativeDto(item.entry.gross),
    reporting: reportingAmountDto(item.net),
    reportingGross: item.gross === null ? null : reportingAmountDto(item.gross),
  });

  return {
    year,
    currentYear,
    today: ctx.today,
    reportingCurrency: reporting,
    minorUnitsByCurrency: catalogue.minorUnitsByCurrency,
    selectableCurrencyCodes: catalogue.selectableCurrencyCodes,
    empty: overview.years.length === 0 && !templates.some((row) => row.kind === 'income'),
    navigation: {
      previous: year > firstYear ? year - 1 : null,
      next: year < currentYear ? year + 1 : null,
    },
    view: {
      year: view.year,
      current: view.current,
      months: view.months.map((month) => ({
        month: label(month.month),
        current: month.current,
        total: totalDto(month.total),
        salary: reportingAmountDto(month.groups.salary),
        bonus: reportingAmountDto(month.groups.bonus),
        other: reportingAmountDto(month.groups.other),
      })),
      total: totalDto(view.total),
      tracked: totalDto(view.tracked),
      outside: totalDto(view.outside),
      sourceOrder: view.sourceOrder,
      sources: view.sources.map((row) => {
        const template = templatesById.get(row.templateId);
        return {
          templateId: row.templateId,
          name: template?.name ?? 'Unknown source',
          archived: template !== undefined && template.archivedAt !== null,
          currency: template?.currency ?? reporting,
          total: totalDto(row.total),
        };
      }),
      oneOff:
        view.oneOff === null
          ? null
          : {
              total: totalDto(view.oneOff.total),
              kinds: view.oneOff.kinds.map((group) => ({
                kind: group.kind,
                total: totalDto(group.total),
                payments: group.items.map(paymentOf),
              })),
            },
      missing: view.missing.map((flag) => ({
        templateId: flag.templateId,
        name: flag.templateName,
        archived: (templatesById.get(flag.templateId)?.archivedAt ?? null) !== null,
        occurrences: [...flag.occurrences],
      })),
    },
    years: overview.years.map((row) => ({
      year: row.year,
      current: row.current,
      total: totalDto(row.total),
    })),
    lastTwelveMonths: {
      from: label(overview.lastTwelveMonths.from),
      to: label(overview.lastTwelveMonths.to),
      total: totalDto(overview.lastTwelveMonths.total),
    },
    forms: {
      paymentKinds: [...INCOME_RECORDED_KINDS],
      cashAccounts: cash.map((row) => ({
        positionId: row.id,
        name: row.name,
        currency: row.currency,
      })),
    },
  };
}
