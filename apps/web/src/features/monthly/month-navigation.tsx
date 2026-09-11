'use client';

import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { useHydrated } from '@/lib/use-hydrated';
import { isEditableTarget, isOpenableMonth } from '@/features/monthly/presentation';

/**
 * Moving between months (blueprint 15.3: "`[`/`]` previous/next month").
 *
 * Every month the links and keys can reach was decided by the server from the
 * request's today: there is a previous month always, a next month only up to
 * the current one, and nothing ever points into the future. The direct control
 * is checked against the same current month before it navigates, and the page
 * refuses a future month again on the server.
 *
 * The shortcuts leave alone any key pressed in something that takes text, and
 * any press with a modifier, so typing `[` into a field never changes month.
 */

export interface MonthNavigationProps {
  readonly month: string;
  readonly previous: string;
  readonly next: string | null;
  readonly current: string;
  readonly previousLabel: string;
  readonly nextLabel: string | null;
}

const monthHref = (month: string): Route => `/monthly/${month}` as Route;

export function MonthNavigation({
  month,
  previous,
  next,
  current,
  previousLabel,
  nextLabel,
}: MonthNavigationProps) {
  const router = useRouter();
  const hydrated = useHydrated();
  const inputId = useId();
  const [value, setValue] = useState(month);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (isEditableTarget(event.target instanceof HTMLElement ? event.target : null)) return;
      if (event.key === '[') {
        event.preventDefault();
        router.push(monthHref(previous));
      } else if (event.key === ']' && next !== null) {
        event.preventDefault();
        router.push(monthHref(next));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [router, previous, next]);

  const go = () => {
    const trimmed = value.trim();
    if (!isOpenableMonth(trimmed, current)) {
      setError(`Choose a month as YYYY-MM, up to ${current}.`);
      return;
    }
    setError(null);
    router.push(monthHref(trimmed));
  };

  return (
    <nav aria-label="Months" className="flex flex-wrap items-end gap-3">
      <Link
        href={monthHref(previous)}
        data-testid="month-previous"
        aria-keyshortcuts="["
        className="rounded-[var(--radius-control)] border px-3 py-1.5 text-[length:var(--text-meta)]"
      >
        <span aria-hidden="true">← </span>
        {previousLabel}
      </Link>
      {next === null || nextLabel === null ? null : (
        <Link
          href={monthHref(next)}
          data-testid="month-next"
          aria-keyshortcuts="]"
          className="rounded-[var(--radius-control)] border px-3 py-1.5 text-[length:var(--text-meta)]"
        >
          {nextLabel}
          <span aria-hidden="true"> →</span>
        </Link>
      )}
      <form
        className="flex items-end gap-2"
        // The check below says why a month cannot be opened, in words and
        // accessibly; the browser's own range bubble would block it silently.
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          go();
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={inputId} className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
            Go to month
          </label>
          <input
            id={inputId}
            type="month"
            data-testid="month-picker"
            max={current}
            value={value}
            placeholder="YYYY-MM"
            aria-invalid={error !== null}
            aria-describedby={error === null ? undefined : `${inputId}-error`}
            onChange={(event) => {
              setValue(event.target.value);
            }}
            className="tabular h-8 rounded-[var(--radius-control)] border bg-[var(--color-surface)] px-2 text-[length:var(--text-meta)]"
          />
        </div>
        <button
          type="submit"
          data-testid="month-go"
          disabled={!hydrated}
          className="h-8 rounded-[var(--radius-control)] border px-3 text-[length:var(--text-meta)] disabled:opacity-60"
        >
          Open
        </button>
      </form>
      {error === null ? null : (
        <p
          id={`${inputId}-error`}
          role="alert"
          data-testid="month-picker-error"
          className="w-full text-[length:var(--text-meta)] text-[var(--color-negative)]"
        >
          {error}
        </p>
      )}
      <p className="w-full text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
        Press <kbd>[</kbd> for the previous month{next === null ? '' : <> and <kbd>]</kbd> for the next</>}.
      </p>
    </nav>
  );
}
