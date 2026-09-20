import type { RequestContext } from '../context';
import { withUserRead } from '../coordination';
import { prepareCorrectionIn, type CorrectionDependencies, type PreviewCorrectionArgs } from './derive';
import type { CorrectionPreparation } from './types';

/**
 * Historical Correction — Preview (ADR 0010 §8; §27, §28 of the slice prompt).
 *
 * ```text
 * withUserRead   repeatable read, read only, RLS, no write mutex
 * ```
 *
 * **It writes nothing.** No source row, no audit row, no MonthReview row, no
 * exchange rate, no recurring-occurrence claim. It takes no mutex, so it blocks
 * no writer, and it calls no provider, so historical consent stays available
 * when the rate publisher is not (§78).
 *
 * It is one transaction rather than several because it answers several
 * questions about **one** coherent state of the world — what each affected
 * period says, which spans appear or disappear, which statuses move. Composed
 * from separate `READ COMMITTED` reads it could show a before taken from one
 * world beside an after taken from another, which is a preview of a state that
 * never existed.
 *
 * This module is deliberately separate from the Confirm module. A financial
 * mutation may not contain a second transaction boundary, and the architectural
 * test enforces that per module; keeping the read here is how the rule stays
 * exactly as strict as it was rather than being widened to accommodate this
 * feature.
 */
export async function previewHistoricalCorrection(
  deps: CorrectionDependencies,
  ctx: RequestContext,
  args: PreviewCorrectionArgs,
): Promise<CorrectionPreparation> {
  return withUserRead(deps.db, { userId: ctx.userId }, async (tx) =>
    prepareCorrectionIn(tx, ctx, args.draft),
  );
}
