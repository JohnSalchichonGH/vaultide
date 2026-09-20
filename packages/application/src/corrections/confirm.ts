import type { Transaction } from '@vaultide/db';
import type { RequestContext } from '../context';
import { withUserWrite } from '../coordination';
import { normalizeReason } from '../flows/shared';
import type { FxService } from '../fx/service';
import type { SupportWarm } from '../write-plan';
import {
  previewFromPlanIn,
  type ConfirmCorrectionArgs,
  type CorrectionDependencies,
} from './derive';
import { applyCorrectionIn, resolveCorrectionIn } from './resolve';
import type { ConfirmCorrectionResult } from './types';

/**
 * Historical Correction — Confirm (blueprint 30.22 item 12; ADR 0010 §12).
 *
 * ```text
 * withUserWrite   read committed, RLS, the per-user write mutex
 * ```
 *
 * A financial mutation like every other, and it earns nothing by being a
 * ceremony: the same mutex before the first authoritative read, the same
 * transaction for the validation, the decisions, the writes and the audit, and
 * the same `WRITE_BUSY` when contention exhausts the bounded retry.
 *
 * What it adds is one comparison, and the order around it is the contract:
 *
 * ```text
 *  1  resolve the draft authoritatively — the target and its aggregate locked,
 *     versions checked, every domain rule applied, references locked
 *  2  derive the exact dormancy consequence      <- part of that resolution
 *  3  load the affected evidence
 *  4  derive BEFORE, overlay in memory, derive AFTER
 *  5  derive the impact and the structural changes
 *  6  canonicalize and fingerprint
 *  7  compare against the fingerprint the user consented to
 *  8  only then: apply the source mutations, the dormancy consequence, the audit
 * ```
 *
 * Resolution comes **first** on purpose. A target whose version moved is
 * `CONFLICT_VERSION`, an occurrence somebody else recorded is its own duplicate
 * conflict, and a category archived in the meantime is refused under the lock
 * the resolution takes — none of them is dressed up as a changed impact.
 * `impact_changed` is reserved for a draft that is still perfectly valid and
 * whose surrounding, consent-relevant impact has moved (§59, §62).
 *
 * Nothing is written before the equality holds, and a mismatch writes nothing
 * at all: no source row, no audit row, no MonthReview row and no exchange rate.
 */

/** What the commit leaves for the post-commit support effect to do (10.4). */
interface ConfirmOutcome {
  readonly result: ConfirmCorrectionResult;
  readonly support: readonly SupportWarm[];
}

async function confirmIn(
  tx: Transaction,
  ctx: RequestContext,
  args: ConfirmCorrectionArgs,
): Promise<ConfirmOutcome> {
  const resolved = await resolveCorrectionIn(tx, ctx, args.draft, { lock: true });
  const fresh = await previewFromPlanIn(tx, ctx, resolved);

  if (fresh.fingerprint !== args.fingerprint) {
    return { result: { status: 'impact_changed', preview: fresh }, support: [] };
  }

  await applyCorrectionIn(tx, ctx, resolved, normalizeReason(args.reason));

  return {
    result: {
      status: 'committed',
      summary: {
        sourceScope: fresh.sourceScope,
        sourcePeriods: fresh.sourcePeriods,
        affectedPeriods: [...new Set(fresh.periods.map((period) => period.month))].sort(),
        dormancyChanged: resolved.plan.dormancy.some(
          (effect) =>
            effect.before.isDormant !== effect.after.isDormant ||
            effect.before.dormantFrom !== effect.after.dormantFrom,
        ),
      },
    },
    support: resolved.plan.support,
  };
}

/**
 * Warm the exchange-rate history the commit made worth having (10.4).
 *
 * After the commit and outside the mutex, from a descriptor the transaction
 * produced rather than a dependency it was handed: no provider IO ever happens
 * while a financial lock is held, and a publisher being down can never undo a
 * committed correction (ADR 0010 §16 item 6). It runs for a commit and for
 * nothing else — never for a preview, an `impact_changed` or a failed confirm,
 * each of which leaves `support` empty.
 */
async function warmCorrectionSupport(
  fx: FxService,
  support: readonly SupportWarm[],
): Promise<void> {
  for (const item of support) await fx.ensureHistory(item.currency, item.from);
}

export async function confirmHistoricalCorrection(
  deps: CorrectionDependencies,
  ctx: RequestContext,
  args: ConfirmCorrectionArgs,
): Promise<ConfirmCorrectionResult> {
  const outcome = await withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
    confirmIn(tx, ctx, args),
  );

  await warmCorrectionSupport(deps.fx, outcome.support);
  return outcome.result;
}
