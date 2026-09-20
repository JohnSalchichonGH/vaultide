import type { PlainDate } from '@vaultide/finance';
import { HistoricalReviewRequiredError } from '../errors';
import type { ResolvedWrite } from '../write-plan';
import { classifyHistorical, type HistoricalReview } from './classify';

/**
 * The server-side boundary no ordinary financial write may cross
 * (blueprint 30.22 items 1 and 2; ADR 0010 §1).
 *
 * Every ordinary mutation resolves its operation first — the row it is about,
 * the values it would write, the dormant episode it would end — and then calls
 * this before it mutates anything. So a caller that reaches
 * `updateIncomeEntry`, `removeValuation` or `quickUpdate` directly cannot save
 * a revision of a closed month, and cannot wake a historical dormant episode,
 * merely by not going through the interface.
 *
 * It is deliberately **not** a flag the caller passes. Historical Confirm does
 * not "bypass" this check: it never calls the ordinary entry point at all. It
 * resolves the same operation, derives the impact, compares the consent
 * fingerprint the user actually saw, and only then applies the same plan
 * through the same apply function. There is no token, no boolean and nothing a
 * browser could send that turns the guard off.
 */
export function historicalReviewOf(write: ResolvedWrite, today: PlainDate): HistoricalReview {
  return classifyHistorical(write, today);
}

/**
 * The message the refusal carries.
 *
 * Two sentences at most, and the dormancy one says what the user could not have
 * predicted: that an ordinary-looking save was about to rewrite a period the
 * account was recorded as dormant over.
 */
function messageFor(review: HistoricalReview): string {
  if (review.reasons.includes('historical_dormancy')) {
    return 'This changes a period this account was recorded as dormant over, so it has to be reviewed before it is saved. Nothing was saved.';
  }
  return 'This changes a month that is already closed, so it has to be reviewed before it is saved. Nothing was saved.';
}

/** Refuse, having written nothing, when the resolved write needs consent. */
export function assertNoHistoricalReview(write: ResolvedWrite, today: PlainDate): void {
  const review = historicalReviewOf(write, today);
  if (!review.required) return;
  throw new HistoricalReviewRequiredError(
    review.reasons,
    review.completedPeriods,
    messageFor(review),
  );
}
