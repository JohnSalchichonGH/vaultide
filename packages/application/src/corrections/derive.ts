import type { Database, Transaction } from '@vaultide/db';
import type { RequestContext } from '../context';
import type { FxService } from '../fx/service';
import { classifyHistorical, sourcePeriodsOf } from './classify';
import type { CorrectionDraft } from './draft';
import {
  correctionWindow,
  loadCorrectionEvidenceIn,
  loadValuationHistoryIn,
  overlayCorrection,
} from './evidence';
import { withFingerprint } from './fingerprint';
import { deriveImpact } from './impact';
import { resolveCorrectionIn, type CorrectionPlan } from './resolve';
import type { CorrectionPreparation, CorrectionPreview, SourceScopeItem } from './types';

/**
 * Historical Correction: Preview and Confirm (blueprint 15.3, 30.22 items 1–4
 * and 12; ADR 0010 §1, §2, §8, §12, §13).
 *
 * The ceremony is two steps and they have deliberately different contracts.
 *
 * ```text
 * Preview   withUserRead    repeatable read, read only, RLS, no mutex
 * Confirm   withUserWrite   read committed, RLS, the per-user write mutex
 * ```
 *
 * **Preview writes nothing.** No source row, no audit row, no MonthReview row,
 * no exchange rate, no recurring occurrence claim — and it takes no mutex, so
 * it blocks no writer. It answers several questions about one coherent state of
 * the world, which is why it is one `REPEATABLE READ READ ONLY` transaction
 * rather than several ordinary reads: figures composed from two worlds would be
 * a preview of a state that never existed.
 *
 * **Confirm re-derives everything.** It resolves the draft again under the
 * mutex, against the newest committed state, loads the evidence again, derives
 * the impact again, fingerprints it again, and only then compares what the user
 * consented to. Nothing is written before that equality holds, and a mismatch
 * writes nothing at all.
 *
 * The order inside Confirm is the contract, and each step earns its place:
 *
 * ```text
 *  1  resolve the draft authoritatively (locks the target and its aggregate,
 *     checks versions, applies every domain rule, locks the references)
 *  2  derive the exact dormancy consequence          <- part of the resolution
 *  3  load the affected evidence
 *  4  derive BEFORE, overlay, derive AFTER
 *  5  derive the impact and the structural changes
 *  6  canonicalize and fingerprint
 *  7  compare
 *  8  apply the source mutations and the dormancy consequence, with the audit
 * ```
 *
 * Resolution comes **first**, so a moved version is `CONFLICT_VERSION` and an
 * occurrence somebody else recorded is its own duplicate conflict — not
 * `impact_changed`. `impact_changed` is for a draft that is still perfectly
 * valid and whose surrounding impact has moved (§59).
 */

export interface CorrectionDependencies {
  readonly db: Database;
  readonly fx: FxService;
}

export interface PreviewCorrectionArgs {
  readonly draft: CorrectionDraft;
}

export interface ConfirmCorrectionArgs {
  readonly draft: CorrectionDraft;
  /** The fingerprint of the preview the user actually reviewed. */
  readonly fingerprint: string;
  /** The user's own explanation, for the audit rows (18.1). Not fingerprinted. */
  readonly reason?: string | undefined;
}

const scopeOf = (resolved: CorrectionPlan): readonly SourceScopeItem[] =>
  resolved.plan.changes.map((change) => ({
    identity: change.identity,
    operation: change.operation,
  }));

/**
 * Derive one preview from a resolved correction, inside the caller's
 * transaction.
 *
 * Used by Preview and by Confirm, so the thing the user reviewed and the thing
 * the commit compares against are the same derivation over different snapshots,
 * never two implementations of the same idea.
 *
 * It opens no transaction of its own — it takes one — which is what lets
 * Confirm stay one atomic mutex-owned unit.
 */
export async function previewFromPlanIn(
  tx: Transaction,
  ctx: RequestContext,
  resolved: CorrectionPlan,
): Promise<CorrectionPreview> {
  const write = resolved.plan;
  // The balance history first, because how far a corrected balance reaches
  // depends on the balances after it. Then one window, used both to read the
  // rest and to judge: see `correctionWindow`.
  const history = await loadValuationHistoryIn(tx, ctx.today);
  const window = correctionWindow(write, ctx.today, history);
  const before = await loadCorrectionEvidenceIn(tx, ctx.today, history, window);
  const after = overlayCorrection(before, write);
  const sourcePeriods = sourcePeriodsOf(write);
  const impact = deriveImpact(write, before, after, sourcePeriods, window);

  return withFingerprint({
    sourceScope: scopeOf(resolved),
    sourcePeriods,
    periods: impact.periods,
    structuralChanges: impact.structuralChanges,
    sourceChanges: write.changes,
  });
}

/**
 * Resolve a draft, judge it, and preview it when it needs consent.
 *
 * `lock: false`: this is the read side, and a `READ ONLY` transaction cannot
 * take a row lock at all. Every rule it applies is the rule the write applies
 * (§21, §22).
 */
export async function prepareCorrectionIn(
  tx: Transaction,
  ctx: RequestContext,
  draft: CorrectionDraft,
): Promise<CorrectionPreparation> {
  const resolved = await resolveCorrectionIn(tx, ctx, draft, { lock: false });
  const review = classifyHistorical(resolved.plan, ctx.today);
  if (!review.required) return { status: 'not_required' };
  return { status: 'review_required', preview: await previewFromPlanIn(tx, ctx, resolved) };
}
