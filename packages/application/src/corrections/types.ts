import type {
  CashCloseState,
  CashOpenState,
  CompletenessState,
  IssueKey,
  MtdValueState,
  ReconciliationStatus,
} from '@vaultide/finance';
import type { IdentifiedSourceChange, SourceIdentity } from '../write-plan';

/**
 * What a Historical Correction preview says (blueprint 30.22 items 3 and 4;
 * ADR 0010 §2, §13).
 *
 * Three things, kept apart because they answer different questions:
 *
 *  - **source scope** — which records the correction touches;
 *  - **period impact** — what each affected financial period says before and
 *    after;
 *  - **structural changes** — the effects that are not a figure moving: a span
 *    appearing or disappearing, a month's status or completeness moving, an
 *    issue arriving or clearing, a balance's carry interval changing, a dormant
 *    episode being rewritten.
 *
 * ## What is deliberately absent
 *
 * No reporting-currency value, no exchange rate, no rolling average, no chart
 * point and **no derived monetary total**. The dialog shows the correction's
 * own native source facts, which the user is consenting to, and then explains
 * which periods are recalculated and which structural facts move. It does not
 * pretend to predict every future euro figure, and the consent fingerprint does
 * not depend on one (§35, §51 of the slice prompt).
 *
 * That is also what makes consent independent of FX: a preview taken while the
 * rate publisher is down says exactly what one taken afterwards says, and a
 * reporting-currency switch never invalidates a correction the user already
 * reviewed (30.16).
 */

/* -------------------------------------------------------------------------- */
/* Impact tags                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The coarse families of output a correction recalculates.
 *
 * Six, frozen, and deliberately blunt. The review dialog is a confirmation, not
 * a second analytics page: the user needs to know that their spending figures
 * and their savings figures for August will be recomputed, not what every one
 * of them will become.
 */
export type ImpactTag =
  /** Bucket status, evidence, issues or reconciliation semantics moved. */
  | 'reconciliation'
  /** Tracked, known, unclassified or additional spending semantics moved. */
  | 'spending'
  /** Tracked or personal savings semantics moved. */
  | 'savings'
  /** An income source's contribution moved. */
  | 'income'
  /** The known-expense decomposition by category moved. */
  | 'categories'
  /** Informational, source-only figures moved — third-party paid, notes. */
  | 'memo';

export const IMPACT_TAG_ORDER: readonly ImpactTag[] = [
  'reconciliation',
  'spending',
  'savings',
  'income',
  'categories',
  'memo',
];

/* -------------------------------------------------------------------------- */
/* Issue identity                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One issue, named the way the corrective actions already name one (30.21).
 *
 * The wording of an issue is display, and a message that was reworded is not a
 * different issue. What identifies one is its key, the bucket it belongs to,
 * and whatever it is about — an account, a scheduled occurrence, or the record
 * whose leg names no account, which carries the same `{ kind, id, on }` the
 * engine's own `IssueSource` does.
 */
export interface IssueIdentity {
  readonly key: IssueKey;
  readonly currency: string | null;
  readonly positionId: string | null;
  readonly templateId: string | null;
  readonly occurrenceDate: string | null;
  readonly source: { readonly kind: string; readonly id: string; readonly on: string } | null;
}

/* -------------------------------------------------------------------------- */
/* Completed periods                                                           */
/* -------------------------------------------------------------------------- */

/** One account's endpoints in a completed month's bucket (8.9). */
export interface CompletedAccountState {
  readonly positionId: string;
  readonly opening: CashOpenState;
  readonly closing: CashCloseState;
  readonly included: boolean;
  readonly excludedFirstBalance: boolean;
  readonly dormant: boolean;
}

/**
 * Whether `count_additional_spending` actually decides anything here (12.5).
 *
 * Present so a correction whose personal-savings result genuinely depends on
 * the preference has to be reviewed again when it is flipped — and so one that
 * does not is left alone. The preference is not fingerprinted globally; this
 * derived fact is, and it only moves for a bucket that has untracked-self
 * spending to count.
 */
export interface SavingsImpactState {
  readonly availability: 'available' | 'unavailable';
  readonly quality: 'reliable' | 'estimated' | 'provisional' | null;
  readonly rate: 'ratio' | 'unavailable';
  readonly additionalSpendingCounts: boolean;
}

export interface CompletedBucketImpact {
  readonly currency: string;
  readonly status: ReconciliationStatus;
  /**
   * Whether the balance-derived figures exist at all (30.12).
   *
   * `missing` is not "zero": it says 8.3 stopped short of the identity, so the
   * cash delta, the tracked total and the unclassified residual have no value.
   */
  readonly balanceEvidence: 'complete' | 'missing';
  readonly accounts: readonly CompletedAccountState[];
  readonly issues: readonly IssueIdentity[];
  readonly savings: SavingsImpactState;
}

export interface CompletenessImpact {
  readonly state: CompletenessState;
  readonly satisfied: number;
  readonly required: number;
}

export interface CompletedPeriodState {
  readonly status: ReconciliationStatus;
  readonly buckets: readonly CompletedBucketImpact[];
  readonly completeness: CompletenessImpact | null;
}

/**
 * A completed month, before and after.
 *
 * Deliberately a before/after pair rather than one state with the difference
 * implied, so the dialog can show both sides and the fingerprint covers both.
 */
export interface CompletedPeriodImpact {
  readonly kind: 'completed';
  readonly month: string;
  readonly before: CompletedPeriodState;
  readonly after: CompletedPeriodState;
  readonly tags: readonly ImpactTag[];
}

/* -------------------------------------------------------------------------- */
/* The current period                                                          */
/* -------------------------------------------------------------------------- */

export interface CurrentAccountState {
  readonly positionId: string;
  readonly opening: CashOpenState;
  readonly atAsOf: MtdValueState;
  readonly included: boolean;
  readonly excludedFirstBalance: boolean;
  readonly dormant: boolean;
  readonly snapshotRequired: boolean;
}

export interface CurrentBucketState {
  readonly currency: string;
  readonly status: ReconciliationStatus;
  readonly reason: 'missing_opening' | null;
  readonly accounts: readonly CurrentAccountState[];
  readonly issues: readonly IssueIdentity[];
  readonly savings: SavingsImpactState;
}

/**
 * The current month's state, in the only two shapes it has (8.6, 30.13 items 3
 * and 4; ADR 0010 §13).
 *
 * A union, not one shape with optional fields. Without a common as-of date `D`
 * there is **no interval**: no month-to-date total, no bucket and no account
 * state. The `no_tracked_interval` arm says exactly that and carries no
 * `buckets` field at all — an empty list would read as "a tracked interval
 * containing nothing", which is a different and untrue statement.
 */
export type CurrentPeriodState =
  | {
      readonly kind: 'no_tracked_interval';
      readonly asOf: null;
      readonly status: 'unavailable';
      readonly reason: 'mtd_no_common_date';
      /** Source-only figures still run to today, where the contract allows. */
      readonly sourceOnlyThrough: string;
    }
  | {
      readonly kind: 'tracked_interval';
      readonly asOf: string;
      readonly status: 'provisional' | 'unresolved' | 'unavailable';
      readonly sourceOnlyThrough: string;
      readonly buckets: readonly CurrentBucketState[];
    };

export interface CurrentPeriodImpact {
  readonly kind: 'current';
  readonly month: string;
  readonly before: CurrentPeriodState;
  readonly after: CurrentPeriodState;
  readonly tags: readonly ImpactTag[];
}

export type PeriodImpact = CompletedPeriodImpact | CurrentPeriodImpact;

/* -------------------------------------------------------------------------- */
/* Structural changes                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The consequences that are not a figure moving (30.22 item 3).
 *
 * Every one carries a stable canonical identity and no human-readable message:
 * a reworded explanation is not a different consequence, and fingerprinting one
 * would ask a user to re-confirm a copy edit.
 *
 * There is deliberately **no** `mtd_date` entry: the authoritative date
 * transition is already `before.asOf` → `after.asOf` on the current period, and
 * a second copy of it could only ever disagree with the first (§41).
 */
export type StructuralChange =
  | {
      readonly kind: 'span';
      readonly change: 'appeared' | 'disappeared';
      readonly currency: string;
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly kind: 'month_status';
      readonly month: string;
      readonly before: ReconciliationStatus;
      readonly after: ReconciliationStatus;
    }
  | {
      readonly kind: 'bucket_status';
      readonly month: string;
      readonly currency: string;
      readonly before: ReconciliationStatus | null;
      readonly after: ReconciliationStatus | null;
    }
  | {
      readonly kind: 'completeness';
      readonly month: string;
      readonly before: CompletenessImpact | null;
      readonly after: CompletenessImpact | null;
    }
  | {
      readonly kind: 'issue';
      readonly change: 'appeared' | 'cleared';
      readonly month: string;
      readonly issue: IssueIdentity;
    }
  | {
      readonly kind: 'valuation_carry';
      readonly positionId: string;
      /** The interval this balance is the account's value over, `[from, to]`. */
      readonly before: { readonly from: string; readonly to: string | null } | null;
      readonly after: { readonly from: string; readonly to: string | null } | null;
    }
  | {
      readonly kind: 'dormancy_episode';
      readonly positionId: string;
      readonly before: string | null;
      readonly after: string | null;
    };

/* -------------------------------------------------------------------------- */
/* The preview                                                                 */
/* -------------------------------------------------------------------------- */

/** One record the correction touches, and what happens to it. */
export interface SourceScopeItem {
  readonly identity: SourceIdentity;
  readonly operation: 'create' | 'update' | 'delete';
}

/**
 * What Preview returns and Confirm re-derives.
 *
 * `fingerprint` is a deterministic hash of everything below it. The browser
 * sends it back with the draft; Confirm recomputes the whole preview from the
 * newest committed state and compares. It is not authority — a modified
 * fingerprint merely fails equality and authorizes nothing (§53).
 */
export interface CorrectionPreview {
  readonly fingerprint: string;
  readonly sourceScope: readonly SourceScopeItem[];
  /** The financial periods the source facts themselves belong to, ascending. */
  readonly sourcePeriods: readonly string[];
  readonly periods: readonly PeriodImpact[];
  readonly structuralChanges: readonly StructuralChange[];
  readonly sourceChanges: readonly IdentifiedSourceChange[];
}

/**
 * Whether an otherwise-ordinary operation needs the review ceremony (§55).
 *
 * The web layer asks this before a save it has no reason to think is
 * historical — recording a balance, accepting a suggestion, saving an account
 * form — so a hidden dormancy consequence opens the dialog instead of hitting
 * the server guard and looking like a failure.
 */
export type CorrectionPreparation =
  | { readonly status: 'not_required' }
  | { readonly status: 'review_required'; readonly preview: CorrectionPreview };

/** A committed correction, as the interface needs to describe it. */
export interface CorrectionCommitSummary {
  readonly sourceScope: readonly SourceScopeItem[];
  readonly sourcePeriods: readonly string[];
  /** The periods whose figures were recalculated, ascending. */
  readonly affectedPeriods: readonly string[];
  /** Whether the commit rewrote a dormant episode (§72). */
  readonly dormancyChanged: boolean;
}

/**
 * Confirm's outcome — a **protocol result**, not an error (ADR 0010 §12).
 *
 * `impact_changed` is a normal outcome of a two-step ceremony: the world moved
 * while the user was reading the preview, so the dialog re-renders from the
 * fresh one and asks again. It is deliberately not an `ErrorCode`: it is not a
 * failure to log and count alongside validation errors, and nothing was
 * written when it is returned.
 */
export type ConfirmCorrectionResult =
  | { readonly status: 'committed'; readonly summary: CorrectionCommitSummary }
  | { readonly status: 'impact_changed'; readonly preview: CorrectionPreview };
