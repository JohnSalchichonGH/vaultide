'use server';

import { revalidatePath } from 'next/cache';
import {
  confirmHistoricalCorrection,
  getServices,
  previewHistoricalCorrection,
} from '@vaultide/application';
import { correctionInput } from '@vaultide/validation';
import { action, financialAction } from './define';

/**
 * Historical Correction (blueprint 15.3, 30.22; ADR 0010 §1, §8, §12).
 *
 * Two actions with deliberately different contracts, because they are two
 * different kinds of request.
 *
 * **Preview reads.** It writes no source row, no audit row, no review state and
 * no exchange rate, it takes no financial mutex, and it is not a financial
 * mutation — so it is declared with the ordinary wrapper and is named on
 * `financial-actions.test.ts`'s explicit non-financial list, where the reason
 * is a reviewable line rather than an invisible omission. It is still
 * authenticated: it reads a user's own financial records, and RLS scopes it to
 * them.
 *
 * **Confirm writes.** It is a financial mutation like any other — the
 * authoritative session (ADR 0003), the per-user write mutex, one atomic
 * transaction — and is registered in the write-boundary AST check.
 *
 * Neither accepts a `userId`, and neither accepts an impact, a before-image or
 * a "this is historical" claim. The draft is intent; everything else the server
 * derives for itself.
 */

/**
 * Ask what an operation would do, and whether it needs consent.
 *
 * The interface calls this from two places, and they are the same question:
 * before opening the review dialog for an edit it knows is historical, and as a
 * preflight before an ordinary-looking save that might have a dormancy
 * consequence it cannot see. `not_required` means "just save it".
 */
export const previewHistoricalCorrectionAction = action({
  name: 'corrections.preview',
  input: (ctx) => correctionInput.previewCorrectionInput(ctx.today),
  async handler({ input, ctx }) {
    return previewHistoricalCorrection(getServices().corrections, ctx, { draft: input.draft });
  },
});

/**
 * Commit a reviewed correction.
 *
 * `impact_changed` is a normal outcome and comes back as data, not as an error:
 * the world moved while the user was reading the preview, nothing was written,
 * and the dialog re-renders from the fresh preview it carries (ADR 0010 §12).
 *
 * Only a commit refreshes the pages: an `impact_changed` changed no source
 * truth, so there is nothing to revalidate.
 */
export const confirmHistoricalCorrectionAction = financialAction({
  name: 'corrections.confirm',
  input: (ctx) => correctionInput.confirmCorrectionInput(ctx.today),
  async handler({ input, ctx }) {
    const result = await confirmHistoricalCorrection(getServices().corrections, ctx, {
      draft: input.draft,
      fingerprint: input.fingerprint,
      reason: input.reason,
    });

    if (result.status === 'committed') {
      revalidatePath('/dashboard');
      revalidatePath('/accounts');
      revalidatePath('/expenses');
      revalidatePath('/', 'layout');
    }
    return result;
  },
});
