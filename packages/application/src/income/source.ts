import {
  findPositionIn,
  findTemplateIn,
  listIncomeEntriesOfTemplateIn,
  listSkipsOfTemplateIn,
  listTermsIn,
  type Database,
  type IncomeEntryRow,
} from '@vaultide/db';
import {
  addDays,
  currencyCode,
  incomeSourceYear,
  money,
  occurrencesInRange,
  plainDate,
  startOfMonth,
  type Money,
  type MoneyDto,
  type SourcePayment,
} from '@vaultide/finance';
import type { RequestContext } from '../context';
import { withUserRead } from '../coordination';
import { currencyCatalogue } from '../currencies/service';
import { NotFoundError, ValidationError } from '../errors';
import { termDtoOf } from '../monthly/income';
import { moneyDto } from '../positions/mapping';
import { toCompletenessTemplate } from '../reconciliation/loader';
import { EARLIEST_INCOME_YEAR, parseIncomeYear, type IncomeQuery } from './service';
import type {
  IncomeSourceOccurrenceStateDto,
  IncomeSourcePageDto,
  IncomeSourcePaymentDto,
} from './source-types';

/**
 * One income source's page (blueprint 15.2 "Income source", v2.1.20 30.23;
 * ADR 0012 D2, D4, D7).
 *
 * One call. The user's rows are read in **one snapshot** (`withUserRead`:
 * repeatable read, read only, no mutex), as the year view's are, so a payment
 * recorded between two reads can never sit beside its occurrence still marked
 * missing. Each read is one statement over the source's whole life, so the
 * count is fixed however long that life is:
 *
 *  - the template — another user's is invisible under RLS, so it reads as
 *    absent, and so does one that is not an income source;
 *  - its terms, its income entries and its skips: the resolved set its missing
 *    occurrences are judged against, and what arrived beside what it was set to;
 *  - the name of the account it pays into, when it names one.
 *
 * The currency catalogue, which is global, is read beside it for minor units.
 * Everything is in the source's own currency, so no rate is read and nothing
 * converts. No reconciliation runs.
 */

export interface IncomeSourceDependencies {
  readonly db: Database;
}

export interface IncomeSourceQuery extends IncomeQuery {
  /** From the address: not trusted to be an id at all. */
  readonly templateId: string;
}

/** A canonical UUID; anything else names no row, and the database would refuse it rather than find nothing. */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const yearOf = (date: string): number => Number.parseInt(date.slice(0, 4), 10);

const notFound = (): NotFoundError => new NotFoundError('That income source does not exist.');

const nativeDto = (value: Money): MoneyDto => moneyDto(value.amount.toString(), value.currency);

function paymentDtoOf(payment: SourcePayment): IncomeSourcePaymentDto {
  return {
    entryId: payment.id,
    occurrenceDate: payment.occurrenceDate,
    receivedOn: payment.receivedOn,
    net: nativeDto(payment.net),
    gross: payment.gross === null ? null : nativeDto(payment.gross),
  };
}

function paymentOf(row: IncomeEntryRow, occurrenceDate: string): SourcePayment {
  const currency = currencyCode(row.currency);
  return {
    id: row.id,
    occurrenceDate: plainDate(occurrenceDate),
    receivedOn: plainDate(row.receivedOn),
    // NUMERIC arrives as an exact decimal string; no digit is lost (7.1).
    net: money(row.netAmount, currency),
    gross: row.grossAmount === null ? null : money(row.grossAmount, currency),
  };
}

/**
 * The page's read: the source, its amounts, what arrived, and the year's
 * occurrences.
 *
 * A malformed, missing or other user's id, and a template that is not an
 * income source, are `NotFoundError` — existence is never leaked (17.2). A year
 * `parseIncomeYear` refuses, or one before the source's start year, is a
 * `ValidationError`.
 */
export async function getIncomeSourcePage(
  deps: IncomeSourceDependencies,
  ctx: RequestContext,
  query: IncomeSourceQuery,
): Promise<IncomeSourcePageDto> {
  if (!ID_PATTERN.test(query.templateId)) throw notFound();
  const today = plainDate(ctx.today);
  const currentYear = yearOf(today);
  const year = parseIncomeYear(query, currentYear);

  const [snapshot, catalogue] = await Promise.all([
    withUserRead(deps.db, { userId: ctx.userId }, async (tx) => {
      const template = await findTemplateIn(tx, query.templateId);
      if (template === undefined || template.kind !== 'income') return undefined;
      const terms = await listTermsIn(tx, template.id);
      const entries = await listIncomeEntriesOfTemplateIn(tx, template.id);
      const skips = await listSkipsOfTemplateIn(tx, template.id);
      const account =
        template.cashPositionId === null ? null : await findPositionIn(tx, template.cashPositionId);
      return { template, terms, entries, skips, account };
    }),
    currencyCatalogue(deps.db),
  ]);
  if (snapshot === undefined) throw notFound();
  const { template, terms, entries, skips, account } = snapshot;

  // The years the page answers for run from the source's start to the current
  // one — just the current one for a source that starts later — and never
  // before 1900, which `parseIncomeYear` already refuses.
  const firstYear = Math.max(EARLIEST_INCOME_YEAR, Math.min(yearOf(template.startDate), currentYear));
  if (year < firstYear) {
    throw new ValidationError('That year is before this source started.', {
      year: [`This source covers the years from ${String(firstYear)}.`],
    });
  }

  const { currency } = template;
  const payments = entries.flatMap((row) =>
    // The read takes only rows that carry their occurrence; the narrowing is the type's.
    row.occurrenceDate === null ? [] : [paymentOf(row, row.occurrenceDate)],
  );

  const completed = toCompletenessTemplate(template);
  const view = incomeSourceYear({
    template: completed,
    payments,
    skips: skips.map((row) => ({
      id: row.id,
      occurrenceDate: plainDate(row.occurrenceDate),
      reason: row.reason,
      note: row.note,
    })),
    year,
    today,
  });

  // The end of the last completed month (8.1): as Known expenses measures an
  // end-date change, over the schedule as though it never ended, so a shorter
  // and a longer end date are compared against the same dates.
  const lastCompletedDay = addDays(startOfMonth(today), -1);

  return {
    today: ctx.today,
    year,
    currentYear,
    minorUnitsByCurrency: catalogue.minorUnitsByCurrency,
    navigation: {
      previous: year > firstYear ? year - 1 : null,
      next: year < currentYear ? year + 1 : null,
    },
    source: {
      templateId: template.id,
      version: template.version,
      name: template.name,
      counterparty: template.counterparty,
      /* v8 ignore next -- an income template always has its income kind (6.2 CHECK). */
      incomeKind: template.incomeKind ?? 'other',
      currency,
      frequency: template.frequency,
      dayOfMonth: template.dayOfMonth,
      startDate: template.startDate,
      endDate: template.endDate,
      archived: template.archivedAt !== null,
      account:
        template.cashPositionId === null
          ? null
          : {
              positionId: template.cashPositionId,
              /* v8 ignore next -- the default account is the user's own position (6.2 FK). */
              name: account?.name ?? 'Unknown account',
            },
      completedOccurrenceDates: occurrencesInRange(
        { ...completed.schedule, endDate: null },
        completed.schedule.startDate,
        lastCompletedDay,
      ),
    },
    terms: [...terms]
      .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1))
      .map((row) => ({
        effectiveFrom: row.effectiveFrom,
        net: moneyDto(row.amount, currency),
        gross: row.grossAmount === null ? null : moneyDto(row.grossAmount, currency),
        note: row.note,
      })),
    arrivals: payments.map((payment) => ({
      payment: paymentDtoOf(payment),
      term: termDtoOf(terms, payment.occurrenceDate, currency),
    })),
    occurrences: view.occurrences.map((occurrence) => {
      const { state } = occurrence;
      let dto: IncomeSourceOccurrenceStateDto;
      switch (state.kind) {
        case 'received':
          dto = { kind: 'received', payment: paymentDtoOf(state.payment) };
          break;
        case 'skipped':
          dto = { kind: 'skipped', reason: state.skip.reason, note: state.skip.note };
          break;
        case 'missing':
        case 'not_yet_due':
          dto = { kind: state.kind };
          break;
      }
      return {
        occurrenceDate: occurrence.occurrenceDate,
        term: termDtoOf(terms, occurrence.occurrenceDate, currency),
        state: dto,
      };
    }),
  };
}
