'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  dismissMonthAdvisoryAction,
  markMonthReviewedAction,
  restoreMonthAdvisoryAction,
} from '@/server/actions/monthly';
import { useHydrated } from '@/lib/use-hydrated';

/**
 * The month's review controls (blueprint 15.3, 20.3).
 *
 * Each sends one action and then asks the server for the page again: nothing is
 * filtered or recomputed in the browser, so what the page shows afterwards is
 * the server's answer with the new review state beside it. None of them changes
 * a figure.
 */

function useReviewAction() {
  const router = useRouter();
  const hydrated = useHydrated();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (send: () => Promise<{ ok: true } | { ok: false; error: { message: string } }>) => {
    setError(null);
    startTransition(async () => {
      const result = await send();
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      router.refresh();
    });
  };

  return { ready: hydrated && !pending, pending, error, run };
}

function ErrorLine({ error }: { readonly error: string | null }) {
  return error === null ? null : (
    <p role="alert" className="text-[length:var(--text-meta)] text-[var(--color-negative)]">
      {error}
    </p>
  );
}

const BUTTON =
  'rounded-[var(--radius-control)] border px-3 py-1.5 text-[length:var(--text-meta)] font-medium disabled:opacity-60';

/** "Mark reviewed" for a completed month. */
export function MarkReviewedButton({ month }: { readonly month: string }) {
  const { ready, pending, error, run } = useReviewAction();
  return (
    <div className="space-y-1">
      <button
        type="button"
        data-testid="mark-reviewed"
        disabled={!ready}
        className={`${BUTTON} bg-[var(--color-accent)] text-[var(--color-accent-foreground)]`}
        onClick={() => {
          run(() => markMonthReviewedAction({ month }));
        }}
      >
        {pending ? 'Saving…' : 'Mark reviewed'}
      </button>
      <ErrorLine error={error} />
    </div>
  );
}

/** Hide one advisory key for the month — every instance of it, as the store holds keys. */
export function DismissAdvisoryButton({
  month,
  issueKey,
  monthName,
  title,
}: {
  readonly month: string;
  readonly issueKey: string;
  readonly monthName: string;
  readonly title: string;
}) {
  const { ready, pending, error, run } = useReviewAction();
  return (
    <div className="space-y-1">
      <button
        type="button"
        data-testid={`dismiss-${issueKey}`}
        disabled={!ready}
        aria-label={`Hide “${title}” for ${monthName}`}
        className={BUTTON}
        onClick={() => {
          run(() => dismissMonthAdvisoryAction({ month, key: issueKey }));
        }}
      >
        {pending ? 'Hiding…' : `Hide for ${monthName}`}
      </button>
      <ErrorLine error={error} />
    </div>
  );
}

/** Show a dismissed advisory key again. */
export function RestoreAdvisoryButton({
  month,
  issueKey,
  title,
}: {
  readonly month: string;
  readonly issueKey: string;
  readonly title: string;
}) {
  const { ready, pending, error, run } = useReviewAction();
  return (
    <div className="space-y-1">
      <button
        type="button"
        data-testid={`restore-${issueKey}`}
        disabled={!ready}
        aria-label={`Show “${title}” again`}
        className={BUTTON}
        onClick={() => {
          run(() => restoreMonthAdvisoryAction({ month, key: issueKey }));
        }}
      >
        {pending ? 'Restoring…' : 'Show again'}
      </button>
      <ErrorLine error={error} />
    </div>
  );
}
