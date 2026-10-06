import {
  findMonthReview,
  listLatestValuationsIn,
  listTransferFeesByTransferDate,
  type PositionRecord as PositionRow,
} from '@vaultide/db';
import {
  addMonths,
  endOfMonthKey,
  monthKey,
  plainDate,
  startOfMonthKey,
  type MonthKey,
} from '@vaultide/finance';
import type { RequestContext } from '../context';
import { withUserRead } from '../coordination';
import { ValidationError } from '../errors';
import { currencyCatalogue } from '../currencies/service';
import { closedAccountFinalOf, type ClosedAccountFinal } from '../positions/cash-month';
import { readSettings } from '../settings/service';
import { monthCompletenessFrom } from '../reconciliation/completeness-service';
import type { LoadedCompletedMonth } from '../reconciliation/loader';
import { loadMonthToDate } from '../reconciliation/mtd-loader';
import { monthToDateFrom } from '../reconciliation/mtd-service';
import { loadCompletedRange } from '../reconciliation/range-loader';
import { completedReportingFrom, monthToDateReportingFrom } from '../reconciliation/reporting-service';
import {
  monthReconciliationFrom,
  reconciliationRangeStart,
  type ReconciliationDependencies,
} from '../reconciliation/service';
import { completedAccountsOf, currentAccountsOf } from './accounts';
import { currentMonthlyExpensesOf, monthlyExpensesOf } from './expenses';
import { loadCompletedMonthExpenses, loadCurrentMonthExpenses } from './expenses-loader';
import { currentMonthlyIncomeOf, monthlyIncomeOf } from './income';
import { loadCompletedMonthIncome, loadCurrentMonthIncome } from './income-loader';
import { reviewDtoOf } from './review-service';
import { monthlyTransfersOf } from './transfers';
import type {
  CompletedMonthlyPageDto,
  CurrentMonthlyPageDto,
  MonthlyNavigationDto,
  MonthlyPageDto,
} from './types';

/**
 * The Monthly page's read (blueprint 15.2, 15.3, 23.2).
 *
 * One call per page, one load of the month. The completed variant reads the
 * `M−6 … M` range the reconciliation read already uses and hands the same rows
 * to reconciliation, reporting and completeness through their own `…From`
 * helpers — each the exact code path behind its standalone read, so the page
 * shows precisely what those reads would, the `large_unclassified` baseline and
 * the `possible_missing_conversion` signature included. The current variant
 * reads the month-to-date window once and does the same with its two reads.
 * The Accounts section is built from the same loaded rows — the positions and
 * valuations the reconciliation read. Its one read of its own is for closed
 * accounts only: whether "Unchanged this month" would keep each one's final
 * balance zero (M6) turns on its latest balance on or before its closing day,
 * which may lie after the month the loaded window stops at.
 *
 * Nothing is computed here. The review state comes back beside the results and
 * is applied by the page's presentation, never by any result: a dismissed key
 * is still in every issue list this returns.
 *
 * The Income section adds exactly one read, and only what no other read can
 * answer: the rows behind the occurrences **scheduled** in the month. Its
 * financial half — the entries received in the month — is the same income the
 * loaders already read, handed on rather than fetched again (15.3 section 2).
 *
 * The Known-expenses section does the same for expenses, with a read of its own
 * rather than a share of Income's: the expense rows and categories the loaders
 * already hold are its financial half, and one scope answers its schedule side
 * (15.3 section 3). The two sections' reads are independent, so they run side by
 * side.
 *
 * Accounts' transfer maintenance adds one read as well, for the one thing no
 * other read holds: every row linked to the month's transfers, whatever its own
 * date (ADR 0006 §7). The transfers are the rows the loaders already read,
 * handed on; their fees cannot be, because a September transfer's fee may be
 * dated in October and the loaders read expenses by their own date.
 *
 * The bound is a constant number of user-scoped repository transactions — the
 * loader's, one for the Income rows, one for the Known-expenses rows, one for
 * the transfers' linked fees, one for settings, one for the currency catalogue,
 * one for the review, one for the closed accounts' final balances when any
 * closed account takes part in a completed month, and the exchange-rate reads
 * the reporting and diagnostic rules already make — whatever the size of the
 * month.
 */

export type MonthlyDependencies = ReconciliationDependencies;

const label = (month: MonthKey): string => (month as string).slice(0, 7);

function navigationOf(month: MonthKey, current: MonthKey): MonthlyNavigationDto {
  return {
    previous: label(monthKey(addMonths(startOfMonthKey(month), -1))),
    next: month === current ? null : label(monthKey(addMonths(startOfMonthKey(month), 1))),
    current: label(current),
  };
}

export async function getMonthlyPage(
  deps: MonthlyDependencies,
  ctx: RequestContext,
  month: MonthKey,
): Promise<MonthlyPageDto> {
  const current = monthKey(ctx.today);
  if (month > current) {
    // A month that has not begun has no evidence of any kind; answering with an
    // empty result would be a synthetic one.
    throw new ValidationError('That month has not started yet.', {
      month: ['Monthly covers completed months and the current month.'],
    });
  }

  const base = {
    month: label(month),
    monthEndsOn: endOfMonthKey(month) as string,
    today: ctx.today as string,
    navigation: navigationOf(month, current),
  };

  return month === current
    ? currentMonthlyPage(deps, ctx, base)
    : completedMonthlyPage(deps, ctx, month, base);
}

type PageBase = Pick<CompletedMonthlyPageDto, 'month' | 'monthEndsOn' | 'today' | 'navigation'>;

/**
 * What the final-zero rule reads for a completed month's closed cash accounts
 * (M6): each one's latest balance on or before its closing day. The range's
 * window stops at the month's end, short of a later closing day, so this is a
 * read of its own — one statement for all of them, and none when no closed
 * account takes part in the month.
 */
async function closedAccountFinalsOf(
  deps: MonthlyDependencies,
  userId: string,
  month: MonthKey,
  positions: readonly PositionRow[],
): Promise<ClosedAccountFinal[]> {
  const start = startOfMonthKey(month) as string;
  const closed = positions.flatMap((row) =>
    row.kind === 'cash' && row.status === 'closed' && row.closedOn !== null && row.closedOn >= start
      ? [{ row, closedOn: row.closedOn }]
      : [],
  );
  if (closed.length === 0) return [];

  const latest = await withUserRead(deps.db, { userId }, (tx) =>
    listLatestValuationsIn(
      tx,
      closed.map(({ row, closedOn }) => ({ positionId: row.id, onOrBefore: closedOn })),
    ),
  );
  return closed.flatMap(({ row }) => {
    const final = closedAccountFinalOf(row, latest);
    return final === null ? [] : [final];
  });
}

async function completedMonthlyPage(
  deps: MonthlyDependencies,
  ctx: RequestContext,
  month: MonthKey,
  base: PageBase,
): Promise<CompletedMonthlyPageDto> {
  const [range, settings, review, currencies] = await Promise.all([
    loadCompletedRange(deps, ctx.userId, reconciliationRangeStart(month), month, ctx.today),
    readSettings(deps.db, ctx.userId),
    findMonthReview(deps.db, ctx.userId, month),
    // One catalogue read answers both questions the page has of it: how to
    // format every amount, and which currencies a picker may offer.
    currencyCatalogue(deps.db),
  ]);

  const input = range.inputs.get(month);
  /* v8 ignore next -- the range ends at `month`, so its input is always there. */
  if (input === undefined) throw new Error(`no input for ${month}`);

  // The month as the single-month loader would have shaped it, from the same
  // rows: the range slices flows on the month's bounds, and completeness reads
  // the whole window's positions, valued to the month's end.
  const data: LoadedCompletedMonth = {
    input,
    positions: range.positions,
    categories: range.categories,
    templates: range.templates,
    terms: range.terms,
    positionsWithValuations: range.positionsWithValuations,
  };

  // The month's own income entries, by financial date, sliced from the range
  // the loader already read — the same rows, never a second query.
  const receivedInMonth = range.income.filter(
    (row) => row.receivedOn >= (startOfMonthKey(month) as string) && row.receivedOn <= base.monthEndsOn,
  );

  // The month's own expense entries, by financial date, from the same range —
  // capital improvements included, which the section's mapping leaves unlisted
  // while every figure above keeps them.
  const incurredInMonth = range.expenses.filter(
    (row) => row.incurredOn >= (startOfMonthKey(month) as string) && row.incurredOn <= base.monthEndsOn,
  );

  const [reconciliation, reporting, incomeRows, expenseRows, transferFees, closedFinals] = await Promise.all([
    monthReconciliationFrom(deps, range, month, ctx.today),
    completedReportingFrom(deps, data, settings, ctx.today),
    loadCompletedMonthIncome(
      deps,
      ctx.userId,
      month,
      receivedInMonth.flatMap((row) => (row.templateId === null ? [] : [row.templateId])),
    ),
    loadCompletedMonthExpenses(
      deps,
      ctx.userId,
      month,
      incurredInMonth.flatMap((row) => (row.templateId === null ? [] : [row.templateId])),
    ),
    listTransferFeesByTransferDate(deps.db, ctx.userId, startOfMonthKey(month), base.monthEndsOn),
    closedAccountFinalsOf(deps, ctx.userId, month, range.positions),
  ]);

  return {
    kind: 'completed',
    ...base,
    minorUnitsByCurrency: currencies.minorUnitsByCurrency,
    selectableCurrencyCodes: currencies.selectableCurrencyCodes,
    review: reviewDtoOf(review),
    reconciliation,
    reporting,
    completeness: monthCompletenessFrom(data),
    accounts: completedAccountsOf(month, range.positionsWithValuations, range.valuations, closedFinals),
    transfers: monthlyTransfersOf({
      from: startOfMonthKey(month),
      to: base.monthEndsOn,
      // The range's own rows, kept to the month by their financial date.
      transfers: range.transfers,
      linkedRows: transferFees,
      categories: range.categories,
      positions: range.positions,
    }),
    income: monthlyIncomeOf({
      month,
      today: plainDate(ctx.today),
      receivedInMonth,
      // Archived included: `archived_at` is present-tense visibility and never a
      // schedule boundary, so a source archived today still expected an
      // occurrence last September (§30.10, 12.6).
      scheduleTemplates: range.templates,
      terms: range.terms,
      positions: range.positions,
      rows: incomeRows,
      shape: 'completed',
    }),
    expenses: monthlyExpensesOf({
      month,
      today: plainDate(ctx.today),
      incurredInMonth,
      // The same schedule window as Income, archived sources included (§30.10).
      scheduleTemplates: range.templates,
      terms: range.terms,
      categories: range.categories,
      positions: range.positions,
      rows: expenseRows,
      shape: 'completed',
    }),
  };
}

async function currentMonthlyPage(
  deps: MonthlyDependencies,
  ctx: RequestContext,
  base: PageBase,
): Promise<CurrentMonthlyPageDto> {
  const month = monthKey(ctx.today);
  const [data, settings, review, currencies] = await Promise.all([
    loadMonthToDate(deps, ctx.userId, ctx.today),
    readSettings(deps.db, ctx.userId),
    findMonthReview(deps.db, ctx.userId, month),
    currencyCatalogue(deps.db),
  ]);

  // Everything the month-to-date read holds is already dated on or before
  // today, and no actual record may be dated later (M5), so these are all of
  // the month's income entries there can be.
  const receivedInMonth = data.income;
  // The same holds for expenses, and the rows run through today rather than
  // through the month-to-date date: `D` bounds what a reconciliation figure
  // covers, never which records exist.
  const incurredInMonth = data.expenses;
  const [incomeRows, expenseRows, transferFees] = await Promise.all([
    loadCurrentMonthIncome(
      deps,
      ctx.userId,
      month,
      plainDate(ctx.today),
      receivedInMonth.flatMap((row) => (row.templateId === null ? [] : [row.templateId])),
    ),
    loadCurrentMonthExpenses(
      deps,
      ctx.userId,
      month,
      plainDate(ctx.today),
      incurredInMonth.flatMap((row) => (row.templateId === null ? [] : [row.templateId])),
    ),
    // The same window the month-to-date loader read transfers over.
    listTransferFeesByTransferDate(deps.db, ctx.userId, startOfMonthKey(month), ctx.today),
  ]);

  return {
    kind: 'current',
    ...base,
    minorUnitsByCurrency: currencies.minorUnitsByCurrency,
    selectableCurrencyCodes: currencies.selectableCurrencyCodes,
    review: reviewDtoOf(review),
    monthToDate: monthToDateFrom(data),
    reporting: await monthToDateReportingFrom(deps, data, settings, ctx.today),
    accounts: currentAccountsOf(ctx.today, data.input.cashAccounts, data.valuations),
    transfers: monthlyTransfersOf({
      from: startOfMonthKey(month),
      to: ctx.today,
      transfers: data.transfers,
      linkedRows: transferFees,
      categories: data.categories,
      positions: data.positions,
    }),
    income: currentMonthlyIncomeOf({
      month,
      today: plainDate(ctx.today),
      receivedInMonth,
      // The operational feed's set: an archived source offers no new suggestion,
      // and the resolved occurrences it already has stay visible (§30.10).
      scheduleTemplates: incomeRows.activeTemplates,
      terms: incomeRows.operationalTerms,
      positions: data.positions,
      rows: incomeRows,
      shape: 'current',
    }),
    expenses: currentMonthlyExpensesOf({
      month,
      today: plainDate(ctx.today),
      incurredInMonth,
      scheduleTemplates: expenseRows.activeTemplates,
      terms: expenseRows.operationalTerms,
      categories: data.categories,
      positions: data.positions,
      rows: expenseRows,
      shape: 'current',
    }),
  };
}
