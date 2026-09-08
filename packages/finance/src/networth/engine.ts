import { toPlainString } from '../decimal';
import type { PlainDate } from '../dates/plain-date';
import { convert } from '../fx/convert';
import type { FxTable } from '../fx/types';
import { MoneyBag } from '../money/bag';
import { add, money, neg, zero } from '../money/money';
import { currencyCode, type CurrencyCode, type Money } from '../money/types';
import { isUnavailable, type Unavailable } from '../unavailable';
import { netWorthSign, type PositionKind } from '../positions/sign';
import type { PositionWithValuations } from '../positions/types';
import { valueAt, type PositionValue } from '../positions/valuation';
import type {
  Availability,
  MissingContribution,
  MoneyAggregate,
  NetWorthResult,
  PositionContribution,
} from './types';

/**
 * The net-worth engine (blueprint 12.1, R18, R25, 7.6, 10.3).
 *
 * Two metrics, computed in one pass from the same records so they can never
 * disagree:
 *
 *  - **Total net worth** — every tracked asset minus every tracked liability.
 *    Nothing a user can switch removes anything from it.
 *  - **Financial net worth** — the headline: total net worth minus the other
 *    assets the user has chosen to leave out (12.1). Only other assets carry
 *    that preference (M15); a liability can never be excluded, which is the
 *    whole reason the specification's generic "counts towards net worth"
 *    toggle was replaced by two defined metrics (F21).
 *
 * Everything generic goes through `netWorthSign` (7.8): assets `+1`,
 * liabilities `−1`. No branch anywhere says "if it is a debt, subtract" — the
 * sign carries it, which is what makes loan proceeds and principal repayments
 * provably neutral when Phase 5 arrives.
 *
 * Conversion is at the **as-of date**, not the valuation's date (10.3): a
 * carried USD balance shown at 30 September is valued at the 30 September rate,
 * so a stale balance does not also freeze its exchange rate. A conversion with
 * no rate is `Unavailable` and makes the aggregate partial — never zero (10.5).
 */

export interface NetWorthInput {
  readonly positions: readonly PositionWithValuations[];
  readonly asOf: PlainDate;
  readonly reportingCurrency: CurrencyCode | string;
  readonly fx: FxTable;
}

/** Other assets are in financial net worth only when the user includes them. */
function inFinancialNetWorth(kind: PositionKind, include: boolean | undefined): boolean {
  return kind === 'other_asset' ? include === true : true;
}

function contributionOf(
  entry: PositionWithValuations,
  asOf: PlainDate,
  reporting: CurrencyCode,
  fx: FxTable,
): PositionContribution {
  const { position } = entry;
  const value: PositionValue = valueAt(position, entry.valuations, asOf);
  const sign = netWorthSign(position.kind);
  const included = inFinancialNetWorth(position.kind, position.includeInFinancialNetWorth);

  /** One shape for "this position is not inside the total, and here is why". */
  const withoutValue = (cause: Unavailable): PositionContribution => ({
    value,
    sign,
    inFinancialNetWorth: included,
    unavailableReason: cause.reason,
    ...(cause.detail === undefined ? {} : { unavailableDetail: cause.detail }),
  });

  if (isUnavailable(value.native)) return withoutValue(value.native);

  const converted = convert(value.native, reporting, asOf, fx);
  if (isUnavailable(converted)) return withoutValue(converted);

  return {
    value,
    sign,
    inFinancialNetWorth: included,
    // Signed once, here. Every aggregate below simply adds.
    reporting: sign === 1 ? converted.amount : neg(converted.amount),
    rate: {
      rate: toPlainString(converted.rate),
      rateDate: converted.rateDate,
      source: converted.source,
      exact: converted.exact,
    },
  };
}

function missingOf(contribution: PositionContribution): MissingContribution {
  const { position } = contribution.value;
  const native = contribution.value.native;
  return {
    positionId: position.id,
    positionName: position.name,
    kind: position.kind,
    reason: contribution.unavailableReason ?? 'not_applicable',
    ...(contribution.unavailableDetail === undefined
      ? {}
      : { detail: contribution.unavailableDetail }),
    ...(isUnavailable(native) ? {} : { native }),
  };
}

function availabilityOf(contributingCount: number, missingCount: number): Availability {
  if (missingCount === 0) return 'available';
  return contributingCount === 0 ? 'unavailable' : 'partial';
}

/**
 * Order contributions canonically, by position id.
 *
 * Not cosmetic. A converted amount is a division — `USD 3,000 / 1.1596` — and
 * its decimal expansion does not terminate, so it is held to 40 significant
 * digits. Adding several such values in a different order can therefore differ
 * in the fortieth digit: real decimal arithmetic is not associative once a
 * value has been rounded to a precision at all.
 *
 * That is invisible at any scale a person sees, and it would still be wrong to
 * let it through: the same balance sheet must produce the same number every
 * time, whatever order the rows came back from the database in. Summing in a
 * fixed order makes that true by construction rather than by luck, and a
 * property test asserts it for random balance sheets.
 */
function canonicalOrder(
  contributions: readonly PositionContribution[],
): readonly PositionContribution[] {
  return [...contributions].sort((a, b) => {
    const left = a.value.position.id;
    const right = b.value.position.id;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/**
 * Sum a set of contributions into one aggregate.
 *
 * A contribution that is part of the balance sheet but could not be valued or
 * converted is counted as missing, never as zero — that is the difference
 * between "your net worth is €40,000" and "your net worth is at least €40,000,
 * and one account is not in it".
 */
export function aggregate(
  contributions: readonly PositionContribution[],
  reporting: CurrencyCode,
): MoneyAggregate {
  let total = zero(reporting);
  const missing: MissingContribution[] = [];
  const bag = new MoneyBag();
  let contributingCount = 0;

  for (const contribution of contributions) {
    // Positions that were not yet tracked at the as-of date are not part of the
    // balance sheet then, and are neither counted nor reported missing (12.3).
    if (!contribution.value.contributes) continue;

    const native = contribution.value.native;
    if (!isUnavailable(native)) {
      bag.add(contribution.sign === 1 ? native : neg(native));
    }

    if (contribution.reporting === undefined) {
      missing.push(missingOf(contribution));
      continue;
    }

    total = add(total, contribution.reporting);
    contributingCount += 1;
  }

  return {
    value: total,
    availability: availabilityOf(contributingCount, missing.length),
    missing,
    contributingCount,
    native: bag.entries(),
  };
}

export function netWorthAt(input: NetWorthInput): NetWorthResult {
  const reporting = currencyCode(input.reportingCurrency);
  // Ordered once, here, so every aggregate below accumulates identically and
  // `positions` is in the same order the totals were built from.
  const contributions = canonicalOrder(
    input.positions.map((entry) => contributionOf(entry, input.asOf, reporting, input.fx)),
  );

  const byKind = (kind: PositionKind): PositionContribution[] =>
    contributions.filter((contribution) => contribution.value.position.kind === kind);

  const otherAssets = byKind('other_asset');
  const otherIncluded = otherAssets.filter((contribution) => contribution.inFinancialNetWorth);
  const otherExcluded = otherAssets.filter((contribution) => !contribution.inFinancialNetWorth);

  const totalNetWorth = aggregate(contributions, reporting);
  // Financial net worth is total minus the excluded other assets, computed from
  // the same per-position pass. Deriving it by filtering the same list — rather
  // than by subtracting a separately computed number — is what makes the
  // identity of 12.1 hold exactly, including its availability.
  const financialNetWorth = aggregate(
    contributions.filter((contribution) => contribution.inFinancialNetWorth),
    reporting,
  );

  return {
    asOf: input.asOf,
    reportingCurrency: reporting,
    positions: contributions,
    components: {
      cash: aggregate(byKind('cash'), reporting),
      otherAssetsIncluded: aggregate(otherIncluded, reporting),
      otherAssetsExcluded: aggregate(otherExcluded, reporting),
    },
    totalNetWorth,
    financialNetWorth,
    metricsDiffer: !totalNetWorth.value.amount.equals(financialNetWorth.value.amount),
  };
}

/**
 * The change between two net-worth figures of the same metric.
 *
 * `undefined` when either end is not fully available: a delta between two
 * partial numbers is not a delta, and showing one would be exactly the kind of
 * confident-looking wrong number this product exists to avoid.
 */
export function netWorthChange(
  from: MoneyAggregate,
  to: MoneyAggregate,
): Money | undefined {
  if (from.availability !== 'available' || to.availability !== 'available') return undefined;
  return money(to.value.amount.minus(from.value.amount), to.value.currency);
}
