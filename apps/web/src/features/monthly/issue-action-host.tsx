'use client';

import { createContext, useContext, useId, useState, type ReactNode } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import type {
  ExpenseCategoryDto,
  MonthlyExpensesDto,
  MonthlyIncomeDto,
  MonthlyTransfersDto,
} from '@vaultide/application';
import { acceptAdjustmentAction } from '@/server/actions/flows';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MoneyText } from '@/components/finance/money-text';
import { QuickUpdate, type QuickUpdatePosition } from '@/features/accounts/quick-update';
import { useHydrated } from '@/lib/use-hydrated';
import { cn } from '@/lib/utils';
import { AddIncomeForm } from '@/features/monthly/income-editor';
import { AddExpenseForm } from '@/features/monthly/expenses-editor';
import { TransferEditor } from '@/features/monthly/transfers-editor';
import { dayTitle } from '@/features/monthly/presentation';
import type { IssueAction } from '@/features/monthly/issue-actions';

/**
 * The corrective controls beside an issue, and the one dialog behind them
 * (blueprint 15.3 section 8, 30.21; ADR 0009 §1, §4).
 *
 * One host for the whole panel rather than a modal per issue card. Two things
 * follow from that, and both matter:
 *
 *  - a dialog is opened with a **snapshot** of the action, so a refresh that
 *    arrives while it is open — a server action's response carries a fresh page
 *    — cannot replace the draft underneath the user;
 *  - the host knows which actions the page still offers, so when the issue
 *    behind an open dialog is gone it says so instead of showing stale
 *    certainty.
 *
 * Every dialog is an existing editor: the income form, the known-expense form,
 * the transfer editor, Quick update. Only the adjustment has a form of its own,
 * because it is the one action with nothing for a user to fill in.
 */

interface Formatting {
  readonly locale: string;
  readonly minorUnitsByCurrency: Readonly<Record<string, number>>;
}

/** Everything the dialogs need, from the composite read the page already made. */
export interface IssueActionResources {
  /** `YYYY-MM`. */
  readonly month: string;
  readonly monthName: string;
  readonly monthEndsOn: string;
  readonly today: string;
  readonly formatting: Formatting;
  readonly currencies: readonly string[];
  readonly defaultCurrency: string;
  readonly incomeAccounts: MonthlyIncomeDto['cashAccounts'];
  readonly expenseAccounts: MonthlyExpensesDto['cashAccounts'];
  readonly eligibleCategories: readonly ExpenseCategoryDto[];
  readonly transferAccounts: MonthlyTransfersDto['cashAccounts'];
  readonly quickUpdatePositions: readonly QuickUpdatePosition[];
  /** The days a row of this month may carry, for the forms that are not bounded by an issue. */
  readonly bounds: { readonly min: string; readonly max: string };
}

interface HostValue {
  readonly resources: IssueActionResources;
  readonly open: (action: IssueAction) => void;
  readonly offered: ReadonlySet<string>;
}

const HostContext = createContext<HostValue | null>(null);

const ACTION =
  'min-h-8 rounded-[var(--radius-control)] border px-2.5 py-1 text-[length:var(--text-meta)] font-medium disabled:opacity-60';
const PRIMARY = cn(
  ACTION,
  'border-transparent bg-[var(--color-accent)] text-[var(--color-accent-foreground)]',
);
const META = 'text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]';
const NEGATIVE = 'text-[length:var(--text-meta)] text-[var(--color-negative)]';

function useHost(): HostValue {
  const value = useContext(HostContext);
  if (value === null) throw new Error('An issue action needs its host.');
  return value;
}

/* -------------------------------------------------------------------------- */
/* The adjustment                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Whether this dialog may send the adjustment.
 *
 * `stale` means the page behind it no longer raises the issue, so the figure
 * this would confirm is one the month has moved past. The server refuses such
 * an acceptance on its own evidence (ADR 0009 §9) and stays the authority;
 * this only stops the user sending a confirmation that cannot succeed.
 */
export const canRecordAdjustment = (state: {
  readonly hydrated: boolean;
  readonly pending: boolean;
  readonly stale: boolean;
}): boolean => state.hydrated && !state.pending && !state.stale;

/**
 * Accepting the unexplained difference (ADR 0009 §5–§9).
 *
 * The one corrective dialog with no financial field: the amount is the month's
 * own, the date is where the discrepancy was measured, and there is no account
 * because the residual belongs to the bucket. What the user can add is a note,
 * and what they must do is confirm.
 */
export function AdjustmentForm({
  currency,
  amount,
  recordedOn,
  stale,
  onDone,
  onCancel,
  onBusyChange,
}: {
  readonly currency: string;
  readonly amount: { readonly amount: string; readonly currency: string };
  readonly recordedOn: string;
  readonly stale: boolean;
  readonly onDone: () => void;
  readonly onCancel: () => void;
  readonly onBusyChange: (busy: boolean) => void;
}) {
  const host = useHost();
  const router = useRouter();
  const hydrated = useHydrated();
  const noteId = useId();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const minorUnits = host.resources.formatting.minorUnitsByCurrency[currency] ?? 2;

  const submit = (): void => {
    if (pending) return;
    setPending(true);
    onBusyChange(true);
    setError(null);
    void acceptAdjustmentAction({
      month: host.resources.month,
      currency,
      expectedAmount: amount.amount,
      ...(note.trim() === '' ? {} : { note: note.trim() }),
    })
      .then((result) => {
        if (!result.ok) {
          setPending(false);
          onBusyChange(false);
          setError(result.error.message);
          return;
        }
        // Closed first: the refresh this save brings may take the issue — and
        // this dialog's own action — off the page.
        onDone();
        router.refresh();
      })
      .catch(() => {
        setPending(false);
        onBusyChange(false);
        setError('The adjustment could not be recorded — the server did not answer.');
      });
  };

  return (
    <form
      className="flex flex-col"
      data-testid="adjustment-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="max-h-[70vh] space-y-4 overflow-y-auto px-4 py-4 sm:px-6">
        {stale ? (
          <p role="alert" className={NEGATIVE} data-testid="issue-action-stale">
            This issue is no longer raised for {host.resources.monthName}. Close this and look at
            what the month says now.
          </p>
        ) : null}

        <p data-testid="adjustment-amount">
          Records{' '}
          <MoneyText
            amount={amount.amount}
            currency={amount.currency}
            locale={host.resources.formatting.locale}
            minorUnits={minorUnits}
            className="font-medium"
          />{' '}
          as a reconciliation adjustment in {currency}.
        </p>
        <p className={META} data-testid="adjustment-date">
          Vaultide records it on {dayTitle(recordedOn, host.resources.formatting.locale)}, the end
          of the period the difference was measured over. That is a bookkeeping date, not a claim
          about when the missing event happened, and the adjustment is attributed to no account.
        </p>
        <p className={META}>
          It makes the cash records add up, but it does not identify what caused the difference.
          Vaultide does not count it as income when it works out your savings. If you later find
          the missing transaction, record it and delete this adjustment from Income.
        </p>

        <div className="space-y-1.5">
          <Label htmlFor={noteId}>Note (optional)</Label>
          <Input
            id={noteId}
            data-testid="adjustment-note"
            value={note}
            maxLength={200}
            autoComplete="off"
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        </div>
      </div>

      <div className="space-y-2 border-t px-4 py-3 sm:px-6">
        {error === null ? null : (
          <p role="alert" className={NEGATIVE} data-testid="adjustment-error">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={ACTION} data-testid="adjustment-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className={PRIMARY}
            data-testid="adjustment-submit"
            disabled={!canRecordAdjustment({ hydrated, pending, stale })}
          >
            {pending ? 'Recording…' : 'Record adjustment'}
          </button>
        </div>
      </div>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* The host                                                                    */
/* -------------------------------------------------------------------------- */

const TITLES: Readonly<Record<string, string>> = {
  add_income: 'Add missing income',
  add_expense: 'Add a known expense',
  transfer: 'Record a transfer',
  adjustment: 'Record a reconciliation adjustment',
};

export function IssueActionHost({
  resources,
  offeredActionIds,
  children,
}: {
  readonly resources: IssueActionResources;
  /** Every action the page currently offers, for telling an open one it is stale. */
  readonly offeredActionIds: readonly string[];
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState<IssueAction | null>(null);
  const [busy, setBusy] = useState(false);
  const offered = new Set(offeredActionIds);
  const close = (): void => {
    setOpen(null);
    setBusy(false);
  };
  const stale = open !== null && !offered.has(open.id);

  return (
    <HostContext.Provider value={{ resources, open: setOpen, offered }}>
      {children}
      {open === null ? null : (
        <Modal
          title={TITLES[open.target.kind] ?? open.label}
          busy={busy}
          testId="issue-dialog"
          onClose={close}
        >
          <div data-testid="issue-dialog-body" data-action={open.id}>
            {open.target.kind === 'adjustment' ? (
              <AdjustmentForm
                currency={open.target.currency}
                amount={open.target.amount}
                recordedOn={open.target.recordedOn}
                stale={stale}
                onDone={close}
                onCancel={close}
                onBusyChange={setBusy}
              />
            ) : (
              <>
                {/* What the correction is, above whichever editor it opens. */}
                <div className="space-y-2 border-b px-4 py-3 sm:px-6">
                  {stale ? (
                    <p role="alert" className={NEGATIVE} data-testid="issue-action-stale">
                      This issue is no longer raised for {resources.monthName}. Anything you record
                      here is an ordinary record, not a correction of it.
                    </p>
                  ) : null}
                  <p className={META} data-testid="issue-dialog-hint">
                    {open.hint}
                  </p>
                </div>
                {open.target.kind === 'transfer' ? (
                  // The transfer editor brings its own scrolling body and its
                  // own Save and Cancel, so it is not wrapped again.
                  <TransferEditor
                    accounts={resources.transferAccounts}
                    // The issue's interval, not the page's: a correction dated
                    // past where its month-to-date stops would not touch it.
                    range={open.target.dates}
                    today={resources.today}
                    formatting={resources.formatting}
                    transfer={null}
                    initial={open.target.initial}
                    // The suggestion knows no day, so the editor asks for one.
                    defaultDate={null}
                    onDone={close}
                    onCancel={close}
                    onBusyChange={setBusy}
                  />
                ) : (
                  <div className="max-h-[70vh] overflow-y-auto px-4 py-4 sm:px-6">
                    {open.target.kind === 'add_income' ? (
                      <AddIncomeForm
                        accounts={resources.incomeAccounts}
                        currencies={resources.currencies}
                        bounds={open.target.dates}
                        today={resources.today}
                        defaultCurrency={resources.defaultCurrency}
                        initial={open.target.initial}
                        onSaved={close}
                      />
                    ) : (
                      <AddExpenseForm
                        accounts={resources.expenseAccounts}
                        eligibleCategories={resources.eligibleCategories}
                        currencies={resources.currencies}
                        bounds={resources.bounds}
                        today={resources.today}
                        defaultCurrency={resources.defaultCurrency}
                        formatting={resources.formatting}
                        initial={
                          open.target.kind === 'add_expense' ? open.target.initial : undefined
                        }
                        onSaved={close}
                      />
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </Modal>
      )}
    </HostContext.Provider>
  );
}

/* -------------------------------------------------------------------------- */
/* The controls                                                                */
/* -------------------------------------------------------------------------- */

/** An id a browser and a test can both address, from an action's own identity. */
const hintIdOf = (action: IssueAction): string =>
  `issue-action-${action.id.replaceAll(/[^a-zA-Z0-9]+/gu, '-')}-hint`;

function ActionButton({ action }: { readonly action: IssueAction }) {
  const host = useHost();
  const hydrated = useHydrated();
  return (
    <button
      type="button"
      data-testid="issue-action"
      data-action-id={action.id}
      aria-describedby={hintIdOf(action)}
      className={action.emphasis === 'primary' ? PRIMARY : ACTION}
      disabled={!hydrated}
      onClick={() => {
        host.open(action);
      }}
    >
      {action.label}
    </button>
  );
}

/**
 * One issue's controls.
 *
 * A link for a surface that already exists, a button for a focused form, and
 * Quick update rendered as itself — the same modal the Accounts section opens,
 * not a second implementation of it (ADR 0009 §4).
 */
export function IssueActionControls({ actions }: { readonly actions: readonly IssueAction[] }) {
  const host = useHost();
  if (actions.length === 0) return null;

  return (
    <ul className="space-y-3" data-testid="issue-actions">
      {actions.map((action) => (
        <li key={action.id} className="space-y-1.5">
          {action.target.kind === 'anchor' ? (
            <a
              href={action.target.anchor}
              data-testid="issue-action"
              data-action-id={action.id}
              aria-describedby={hintIdOf(action)}
              className={action.emphasis === 'primary' ? PRIMARY : ACTION}
            >
              {action.label}
            </a>
          ) : action.target.kind === 'link' ? (
            <Link
              href={action.target.href as Route}
              data-testid="issue-action"
              data-action-id={action.id}
              aria-describedby={hintIdOf(action)}
              className={action.emphasis === 'primary' ? PRIMARY : ACTION}
            >
              {action.label}
            </Link>
          ) : action.target.kind === 'quick_update' ? (
            <span data-testid="issue-action" data-action-id={action.id} className="inline-block">
              <QuickUpdate
                positions={host.resources.quickUpdatePositions}
                today={host.resources.today}
                locale={host.resources.formatting.locale}
                monthEndsOn={host.resources.monthEndsOn}
                label={action.label}
              />
            </span>
          ) : (
            <ActionButton action={action} />
          )}
          <p id={hintIdOf(action)} className={META}>
            {action.hint}
          </p>
        </li>
      ))}
    </ul>
  );
}
