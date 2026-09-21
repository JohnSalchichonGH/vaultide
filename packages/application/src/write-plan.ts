import { Decimal } from '@vaultide/finance';

/**
 * The vocabulary a resolved financial write speaks (blueprint 30.22; ADR 0010
 * §1, §2).
 *
 * Every ordinary mutation of mutable financial evidence now resolves before it
 * applies: it reads what it is about, judges it, and produces a **plan** that
 * says which source facts change and what happens to the dormant episodes
 * those facts touch. The write then applies that plan, and Historical
 * Correction previews it instead.
 *
 * That is why this module sits at the package root rather than inside
 * `corrections/`. The resolvers live with the mutations they belong to —
 * income with income, valuations with valuations — and the correction services
 * read their plans. One neutral module both can import keeps the direction of
 * every edge pointing one way.
 *
 * Nothing here performs IO, reads a clock or converts a currency. A fact is
 * native and exact, exactly as the source row holds it.
 */

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

/** The source tables a Phase 3 financial write can change. */
export type SourceKind = 'income' | 'expense' | 'transfer' | 'valuation' | 'cash_dormancy';

/**
 * What a row that does not exist yet is called.
 *
 * A prospective row has no database id — PostgreSQL generates one on insert —
 * so a preview that invented a UUID would be fingerprinting a value the commit
 * can never reproduce (ADR 0010 §2; the design note in §19 of the slice
 * prompt). It is named by what it **is** in its aggregate instead.
 */
export type ProspectiveRole =
  /** A standalone new income or expense entry. */
  | 'entry'
  /** A new transfer. */
  | 'transfer'
  /** The one fee row a transfer aggregate carries. */
  | 'transfer_fee'
  /** A balance that does not exist yet. */
  | 'valuation'
  /** The flow a recurring occurrence would materialize. */
  | 'occurrence';

export type SourceIdentity =
  | { readonly scope: 'existing'; readonly kind: SourceKind; readonly id: string }
  | {
      readonly scope: 'prospective';
      readonly kind: SourceKind;
      readonly role: ProspectiveRole;
      /**
       * The aggregate or schedule the prospective row belongs to — a transfer
       * id for its fee, a `templateId#occurrenceDate` for an occurrence — or
       * `null` for a row that belongs to nothing but itself.
       */
      readonly owner: string | null;
    };

/** One canonical, stable string for an identity. Never a display label. */
export function identityKey(identity: SourceIdentity): string {
  return identity.scope === 'existing'
    ? `existing:${identity.kind}:${identity.id}`
    : `prospective:${identity.kind}:${identity.role}:${identity.owner ?? '-'}`;
}

/* -------------------------------------------------------------------------- */
/* Facts                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * An amount as its exact decimal value rather than its spelling.
 *
 * `100.00` and `100` are the same financial fact, and a consent fingerprint
 * that told them apart would ask a user to re-confirm a change nobody made.
 */
export const canonicalAmount = (value: string): string => new Decimal(value).toString();

export interface IncomeSourceFacts {
  readonly kind: 'income';
  readonly incomeKind: string;
  readonly receivedOn: string;
  readonly netAmount: string;
  readonly grossAmount: string | null;
  readonly currency: string;
  readonly settlement: string;
  readonly cashPositionId: string | null;
  readonly description: string | null;
  /** The occurrence this row materializes; identity, never a financial date. */
  readonly templateId: string | null;
  readonly occurrenceDate: string | null;
}

export interface ExpenseSourceFacts {
  readonly kind: 'expense';
  readonly categoryId: string;
  /** 7.4 classifies on the kind, so the kind travels with the id. */
  readonly categoryKind: string;
  readonly incurredOn: string;
  readonly amount: string;
  readonly currency: string;
  readonly settlement: string;
  readonly cashPositionId: string | null;
  readonly description: string | null;
  /**
   * The user's own "one-off" mark.
   *
   * No engine reads it — the rolling baseline deliberately does not consult it
   * — but Monthly lets a person set it on an expense, and a historical expense
   * whose only change is this flag is still a revision of a closed month. So it
   * is a fact the review has to be able to show; otherwise that review would
   * open with nothing on it changed.
   */
  readonly isOneOff: boolean;
  /** The transfer this row is the fee of, when it is one (M14). */
  readonly transferId: string | null;
  readonly templateId: string | null;
  readonly occurrenceDate: string | null;
}

export interface TransferSourceFacts {
  readonly kind: 'transfer';
  readonly occurredOn: string;
  /** Nullable in the schema; a Phase 3 cash transfer always names both. */
  readonly fromPositionId: string | null;
  readonly fromCurrency: string;
  readonly fromAmount: string;
  readonly toPositionId: string | null;
  readonly toCurrency: string;
  readonly toAmount: string;
  readonly description: string | null;
}

export interface ValuationSourceFacts {
  readonly kind: 'valuation';
  readonly positionId: string;
  readonly valuedOn: string;
  readonly amount: string;
  readonly currency: string;
  readonly datePrecision: 'exact' | 'month_end';
  readonly note: string | null;
}

export interface DormancySourceFacts {
  readonly kind: 'cash_dormancy';
  readonly positionId: string;
  readonly isDormant: boolean;
  /** The date of the zero balance the episode rests on (8.8, 30.20). */
  readonly dormantFrom: string | null;
}

export type SourceFacts =
  | IncomeSourceFacts
  | ExpenseSourceFacts
  | TransferSourceFacts
  | ValuationSourceFacts
  | DormancySourceFacts;

/* -------------------------------------------------------------------------- */
/* Changes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A source fact changing, modelled so the impossible combinations cannot be
 * written down.
 *
 * Deliberately not `{ before: T; after: T | null }`: a first assertion that
 * wakes a historical dormant episode legitimately has no before-image, and a
 * shape with a required `before` would have forced a fake one (§18 of the
 * slice prompt; ADR 0010 §1).
 */
export type SourceChange<T> =
  | { readonly operation: 'create'; readonly before: null; readonly after: T }
  | { readonly operation: 'update'; readonly before: T; readonly after: T }
  | { readonly operation: 'delete'; readonly before: T; readonly after: null };

/** A source change with the identity of the row it is about. */
export type IdentifiedSourceChange = SourceChange<SourceFacts> & {
  readonly identity: SourceIdentity;
};

export function created(
  identity: SourceIdentity,
  after: SourceFacts,
): IdentifiedSourceChange {
  return { identity, operation: 'create', before: null, after };
}

export function updated(
  identity: SourceIdentity,
  before: SourceFacts,
  after: SourceFacts,
): IdentifiedSourceChange {
  return { identity, operation: 'update', before, after };
}

export function deleted(
  identity: SourceIdentity,
  before: SourceFacts,
): IdentifiedSourceChange {
  return { identity, operation: 'delete', before, after: null };
}

/* -------------------------------------------------------------------------- */
/* Dormancy                                                                    */
/* -------------------------------------------------------------------------- */

/** A cash account's dormant episode, as a write finds it and as it leaves it. */
export interface DormancyState {
  readonly isDormant: boolean;
  readonly dormantFrom: string | null;
}

/**
 * What a resolved write does to one account's dormant episode (8.8, 30.20).
 *
 * `via` says which writer applies it, because the two are not interchangeable:
 * a consequence `clear` does not consume the position's optimistic version
 * (a flow must not invalidate an account form somebody has open), while the
 * account editor's own transition is part of its versioned update.
 */
export interface DormancyEffect {
  readonly positionId: string;
  readonly before: DormancyState;
  readonly after: DormancyState;
  readonly via: 'clear' | 'account_update';
}

export function dormancyChanged(effect: DormancyEffect): boolean {
  return (
    effect.before.isDormant !== effect.after.isDormant ||
    effect.before.dormantFrom !== effect.after.dormantFrom
  );
}

/** The dormancy effects that actually move something, in position order. */
export function realDormancyEffects(
  effects: readonly DormancyEffect[],
): readonly DormancyEffect[] {
  return [...effects]
    .filter(dormancyChanged)
    .sort((a, b) => (a.positionId < b.positionId ? -1 : a.positionId > b.positionId ? 1 : 0));
}

/** A dormancy effect as the source change it is. */
export function dormancyChange(effect: DormancyEffect): IdentifiedSourceChange {
  return updated(
    { scope: 'existing', kind: 'cash_dormancy', id: effect.positionId },
    {
      kind: 'cash_dormancy',
      positionId: effect.positionId,
      isDormant: effect.before.isDormant,
      dormantFrom: effect.before.dormantFrom,
    },
    {
      kind: 'cash_dormancy',
      positionId: effect.positionId,
      isDormant: effect.after.isDormant,
      dormantFrom: effect.after.dormantFrom,
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Post-commit support                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Exchange-rate history worth warming once the financial truth has committed
 * (10.4; ADR 0010 §16 item 6).
 *
 * A descriptor rather than a dependency: the transaction says which currency
 * from which date, and the caller warms it **after** the commit, outside the
 * mutex. Nothing inside the transaction may decide anything from it.
 */
export interface SupportWarm {
  readonly currency: string;
  readonly from: string;
}

/** The earliest date each currency is needed from, currency order. */
export function mergeSupport(items: readonly SupportWarm[]): readonly SupportWarm[] {
  const earliest = new Map<string, string>();
  for (const item of items) {
    const known = earliest.get(item.currency);
    if (known === undefined || item.from < known) earliest.set(item.currency, item.from);
  }
  return [...earliest]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, from]) => ({ currency, from }));
}

/* -------------------------------------------------------------------------- */
/* The plan                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Whether a resolving read should hold the rows it reads (ADR 0010 §8).
 *
 * `lock: true` is every write and Historical Confirm: the row a decision is
 * made from must be the row that is written. `lock: false` is the correction
 * **preview**, which runs `REPEATABLE READ READ ONLY` — where PostgreSQL
 * refuses a row lock outright — and whose one coherent snapshot gives it the
 * stability the lock would have given.
 *
 * It changes the locking and nothing else. Every rule either side of it is the
 * same rule, which is what stops a preview approving an operation the save
 * would refuse on unchanged data.
 */
export interface ResolveOptions {
  readonly lock: boolean;
}

/**
 * What every resolved financial write has in common.
 *
 * A family's own plan extends it with whatever its apply step needs — the
 * locked rows, the columns to write, the versions to check. Only the three
 * fields here are read by the correction machinery.
 */
export interface ResolvedWrite {
  /**
   * Whether this write **revises** existing evidence rather than asserting
   * something for the first time (30.22 item 2).
   *
   * It is a property of the operation, not of any one row: correcting a
   * transfer aggregate is a revision even where it adds a fee that did not
   * exist before, and creating an income entry is a first assertion even where
   * its date lands in a month that closed months ago.
   */
  readonly revision: boolean;
  /** Every source fact this write changes, primary and consequential alike. */
  readonly changes: readonly IdentifiedSourceChange[];
  readonly dormancy: readonly DormancyEffect[];
  readonly support: readonly SupportWarm[];
}
