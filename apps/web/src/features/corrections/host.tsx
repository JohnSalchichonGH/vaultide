'use client';

import { useEffect, useRef } from 'react';
import { CorrectionReview, type CorrectionReviewProps } from './review-dialog';
import type { CorrectionLabels } from './presentation';
import type { CorrectionFlow } from './use-correction';

/**
 * The review dialog, wherever an editor can open one (16.5).
 *
 * One line per editor rather than a copy of the dialog's wiring in each. It
 * renders nothing until a save has actually been told that consent is needed,
 * so an editor that never produces a correction pays nothing for it.
 */
export function CorrectionHost({
  flow,
  labels,
  onCommitted,
  onSettled,
}: {
  readonly flow: CorrectionFlow;
  readonly labels: CorrectionLabels;
  readonly onCommitted: () => void;
  readonly onSettled?: CorrectionReviewProps['onSettled'];
}) {
  const pending = flow.pending;
  if (pending === null) return null;

  // Stepped back: the edit is still unsaved and still needs consent, so the
  // way back in stays on screen rather than leaving a dead draft (§67).
  if (flow.paused) return <Reopen onReopen={flow.resume} />;

  return (
    <CorrectionReview
      draft={pending.draft}
      preview={pending.preview}
      labels={labels}
      onBack={flow.pause}
      onCommitted={() => {
        flow.clear();
        onCommitted();
      }}
      onSettled={onSettled}
    />
  );
}

/**
 * The way back into a review the user stepped out of.
 *
 * It takes the review's place, and often the place of the control that opened
 * the review too: this button itself, which gives way to the review it
 * reopens, or Bulk History's own Review changes, which gives way to this one.
 * Focus then has nothing to go back to and is left on the body, so when that
 * is where it is as this appears, it comes here (16.6). Where the opener is
 * still on the page the dialog has already given focus back to it, and this
 * leaves it there.
 */
function Reopen({ onReopen }: { readonly onReopen: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) ref.current?.focus();
  }, []);

  return (
    <button
      ref={ref}
      type="button"
      data-testid="correction-reopen"
      className="min-h-6 rounded-[var(--radius-control)] border px-2.5 py-1 text-[length:var(--text-meta)] font-medium"
      onClick={onReopen}
    >
      Review changes
    </button>
  );
}
