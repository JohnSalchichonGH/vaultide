import { Decimal } from '../../src/decimal';
import { plainDate } from '../../src/dates/plain-date';
import { createFxTable, type FxRateRecord } from '../../src/fx/index';
import { currencyCode } from '../../src/money/types';
import type {
  DatePrecision,
  PositionRecord,
  PositionWithValuations,
  ValuationRecord,
  ValuationSource,
} from '../../src/positions/types';
import type { PositionKind } from '../../src/positions/sign';

/** Builders for the position engines' inputs. Terse on purpose: the fixtures
 *  below should read like the balance sheet they describe. */

let sequence = 0;
const nextId = (prefix: string): string => `${prefix}-${String((sequence += 1)).padStart(4, '0')}`;

export interface PositionOptions {
  readonly id?: string;
  readonly kind?: PositionKind;
  readonly currency?: string;
  readonly status?: PositionRecord['status'];
  readonly openedOn?: string | null;
  readonly closedOn?: string | null;
  readonly isDormant?: boolean;
  readonly includeInFinancialNetWorth?: boolean;
}

export function position(name: string, options: PositionOptions = {}): PositionRecord {
  return {
    id: options.id ?? nextId('pos'),
    kind: options.kind ?? 'cash',
    name,
    currency: currencyCode(options.currency ?? 'EUR'),
    status: options.status ?? 'active',
    openedOn: options.openedOn === undefined || options.openedOn === null
      ? null
      : plainDate(options.openedOn),
    closedOn: options.closedOn === undefined || options.closedOn === null
      ? null
      : plainDate(options.closedOn),
    ...(options.isDormant === undefined ? {} : { isDormant: options.isDormant }),
    ...(options.includeInFinancialNetWorth === undefined
      ? {}
      : { includeInFinancialNetWorth: options.includeInFinancialNetWorth }),
  };
}

export function valuation(
  positionId: string,
  valuedOn: string,
  amount: string,
  options: { precision?: DatePrecision; source?: ValuationSource; id?: string } = {},
): ValuationRecord {
  return {
    id: options.id ?? nextId('val'),
    positionId,
    valuedOn: plainDate(valuedOn),
    amount: new Decimal(amount),
    source: options.source ?? 'entered',
    datePrecision: options.precision ?? 'exact',
  };
}

/** A month-end statement balance: the only kind that closes a month (R15). */
export function monthEnd(
  positionId: string,
  valuedOn: string,
  amount: string,
  source: ValuationSource = 'entered',
): ValuationRecord {
  return valuation(positionId, valuedOn, amount, { precision: 'month_end', source });
}

export function entry(
  record: PositionRecord,
  valuations: readonly ValuationRecord[],
): PositionWithValuations {
  return { position: record, valuations };
}

export function rate(
  quote: string,
  rateDate: string,
  value: string,
  source = 'ecb',
): FxRateRecord {
  return {
    quote: currencyCode(quote),
    rateDate: plainDate(rateDate),
    rate: new Decimal(value),
    source,
  };
}

export function fxTable(rows: readonly FxRateRecord[], today: string) {
  return createFxTable(rows, { today: plainDate(today) });
}
