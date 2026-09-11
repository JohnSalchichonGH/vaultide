'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import type {
  AccountOpeningDto,
  CompletedAccountDto,
  CompletedAccountsDto,
  CurrentAccountDto,
  CurrentAccountsDto,
} from '@vaultide/application';
import {
  confirmMonthEndAction,
  confirmUnchangedAction,
  confirmUnchangedBatchAction,
  correctValuationAction,
  quickUpdateAction,
  recordValuationAction,
} from '@/server/actions/positions';
import { Badge } from '@/components/ui/badge';
import { MoneyText } from '@/components/finance/money-text';
import { QuickUpdate } from '@/features/accounts/quick-update';
import { normalizeMoneyInput } from '@/lib/money-input';
import { useHydrated } from '@/lib/use-hydrated';
import { cn } from '@/lib/utils';
import { dayTitle } from '@/features/monthly/presentation';
import {
  accountStatus,
  anyUnchangedEligible,
  latestText,
  openingText,
  quickUpdatePositionsOf,
  structuralClosingText,
  untouchedUnchangedTargets,
} from '@/features/monthly/accounts-presentation';
import {
  IDLE,
  decideOnBlur,
  fieldValueOf,
  isProblem,
  runSave,
  sameDecimal,
  saveStateText,
  type SaveOutcome,
  type SaveState,
} from '@/features/monthly/autosave';

/**
 * Monthly's Accounts section (blueprint 15.3 section 4, 16.4–16.6, 20.3).
 *
 * A completed month shows Account · Previous · Current · Status: the statement
 * at the end of the month is entered, corrected, confirmed from a last-day
 * snapshot, or confirmed unchanged. The current month shows Account · Previous ·
 * Latest balance · Update today, and never a month-end control — not even on
 * its last day (M5, R15).
 *
 * Every write is an existing valuation action, and every one is judged again by
 * the server. After a save the page asks the server for itself again: the
 * route is dynamic and every position action already revalidates the root
 * layout, so `router.refresh()` is what replaces this page's state — the
 * reconciliation, the statuses, the openings — with the server's result. None
 * of it is recomputed here.
 */

interface Formatting {
  readonly locale: string;
  readonly minorUnitsByCurrency: Readonly<Record<string, number>>;
}

const minorUnitsOf = (formatting: Formatting, currency: string): number =>
  formatting.minorUnitsByCurrency[currency] ?? 2;

const monthHref = (month: string): Route => `/monthly/${month}#accounts` as Route;

const META = 'text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]';
const ACTION =
  'min-h-6 rounded-[var(--radius-control)] border px-2.5 py-1 text-[length:var(--text-meta)] font-medium disabled:opacity-60';

/** Every amount field of the section, in order, for Enter-moves-down (15.3). */
function focusNextAmount(input: HTMLInputElement): void {
  const fields = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[data-monthly-amount]:not([disabled])'),
  );
  const next = fields[fields.indexOf(input) + 1];
  if (next === undefined) input.blur();
  else next.focus();
}

/* -------------------------------------------------------------------------- */
/* Shared cells                                                                */
/* -------------------------------------------------------------------------- */

/** A field's save state, announced politely (16.6); empty while idle. */
export function SaveStatus({ id, state }: { readonly id: string; readonly state: SaveState }) {
  return (
    <span
      id={id}
      role="status"
      aria-live="polite"
      data-testid="save-status"
      data-state={state.kind}
      className={cn(
        'block text-[length:var(--text-meta)]',
        isProblem(state) ? 'text-[var(--color-negative)]' : 'text-[var(--color-muted-foreground)]',
      )}
    >
      {saveStateText(state)}
    </span>
  );
}

interface AmountFieldProps<Target> {
  /** Names the field for assistive technology; the table header is its visual label. */
  readonly label: string;
  readonly testId: string;
  /** The server's amount this field edits, or `null` when there is none yet. */
  readonly saved: string | null;
  /**
   * What an edit that starts now is based on — the row and version it would
   * correct, or none. Captured at the first keystroke, so a value refreshed in
   * underneath is a conflict rather than something to overwrite (20.3).
   */
  readonly target: Target;
  readonly minorUnits: number;
  readonly state: SaveState;
  readonly describedBy: string;
  readonly disabled: boolean;
  readonly onCommit: (amount: string, target: Target) => Promise<SaveState>;
  readonly onInvalid: (message: string) => void;
  readonly onReverted: () => void;
  readonly onTouched: () => void;
}

/**
 * One amount, saved when the field is left.
 *
 * What was typed stays in the field until the server's page replaces it: while
 * the save is pending, after a conflict or an error, and until the refreshed
 * value arrives.
 */
function AmountField<Target>(props: AmountFieldProps<Target>) {
  const inputId = useId();
  const [draft, setDraft] = useState<{
    readonly value: string;
    readonly target: Target;
    readonly committed: boolean;
  } | null>(null);
  const { saved } = props;

  // The server's value moved — the refresh after this field's own save, or a
  // reload. A saved draft, or one that now equals the server, has done its job.
  useEffect(() => {
    setDraft((current) =>
      current !== null &&
      (current.committed || (saved !== null && sameDecimal(normalizeMoneyInput(current.value), saved)))
        ? null
        : current,
    );
  }, [saved]);

  const value = draft?.value ?? (saved === null ? '' : fieldValueOf(saved, props.minorUnits));

  const commit = async (): Promise<void> => {
    if (draft === null || draft.committed) return;
    const decision = decideOnBlur({ draft: draft.value, saved, minorUnits: props.minorUnits });
    if (decision.kind === 'unchanged') {
      setDraft(null);
      props.onReverted();
      return;
    }
    if (decision.kind === 'invalid') {
      props.onInvalid(decision.message);
      return;
    }
    const final = await props.onCommit(decision.amount, draft.target);
    if (final.kind === 'saved') {
      setDraft((current) => (current === null ? null : { ...current, committed: true }));
    }
  };

  return (
    <>
      <label htmlFor={inputId} className="sr-only">
        {props.label}
      </label>
      <input
        id={inputId}
        data-testid={props.testId}
        data-monthly-amount=""
        inputMode="decimal"
        enterKeyHint="next"
        autoComplete="off"
        spellCheck={false}
        value={value}
        disabled={props.disabled}
        readOnly={props.state.kind === 'saving'}
        aria-busy={props.state.kind === 'saving'}
        aria-invalid={isProblem(props.state)}
        aria-describedby={props.describedBy}
        className="tabular h-9 w-24 rounded-[var(--radius-control)] border bg-[var(--color-surface)] px-2 text-right text-[length:var(--text-table)] sm:w-36 aria-[invalid=true]:border-[var(--color-negative)]"
        onChange={(event) => {
          const next = event.target.value;
          setDraft((current) =>
            current === null || current.committed
              ? { value: next, target: props.target, committed: false }
              : { ...current, value: next },
          );
          props.onTouched();
        }}
        onBlur={() => {
          void commit();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          focusNextAmount(event.currentTarget);
        }}
      />
    </>
  );
}

/** An account's opening — its Previous cell — as the server stated it. */
function OpeningCell({
  opening,
  currency,
  formatting,
  previousMonth,
  previousMonthName,
}: {
  readonly opening: AccountOpeningDto;
  readonly currency: string;
  readonly formatting: Formatting;
  readonly previousMonth: string;
  readonly previousMonthName: string;
}) {
  if (opening.kind === 'statement') {
    return (
      <span className="flex flex-col items-end" data-testid="account-opening">
        <MoneyText
          amount={opening.amount.amount}
          currency={currency}
          locale={formatting.locale}
          minorUnits={minorUnitsOf(formatting, currency)}
          className="whitespace-nowrap"
        />
        <span className={META}>Statement, {dayTitle(opening.valuedOn, formatting.locale)}</span>
      </span>
    );
  }
  return (
    <span className="flex flex-col items-end text-right" data-testid="account-opening">
      <span className={opening.kind === 'no_statement' ? 'text-[var(--color-negative)]' : undefined}>
        {openingText(opening, previousMonthName)}
      </span>
      {opening.kind === 'no_statement' && opening.state === 'carried' ? (
        <Link href={monthHref(previousMonth)} className="text-[length:var(--text-meta)] underline">
          Open {previousMonthName}
        </Link>
      ) : null}
    </span>
  );
}

function AccountName({
  name,
  currency,
  dormant,
}: {
  readonly name: string;
  readonly currency: string;
  readonly dormant: boolean;
}) {
  return (
    <>
      <span className="font-medium">{name}</span>
      <span className={cn('block', META)}>
        {currency}
        {dormant ? ' · dormant' : ''}
      </span>
    </>
  );
}

/**
 * A dense table that scrolls sideways inside its own container on a narrow
 * screen, with the account column kept in view (16.2, 16.4, 16.5).
 */
function Table({
  caption,
  columns,
  children,
  testId,
}: {
  readonly caption: string;
  readonly columns: readonly { readonly label: string; readonly numeric: boolean }[];
  readonly children: ReactNode;
  readonly testId: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[length:var(--text-table)]" data-testid={testId}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b text-left text-[var(--color-muted-foreground)]">
            {columns.map((column, index) => (
              <th
                key={column.label}
                scope="col"
                className={cn(
                  'py-2 pr-2 font-medium sm:pr-4',
                  index === 0 && 'sticky left-0 z-10 bg-[var(--color-surface)]',
                  column.numeric && 'text-right',
                )}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const ROW = 'border-b align-top last:border-0';
const NAME_CELL =
  'sticky left-0 z-10 bg-[var(--color-surface)] py-2 pr-2 text-left font-normal sm:pr-4';

/* -------------------------------------------------------------------------- */
/* A completed month                                                           */
/* -------------------------------------------------------------------------- */

type ClosingTarget =
  | { readonly kind: 'record' }
  | { readonly kind: 'correct'; readonly valuationId: string; readonly version: number };

interface CompletedRowProps {
  readonly account: CompletedAccountDto;
  readonly month: string;
  readonly monthEndsOn: string;
  readonly previousMonth: string;
  readonly previousMonthName: string;
  readonly formatting: Formatting;
  readonly hydrated: boolean;
  readonly onTouched: (positionId: string) => void;
}

function CompletedAccountRow({
  account,
  month,
  monthEndsOn,
  previousMonth,
  previousMonthName,
  formatting,
  hydrated,
  onTouched,
}: CompletedRowProps) {
  const router = useRouter();
  const statusId = useId();
  const hintId = useId();
  const [state, setState] = useState<SaveState>(IDLE);
  const [generation, setGeneration] = useState(0);
  const { closing, currency, positionId } = account;
  const minorUnits = minorUnitsOf(formatting, currency);
  const status = accountStatus(account, previousMonthName);

  const run = (send: () => Promise<SaveOutcome>): Promise<SaveState> =>
    runSave(send, setState, () => {
      router.refresh();
    });

  // The balance at the end of M: dated `end(M)`, `month_end` precision, always
  // (8.1). A missing one is created; an existing row — a statement, or the
  // last-day snapshot the typed figure replaces — is corrected against the
  // version the edit started from.
  const commit = (amount: string, target: ClosingTarget): Promise<SaveState> =>
    run(() =>
      target.kind === 'record'
        ? recordValuationAction({ positionId, valuedOn: monthEndsOn, amount, datePrecision: 'month_end' })
        : correctValuationAction({
            valuationId: target.valuationId,
            expectedVersion: target.version,
            valuedOn: monthEndsOn,
            amount,
            datePrecision: 'month_end',
          }),
    );

  const reload = () => {
    setState(IDLE);
    setGeneration((current) => current + 1);
    router.refresh();
  };

  const day = (date: string) => dayTitle(date, formatting.locale);
  const hasHint =
    closing.kind === 'last_day_snapshot' || (closing.kind === 'no_statement' && closing.latestSnapshot !== null);
  const busy = !hydrated || state.kind === 'saving';

  return (
    <tr className={ROW} data-testid="monthly-account" data-position-id={positionId}>
      <th scope="row" className={NAME_CELL}>
        <AccountName name={account.name} currency={currency} dormant={account.dormant} />
      </th>
      <td className="py-2 pr-2 text-right sm:pr-4">
        <OpeningCell
          opening={account.opening}
          currency={currency}
          formatting={formatting}
          previousMonth={previousMonth}
          previousMonthName={previousMonthName}
        />
      </td>
      <td className="py-2 pr-2 text-right sm:pr-4" data-testid="account-closing">
        {closing.kind === 'closed_zero' || closing.kind === 'dormant_zero' ? (
          <span>{structuralClosingText(closing)}</span>
        ) : (
          <div className="flex flex-col items-end gap-1">
            <AmountField<ClosingTarget>
              key={generation}
              label={`${account.name}: balance at the end of ${day(monthEndsOn)} (${currency})`}
              testId="closing-amount"
              saved={closing.kind === 'no_statement' ? null : closing.amount.amount}
              target={
                closing.kind === 'no_statement'
                  ? { kind: 'record' }
                  : { kind: 'correct', valuationId: closing.valuationId, version: closing.version }
              }
              minorUnits={minorUnits}
              state={state}
              describedBy={hasHint ? `${statusId} ${hintId}` : statusId}
              disabled={!hydrated}
              onCommit={commit}
              onInvalid={(message) => {
                setState({ kind: 'invalid', message });
              }}
              onReverted={() => {
                setState(IDLE);
              }}
              onTouched={() => {
                onTouched(positionId);
              }}
            />
            {closing.kind === 'statement' ? (
              <span className={META}>{closing.confirmedUnchanged ? 'Confirmed unchanged' : 'Statement balance'}</span>
            ) : null}
            {closing.kind === 'last_day_snapshot' ? (
              <>
                <span id={hintId} className={META} data-testid="closing-hint">
                  Snapshot on {day(monthEndsOn)} — not yet a statement balance
                </span>
                <button
                  type="button"
                  data-testid="confirm-statement"
                  disabled={busy}
                  className={ACTION}
                  onClick={() => {
                    onTouched(positionId);
                    void run(() =>
                      confirmMonthEndAction({ valuationId: closing.valuationId, expectedVersion: closing.version }),
                    );
                  }}
                >
                  Confirm as statement balance
                </button>
              </>
            ) : null}
            {closing.kind === 'no_statement' ? (
              <>
                {closing.latestSnapshot === null ? null : (
                  <span id={hintId} className={META} data-testid="closing-hint">
                    Last snapshot{' '}
                    <MoneyText
                      amount={closing.latestSnapshot.amount.amount}
                      currency={currency}
                      locale={formatting.locale}
                      minorUnits={minorUnits}
                    />{' '}
                    on {day(closing.latestSnapshot.valuedOn)}
                  </span>
                )}
                {closing.canConfirmUnchanged ? (
                  <button
                    type="button"
                    data-testid="confirm-unchanged"
                    disabled={busy}
                    className={ACTION}
                    onClick={() => {
                      onTouched(positionId);
                      void run(() => confirmUnchangedAction({ positionId, month }));
                    }}
                  >
                    Unchanged this month
                  </button>
                ) : null}
              </>
            ) : null}
            <SaveStatus id={statusId} state={state} />
            {state.kind === 'conflict' ? (
              <button type="button" className={ACTION} data-testid="reload-account" onClick={reload}>
                Reload
              </button>
            ) : null}
          </div>
        )}
      </td>
      <td className="py-2" data-testid="account-status">
        <Badge tone={status.tone}>
          <span aria-hidden="true">{status.glyph}</span>
          {status.label}
        </Badge>
        {account.state.firstBalance ? (
          <span className={cn('block', META)}>Not part of this month’s spending</span>
        ) : null}
      </td>
    </tr>
  );
}

export interface CompletedAccountsEditorProps {
  readonly month: string;
  readonly monthName: string;
  readonly monthEndsOn: string;
  readonly previousMonthName: string;
  readonly accounts: CompletedAccountsDto;
  readonly formatting: Formatting;
}

export function CompletedAccountsEditor({
  month,
  monthName,
  monthEndsOn,
  previousMonthName,
  accounts,
  formatting,
}: CompletedAccountsEditorProps) {
  const router = useRouter();
  const hydrated = useHydrated();
  const batchStatusId = useId();
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const [batch, setBatch] = useState<SaveState>(IDLE);

  const targets = untouchedUnchangedTargets(accounts.accounts, touched);
  const markTouched = (positionId: string) => {
    setTouched((current) => (current.has(positionId) ? current : new Set([...current, positionId])));
  };

  const confirmAll = () => {
    const positionIds = targets.map((account) => account.positionId);
    void runSave(() => confirmUnchangedBatchAction({ month, positionIds }), setBatch, () => {
      router.refresh();
    });
  };

  if (accounts.accounts.length === 0) {
    return (
      <p className="text-[var(--color-muted-foreground)]" data-testid="accounts-empty">
        No cash account took part in {monthName}.{' '}
        <Link href="/accounts" className="underline">
          Add an account
        </Link>
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <Table
        caption={`Cash accounts in ${monthName}: the statement at the end of ${previousMonthName}, and at the end of ${monthName}`}
        columns={[
          { label: 'Account', numeric: false },
          { label: `Previous (end of ${previousMonthName})`, numeric: true },
          { label: `Current (end of ${monthName})`, numeric: true },
          { label: 'Status', numeric: false },
        ]}
        testId="monthly-accounts"
      >
        {accounts.accounts.map((account) => (
          <CompletedAccountRow
            key={account.positionId}
            account={account}
            month={month}
            monthEndsOn={monthEndsOn}
            previousMonth={accounts.previousMonth}
            previousMonthName={previousMonthName}
            formatting={formatting}
            hydrated={hydrated}
            onTouched={markTouched}
          />
        ))}
      </Table>

      {anyUnchangedEligible(accounts.accounts) || batch.kind !== 'idle' ? (
        <div className="space-y-1" data-testid="confirm-all-unchanged-panel">
          <button
            type="button"
            data-testid="confirm-all-unchanged"
            disabled={!hydrated || targets.length === 0 || batch.kind === 'saving'}
            aria-describedby={batchStatusId}
            className={ACTION}
            onClick={confirmAll}
          >
            Confirm all untouched as unchanged
          </button>
          <p className={META}>
            {targets.length === 0
              ? 'Every account that could be confirmed unchanged has been edited here.'
              : `Carries each account’s ${previousMonthName} statement balance to the end of ${monthName}, for the ${String(targets.length)} account${targets.length === 1 ? '' : 's'} you have not edited here: ${targets.map((account) => account.name).join(', ')}. All of them, or none.`}
          </p>
          <SaveStatus id={batchStatusId} state={batch} />
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The current month                                                           */
/* -------------------------------------------------------------------------- */

interface TodayTarget {
  /** The version of today's snapshot when the edit began, or `null` when there was none. */
  readonly version: number | null;
}

interface CurrentRowProps {
  readonly account: CurrentAccountDto;
  readonly today: string;
  readonly previousMonth: string;
  readonly previousMonthName: string;
  readonly formatting: Formatting;
  readonly hydrated: boolean;
}

function CurrentAccountRow({
  account,
  today,
  previousMonth,
  previousMonthName,
  formatting,
  hydrated,
}: CurrentRowProps) {
  const router = useRouter();
  const statusId = useId();
  const [state, setState] = useState<SaveState>(IDLE);
  const [generation, setGeneration] = useState(0);
  const { currency, positionId, latest, todaySnapshot } = account;
  const minorUnits = minorUnitsOf(formatting, currency);
  const day = (date: string) => dayTitle(date, formatting.locale);

  // An exact snapshot dated the server's today, through Quick update's own
  // write: today's row is corrected rather than duplicated (M1), and there is
  // no date to choose (M5).
  const commit = (amount: string, target: TodayTarget): Promise<SaveState> => {
    if (target.version === null && todaySnapshot !== null) {
      // Today's balance was recorded elsewhere while this one was being typed.
      const conflict: SaveState = {
        kind: 'conflict',
        message: 'Today’s balance for this account was recorded elsewhere meanwhile.',
      };
      setState(conflict);
      return Promise.resolve(conflict);
    }
    return runSave(
      () =>
        quickUpdateAction({
          entries: [
            { positionId, amount, ...(target.version === null ? {} : { expectedVersion: target.version }) },
          ],
        }),
      setState,
      () => {
        router.refresh();
      },
    );
  };

  const reload = () => {
    setState(IDLE);
    setGeneration((current) => current + 1);
    router.refresh();
  };

  return (
    <tr className={ROW} data-testid="monthly-account" data-position-id={positionId}>
      <th scope="row" className={NAME_CELL}>
        <AccountName name={account.name} currency={currency} dormant={account.dormant} />
      </th>
      <td className="py-2 pr-2 text-right sm:pr-4">
        <OpeningCell
          opening={account.opening}
          currency={currency}
          formatting={formatting}
          previousMonth={previousMonth}
          previousMonthName={previousMonthName}
        />
      </td>
      <td className="py-2 pr-2 text-right sm:pr-4" data-testid="account-latest">
        <span className="flex flex-col items-end">
          <MoneyText
            amount={latest.amount?.amount ?? null}
            currency={currency}
            locale={formatting.locale}
            minorUnits={minorUnits}
            unavailableReason="No balance recorded."
            className="whitespace-nowrap"
          />
          <span className={META}>{latestText(latest, today, day)}</span>
        </span>
      </td>
      <td className="py-2 text-right" data-testid="account-today">
        {account.canUpdateToday ? (
          <div className="flex flex-col items-end gap-1">
            <AmountField<TodayTarget>
              key={generation}
              label={`${account.name}: balance today, ${day(today)} (${currency})`}
              testId="today-amount"
              saved={todaySnapshot?.amount.amount ?? null}
              target={{ version: todaySnapshot?.version ?? null }}
              minorUnits={minorUnits}
              state={state}
              describedBy={statusId}
              disabled={!hydrated}
              onCommit={commit}
              onInvalid={(message) => {
                setState({ kind: 'invalid', message });
              }}
              onReverted={() => {
                setState(IDLE);
              }}
              onTouched={() => undefined}
            />
            <SaveStatus id={statusId} state={state} />
            {state.kind === 'conflict' ? (
              <button type="button" className={ACTION} data-testid="reload-account" onClick={reload}>
                Reload
              </button>
            ) : null}
          </div>
        ) : (
          <span className={META}>
            {account.dormant ? 'Dormant (0) — left out of updates' : 'Closed — no longer updated'}
          </span>
        )}
      </td>
    </tr>
  );
}

export interface CurrentAccountsEditorProps {
  readonly monthName: string;
  readonly monthEndsOn: string;
  readonly today: string;
  readonly previousMonthName: string;
  readonly accounts: CurrentAccountsDto;
  readonly formatting: Formatting;
}

export function CurrentAccountsEditor({
  monthName,
  monthEndsOn,
  today,
  previousMonthName,
  accounts,
  formatting,
}: CurrentAccountsEditorProps) {
  const hydrated = useHydrated();
  const day = (date: string) => dayTitle(date, formatting.locale);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className={cn('max-w-prose', META)} data-testid="accounts-current-note">
          Balances entered here are ordinary snapshots dated today, {day(today)}. {monthName} can
          be closed from {day(accounts.closableFrom)}, when its statement balances can be entered.
        </p>
        <QuickUpdate
          positions={quickUpdatePositionsOf(accounts.accounts, formatting.minorUnitsByCurrency)}
          today={today}
          locale={formatting.locale}
          monthEndsOn={monthEndsOn}
          label="Update all today"
        />
      </div>

      {accounts.accounts.length === 0 ? (
        <p className="text-[var(--color-muted-foreground)]" data-testid="accounts-empty">
          No cash account takes part in {monthName}.{' '}
          <Link href="/accounts" className="underline">
            Add an account
          </Link>
        </p>
      ) : (
        <Table
          caption={`Cash accounts in ${monthName}: the opening, the latest balance with its date, and today’s balance`}
          columns={[
            { label: 'Account', numeric: false },
            { label: `Previous (end of ${previousMonthName})`, numeric: true },
            { label: 'Latest balance', numeric: true },
            { label: 'Update today', numeric: true },
          ]}
          testId="monthly-accounts"
        >
          {accounts.accounts.map((account) => (
            <CurrentAccountRow
              key={account.positionId}
              account={account}
              today={today}
              previousMonth={accounts.previousMonth}
              previousMonthName={previousMonthName}
              formatting={formatting}
              hydrated={hydrated}
            />
          ))}
        </Table>
      )}
    </div>
  );
}
