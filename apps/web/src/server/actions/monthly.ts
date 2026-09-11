'use server';

import { revalidatePath } from 'next/cache';
import {
  dismissMonthAdvisory,
  getServices,
  markMonthReviewed,
  parseMonth,
  restoreMonthAdvisory,
} from '@vaultide/application';
import { monthlyInput } from '@vaultide/validation';
import { action } from './define';

/**
 * The month's review state: marking a completed month reviewed, and hiding or
 * restoring an advisory key (blueprint 5.1, 6.2, 8.5, 20.3).
 *
 * **These are declared with the ordinary `action` wrapper, deliberately.** ADR
 * 0003 reserves `financialAction` for mutations that change a financial record —
 * a valuation, a flow, a balance, an account edit — and accepts the cookie
 * cache's five-minute window for state that is cheap, reversible and visible to
 * the account holder. Review state is exactly that: it changes no figure, no
 * status, no issue and no completeness result, a dismissal is restored with one
 * click, and a review mark only records that somebody looked. Each is named on
 * the non-financial list in `test/financial-actions.test.ts`, with this reason.
 *
 * The user comes from the session, never from the input; the month and the key
 * are validated for shape here and for meaning by the service — whether the
 * month is over or has begun, and whether the key is an advisory at all, are
 * answered from the request's today and the issue catalogue, never from the
 * client.
 */

function refreshMonth(month: string): void {
  revalidatePath(`/monthly/${month}`);
}

export const markMonthReviewedAction = action({
  name: 'monthly.markReviewed',
  input: monthlyInput.markMonthReviewedInput,
  async handler({ input, ctx }) {
    const review = await markMonthReviewed(getServices(), ctx, parseMonth(input.month));
    refreshMonth(input.month);
    return review;
  },
});

export const dismissMonthAdvisoryAction = action({
  name: 'monthly.dismissAdvisory',
  input: monthlyInput.monthAdvisoryInput,
  async handler({ input, ctx }) {
    const review = await dismissMonthAdvisory(getServices(), ctx, parseMonth(input.month), input.key);
    refreshMonth(input.month);
    return review;
  },
});

export const restoreMonthAdvisoryAction = action({
  name: 'monthly.restoreAdvisory',
  input: monthlyInput.monthAdvisoryInput,
  async handler({ input, ctx }) {
    const review = await restoreMonthAdvisory(getServices(), ctx, parseMonth(input.month), input.key);
    refreshMonth(input.month);
    return review;
  },
});
