'use client';

import { useId, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { PositionDto } from '@vaultide/application';
import { quickUpdateAction } from '@/server/actions/positions';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { MoneyText } from '@/components/finance/money-text';
import { normalizeMoneyInput } from '@/lib/money-input';
import { useHydrated } from '@/lib/use-hydrated';
import { cn } from '@/lib/utils';

/**
 * Quick update (blueprint 15.3, M5, 20.3).
 *
 * Every active position is listed, with the balance it currently carries beside
 * an empty field. There is nothing to select: a field left blank keeps that
 * position's last snapshot, and only what you type is written. Dormant accounts
 * are left out entirely, because a dormant account is one the user has already
 * said carries at zero — asking again every month is the thing dormancy exists
 * to stop.
 *
 * Everything it writes is dated **today**, with `exact` precision. There is no
 * date field, and that is the design: no actual record may be dated in the
 * future, and a statement month-end balance is a different act performed after
 * the month has ended (M5, R15). On the last day of a month this modal says so
 * explicitly, because that is precisely when somebody would expect otherwise.
 *
 * Leaving a balance blank keeps that account's older snapshot. The submission
 * is one transaction: it lands completely or not at all (20.3).
 */

/**
 * What the modal reads of a position. `PositionDto` satisfies it, and so does a
 * Monthly account row, so both pages open the same modal (15.3).
 */
export type QuickUpdatePosition = Pick<
  PositionDto,
  'id' | 'name' | 'currency' | 'minorUnits' | 'status' | 'isDormant'
> & {
  readonly value: Pick<PositionDto['value'], 'native' | 'valuedOn'>;
};

export interface QuickUpdateProps {
  readonly positions: readonly QuickUpdatePosition[];
  readonly today: string;
  readonly locale: string;
  /** The last day of the current month, for the end-of-month note. */
  readonly monthEndsOn: string;
  /** The opening button's words: "Quick update" unless a page names it otherwise. */
  readonly label?: string;
}

interface Draft {
  readonly value: string;
  readonly error: string | null;
}

export function QuickUpdate({
  positions,
  today,
  locale,
  monthEndsOn,
  label = 'Quick update',
}: QuickUpdateProps) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const hydrated = useHydrated();
  const [pending, startTransition] = useTransition();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const updatable = positions.filter(
    (position) => position.status === 'active' && position.isDormant !== true,
  );

  const open = () => {
    setError(null);
    setSaved(null);
    setDrafts({});
    dialogRef.current?.showModal();
  };

  const setDraft = (position: QuickUpdatePosition, raw: string) => {
    const canonical = normalizeMoneyInput(raw);
    const decimals = canonical.split('.')[1]?.length ?? 0;
    const invalid =
      canonical !== '' &&
      (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(canonical) || decimals > position.minorUnits);

    setDrafts((current) => ({
      ...current,
      [position.id]: {
        value: raw,
        error: invalid
          ? position.minorUnits === 0
            ? 'This currency has no decimals.'
            : `Use digits and at most ${String(position.minorUnits)} decimals.`
          : null,
      },
    }));
  };

  const submit = () => {
    const entries = Object.entries(drafts)
      .map(([positionId, draft]) => ({
        positionId,
        amount: normalizeMoneyInput(draft.value),
        error: draft.error,
      }))
      .filter((entry) => entry.amount !== '');

    if (entries.some((entry) => entry.error !== null)) {
      setError('Check the highlighted amounts.');
      return;
    }
    if (entries.length === 0) {
      setError('Enter at least one balance.');
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await quickUpdateAction({
        entries: entries.map(({ positionId, amount }) => ({ positionId, amount })),
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setSaved(
        `Saved ${String(result.data.inserted + result.data.corrected)} balance${
          result.data.inserted + result.data.corrected === 1 ? '' : 's'
        } dated ${result.data.valuedOn}.`,
      );
      setDrafts({});
      router.refresh();
      dialogRef.current?.close();
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={open}
        disabled={!hydrated || updatable.length === 0}
        data-testid="quick-update-open"
        className="rounded-[var(--radius-control)] bg-[var(--color-accent)] px-4 py-2 font-medium text-[var(--color-accent-foreground)] disabled:opacity-60"
      >
        {label}
      </button>

      {saved === null ? null : (
        <p role="status" aria-live="polite" data-testid="quick-update-saved" className="text-[length:var(--text-meta)] text-[var(--color-positive)]">
          {saved}
        </p>
      )}

      <dialog
        ref={dialogRef}
        aria-labelledby={headingId}
        // `m-auto` is not decoration. A modal dialog is laid out with `inset:
        // 0` and fit-content sizing, and centres itself through the user
        // agent's `margin: auto` — which Tailwind's preflight resets to 0 along
        // with every other element's, dropping the dialog into the top-left
        // corner. Putting the margin back is what centres it.
        className="m-auto w-[min(40rem,92vw)] rounded-[var(--radius-surface)] border bg-[var(--color-surface)] p-0 text-[var(--color-foreground)] backdrop:bg-black/40"
        onCancel={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <div className="border-b px-6 py-4">
          <h2 id={headingId} className="text-[length:var(--text-section)] font-semibold">
            {label}
          </h2>
          <p className="mt-1 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
            Balances are recorded for <strong>{today}</strong>. Leave one blank to keep its last
            snapshot.
            {today === monthEndsOn ? (
              <>
                {' '}
                Today is the last day of the month, so these are ordinary snapshots — you can
                confirm them as statement balances from tomorrow.
              </>
            ) : null}
          </p>
        </div>

        <div className="max-h-[50vh] overflow-y-auto px-6 py-4">
          <ul className="space-y-3">
            {updatable.map((position) => {
              const draft = drafts[position.id];
              return (
                <li key={position.id} className="space-y-1">
                  <Label htmlFor={`quick-${position.id}`}>
                    {position.name}{' '}
                    <span className="font-normal">({position.currency})</span>
                  </Label>
                  <div className="flex items-center gap-3">
                    <Input
                      id={`quick-${position.id}`}
                      data-testid={`quick-balance-${position.id}`}
                      inputMode="decimal"
                      autoComplete="off"
                      value={draft?.value ?? ''}
                      aria-invalid={draft?.error != null}
                      aria-describedby={`quick-${position.id}-hint`}
                      className={cn('tabular text-right')}
                      onChange={(event) => {
                        setDraft(position, event.target.value);
                      }}
                    />
                    <span className="w-40 shrink-0 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
                      now{' '}
                      <MoneyText
                        amount={position.value.native?.amount ?? null}
                        currency={position.currency}
                        locale={locale}
                        minorUnits={position.minorUnits}
                        unavailableReason="No value recorded"
                      />
                    </span>
                  </div>
                  <p
                    id={`quick-${position.id}-hint`}
                    className={cn(
                      'text-[length:var(--text-meta)]',
                      draft?.error == null
                        ? 'text-[var(--color-muted-foreground)]'
                        : 'text-[var(--color-negative)]',
                    )}
                    role={draft?.error == null ? undefined : 'alert'}
                  >
                    {draft?.error ??
                      (position.value.valuedOn === null
                        ? 'No balance recorded yet.'
                        : `Last recorded ${position.value.valuedOn}.`)}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="flex items-center justify-between gap-3 border-t px-6 py-4">
          <p
            role={error === null ? undefined : 'alert'}
            aria-live="polite"
            data-testid="quick-update-error"
            className="text-[length:var(--text-meta)] text-[var(--color-negative)]"
          >
            {error}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-[var(--radius-control)] border px-4 py-2"
              disabled={pending}
              onClick={() => {
                dialogRef.current?.close();
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="quick-update-save"
              className="rounded-[var(--radius-control)] bg-[var(--color-accent)] px-4 py-2 font-medium text-[var(--color-accent-foreground)] disabled:opacity-60"
              disabled={pending}
              onClick={submit}
            >
              {pending ? 'Saving…' : 'Save balances'}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
