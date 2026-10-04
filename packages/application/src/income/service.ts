import {
  listIncomeEntriesThrough,
  listPositions,
  listResolvedOccurrencesInRange,
  listTemplates,
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
import { currencyCatalogue } from '../currencies/service';
import { ValidationError } from '../errors';
import { moneyDto } from '../positions/mapping';
import { toCompletenessTemplate } from '../reconciliation/loader';
import {
  loadReportingRates,
  reportingAmountDto,
  type ReportingDependencies,
} from '../reconciliation/reporting-service';
import { readSettings } from '../settings/service';
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
 * entries, then one pure computation (`incomeOverview`). The reads, side by
 * side, none of them per year, source, month or entry:
 *
 *  - every income entry received on or before today, with no lower bound: the
 *    totals for every year with income span the whole history;
 *  - every recurring template, archived or not: a source's name and archived
 *    label, and the schedule the missing flags are judged against (30.10
 *    item 2);
 *  - the occurrences recorded or skipped in the year in view, by their
 *    scheduled date — the resolved set `suggested_income_missing` uses;
 *  - the settings, the currency catalogue and the cash accounts the two forms
 *    offer.
 *
 * Then one rate read for every currency an entry holds, stored rates only, over
 * the entries' own dates. Nothing here is reconciliation-scoped (30.23 item 3),
 * so no balance and no valuation is read, and no reconciliation runs.
 */

export type IncomeDependencies = ReportingDependencies;

export interface IncomeQuery {
  /** `YYYY`, from the address. Absent means the current year. */
  readonly year?: string | undefined;
}

const YEAR_PATTERN = /^\d{4}$/u;

const yearOf = (date: string): number => Number.parseInt(date.slice(0, 4), 10);
const label = (month: MonthKey): string => (month as string).slice(0, 7);

/** The year in view, or a validation error for one that is not a year or has not begun. */
export function parseIncomeYear(query: IncomeQuery, currentYear: number): number {
  if (query.year === undefined) return currentYear;
  if (!YEAR_PATTERN.test(query.year)) {
    throw new ValidationError('That is not a year.', { year: ['Expected YYYY.'] });
  }
  const year = Number.parseInt(query.year, 10);
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

  const [rows, templates, resolved, settings, catalogue, cash] = await Promise.all([
    listIncomeEntriesThrough(deps.db, ctx.userId, today),
    // Archived included: archiving is present-tense visibility, and a past
    // month's expectation and a source's own name both outlive it (30.10).
    listTemplates(deps.db, ctx.userId, { includeArchived: true }),
    listResolvedOccurrencesInRange(deps.db, ctx.userId, yearFrom, yearTo),
    readSettings(deps.db, ctx.userId),
    currencyCatalogue(deps.db),
    listPositions(deps.db, ctx.userId, { kinds: ['cash'] }),
  ]);

  const reporting = currencyCode(settings.reportingCurrency);
  const entries = rows.map(recordedEntryOf);

  // One rate table for every currency a counted entry holds, from the earliest
  // one's date — the rows arrive in date order (10.2, 10.3).
  const counted = entries.filter((entry) => isIncomeRecorded(entry));
  const currencies = new Set<string>(counted.map((entry) => entry.net.currency));
  const earliest = counted[0]?.receivedOn ?? today;
  const fx = await loadReportingRates(deps, currencies, reporting, earliest, today, today);

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
      previous: year > 0 ? year - 1 : null,
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
