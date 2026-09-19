import type { PlainDate } from '../dates/plain-date';
import type { CategoryKind } from '../flows/types';
import type { FxTable } from '../fx/types';
import type { CurrencyCode, Money } from '../money/types';
import {
  factsInRange,
  factsInScope,
  scopeAccountIds,
  type FlowRecords,
  type ScopeAccount,
} from '../reconciliation/scope';
import { costBucket } from '../savings/classify';
import { sumAmountsOf, type ReportingAmount } from './aggregate';
import { convertContribution } from './cash-flow';
import {
  contributionOfFact,
  untrackedContribution,
  type ReportingContribution,
  type ReportingField,
} from './contributions';

/**
 * The explicit records behind an interval's known spending (blueprint 15.2
 * "categories; largest known", 8.1, 12.5, v2.1.13 30.16 item 1).
 *
 * The Spending page explains two figures with rows: known tracked spending
 * (`ΣK`) and additional spending. Each row here is **one contribution those
 * figures already consumed**, taken the way the reporting month takes it:
 *
 *  - a tracked known expense is a `K` fact inside a reconciliation bucket's own
 *    scope — the same `factsInScope` over the same `scopeAccountIds` — so an
 *    account the month excluded as `first_balance` contributes nothing here for
 *    exactly the reason it contributed nothing to the identity. Rescanning the
 *    month's expense rows instead would put that excluded expense back (30.15
 *    item 3);
 *  - an additional row is an `untracked_self` expense over the interval, any
 *    kind (12.5), converted at its own date like the reporting month converts it;
 *  - `third_party` rows are not here at all: paid by others is a memo and is in
 *    no spending figure a row could explain.
 *
 * Each row is converted on its own, by `convertContribution` — the very rule
 * `reportCashFlow` uses — so a category total is a sum of converted rows and
 * never a composite converted at one rate, and the rows of one field sum to that
 * field exactly. Nothing is rounded.
 *
 * The residual is not a row. Unclassified spending is inferred, not a record
 * with a category, and it is reported beside the rows rather than among them.
 */

/** What a row is, for the figure it explains. */
export type KnownSpendingKind = 'consumption' | 'cost' | 'money_out' | 'additional';

/** The reporting field each tracked cost bucket feeds, and what it is called here. */
const KIND_OF_FIELD: Partial<Readonly<Record<ReportingField, KnownSpendingKind>>> = {
  knownConsumption: 'consumption',
  propertyOperatingCosts: 'cost',
  interestAndFees: 'cost',
  transactionCosts: 'cost',
  externalOutflows: 'money_out',
  additionalSpending: 'additional',
};

export interface KnownSpendingItem {
  /** The expense row the contribution came from. */
  readonly sourceId: string;
  readonly kind: KnownSpendingKind;
  /** The reporting figure it is inside. */
  readonly field: ReportingField;
  readonly native: Money;
  /** Its own financial date — the date it converts at. */
  readonly on: PlainDate;
  /** This one row in the reporting currency, or why it could not be stated. */
  readonly reporting: ReportingAmount;
}

/** One reconciliation bucket's scope, as the engines returned it. */
export interface KnownSpendingBucket {
  readonly currency: CurrencyCode;
  readonly accounts: readonly ScopeAccount[];
}

export interface KnownSpendingInput {
  /** The records reconciliation read for the interval. */
  readonly records: FlowRecords;
  /**
   * The reconciliation buckets whose scope defines tracked known spending.
   *
   * Empty when there is no tracked interval — a completed month with no bucket,
   * or a current month with no common date — and then no tracked row exists:
   * there is no scope for one to be inside.
   */
  readonly buckets: readonly KnownSpendingBucket[];
  /** The interval: `[start(M), end(M)]`, `[start(M), D]`, or through today with no `D`. */
  readonly from: PlainDate;
  readonly to: PlainDate;
  readonly reportingCurrency: CurrencyCode;
  readonly fx: FxTable;
}

const TRACKED_KINDS = new Set<KnownSpendingKind>(['consumption', 'cost', 'money_out']);

/**
 * Every row behind the interval's known tracked and additional spending, tracked
 * rows first (bucket by bucket, in the order reconciliation holds its facts),
 * then additional rows in record order.
 */
export function knownSpendingItems(input: KnownSpendingInput): KnownSpendingItem[] {
  const items: KnownSpendingItem[] = [];
  const push = (sourceId: string, contribution: ReportingContribution, on: PlainDate): void => {
    const kind = KIND_OF_FIELD[contribution.field];
    /* v8 ignore next -- unreachable: an expense's `K` contribution feeds one of
       the five cost fields and an untracked one `additionalSpending`, all six
       named above. The guard keeps a later field from arriving here unnamed. */
    if (kind === undefined) return;
    items.push({
      sourceId,
      kind,
      field: contribution.field,
      native: contribution.amount,
      on,
      reporting: convertContribution(contribution, input.reportingCurrency, input.fx),
    });
  };

  const inRange = factsInRange(input.records, input.from, input.to);
  for (const bucket of input.buckets) {
    for (const fact of factsInScope(inRange, bucket.currency, scopeAccountIds(bucket.accounts))) {
      if (fact.kind !== 'expense') continue;
      const contribution = contributionOfFact(fact);
      // Only a `K` leg yields a contribution from an expense, and it is dated.
      if (contribution === undefined || contribution.basis.kind !== 'dated') continue;
      push(fact.expense.id, contribution, contribution.basis.on);
    }
  }

  for (const expense of input.records.expenses) {
    if (expense.settlement !== 'untracked_self') continue;
    if (expense.incurredOn < input.from || expense.incurredOn > input.to) continue;
    push(
      expense.id,
      untrackedContribution(
        'additionalSpending',
        expense.amount,
        expense.currency,
        expense.incurredOn,
        expense.id,
      ),
      expense.incurredOn,
    );
  }

  return items;
}

/**
 * What a tracked expense filed under this category kind is: the same bucket
 * `contributionOfFact` puts it in (`costBucket`, 7.4, 12.5), named for the page.
 * A category keeps one answer whatever its rows' settlement, so a category with
 * only additional rows still sits in the group its kind belongs to.
 */
export function trackedKindOfCategory(
  categoryKind: CategoryKind,
): Exclude<KnownSpendingKind, 'additional'> {
  switch (costBucket(categoryKind)) {
    case 'consumption':
      return 'consumption';
    case 'external_outflows':
      return 'money_out';
    case 'property_operating':
    case 'interest_and_fees':
    case 'transaction_costs':
      return 'cost';
  }
}

/** Whether a row explains tracked spending (rather than additional). */
export const isTrackedKnown = (item: Pick<KnownSpendingItem, 'kind'>): boolean =>
  TRACKED_KINDS.has(item.kind);

/**
 * The reporting-currency sum of some rows, by 7.6's algebra: every row that
 * converted is inside the value, and the figure is partial when one could not be.
 * Rows are summed in the order given, so a caller that keeps the breakdown's
 * order gets the same digits every time (ADR 0004 §1).
 */
export function sumKnownSpending(
  items: readonly KnownSpendingItem[],
  reportingCurrency: CurrencyCode,
): ReportingAmount {
  return sumAmountsOf(
    items.map((item) => item.reporting),
    reportingCurrency,
  );
}

/* -------------------------------------------------------------------------- */
/* Largest known                                                               */
/* -------------------------------------------------------------------------- */

/**
 * How rows were put in order.
 *
 * `reporting_currency` — every row converted, so one order by reporting value
 * exists. `per_native_currency` — some row could not be converted, so no
 * cross-currency order is claimed and each native currency is ranked on its own.
 */
export type KnownSpendingRankingMode = 'reporting_currency' | 'per_native_currency';

export interface KnownSpendingRankingGroup {
  /** `null` for the one reporting-currency ranking; the native code otherwise. */
  readonly currency: CurrencyCode | null;
  readonly items: readonly KnownSpendingItem[];
}

export interface KnownSpendingRanking {
  readonly mode: KnownSpendingRankingMode;
  readonly groups: readonly KnownSpendingRankingGroup[];
}

/**
 * The same amount twice is decided by the later date, then by the row id, so the
 * order is total and never depends on the order the rows arrived in.
 */
function byDateThenId(a: KnownSpendingItem, b: KnownSpendingItem): number {
  if (a.on !== b.on) return a.on > b.on ? -1 : 1;
  return a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0;
}

/**
 * The `limit` largest rows (15.2 "largest known"): `limit` in all when one
 * reporting-currency order exists, and `limit` per native currency when it does
 * not (ADR 0008 §6).
 *
 * A reporting-currency ranking exists only when every candidate converted. With
 * one unconverted row the reporting values are not comparable to it — `$500`
 * and `€480` are not ordered by their face values, and ordering the converted
 * ones while leaving one out would present a partial list as the largest. So each
 * native currency is ranked by its own amounts instead, currencies in code
 * order, and the caller says why.
 */
export function rankKnownSpending(
  items: readonly KnownSpendingItem[],
  limit: number,
): KnownSpendingRanking {
  const allConverted = items.every((item) => item.reporting.availability === 'available');

  if (allConverted) {
    const ranked = [...items].sort((a, b) => {
      const order = b.reporting.value.amount.comparedTo(a.reporting.value.amount);
      return order !== 0 ? order : byDateThenId(a, b);
    });
    return { mode: 'reporting_currency', groups: [{ currency: null, items: ranked.slice(0, limit) }] };
  }

  const byCurrency = new Map<string, KnownSpendingItem[]>();
  for (const item of items) {
    const list = byCurrency.get(item.native.currency);
    if (list === undefined) byCurrency.set(item.native.currency, [item]);
    else list.push(item);
  }

  const groups = [...byCurrency.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, list]) => ({
      currency: currency as CurrencyCode,
      items: [...list]
        .sort((a, b) => {
          const order = b.native.amount.comparedTo(a.native.amount);
          return order !== 0 ? order : byDateThenId(a, b);
        })
        .slice(0, limit),
    }));

  return { mode: 'per_native_currency', groups };
}
