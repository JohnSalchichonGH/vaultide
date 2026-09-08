'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { CashMonthStateDto, PositionDetailDto } from '@vaultide/application';
import {
  confirmMonthEndAction,
  confirmUnchangedAction,
  correctValuationAction,
  deleteValuationAction,
  recordValuationAction,
} from '@/server/actions/positions';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MoneyText } from '@/components/finance/money-text';
import { normalizeMoneyInput } from '@/lib/money-input';
import { useHydrated } from '@/lib/use-hydrated';

/**
 * The valuation editor and the month-end section (blueprint 15.2, 15.3, 8.1,
 * M5, R15, R22).
 *
 * Two surfaces that look similar and mean different things, which is exactly
 * why the interface keeps them apart:
 *
 *  - **Record a balance** writes an ordinary snapshot, dated any day up to
 *    today. It says what the account held that day.
 *  - **Close a month** writes the *statement* balance for a month that has
 *    already ended. It is what a completed month reconciles against, and it is
 *    simply not offered until the month is over — not even on its last day
 *    (R15, C8).
 *
 * The month-end section below therefore only ever lists months the server would
 * accept. The server checks the same rule again, so a request that skips this
 * page is refused rather than believed.
 */

export interface ValuationEditorProps {
  readonly detail: PositionDetailDto;
  readonly today: string;
  readonly locale: string;
}

export function ValuationEditor({ detail, today, locale }: ValuationEditorProps) {
  const { position } = detail;
  const router = useRouter();
  const hydrated = useHydrated();
  const ids = { amount: useId(), date: useId() };

  const [amount, setAmount] = useState('');
  const [valuedOn, setValuedOn] = useState(today);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState('');

  const refresh = () => {
    router.refresh();
  };

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <h2 className="text-[length:var(--text-section)] font-semibold">Record a balance</h2>
        <form
          className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          data-testid="record-valuation"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            setSaved(null);
            startTransition(async () => {
              const result = await recordValuationAction({
                positionId: position.id,
                amount: normalizeMoneyInput(amount),
                valuedOn,
                datePrecision: 'exact',
              });
              if (!result.ok) {
                setError(result.error.message);
                return;
              }
              setSaved(`Balance recorded for ${result.data.valuedOn}.`);
              setAmount('');
              refresh();
            });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor={ids.amount}>
              Balance <span className="font-normal">({position.currency})</span>
            </Label>
            <Input
              id={ids.amount}
              data-testid="valuation-amount"
              inputMode="decimal"
              className="tabular text-right"
              value={amount}
              required
              onChange={(event) => {
                setAmount(event.target.value);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={ids.date}>As it was on</Label>
            <Input
              id={ids.date}
              data-testid="valuation-date"
              type="date"
              max={today}
              className="tabular"
              value={valuedOn}
              onChange={(event) => {
                setValuedOn(event.target.value);
              }}
            />
          </div>
          <button
            type="submit"
            data-testid="valuation-submit"
            disabled={!hydrated || pending}
            className="h-[var(--spacing-field)] rounded-[var(--radius-control)] bg-[var(--color-accent)] px-4 font-medium text-[var(--color-accent-foreground)] disabled:opacity-60"
          >
            {pending ? 'Saving…' : 'Record'}
          </button>
        </form>
        <p className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
          Today is {today}. A balance can never be dated later — a figure for a day that has not
          happened is a forecast, not a record.
        </p>
        {error === null ? null : (
          <p role="alert" data-testid="valuation-error" className="text-[length:var(--text-meta)] text-[var(--color-negative)]">
            {error}
          </p>
        )}
        {saved === null ? null : (
          <p role="status" data-testid="valuation-saved" className="text-[length:var(--text-meta)] text-[var(--color-positive)]">
            {saved}
          </p>
        )}
      </section>

      {position.kind === 'cash' ? (
        <MonthEndSection
          months={detail.monthsAwaitingStatement}
          positionId={position.id}
          locale={locale}
          minorUnits={position.minorUnits}
          onDone={refresh}
        />
      ) : null}

      <section className="space-y-3">
        <h2 className="text-[length:var(--text-section)] font-semibold">History</h2>
        {detail.valuations.length === 0 ? (
          <p className="text-[var(--color-muted-foreground)]">
            No balances recorded yet. Until one is, this position&rsquo;s value is unknown — which
            is not the same as zero, and net worth says so.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[length:var(--text-table)]" data-testid="valuation-history">
              <thead>
                <tr className="border-b text-left text-[var(--color-muted-foreground)]">
                  <th scope="col" className="py-2 pr-4 font-medium">Date</th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    Amount ({position.currency})
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    In {detail.reportingCurrency}
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">Kind</th>
                  <th scope="col" className="py-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail.valuations.map((valuation) => (
                  <tr key={valuation.id} className="border-b last:border-0">
                    <td className="tabular py-2 pr-4">{valuation.valuedOn}</td>
                    <td className="py-2 pr-4 text-right">
                      {editing === valuation.id ? (
                        <Input
                          data-testid="edit-valuation-amount"
                          inputMode="decimal"
                          className="tabular text-right"
                          value={editAmount}
                          onChange={(event) => {
                            setEditAmount(event.target.value);
                          }}
                        />
                      ) : (
                        <MoneyText
                          amount={valuation.amount.amount}
                          currency={valuation.amount.currency}
                          locale={locale}
                          minorUnits={position.minorUnits}
                        />
                      )}
                    </td>
                    <td className="py-2 pr-4 text-right text-[var(--color-muted-foreground)]">
                      <MoneyText
                        amount={valuation.reporting?.amount ?? null}
                        currency={valuation.reporting?.currency ?? detail.reportingCurrency}
                        locale={locale}
                        minorUnits={detail.reportingMinorUnits}
                        unavailableReason="No exchange rate for that date yet."
                      />
                    </td>
                    <td className="py-2 pr-4">
                      {valuation.datePrecision === 'month_end' ? (
                        <Badge tone="positive">Statement balance</Badge>
                      ) : (
                        <Badge tone="neutral">Snapshot</Badge>
                      )}
                      {valuation.source === 'confirmed_unchanged' ? (
                        <span className="ml-2 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
                          confirmed unchanged
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 text-right">
                      {editing === valuation.id ? (
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            data-testid="save-valuation-edit"
                            disabled={pending}
                            className="rounded-[var(--radius-control)] border px-2 py-1"
                            onClick={() => {
                              setError(null);
                              startTransition(async () => {
                                const result = await correctValuationAction({
                                  valuationId: valuation.id,
                                  expectedVersion: valuation.version,
                                  amount: normalizeMoneyInput(editAmount),
                                  valuedOn: valuation.valuedOn,
                                  datePrecision: valuation.datePrecision,
                                });
                                if (!result.ok) {
                                  setError(result.error.message);
                                  return;
                                }
                                setEditing(null);
                                refresh();
                              });
                            }}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className="rounded-[var(--radius-control)] border px-2 py-1"
                            onClick={() => {
                              setEditing(null);
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            data-testid={`edit-valuation-${valuation.valuedOn}`}
                            className="rounded-[var(--radius-control)] border px-2 py-1"
                            onClick={() => {
                              setEditing(valuation.id);
                              setEditAmount(valuation.amount.amount);
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            data-testid={`delete-valuation-${valuation.valuedOn}`}
                            disabled={pending}
                            className="rounded-[var(--radius-control)] border px-2 py-1"
                            onClick={() => {
                              setError(null);
                              startTransition(async () => {
                                const result = await deleteValuationAction({
                                  valuationId: valuation.id,
                                });
                                if (!result.ok) {
                                  setError(result.error.message);
                                  return;
                                }
                                refresh();
                              });
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
          Editing or deleting a balance keeps a full before-and-after record, and every figure
          derived from it simply reads differently afterwards — nothing was stored to go stale.
        </p>
      </section>
    </div>
  );
}

/**
 * Closing a completed month (8.1, R15, R22).
 *
 * Only months that have actually ended appear here — the server builds the
 * list — so on 30 September this section does not offer September at all, and
 * on 1 October it does.
 */
function MonthEndSection({
  months,
  positionId,
  locale,
  minorUnits,
  onDone,
}: {
  months: readonly CashMonthStateDto[];
  positionId: string;
  locale: string;
  minorUnits: number;
  onDone: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (months.length === 0) {
    return (
      <section className="space-y-2" data-testid="month-end-section">
        <h2 className="text-[length:var(--text-section)] font-semibold">Month-end balances</h2>
        <p className="text-[var(--color-muted-foreground)]" data-testid="month-end-none">
          Every completed month has its statement balance.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3" data-testid="month-end-section">
      <h2 className="text-[length:var(--text-section)] font-semibold">Month-end balances</h2>
      <p className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
        A month closes on its <strong>statement</strong> balance — the figure your bank shows for
        the last day of the month. A snapshot taken on that day is an ordinary snapshot until you
        confirm it as the statement figure.
      </p>

      <ul className="space-y-2">
        {months.map((month) => (
          <li
            key={month.month}
            data-testid={`month-end-${month.month}`}
            className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-control)] border p-3"
          >
            <div>
              <p className="font-medium">{month.month}</p>
              <p className="text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]">
                {month.confirmable === null
                  ? 'No statement balance yet.'
                  : 'A snapshot exists for the last day of the month.'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {month.confirmable === null ? null : (
                <button
                  type="button"
                  data-testid={`confirm-statement-${month.month}`}
                  disabled={pending}
                  className="rounded-[var(--radius-control)] border px-3 py-2"
                  onClick={() => {
                    setError(null);
                    startTransition(async () => {
                      const result = await confirmMonthEndAction({
                        valuationId: month.confirmable!.valuationId,
                        expectedVersion: month.confirmable!.version,
                      });
                      if (!result.ok) {
                        setError(result.error.message);
                        return;
                      }
                      onDone();
                    });
                  }}
                >
                  Confirm{' '}
                  <MoneyText
                    amount={month.confirmable.amount.amount}
                    currency={month.confirmable.amount.currency}
                    locale={locale}
                    minorUnits={minorUnits}
                  />{' '}
                  as the statement balance
                </button>
              )}
              {/*
               * Offered only once the previous month is closed: this carries
               * that month's statement balance forward, so without one there is
               * nothing to carry (8.1, R22). The server refuses it either way —
               * this exists so the reason is visible before the click, not
               * after it.
               */}
              <button
                type="button"
                data-testid={`confirm-unchanged-${month.month}`}
                disabled={pending || !month.canConfirmUnchanged}
                title={
                  month.canConfirmUnchanged
                    ? undefined
                    : 'Close the previous month first — this carries its statement balance forward.'
                }
                className="rounded-[var(--radius-control)] border px-3 py-2 disabled:opacity-60"
                onClick={() => {
                  setError(null);
                  startTransition(async () => {
                    const result = await confirmUnchangedAction({
                      positionId,
                      month: month.month,
                    });
                    if (!result.ok) {
                      setError(result.error.message);
                      return;
                    }
                    onDone();
                  });
                }}
              >
                Unchanged this month
              </button>
            </div>
          </li>
        ))}
      </ul>

      {error === null ? null : (
        <p role="alert" data-testid="month-end-error" className="text-[length:var(--text-meta)] text-[var(--color-negative)]">
          {error}
        </p>
      )}
    </section>
  );
}
