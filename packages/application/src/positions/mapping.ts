import {
  currencyCode,
  isUnavailable,
  money,
  serialize,
  type FxTable,
  type MoneyAggregate,
  type MoneyDto,
  type PositionContribution,
  type PositionRecord,
  type PositionWithValuations,
  type ValuationRecord,
} from '@vaultide/finance';
import { Decimal, convert, plainDate } from '@vaultide/finance';
import type { PositionRecord as PositionRow, ValuationRow } from '@vaultide/db';
import type {
  AggregateDto,
  MissingContributionDto,
  PositionDto,
  PositionValueDto,
  ValuationDto,
} from './types';

/**
 * Database rows to engine records, and engine results to DTOs (blueprint 4.2).
 *
 * The two directions are here together because they are the same boundary. Rows
 * carry `NUMERIC` as exact strings and dates as `YYYY-MM-DD` text; the engines
 * want `Decimal` and `PlainDate`; the interface wants serializable strings
 * again. Nothing on this path ever goes through a JavaScript number (7.1).
 */

export function toPositionRecord(row: PositionRow): PositionRecord {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    currency: currencyCode(row.currency),
    status: row.status,
    openedOn: row.openedOn === null ? null : plainDate(row.openedOn),
    closedOn: row.closedOn === null ? null : plainDate(row.closedOn),
    ...(row.isDormant === undefined ? {} : { isDormant: row.isDormant }),
    ...(row.includeInFinancialNetWorth === undefined
      ? {}
      : { includeInFinancialNetWorth: row.includeInFinancialNetWorth }),
  };
}

export function toValuationRecord(row: ValuationRow): ValuationRecord {
  return {
    id: row.id,
    positionId: row.positionId,
    valuedOn: plainDate(row.valuedOn),
    // The column is NUMERIC, so the driver hands back an exact decimal string
    // and no digit is lost on the way into the engine (7.1).
    amount: new Decimal(row.amount),
    source: row.source,
    datePrecision: row.datePrecision,
  };
}

/** Group valuations by position, as the engines take them. */
export function toPositionsWithValuations(
  rows: readonly PositionRow[],
  valuations: readonly ValuationRow[],
): PositionWithValuations[] {
  const byPosition = new Map<string, ValuationRecord[]>();
  for (const row of valuations) {
    const list = byPosition.get(row.positionId);
    const record = toValuationRecord(row);
    if (list === undefined) byPosition.set(row.positionId, [record]);
    else list.push(record);
  }
  return rows.map((row) => ({
    position: toPositionRecord(row),
    valuations: byPosition.get(row.id) ?? [],
  }));
}

export function moneyDto(amount: string, currency: string): MoneyDto {
  return serialize(money(amount, currency));
}

export function aggregateDto(aggregate: MoneyAggregate): AggregateDto {
  const missing: MissingContributionDto[] = aggregate.missing.map((item) => ({
    positionId: item.positionId,
    positionName: item.positionName,
    kind: item.kind,
    reason: item.reason,
    detail: item.detail ?? null,
    native: item.native === undefined ? null : serialize(item.native),
  }));

  return {
    // An aggregate nothing could be established for carries no value at all:
    // the interface must render `—` with the reason, and `0` would be a lie
    // (16.2, 7.6).
    value: aggregate.availability === 'unavailable' ? null : serialize(aggregate.value),
    availability: aggregate.availability,
    missing,
    contributingCount: aggregate.contributingCount,
    native: aggregate.native.map(serialize),
  };
}

/**
 * A position's value as the interface sees it.
 *
 * `reporting` is the **unsigned** value in the reporting currency — a page
 * shows "€8,055" for a debt and lets the sign convention do its work in the
 * totals, exactly as 7.8 requires ("liability balances stay positive in
 * storage and in the UI").
 */
export function positionValueDto(contribution: PositionContribution): PositionValueDto {
  const { value } = contribution;
  const native = isUnavailable(value.native) ? null : serialize(value.native);
  const reporting =
    contribution.reporting === undefined
      ? null
      : serialize(
          contribution.sign === 1
            ? contribution.reporting
            : money(contribution.reporting.amount.negated(), contribution.reporting.currency),
        );

  return {
    state: value.state,
    native,
    valuedOn: value.valuedOn ?? null,
    ageDays: value.ageDays ?? null,
    ageMonths: value.ageMonths ?? null,
    fromMonthEnd: value.fromMonthEnd === true,
    reporting,
    rate: contribution.rate ?? null,
    unavailableReason: contribution.unavailableReason ?? null,
    unavailableDetail: contribution.unavailableDetail ?? null,
  };
}

export interface PositionDtoInput {
  readonly row: PositionRow;
  readonly contribution: PositionContribution;
  readonly minorUnits: number;
  readonly valuationCount: number;
  readonly lastCompletedMonth: PositionDto['lastCompletedMonth'];
}

export function positionDto(input: PositionDtoInput): PositionDto {
  const { row } = input;
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    currency: row.currency,
    minorUnits: input.minorUnits,
    status: row.status,
    openedOn: row.openedOn,
    closedOn: row.closedOn,
    notes: row.notes,
    version: row.version,
    accountType: row.accountType ?? null,
    institution: row.institution ?? null,
    isDormant: row.isDormant ?? null,
    assetType: row.assetType ?? null,
    acquisitionDate: row.acquisitionDate ?? null,
    acquisitionValue:
      row.acquisitionValue === undefined || row.acquisitionValue === null
        ? null
        : moneyDto(row.acquisitionValue, row.currency),
    includeInFinancialNetWorth: row.includeInFinancialNetWorth ?? null,
    value: positionValueDto(input.contribution),
    lastCompletedMonth: input.lastCompletedMonth,
    valuationCount: input.valuationCount,
  };
}

/**
 * A valuation row for the history table, with its reporting value **at its own
 * date** — history is read at the rate that applied then, not at today's
 * (10.3).
 */
export function valuationDto(
  row: ValuationRow,
  currency: string,
  reportingCurrency: string,
  fx: FxTable,
): ValuationDto {
  const native = money(row.amount, currency);
  const converted = convert(native, reportingCurrency, plainDate(row.valuedOn), fx);

  return {
    id: row.id,
    positionId: row.positionId,
    valuedOn: row.valuedOn,
    amount: serialize(native),
    source: row.source,
    datePrecision: row.datePrecision,
    note: row.note,
    version: row.version,
    reporting: isUnavailable(converted) ? null : serialize(converted.amount),
  };
}
