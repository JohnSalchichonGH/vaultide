'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Deleting a record (blueprint 15.3; §71, §110 of the slice prompt).
 *
 * Two shapes, decided by which month the record belongs to, and each is the
 * right amount of ceremony for what is being removed:
 *
 *  - a **current-month** delete asks once, in place. Nothing that is already
 *    closed changes, so a full impact review would be noise around an action
 *    the user can simply do again;
 *  - a **historical** delete goes straight to Review → Confirm, because the
 *    review *is* the confirmation. Asking twice would train the user to click
 *    through the first one.
 *
 * The distinction is presentation only. Which delete is a Historical Correction
 * is the server's conclusion, and it refuses one that reaches it without
 * consent whatever this component decided (§25).
 */

const ACTION =
  'min-h-6 rounded-[var(--radius-control)] border px-2.5 py-1 text-[length:var(--text-meta)] font-medium disabled:opacity-60';

/** Whether a record's own date lies in a month before the one containing today. */
export function isHistorical(financialDate: string, today: string): boolean {
  return financialDate.slice(0, 7) < today.slice(0, 7);
}

export function DestructiveConfirm({
  testId,
  label,
  question,
  disabled,
  skipConfirmation = false,
  onConfirm,
}: {
  readonly testId: string;
  readonly label: string;
  readonly question: string;
  readonly disabled: boolean;
  readonly skipConfirmation?: boolean;
  readonly onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);

  if (skipConfirmation) {
    return (
      <button
        type="button"
        data-testid={testId}
        className={ACTION}
        disabled={disabled}
        onClick={onConfirm}
      >
        {label}
      </button>
    );
  }

  if (!asking) {
    return (
      <button
        type="button"
        data-testid={testId}
        className={ACTION}
        disabled={disabled}
        onClick={() => {
          setAsking(true);
        }}
      >
        {label}
      </button>
    );
  }

  return (
    <span
      className="flex flex-wrap items-center gap-2"
      role="group"
      aria-label={question}
      data-testid={`${testId}-confirm-panel`}
    >
      <span className="text-[length:var(--text-meta)]">{question}</span>
      <button
        type="button"
        data-testid={`${testId}-cancel`}
        className={ACTION}
        disabled={disabled}
        onClick={() => {
          setAsking(false);
        }}
      >
        Keep
      </button>
      <button
        type="button"
        data-testid={`${testId}-confirm`}
        className={cn(ACTION, 'border-[var(--color-negative)] text-[var(--color-negative)]')}
        disabled={disabled}
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {label}
      </button>
    </span>
  );
}

/**
 * A record added into a month that is already closed (30.22 item 2; §72, §107).
 *
 * A first assertion, not a revision: nothing the user previously stated is
 * being replaced, so there is no before → after to confirm and no second
 * dialog. What there is, is a consequence worth saying once — that month's
 * figures will be worked out again — so the form says it before the save rather
 * than leaving the user to notice afterwards.
 *
 * A creation that would also wake an account out of a dormant period anchored
 * in a closed month is a different thing, and the server says so: that one
 * opens the review, because an earlier assertion *is* being revised.
 */
export const HISTORICAL_CREATION_NOTE =
  'This adds new information to a month that is already closed. Vaultide will work that month out again after saving.';

/** Whether the form's own month has already ended. */
export function addsToCompletedMonth(bounds: {
  readonly max: string;
  readonly today: string;
}): boolean {
  return bounds.max < bounds.today;
}
