'use client';

import { useId, useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import type {
  CurrentMonthlyIncomeDto,
  EarlyReceiptCandidateDto,
  IncomeOccurrenceDto,
  MonthlyIncomeDto,
  MonthlyIncomeEntryDto,
  OccurrenceTermDto,
} from '@vaultide/application';
import {
  createIncomeEntryAction,
  deleteIncomeEntryAction,
  updateIncomeEntryAction,
} from '@/server/actions/flows';
import {
  acceptSuggestionAction,
  createTemplateAction,
  setTemplateTermAction,
  skipSuggestionAction,
  unskipSuggestionAction,
} from '@/server/actions/recurring';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MoneyText } from '@/components/finance/money-text';
import { normalizeMoneyInput } from '@/lib/money-input';
import { useHydrated } from '@/lib/use-hydrated';
import { cn } from '@/lib/utils';
import { dayTitle, monthTitle } from '@/features/monthly/presentation';
import {
  HISTORICAL_START_WARNING,
  SCHEDULABLE_INCOME_KINDS,
  accountForCurrency,
  defaultPickerCurrency,
  crossMonthNotice,
  ownedEntryDateBounds,
  pickerCurrencies,
  incomeKindLabel,
  occurrenceAnchorId,
  occurrenceStateLabel,
  ownsEntry,
  settlementOptions,
  skipReasonOptions,
  startsInThePast,
  SETTLEMENT_LABEL,
  SKIP_REASON_LABEL,
} from '@/features/monthly/income-presentation';
import {
  IDLE,
  canWrite,
  decideOnBlur,
  draftsAfterSave,
  fieldValueOf,
  isProblem,
  runSave,
  saveStateText,
  withoutDraft,
  type SaveOutcome,
  type SaveState,
} from '@/features/monthly/autosave';

/**
 * Monthly's Income section (blueprint 15.3 section 2, 16.4–16.6, 20.1, 20.3).
 *
 * Three groups, and the read decided which row is in which: the occurrences the
 * schedule placed in this month, the recurring money that arrived here for some
 * other month's occurrence, and the income nothing scheduled. Nothing is
 * partitioned, priced, dated or classified here.
 *
 * ## Controls are state-specific on purpose
 *
 * There is no generic "Edit" whose meaning changes with the row. An unresolved
 * occurrence has nowhere to put an amount except a materialized entry, so
 * adjusting one **is** accepting it; a future occurrence can only be
 * materialized through "received today", and only when it is the one the server
 * says is next; an accepted occurrence is corrected on its own row. Each state
 * therefore offers exactly the actions it can honour, and "change future
 * amount" — which writes a term and rewrites no recorded flow — stays a
 * separate, separately labelled action in every one of them.
 *
 * ## The month with the money owns the row
 *
 * A row's financial date decides which page may correct it. September's page
 * shows an occurrence received on 2 October as recorded and read-only, with a
 * link to October; October's page holds the field. Otherwise a page could
 * change a reconciliation it is not showing.
 *
 * Every write is an existing action behind `financialAction` (ADR 0003), and the
 * server judges all of it again. After a save the page asks the server for
 * itself: the route is dynamic and every flow and recurring action revalidates
 * the root layout, so `router.refresh()` replaces the section — the occurrence
 * states, the reconciliation, the completeness — with the authoritative result.
 */

interface Formatting {
  readonly locale: string;
  readonly minorUnitsByCurrency: Readonly<Record<string, number>>;
}

const minorUnitsOf = (formatting: Formatting, currency: string): number =>
  formatting.minorUnitsByCurrency[currency] ?? 2;

const META = 'text-[length:var(--text-meta)] text-[var(--color-muted-foreground)]';
const ACTION =
  'min-h-6 rounded-[var(--radius-control)] border px-2.5 py-1 text-[length:var(--text-meta)] font-medium disabled:opacity-60';
const PRIMARY = cn(
  ACTION,
  'border-transparent bg-[var(--color-accent)] text-[var(--color-accent-foreground)]',
);
const FIELD =
  'tabular h-9 w-28 rounded-[var(--radius-control)] border bg-[var(--color-surface)] px-2 text-right text-[length:var(--text-table)] aria-[invalid=true]:border-[var(--color-negative)]';
const ROW = 'border-b align-top last:border-0';
const NAME_CELL =
  'sticky left-0 z-10 bg-[var(--color-surface)] py-2 pr-2 text-left font-normal sm:pr-4';

const monthHref = (month: string): Route => `/monthly/${month}#income` as Route;

/* -------------------------------------------------------------------------- */
/* Shared pieces                                                               */
/* -------------------------------------------------------------------------- */

function SaveStatus({ id, state }: { readonly id: string; readonly state: SaveState }) {
  return (
    <span
      id={id}
      role="status"
      aria-live="polite"
      data-testid="income-save-status"
      data-state={state.kind}
      className={cn(
        'block',
        isProblem(state) ? 'text-[length:var(--text-meta)] text-[var(--color-negative)]' : META,
      )}
    >
      {saveStateText(state)}
    </span>
  );
}

/**
 * One amount, saved when the field is left (15.3: "every field autosaves on
 * blur with optimistic UI and version checks").
 *
 * Clearing saves nothing — an amount is corrected here, never deleted — so a
 * gross figure that should go away has its own explicit control instead.
 */
function AmountField({
  label,
  testId,
  saved,
  minorUnits,
  disabled,
  describedBy,
  onCommit,
  onInvalid,
  onReverted,
}: {
  readonly label: string;
  readonly testId: string;
  readonly saved: string | null;
  readonly minorUnits: number;
  readonly disabled: boolean;
  readonly describedBy: string;
  readonly onCommit: (amount: string) => Promise<SaveState>;
  readonly onInvalid: (message: string) => void;
  readonly onReverted: () => void;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? (saved === null ? '' : fieldValueOf(saved, minorUnits));

  return (
    <>
      <label htmlFor={inputId} className="sr-only">
        {label}
      </label>
      <input
        id={inputId}
        data-testid={testId}
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        value={value}
        disabled={disabled}
        aria-describedby={describedBy}
        className={FIELD}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onBlur={() => {
          if (draft === null) return;
          const decision = decideOnBlur({ draft, saved, minorUnits });
          if (decision.kind === 'unchanged') {
            setDraft(null);
            onReverted();
            return;
          }
          if (decision.kind === 'invalid') {
            onInvalid(decision.message);
            return;
          }
          void onCommit(decision.amount).then((final) => {
            if (final.kind === 'saved') setDraft(null);
          });
        }}
      />
    </>
  );
}

function Select({
  id,
  label,
  value,
  options,
  onChange,
  testId,
  disabled,
  hideLabel,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly onChange: (value: string) => void;
  readonly testId: string;
  readonly disabled?: boolean;
  readonly hideLabel?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className={hideLabel === true ? 'sr-only' : undefined}>
        {label}
      </Label>
      <select
        id={id}
        data-testid={testId}
        value={value}
        disabled={disabled}
        className="w-full rounded-[var(--radius-control)] border bg-[var(--color-surface)] px-2 py-1.5 text-[length:var(--text-table)]"
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

const NO_ACCOUNT = '__none__';

function accountOptions(
  accounts: MonthlyIncomeDto['cashAccounts'],
  currency: string,
): { value: string; label: string }[] {
  return [
    { value: NO_ACCOUNT, label: 'Not attributed yet' },
    // Only accounts that could hold the flow: the service refuses the rest, and
    // offering them would be offering a refusal (8.1, R4).
    ...accounts
      .filter((account) => account.currency === currency)
      .map((account) => ({ value: account.positionId, label: account.name })),
  ];
}

function Money({
  amount,
  currency,
  formatting,
  className,
}: {
  readonly amount: string | null;
  readonly currency: string;
  readonly formatting: Formatting;
  readonly className?: string;
}) {
  return (
    <MoneyText
      amount={amount}
      currency={currency}
      locale={formatting.locale}
      minorUnits={minorUnitsOf(formatting, currency)}
      className={className}
      unavailableReason="No amount set for this date"
    />
  );
}

function Panel({
  title,
  children,
  testId,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly testId: string;
}) {
  return (
    <div
      data-testid={testId}
      className="mt-2 space-y-3 rounded-[var(--radius-control)] border bg-[var(--color-muted)] p-3"
    >
      <p className="text-[length:var(--text-meta)] font-medium">{title}</p>
      {children}
    </div>
  );
}

function Problem({ message }: { readonly message: string | null }) {
  if (message === null) return null;
  return (
    <p
      role="alert"
      data-testid="income-error"
      className="text-[length:var(--text-meta)] text-[var(--color-negative)]"
    >
      {message}
    </p>
  );
}

function Table({
  caption,
  columns,
  children,
  testId,
}: {
  readonly caption: string;
  readonly columns: readonly { readonly label: string; readonly numeric?: boolean }[];
  readonly children: ReactNode;
  readonly testId: string;
}) {
  return (
    // `relative` is load-bearing, not decoration: the visually hidden labels
    // inside the cells are absolutely positioned, and without a positioned
    // scroll container their containing block is an ancestor of it — so they
    // escape the clip, sit past the right edge of a phone screen and widen the
    // whole page's scroll area instead of the table's.
    <div className="relative overflow-x-auto">
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
                  column.numeric === true && 'text-right',
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

/** The term amounts a "change future amount" form starts from (§30.9 item 4). */
function termDefaults(term: OccurrenceTermDto): {
  net: string;
  gross: string;
  note: string;
} {
  return {
    net: term.net?.amount ?? '',
    gross: term.gross?.amount ?? '',
    // A new term gets no note: an older one's note explains why *that* term
    // began, and copying it would fabricate provenance.
    note: term.exact.state === 'version' ? (term.exact.note ?? '') : '',
  };
}

/* -------------------------------------------------------------------------- */
/* Change future amount                                                        */
/* -------------------------------------------------------------------------- */

/**
 * "From this occurrence on": a term effective at the occurrence's **scheduled**
 * date (§30.9 item 4).
 *
 * `setTemplateTerm` replaces the whole term rather than patching it, so the form
 * submits the complete desired state and the expectation the row was rendered
 * from — `absent` when nothing starts here, or that exact row's version.
 */
function ChangeFutureAmount({
  templateId,
  occurrenceDate,
  currency,
  term,
  formatting,
  onDone,
}: {
  readonly templateId: string;
  readonly occurrenceDate: string;
  readonly currency: string;
  readonly term: OccurrenceTermDto;
  readonly formatting: Formatting;
  readonly onDone: () => void;
}) {
  const router = useRouter();
  const ids = { net: useId(), gross: useId(), note: useId() };
  const defaults = termDefaults(term);
  const [net, setNet] = useState(defaults.net);
  const [gross, setGross] = useState(defaults.gross);
  const [note, setNote] = useState(defaults.note);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const hydrated = useHydrated();

  return (
    <Panel title={`Amount from ${dayTitle(occurrenceDate, formatting.locale)} on`} testId="term-panel">
      <p className={META}>
        This changes what future occurrences are worth. It does not change anything already
        recorded.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor={ids.net}>Net ({currency})</Label>
          <Input
            id={ids.net}
            data-testid="term-net"
            value={net}
            inputMode="decimal"
            className="tabular text-right"
            onChange={(event) => {
              setNet(event.target.value);
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ids.gross}>Gross ({currency})</Label>
          <Input
            id={ids.gross}
            data-testid="term-gross"
            value={gross}
            inputMode="decimal"
            className="tabular text-right"
            onChange={(event) => {
              setGross(event.target.value);
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ids.note}>Note</Label>
          <Input
            id={ids.note}
            data-testid="term-note"
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        </div>
      </div>
      <Problem message={error} />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="term-save"
          className={PRIMARY}
          disabled={!hydrated || pending}
          onClick={() => {
            setError(null);
            const amount = normalizeMoneyInput(net);
            if (amount === '') {
              setError('Enter the net amount.');
              return;
            }
            const grossAmount = normalizeMoneyInput(gross);
            startTransition(async () => {
              const result = await setTemplateTermAction({
                templateId,
                effectiveFrom: occurrenceDate,
                amount,
                ...(grossAmount === '' ? {} : { grossAmount }),
                ...(note.trim() === '' ? {} : { note: note.trim() }),
                expected:
                  term.exact.state === 'absent'
                    ? { state: 'absent' }
                    : { state: 'version', version: term.exact.version },
              });
              if (!result.ok) {
                setError(result.error.message);
                return;
              }
              onDone();
              router.refresh();
            });
          }}
        >
          {pending ? 'Saving…' : 'Save amount'}
        </button>
        <button type="button" className={ACTION} onClick={onDone}>
          Cancel
        </button>
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Adjust and accept                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Accepting one occurrence with its own amounts, account and financial date.
 *
 * There is no durable override for an unmaterialized suggestion, so adjusting
 * one is the same act as recording it: the amounts land on the entry this
 * creates (6.2: "'This month only' writes no term at all"). The financial date
 * defaults to the occurrence's own and may be any date up to today — before it
 * as well as after, because a salary scheduled for the 25th and paid on the
 * 23rd is an ordinary fact and the domain bounds only the future.
 */
function AdjustAndAccept({
  occurrence,
  accounts,
  formatting,
  month,
  today,
  mode,
  onDone,
}: {
  readonly occurrence: IncomeOccurrenceDto;
  readonly accounts: MonthlyIncomeDto['cashAccounts'];
  readonly formatting: Formatting;
  readonly month: string;
  readonly today: string;
  /** `due` may choose a date; `receivedToday` records today by definition. */
  readonly mode: 'due' | 'receivedToday';
  readonly onDone: () => void;
}) {
  const router = useRouter();
  const ids = { date: useId(), net: useId(), gross: useId(), account: useId(), description: useId() };
  const [receivedOn, setReceivedOn] = useState(
    mode === 'receivedToday' ? today : occurrence.occurrenceDate,
  );
  const [net, setNet] = useState(occurrence.term.net?.amount ?? '');
  const [gross, setGross] = useState(occurrence.term.gross?.amount ?? '');
  const [clearGross, setClearGross] = useState(false);
  const [account, setAccount] = useState(occurrence.defaultCashPositionId ?? NO_ACCOUNT);
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const hydrated = useHydrated();

  const notice = crossMonthNotice(receivedOn, month, (value) =>
    monthTitle(value, formatting.locale),
  );

  return (
    <Panel
      title={mode === 'receivedToday' ? 'Record as received today' : 'Adjust and record'}
      testId="accept-panel"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {mode === 'due' ? (
          <div className="space-y-1.5">
            <Label htmlFor={ids.date}>Date the money arrived</Label>
            <Input
              id={ids.date}
              data-testid="accept-received-on"
              type="date"
              value={receivedOn}
              max={today}
              className="tabular"
              onChange={(event) => {
                setReceivedOn(event.target.value);
              }}
            />
          </div>
        ) : (
          <p className={META} data-testid="accept-today-note">
            Recorded as arriving today, {dayTitle(today, formatting.locale)}. The occurrence keeps
            its scheduled date of {dayTitle(occurrence.occurrenceDate, formatting.locale)}.
          </p>
        )}

        <div className="space-y-1.5">
          <Label htmlFor={ids.net}>Net ({occurrence.currency})</Label>
          <Input
            id={ids.net}
            data-testid="accept-net"
            value={net}
            inputMode="decimal"
            className="tabular text-right"
            onChange={(event) => {
              setNet(event.target.value);
            }}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={ids.gross}>Gross ({occurrence.currency})</Label>
          <Input
            id={ids.gross}
            data-testid="accept-gross"
            value={clearGross ? '' : gross}
            inputMode="decimal"
            disabled={clearGross}
            className="tabular text-right"
            onChange={(event) => {
              setGross(event.target.value);
            }}
          />
          <label className="flex items-center gap-2 text-[length:var(--text-meta)]">
            <input
              type="checkbox"
              data-testid="accept-no-gross"
              checked={clearGross}
              onChange={(event) => {
                setClearGross(event.target.checked);
              }}
            />
            No gross figure for this one
          </label>
        </div>

        <Select
          id={ids.account}
          testId="accept-account"
          label="Account it went into"
          value={account}
          options={accountOptions(accounts, occurrence.currency)}
          onChange={setAccount}
        />

        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={ids.description}>Note</Label>
          <Input
            id={ids.description}
            data-testid="accept-description"
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </div>
      </div>

      {notice === null ? null : (
        <p className={META} data-testid="accept-cross-month">
          {notice}
        </p>
      )}
      <Problem message={error} />

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="accept-submit"
          className={PRIMARY}
          disabled={!hydrated || pending}
          onClick={() => {
            setError(null);
            const amount = normalizeMoneyInput(net);
            if (amount === '') {
              setError('Enter the amount that arrived.');
              return;
            }
            const grossAmount = normalizeMoneyInput(gross);
            startTransition(async () => {
              const result = await acceptSuggestionAction({
                templateId: occurrence.templateId,
                occurrenceDate: occurrence.occurrenceDate,
                amount,
                // Three states, and the middle one matters: leaving the field
                // alone inherits the term's gross, ticking the box records that
                // this occurrence had none.
                ...(clearGross
                  ? { grossAmount: null }
                  : grossAmount === ''
                    ? {}
                    : { grossAmount }),
                ...(mode === 'receivedToday'
                  ? { receivedToday: true }
                  : { financialDate: receivedOn }),
                cashPositionId: account === NO_ACCOUNT ? null : account,
                ...(description.trim() === '' ? {} : { description: description.trim() }),
              });
              if (!result.ok) {
                setError(result.error.message);
                return;
              }
              onDone();
              router.refresh();
            });
          }}
        >
          {pending ? 'Saving…' : 'Record it'}
        </button>
        <button type="button" className={ACTION} onClick={onDone}>
          Cancel
        </button>
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Skip                                                                        */
/* -------------------------------------------------------------------------- */

function SkipOccurrence({
  occurrence,
  onDone,
}: {
  readonly occurrence: IncomeOccurrenceDto;
  readonly onDone: () => void;
}) {
  const router = useRouter();
  const ids = { reason: useId(), note: useId() };
  const options = skipReasonOptions(occurrence.incomeKind);
  const [reason, setReason] = useState(options[0]?.value ?? 'skipped');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const hydrated = useHydrated();

  return (
    <Panel title="Skip this occurrence" testId="skip-panel">
      <p className={META}>
        A skip records that this did not happen. It creates no income and is not the same as hiding
        an advisory.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          id={ids.reason}
          testId="skip-reason"
          label="Why"
          value={reason}
          options={options}
          onChange={setReason}
        />
        <div className="space-y-1.5">
          <Label htmlFor={ids.note}>Note</Label>
          <Input
            id={ids.note}
            data-testid="skip-note"
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        </div>
      </div>
      <Problem message={error} />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="skip-submit"
          className={PRIMARY}
          disabled={!hydrated || pending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await skipSuggestionAction({
                templateId: occurrence.templateId,
                occurrenceDate: occurrence.occurrenceDate,
                reason: reason as 'skipped',
                ...(note.trim() === '' ? {} : { note: note.trim() }),
              });
              if (!result.ok) {
                setError(result.error.message);
                return;
              }
              onDone();
              router.refresh();
            });
          }}
        >
          {pending ? 'Saving…' : 'Skip it'}
        </button>
        <button type="button" className={ACTION} onClick={onDone}>
          Cancel
        </button>
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* An income row's editable financial facts                                    */
/* -------------------------------------------------------------------------- */

/**
 * What Monthly may correct on a materialized row, and what it may not.
 *
 * `receivedOn` is a **financial fact** and is editable on the page whose month
 * holds it — bounded to that month, because moving a recorded row to another one
 * is the historical correction that shows what it affects (15.3). It is not
 * identity: `occurrence_date` is, and the repository patch type cannot even
 * express it (§30.9 item 2).
 *
 * `kind` and `settlement` are offered on a **direct** row and never on a
 * materialized recurring occurrence. A salary occurrence that could become a
 * dividend would be rewriting what its source scheduled; a row nobody scheduled
 * has no such identity, and a payment mis-recorded as `external` changes
 * reconciliation until it is corrected. `tags` and the one-off flag stay out of
 * both, and currency stays out because `updateIncomeEntry` does not accept one.
 */
interface EntryPatch {
  readonly kind?: string;
  readonly settlement?: string;
  readonly netAmount?: string;
  readonly grossAmount?: string | null;
  readonly receivedOn?: string;
  readonly cashPositionId?: string | null;
  readonly description?: string | null;
}

/**
 * What the user has on this row that the server has not accepted yet.
 *
 * An index signature as well as the named fields, so the shared draft rules in
 * `autosave.ts` — which are field-agnostic on purpose — can operate on it.
 */
interface EntryDrafts extends Readonly<Record<string, unknown>> {
  readonly kind?: string;
  readonly settlement?: string;
  readonly receivedOn?: string;
  readonly cashPositionId?: string | null;
  readonly description?: string;
}

/**
 * One row's drafts, its save state, and the writes it may make (20.3, 15.3).
 *
 * A draft is simply what the user has that the server has not: it is set by
 * every control, and cleared **only** by the save that succeeds for that field.
 * That is what makes a conflict safe — the attempted date or account stays on
 * screen with the conflict beside it, rather than snapping back to the server
 * value as though nothing had been typed, and nothing is refreshed over it.
 *
 * Only a successful write refreshes. `reload` is the explicit way out: it
 * discards the drafts and asks the server for the row again, so adopting the
 * authoritative state is a choice the user makes rather than one a failed save
 * makes for them.
 */
function useEntrySave(entry: MonthlyIncomeEntryDto) {
  const router = useRouter();
  const [state, setState] = useState<SaveState>(IDLE);
  const [drafts, setDrafts] = useState<EntryDrafts>({});
  const busy = state.kind === 'saving';

  const setDraft = (partial: EntryDrafts): void => {
    setDrafts((current) => ({ ...current, ...partial }));
  };

  const clearDraft = (key: string): void => {
    setDrafts((current) => withoutDraft(current, key));
  };

  /**
   * Write one patch under the version this row was rendered from.
   *
   * Refused while another write is in flight: every control on the row captured
   * the same `entry.version`, so a second write started before the first
   * returns would carry a version the server has already consumed and conflict
   * against the user's own save.
   */
  const commit = async (patch: EntryPatch, draft: EntryDrafts = {}): Promise<SaveState> => {
    if (!canWrite(state)) return state;
    setDraft(draft);
    const fields = Object.keys(draft);
    const final = await runSave(
      () =>
        updateIncomeEntryAction({
          entryId: entry.entryId,
          expectedVersion: entry.version,
          ...patch,
        }),
      setState,
      () => {
        router.refresh();
      },
    );
    // `runSave` refreshes only a success, and the drafts follow the same rule:
    // a conflict keeps what the user attempted, on screen, beside the message.
    setDrafts((current) => draftsAfterSave(current, fields, final));
    return final;
  };

  const reload = (): void => {
    setDrafts({});
    setState(IDLE);
    router.refresh();
  };

  const remove = async (): Promise<SaveState> => {
    if (!canWrite(state)) return state;
    return runSave(() => deleteIncomeEntryAction({ entryId: entry.entryId }), setState, () => {
      router.refresh();
    });
  };

  return { state, setState, drafts, busy, setDraft, clearDraft, commit, reload, remove };
}

/**
 * The income kind and how the money arrived, corrected together.
 *
 * They are one fact in two fields: 7.4 allows a settlement only for certain
 * kinds, so changing the kind can invalidate the settlement beside it. Writing
 * each on change would either send a pair the service refuses or silently
 * reinterpret where the money went — so both are held as drafts, the settlement
 * options follow the chosen kind, and one explicit action writes the pair.
 */
function KindAndSettlement({
  entry,
  drafts,
  disabled,
  onDraft,
  onApply,
}: {
  readonly entry: MonthlyIncomeEntryDto;
  readonly drafts: EntryDrafts;
  readonly disabled: boolean;
  readonly onDraft: (partial: EntryDrafts) => void;
  readonly onApply: (kind: string, settlement: string) => void;
}) {
  const ids = { kind: useId(), settlement: useId() };
  const kind = drafts.kind ?? entry.kind;
  const allowed = settlementOptions(kind);
  const settlement = drafts.settlement ?? entry.settlement;
  // The draft pair is kept valid as it is built, so the action below can never
  // offer a combination 7.4 does not define.
  const effectiveSettlement = allowed.some((option) => option.value === settlement)
    ? settlement
    : 'tracked_cash';
  const changed = kind !== entry.kind || effectiveSettlement !== entry.settlement;

  return (
    <>
      <Select
        id={ids.kind}
        testId="entry-kind"
        label="What kind of income"
        hideLabel
        value={kind}
        options={DIRECT_KINDS.map((value) => ({ value, label: incomeKindLabel(value) }))}
        disabled={disabled}
        onChange={(value) => {
          const next = settlementOptions(value);
          onDraft({
            kind: value,
            settlement: next.some((option) => option.value === effectiveSettlement)
              ? effectiveSettlement
              : 'tracked_cash',
          });
        }}
      />
      <Select
        id={ids.settlement}
        testId="entry-settlement"
        label="How it arrived"
        hideLabel
        value={effectiveSettlement}
        options={allowed}
        disabled={disabled}
        onChange={(value) => {
          onDraft({ settlement: value });
        }}
      />
      {changed ? (
        <button
          type="button"
          data-testid="entry-apply-kind"
          className={cn(PRIMARY, 'self-end')}
          disabled={disabled}
          onClick={() => {
            onApply(kind, effectiveSettlement);
          }}
        >
          Apply
        </button>
      ) : null}
    </>
  );
}

/**
 * The facts about the money on one materialized row, corrected in place.
 *
 * Rendered only on the page that financially owns the row, so every control
 * here is one this month is entitled to change.
 */
function EntryFields({
  entry,
  accounts,
  formatting,
  bounds,
  editableIdentity,
}: {
  readonly entry: MonthlyIncomeEntryDto;
  readonly accounts: MonthlyIncomeDto['cashAccounts'];
  readonly formatting: Formatting;
  readonly bounds: { readonly min: string; readonly max: string };
  /** Direct rows only: a scheduled occurrence's kind is its source's (7.4). */
  readonly editableIdentity: boolean;
}) {
  const statusId = useId();
  const ids = { account: useId(), date: useId(), description: useId() };
  const { state, setState, drafts, busy, setDraft, clearDraft, commit, reload, remove } =
    useEntrySave(entry);
  const hydrated = useHydrated();
  const minorUnits = minorUnitsOf(formatting, entry.currency);
  const disabled = !hydrated || busy;

  const settlement = drafts.settlement ?? entry.settlement;
  const cashPositionId =
    drafts.cashPositionId === undefined ? entry.cashPositionId : drafts.cashPositionId;
  const description = drafts.description ?? entry.description ?? '';

  const onInvalid = (message: string): void => {
    setState({ kind: 'invalid', message });
  };
  const onReverted = (): void => {
    setState(IDLE);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end justify-end gap-2">
        <div className="flex flex-col items-end gap-0.5">
          <span className={META}>Net</span>
          <AmountField
            label={`Net amount (${entry.currency})`}
            testId="entry-net"
            saved={entry.net.amount}
            minorUnits={minorUnits}
            disabled={disabled}
            describedBy={statusId}
            onCommit={(amount) => commit({ netAmount: amount })}
            onInvalid={onInvalid}
            onReverted={onReverted}
          />
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <span className={META}>Gross</span>
          <AmountField
            label={`Gross amount (${entry.currency})`}
            testId="entry-gross"
            saved={entry.gross?.amount ?? null}
            minorUnits={minorUnits}
            disabled={disabled}
            describedBy={statusId}
            onCommit={(amount) => commit({ grossAmount: amount })}
            onInvalid={onInvalid}
            onReverted={onReverted}
          />
          {entry.gross === null ? null : (
            <button
              type="button"
              data-testid="entry-clear-gross"
              className={ACTION}
              disabled={disabled}
              onClick={() => {
                void commit({ grossAmount: null });
              }}
            >
              No gross figure
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={ids.date} className="sr-only">
            Date the money arrived ({entry.currency})
          </Label>
          <Input
            id={ids.date}
            data-testid="entry-received-on"
            type="date"
            value={drafts.receivedOn ?? entry.receivedOn}
            min={bounds.min}
            max={bounds.max}
            disabled={disabled}
            className="tabular"
            onChange={(event) => {
              const receivedOn = event.target.value;
              // Inside this month only. The occurrence this row materializes
              // keeps its own scheduled date whatever happens here.
              if (receivedOn < bounds.min || receivedOn > bounds.max) {
                setDraft({ receivedOn });
                onInvalid(`Choose a date between ${bounds.min} and ${bounds.max}.`);
                return;
              }
              void commit({ receivedOn }, { receivedOn });
            }}
          />
        </div>

        {editableIdentity ? (
          <KindAndSettlement
            entry={entry}
            drafts={drafts}
            disabled={disabled}
            onDraft={setDraft}
            onApply={(kind, nextSettlement) => {
              void commit(
                {
                  kind,
                  settlement: nextSettlement,
                  // A settlement that never touched tracked cash carries no
                  // account, and the service drops one anyway (6.2 CHECK).
                  ...(nextSettlement === 'tracked_cash' ? {} : { cashPositionId: null }),
                },
                { kind, settlement: nextSettlement },
              );
            }}
          />
        ) : null}

        {settlement === 'tracked_cash' ? (
          <Select
            id={ids.account}
            testId="entry-account"
            label="Account"
            hideLabel
            value={cashPositionId ?? NO_ACCOUNT}
            options={accountOptions(accounts, entry.currency)}
            disabled={disabled}
            onChange={(value) => {
              const next = value === NO_ACCOUNT ? null : value;
              void commit({ cashPositionId: next }, { cashPositionId: next });
            }}
          />
        ) : null}

        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor={ids.description} className="sr-only">
            Note
          </Label>
          <Input
            id={ids.description}
            data-testid="entry-description"
            placeholder="Note"
            value={description}
            disabled={disabled}
            onChange={(event) => {
              setDraft({ description: event.target.value });
            }}
            onBlur={() => {
              if (drafts.description === undefined) return;
              if (drafts.description === (entry.description ?? '')) {
                clearDraft('description');
                return;
              }
              const trimmed = drafts.description.trim();
              void commit(
                { description: trimmed === '' ? null : trimmed },
                { description: drafts.description },
              );
            }}
          />
        </div>
      </div>

      <SaveStatus id={statusId} state={state} />

      <div className="flex justify-end gap-2">
        {state.kind === 'conflict' || state.kind === 'error' ? (
          <button type="button" data-testid="entry-reload" className={ACTION} onClick={reload}>
            Reload
          </button>
        ) : null}
        <button
          type="button"
          data-testid="entry-delete"
          className={ACTION}
          disabled={disabled}
          onClick={() => {
            void remove();
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

/** A row this page shows but does not own: the money belongs to another month. */
function ElsewhereNotice({
  entry,
  locale,
}: {
  readonly entry: MonthlyIncomeEntryDto;
  readonly locale: string;
}) {
  return (
    <p className={META} data-testid="entry-elsewhere">
      Recorded in {monthTitle(entry.receivedMonth, locale)}.{' '}
      <Link href={monthHref(entry.receivedMonth)} className="underline">
        Open {monthTitle(entry.receivedMonth, locale)} to change it
      </Link>
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/* Scheduled occurrences                                                       */
/* -------------------------------------------------------------------------- */

type OpenPanel = 'accept' | 'receivedToday' | 'term' | 'skip' | null;

function OccurrenceRow({
  occurrence,
  accounts,
  formatting,
  month,
  today,
  bounds,
}: {
  readonly occurrence: IncomeOccurrenceDto;
  readonly accounts: MonthlyIncomeDto['cashAccounts'];
  readonly formatting: Formatting;
  readonly month: string;
  readonly today: string;
  readonly bounds: { readonly min: string; readonly max: string };
}) {
  const router = useRouter();
  const [panel, setPanel] = useState<OpenPanel>(null);
  const [state, setState] = useState<SaveState>(IDLE);
  const statusId = useId();
  const hydrated = useHydrated();
  const { state: occurrenceState, currency } = occurrence;
  const busy = !hydrated || state.kind === 'saving';
  const day = (date: string) => dayTitle(date, formatting.locale);
  const close = () => {
    setPanel(null);
  };

  const run = (send: () => Promise<SaveOutcome>): Promise<SaveState> =>
    runSave(send, setState, () => {
      router.refresh();
    });

  const accept = () =>
    run(() =>
      acceptSuggestionAction({
        templateId: occurrence.templateId,
        occurrenceDate: occurrence.occurrenceDate,
      }),
    );

  return (
    <tr
      className={ROW}
      id={occurrenceAnchorId(occurrence.templateId, occurrence.occurrenceDate)}
      data-testid="income-occurrence"
      data-template-id={occurrence.templateId}
      data-occurrence-date={occurrence.occurrenceDate}
      data-state={occurrenceState.kind}
    >
      <th scope="row" className={NAME_CELL}>
        <span className="font-medium">{occurrence.templateName}</span>
        <span className={cn('block', META)}>
          {incomeKindLabel(occurrence.incomeKind)}
          {occurrence.counterparty === null ? '' : ` · ${occurrence.counterparty}`} · {currency}
        </span>
      </th>

      <td className="py-2 pr-2 sm:pr-4" data-testid="occurrence-dates">
        <span className="block whitespace-nowrap">
          Scheduled {day(occurrence.occurrenceDate)}
        </span>
        {occurrenceState.kind === 'accepted' ? (
          <span className={cn('block whitespace-nowrap', META)} data-testid="occurrence-received-on">
            Received {day(occurrenceState.entry.receivedOn)}
          </span>
        ) : null}
      </td>

      <td className="py-2 pr-2 text-right sm:pr-4" data-testid="occurrence-amount">
        {occurrenceState.kind === 'accepted' ? (
          <>
            <Money
              amount={occurrenceState.entry.net.amount}
              currency={currency}
              formatting={formatting}
            />
            {occurrenceState.entry.gross === null ? null : (
              <span className={cn('block whitespace-nowrap', META)}>
                Gross{' '}
                <Money
                  amount={occurrenceState.entry.gross.amount}
                  currency={currency}
                  formatting={formatting}
                />
              </span>
            )}
          </>
        ) : (
          <>
            <Money
              amount={occurrence.term.net?.amount ?? null}
              currency={currency}
              formatting={formatting}
            />
            <span className={cn('block', META)}>Expected</span>
          </>
        )}
      </td>

      <td className="py-2 pr-2 sm:pr-4">
        <Badge
          tone={
            occurrenceState.kind === 'accepted'
              ? 'positive'
              : occurrenceState.kind === 'due'
                ? 'warning'
                : 'neutral'
          }
          data-testid="occurrence-status"
        >
          {occurrenceStateLabel(occurrence)}
        </Badge>
        {occurrence.sourceArchived ? (
          <span className={cn('block', META)} data-testid="occurrence-archived">
            Source archived
          </span>
        ) : null}
        {occurrenceState.kind === 'skipped' ? (
          <span className={cn('block', META)} data-testid="occurrence-skip-reason">
            {SKIP_REASON_LABEL[occurrenceState.reason] ?? occurrenceState.reason}
            {occurrenceState.note === null ? '' : ` — ${occurrenceState.note}`}
          </span>
        ) : null}
      </td>

      <td className="py-2">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap justify-end gap-2">
            {occurrenceState.kind === 'due' && !occurrence.sourceArchived ? (
              <>
                <button
                  type="button"
                  data-testid="occurrence-accept"
                  className={PRIMARY}
                  disabled={busy || occurrence.term.net === null}
                  onClick={() => {
                    void accept();
                  }}
                >
                  Record it
                </button>
                <button
                  type="button"
                  data-testid="occurrence-adjust"
                  className={ACTION}
                  disabled={busy}
                  onClick={() => {
                    setPanel(panel === 'accept' ? null : 'accept');
                  }}
                >
                  Adjust &amp; record
                </button>
              </>
            ) : null}

            {occurrenceState.kind === 'upcoming' &&
            occurrenceState.receivedTodayEligible &&
            !occurrence.sourceArchived ? (
              <button
                type="button"
                data-testid="occurrence-received-today"
                className={PRIMARY}
                disabled={busy}
                onClick={() => {
                  setPanel(panel === 'receivedToday' ? null : 'receivedToday');
                }}
              >
                Received today
              </button>
            ) : null}

            {(occurrenceState.kind === 'due' || occurrenceState.kind === 'upcoming') &&
            !occurrence.sourceArchived ? (
              <button
                type="button"
                data-testid="occurrence-skip"
                className={ACTION}
                disabled={busy}
                onClick={() => {
                  setPanel(panel === 'skip' ? null : 'skip');
                }}
              >
                Skip
              </button>
            ) : null}

            {occurrenceState.kind === 'skipped' ? (
              <button
                type="button"
                data-testid="occurrence-restore"
                className={ACTION}
                disabled={busy}
                onClick={() => {
                  void run(() => unskipSuggestionAction({ skipId: occurrenceState.skipId }));
                }}
              >
                Restore
              </button>
            ) : null}

            {occurrence.sourceArchived ? null : (
              <button
                type="button"
                data-testid="occurrence-term"
                className={ACTION}
                disabled={busy}
                onClick={() => {
                  setPanel(panel === 'term' ? null : 'term');
                }}
              >
                Change future amount
              </button>
            )}
          </div>

          <SaveStatus id={statusId} state={state} />

          {occurrenceState.kind === 'accepted' ? (
            ownsEntry(occurrenceState.entry, month) ? (
              <EntryFields
                entry={occurrenceState.entry}
                accounts={accounts}
                formatting={formatting}
                bounds={bounds}
                // The occurrence fixes what this row is; the date the money
                // arrived is a separate fact, and this month owns it.
                editableIdentity={false}
              />
            ) : (
              <ElsewhereNotice entry={occurrenceState.entry} locale={formatting.locale} />
            )
          ) : null}

          {panel === 'accept' || panel === 'receivedToday' ? (
            <AdjustAndAccept
              occurrence={occurrence}
              accounts={accounts}
              formatting={formatting}
              month={month}
              today={today}
              mode={panel === 'receivedToday' ? 'receivedToday' : 'due'}
              onDone={close}
            />
          ) : null}
          {panel === 'skip' ? <SkipOccurrence occurrence={occurrence} onDone={close} /> : null}
          {panel === 'term' ? (
            <ChangeFutureAmount
              templateId={occurrence.templateId}
              occurrenceDate={occurrence.occurrenceDate}
              currency={currency}
              term={occurrence.term}
              formatting={formatting}
              onDone={close}
            />
          ) : null}
        </div>
      </td>
    </tr>
  );
}

/* -------------------------------------------------------------------------- */
/* Early receipt beyond the month                                              */
/* -------------------------------------------------------------------------- */

/**
 * The one occurrence per source that "received today" may reach when it lies
 * past the end of the month on screen (§30.10).
 *
 * There is no horizon: an annual source whose genuine next payment is months
 * away belongs here, and the server checks the same rule again under the
 * template's lock before it writes anything.
 */
function EarlyReceiptRow({
  candidate,
  accounts,
  formatting,
  month,
  today,
}: {
  readonly candidate: EarlyReceiptCandidateDto;
  readonly accounts: MonthlyIncomeDto['cashAccounts'];
  readonly formatting: Formatting;
  readonly month: string;
  readonly today: string;
}) {
  const [open, setOpen] = useState(false);
  const hydrated = useHydrated();

  return (
    <tr className={ROW} data-testid="income-early-candidate" data-template-id={candidate.templateId}>
      <th scope="row" className={NAME_CELL}>
        <span className="font-medium">{candidate.templateName}</span>
        <span className={cn('block', META)}>
          {incomeKindLabel(candidate.incomeKind)} · {candidate.currency}
        </span>
      </th>
      <td className="py-2 pr-2 sm:pr-4">
        <span className="whitespace-nowrap">
          Next on {dayTitle(candidate.occurrenceDate, formatting.locale)}
        </span>
        <span className={cn('block', META)}>
          {monthTitle(candidate.occurrenceMonth, formatting.locale)}
        </span>
      </td>
      <td className="py-2 pr-2 text-right sm:pr-4">
        <Money
          amount={candidate.term.net?.amount ?? null}
          currency={candidate.currency}
          formatting={formatting}
        />
      </td>
      <td className="py-2">
        <div className="flex flex-col items-end gap-2">
          <button
            type="button"
            data-testid="early-received-today"
            className={PRIMARY}
            disabled={!hydrated}
            onClick={() => {
              setOpen((current) => !current);
            }}
          >
            Received today
          </button>
          {open ? (
            <AdjustAndAccept
              occurrence={{
                templateId: candidate.templateId,
                templateName: candidate.templateName,
                counterparty: null,
                incomeKind: candidate.incomeKind,
                currency: candidate.currency,
                occurrenceDate: candidate.occurrenceDate,
                term: candidate.term,
                defaultCashPositionId: candidate.defaultCashPositionId,
                defaultCashAccountName: candidate.defaultCashAccountName,
                sourceArchived: false,
                state: { kind: 'upcoming', receivedTodayEligible: true },
              }}
              accounts={accounts}
              formatting={formatting}
              month={month}
              today={today}
              mode="receivedToday"
              onDone={() => {
                setOpen(false);
              }}
            />
          ) : null}
        </div>
      </td>
    </tr>
  );
}

/* -------------------------------------------------------------------------- */
/* Recorded income rows                                                        */
/* -------------------------------------------------------------------------- */

function EntryRow({
  entry,
  accounts,
  formatting,
  month,
  bounds,
  editableIdentity,
}: {
  readonly entry: MonthlyIncomeEntryDto;
  readonly accounts: MonthlyIncomeDto['cashAccounts'];
  readonly formatting: Formatting;
  readonly month: string;
  readonly bounds: { readonly min: string; readonly max: string };
  readonly editableIdentity: boolean;
}) {
  const owns = ownsEntry(entry, month);

  return (
    <tr className={ROW} data-testid="income-entry" data-entry-id={entry.entryId}>
      <th scope="row" className={NAME_CELL}>
        <span className="font-medium">
          {entry.occurrence === null
            ? incomeKindLabel(entry.kind)
            : entry.occurrence.templateName}
        </span>
        <span className={cn('block', META)}>
          {entry.occurrence === null ? '' : `${incomeKindLabel(entry.kind)} · `}
          {SETTLEMENT_LABEL[entry.settlement] ?? entry.settlement}
          {entry.isOneOff ? ' · one-off' : ''}
        </span>
      </th>

      <td className="py-2 pr-2 sm:pr-4">
        <span className="block whitespace-nowrap">
          Received {dayTitle(entry.receivedOn, formatting.locale)}
        </span>
        {entry.occurrence === null ? null : (
          <span className={cn('block whitespace-nowrap', META)} data-testid="entry-occurrence">
            For the occurrence scheduled{' '}
            {dayTitle(entry.occurrence.occurrenceDate, formatting.locale)} ·{' '}
            <Link href={monthHref(entry.occurrence.occurrenceMonth)} className="underline">
              {monthTitle(entry.occurrence.occurrenceMonth, formatting.locale)}
            </Link>
          </span>
        )}
        {entry.description === null ? null : (
          <span className={cn('block', META)}>{entry.description}</span>
        )}
      </td>

      <td className="py-2 pr-2 text-right sm:pr-4">
        <Money amount={entry.net.amount} currency={entry.currency} formatting={formatting} />
        {entry.gross === null ? null : (
          <span className={cn('block whitespace-nowrap', META)}>
            Gross{' '}
            <Money amount={entry.gross.amount} currency={entry.currency} formatting={formatting} />
          </span>
        )}
        <span className={cn('block', META)} data-testid="entry-attribution">
          {entry.settlement === 'tracked_cash'
            ? (entry.cashAccountName ?? 'Not attributed yet')
            : (SETTLEMENT_LABEL[entry.settlement] ?? entry.settlement)}
        </span>
      </td>

      <td className="py-2">
        {owns ? (
          <EntryFields
            entry={entry}
            accounts={accounts}
            formatting={formatting}
            bounds={bounds}
            editableIdentity={editableIdentity}
          />
        ) : (
          <ElsewhereNotice entry={entry} locale={formatting.locale} />
        )}
      </td>
    </tr>
  );
}

/* -------------------------------------------------------------------------- */
/* Add a direct income row                                                     */
/* -------------------------------------------------------------------------- */

const DIRECT_KINDS = [
  'employment',
  'freelance',
  'bonus',
  'rental',
  'other',
  'interest',
  'dividend',
  'external_inflow',
  'adjustment',
] as const;

export function AddIncomeForm({
  accounts,
  currencies,
  bounds,
  defaultCurrency,
}: {
  readonly accounts: MonthlyIncomeDto['cashAccounts'];
  readonly currencies: readonly string[];
  readonly bounds: { readonly min: string; readonly max: string };
  readonly defaultCurrency: string;
}) {
  const router = useRouter();
  const ids = {
    kind: useId(),
    date: useId(),
    net: useId(),
    gross: useId(),
    currency: useId(),
    settlement: useId(),
    account: useId(),
    description: useId(),
  };
  const [kind, setKind] = useState<string>('other');
  const [receivedOn, setReceivedOn] = useState(bounds.max);
  const [net, setNet] = useState('');
  const [gross, setGross] = useState('');
  const [currency, setCurrency] = useState(defaultCurrency);
  const [settlement, setSettlement] = useState('tracked_cash');
  const [account, setAccount] = useState(NO_ACCOUNT);
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const hydrated = useHydrated();

  const settlements = settlementOptions(kind);
  const effectiveSettlement = settlements.some((option) => option.value === settlement)
    ? settlement
    : 'tracked_cash';

  return (
    <form
      className="space-y-3"
      data-testid="add-income"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        setSaved(null);
        const amount = normalizeMoneyInput(net);
        if (amount === '') {
          setError('Enter the amount that arrived.');
          return;
        }
        const grossAmount = normalizeMoneyInput(gross);

        startTransition(async () => {
          const result = await createIncomeEntryAction({
            kind: kind as 'other',
            receivedOn,
            netAmount: amount,
            ...(grossAmount === '' ? {} : { grossAmount }),
            currency,
            settlement: effectiveSettlement as 'tracked_cash',
            cashPositionId:
              effectiveSettlement === 'tracked_cash' && account !== NO_ACCOUNT ? account : null,
            ...(description.trim() === '' ? {} : { description: description.trim() }),
          });
          if (!result.ok) {
            setError(result.error.message);
            return;
          }
          setSaved('Income added.');
          setNet('');
          setGross('');
          setDescription('');
          router.refresh();
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Select
          id={ids.kind}
          testId="income-kind"
          label="What kind"
          value={kind}
          options={DIRECT_KINDS.map((value) => ({ value, label: incomeKindLabel(value) }))}
          onChange={(value) => {
            setKind(value);
            setSettlement('tracked_cash');
          }}
        />
        <div className="space-y-1.5">
          <Label htmlFor={ids.date}>Date it arrived</Label>
          <Input
            id={ids.date}
            data-testid="income-received-on"
            type="date"
            value={receivedOn}
            min={bounds.min}
            max={bounds.max}
            className="tabular"
            onChange={(event) => {
              setReceivedOn(event.target.value);
            }}
          />
        </div>
        <Select
          id={ids.currency}
          testId="income-currency"
          label="Currency"
          value={currency}
          options={currencies.map((code) => ({ value: code, label: code }))}
          onChange={(value) => {
            setCurrency(value);
            setAccount((current) => accountForCurrency(accounts, current, value, NO_ACCOUNT));
          }}
        />
        <div className="space-y-1.5">
          <Label htmlFor={ids.net}>Net ({currency})</Label>
          <Input
            id={ids.net}
            data-testid="income-net"
            value={net}
            inputMode="decimal"
            required
            className="tabular text-right"
            onChange={(event) => {
              setNet(event.target.value);
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ids.gross}>Gross ({currency})</Label>
          <Input
            id={ids.gross}
            data-testid="income-gross"
            value={gross}
            inputMode="decimal"
            className="tabular text-right"
            onChange={(event) => {
              setGross(event.target.value);
            }}
          />
        </div>
        <Select
          id={ids.settlement}
          testId="income-settlement"
          label="How it arrived"
          value={effectiveSettlement}
          options={settlements}
          onChange={setSettlement}
        />
        {effectiveSettlement === 'tracked_cash' ? (
          <Select
            id={ids.account}
            testId="income-account"
            label="Account"
            value={account}
            options={accountOptions(accounts, currency)}
            onChange={setAccount}
          />
        ) : null}
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={ids.description}>Note</Label>
          <Input
            id={ids.description}
            data-testid="income-description"
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </div>
      </div>

      <Problem message={error} />
      {saved === null ? null : (
        <p role="status" aria-live="polite" data-testid="income-saved" className={META}>
          {saved}
        </p>
      )}

      <button type="submit" data-testid="income-submit" className={PRIMARY} disabled={!hydrated || pending}>
        {pending ? 'Saving…' : 'Add income'}
      </button>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Add a recurring income source                                               */
/* -------------------------------------------------------------------------- */

const FREQUENCIES = [
  { value: 'monthly', label: 'Every month' },
  { value: 'quarterly', label: 'Every three months' },
  { value: 'semiannual', label: 'Every six months' },
  { value: 'annual', label: 'Every year' },
] as const;

/**
 * Creating a recurring income source (6.2).
 *
 * Creation only: editing, archiving and the rest of a source's life belong to
 * the Income page, not to one month's maintenance. What is offered here is the
 * existing creation input unchanged, including a start date that may be
 * historical — which is the schedule's own meaning (§30.10) and is therefore
 * stated plainly rather than quietly prevented.
 */
export function AddIncomeSourceForm({
  accounts,
  currencies,
  defaultCurrency,
  today,
  locale,
}: {
  readonly accounts: MonthlyIncomeDto['cashAccounts'];
  readonly currencies: readonly string[];
  readonly defaultCurrency: string;
  readonly today: string;
  readonly locale: string;
}) {
  const router = useRouter();
  const ids = {
    name: useId(),
    counterparty: useId(),
    kind: useId(),
    currency: useId(),
    frequency: useId(),
    dayOfMonth: useId(),
    startDate: useId(),
    endDate: useId(),
    amount: useId(),
    gross: useId(),
    account: useId(),
  };
  const [name, setName] = useState('');
  const [counterparty, setCounterparty] = useState('');
  const [incomeKind, setIncomeKind] = useState<string>('employment');
  const [currency, setCurrency] = useState(defaultCurrency);
  const [frequency, setFrequency] = useState<string>('monthly');
  const [dayOfMonth, setDayOfMonth] = useState('25');
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState('');
  const [amount, setAmount] = useState('');
  const [gross, setGross] = useState('');
  const [account, setAccount] = useState(NO_ACCOUNT);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const hydrated = useHydrated();

  return (
    <form
      className="space-y-3"
      data-testid="add-income-source"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        setSaved(null);
        const net = normalizeMoneyInput(amount);
        if (net === '') {
          setError('Enter what this source normally pays.');
          return;
        }
        const grossAmount = normalizeMoneyInput(gross);
        const day = Number.parseInt(dayOfMonth, 10);

        startTransition(async () => {
          const result = await createTemplateAction({
            kind: 'income',
            name,
            ...(counterparty.trim() === '' ? {} : { counterparty: counterparty.trim() }),
            incomeKind: incomeKind as 'employment',
            currency,
            frequency: frequency as 'monthly',
            ...(Number.isNaN(day) ? {} : { dayOfMonth: day }),
            startDate,
            // The server refuses an end before the start; the form does not
            // restate that rule, it just carries what was chosen (6.2).
            ...(endDate === '' ? {} : { endDate }),
            ...(account === NO_ACCOUNT ? {} : { cashPositionId: account }),
            amount: net,
            ...(grossAmount === '' ? {} : { grossAmount }),
          });
          if (!result.ok) {
            setError(result.error.message);
            return;
          }
          setSaved(`${name} added.`);
          setName('');
          setAmount('');
          setGross('');
          router.refresh();
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor={ids.name}>Name</Label>
          <Input
            id={ids.name}
            data-testid="source-name"
            value={name}
            required
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ids.counterparty}>Who pays it</Label>
          <Input
            id={ids.counterparty}
            data-testid="source-counterparty"
            value={counterparty}
            onChange={(event) => {
              setCounterparty(event.target.value);
            }}
          />
        </div>
        <Select
          id={ids.kind}
          testId="source-kind"
          label="What kind"
          value={incomeKind}
          options={SCHEDULABLE_INCOME_KINDS.map((value) => ({ value, label: incomeKindLabel(value) }))}
          onChange={setIncomeKind}
        />
        <Select
          id={ids.currency}
          testId="source-currency"
          label="Currency"
          value={currency}
          options={currencies.map((code) => ({ value: code, label: code }))}
          onChange={(value) => {
            setCurrency(value);
            setAccount((current) => accountForCurrency(accounts, current, value, NO_ACCOUNT));
          }}
        />
        <Select
          id={ids.frequency}
          testId="source-frequency"
          label="How often"
          value={frequency}
          options={FREQUENCIES}
          onChange={setFrequency}
        />
        <div className="space-y-1.5">
          <Label htmlFor={ids.dayOfMonth}>Day of the month</Label>
          <Input
            id={ids.dayOfMonth}
            data-testid="source-day"
            type="number"
            min={1}
            max={31}
            value={dayOfMonth}
            className="tabular"
            onChange={(event) => {
              setDayOfMonth(event.target.value);
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ids.startDate}>Starts</Label>
          <Input
            id={ids.startDate}
            data-testid="source-start-date"
            type="date"
            value={startDate}
            className="tabular"
            onChange={(event) => {
              setStartDate(event.target.value);
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ids.endDate}>Ends (optional)</Label>
          <Input
            id={ids.endDate}
            data-testid="source-end-date"
            type="date"
            value={endDate}
            className="tabular"
            onChange={(event) => {
              setEndDate(event.target.value);
            }}
          />
          <p className={META}>
            A source that genuinely stopped says so here. Leave it empty while it continues.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ids.amount}>Usual net ({currency})</Label>
          <Input
            id={ids.amount}
            data-testid="source-amount"
            value={amount}
            inputMode="decimal"
            required
            className="tabular text-right"
            onChange={(event) => {
              setAmount(event.target.value);
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ids.gross}>Usual gross ({currency})</Label>
          <Input
            id={ids.gross}
            data-testid="source-gross"
            value={gross}
            inputMode="decimal"
            className="tabular text-right"
            onChange={(event) => {
              setGross(event.target.value);
            }}
          />
        </div>
        <Select
          id={ids.account}
          testId="source-account"
          label="Usual account"
          value={account}
          options={accountOptions(accounts, currency)}
          onChange={setAccount}
        />
      </div>

      {startsInThePast(startDate, today) ? (
        <p role="status" className={META} data-testid="source-historical-warning">
          {HISTORICAL_START_WARNING} It starts on {dayTitle(startDate, locale)}.
        </p>
      ) : null}

      <Problem message={error} />
      {saved === null ? null : (
        <p role="status" aria-live="polite" data-testid="source-saved" className={META}>
          {saved}
        </p>
      )}

      <button type="submit" data-testid="source-submit" className={PRIMARY} disabled={!hydrated || pending}>
        {pending ? 'Saving…' : 'Add income source'}
      </button>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* The section                                                                 */
/* -------------------------------------------------------------------------- */

function Subsection({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-[length:var(--text-table)] font-semibold">{title}</h3>
      {description === undefined ? null : <p className={META}>{description}</p>}
      {children}
    </div>
  );
}

function Disclosure({
  label,
  testId,
  children,
}: {
  readonly label: string;
  readonly testId: string;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3">
      <button
        type="button"
        data-testid={testId}
        aria-expanded={open}
        className={ACTION}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        {open ? `Close ${label.toLowerCase()}` : label}
      </button>
      {open ? children : null}
    </div>
  );
}

export interface IncomeSectionProps {
  readonly income: MonthlyIncomeDto | CurrentMonthlyIncomeDto;
  readonly month: string;
  readonly monthName: string;
  readonly monthEndsOn: string;
  readonly today: string;
  readonly reportingCurrency: string;
  /**
   * The active FX-supported catalogue (10.5), from the page's own read.
   *
   * Never the currencies the user holds an account in: income received outside
   * tracked accounts has no account at all, tracked income may be recorded
   * before it is attributed to one, and a source need not have a default
   * account. Offering only account currencies would make each of those
   * unrecordable.
   */
  readonly selectableCurrencyCodes: readonly string[];
  readonly formatting: Formatting;
}

export function IncomeSection({
  income,
  month,
  monthName,
  monthEndsOn,
  today,
  reportingCurrency,
  selectableCurrencyCodes,
  formatting,
}: IncomeSectionProps) {
  const bounds = ownedEntryDateBounds({ month, monthEndsOn, today });
  const candidates =
    'earlyReceiptCandidates' in income ? income.earlyReceiptCandidates : [];
  const currencies = pickerCurrencies(selectableCurrencyCodes, reportingCurrency);
  const defaultCurrency = defaultPickerCurrency(currencies, reportingCurrency);

  return (
    <div className="space-y-6" data-testid="monthly-income">
      <Subsection
        title="Scheduled this month"
        description={`What your recurring sources expected in ${monthName}. A date here is the schedule's; the money keeps its own.`}
      >
        {income.occurrences.length === 0 ? (
          <p className={META} data-testid="income-occurrences-empty">
            No recurring income source has an occurrence in {monthName}.
          </p>
        ) : (
          <Table
            testId="income-occurrences"
            caption={`Recurring income scheduled in ${monthName}`}
            columns={[
              { label: 'Source' },
              { label: 'Dates' },
              { label: 'Amount', numeric: true },
              { label: 'State' },
              { label: 'Actions' },
            ]}
          >
            {income.occurrences.map((occurrence) => (
              <OccurrenceRow
                key={`${occurrence.templateId}-${occurrence.occurrenceDate}`}
                occurrence={occurrence}
                accounts={income.cashAccounts}
                formatting={formatting}
                month={month}
                today={today}
                bounds={bounds}
              />
            ))}
          </Table>
        )}
      </Subsection>

      {candidates.length === 0 ? null : (
        <Subsection
          title="Received something early?"
          description="The next occurrence of each source that nothing has recorded yet. Recording one dates the money today and leaves the occurrence on its own scheduled date."
        >
          <Table
            testId="income-early-candidates"
            caption="Sources whose next occurrence is after this month"
            columns={[
              { label: 'Source' },
              { label: 'Next occurrence' },
              { label: 'Amount', numeric: true },
              { label: 'Actions' },
            ]}
          >
            {candidates.map((candidate) => (
              <EarlyReceiptRow
                key={candidate.templateId}
                candidate={candidate}
                accounts={income.cashAccounts}
                formatting={formatting}
                month={month}
                today={today}
              />
            ))}
          </Table>
        </Subsection>
      )}

      {income.otherRecurring.length === 0 ? null : (
        <Subsection
          title="Recurring income received here for another month"
          description="Money that arrived in this month against an occurrence scheduled in a different one."
        >
          <Table
            testId="income-other-recurring"
            caption={`Recurring income received in ${monthName} for another month's occurrence`}
            columns={[
              { label: 'Source' },
              { label: 'Dates' },
              { label: 'Amount', numeric: true },
              { label: 'Actions' },
            ]}
          >
            {income.otherRecurring.map((entry) => (
              <EntryRow
                key={entry.entryId}
                entry={entry}
                accounts={income.cashAccounts}
                formatting={formatting}
                month={month}
                bounds={bounds}
                // Recurring: its kind and settlement are its source's.
                editableIdentity={false}
              />
            ))}
          </Table>
        </Subsection>
      )}

      <Subsection
        title="Other income received this month"
        description="Income no recurring source scheduled."
      >
        {income.direct.length === 0 ? (
          <p className={META} data-testid="income-direct-empty">
            Nothing else recorded in {monthName}.
          </p>
        ) : (
          <Table
            testId="income-direct"
            caption={`Income received in ${monthName} that no source scheduled`}
            columns={[
              { label: 'What' },
              { label: 'Date' },
              { label: 'Amount', numeric: true },
              { label: 'Actions' },
            ]}
          >
            {income.direct.map((entry) => (
              <EntryRow
                key={entry.entryId}
                entry={entry}
                accounts={income.cashAccounts}
                formatting={formatting}
                month={month}
                bounds={bounds}
                // Nothing scheduled it, so it has no source identity to keep.
                editableIdentity
              />
            ))}
          </Table>
        )}
      </Subsection>

      <div className="grid gap-6 border-t pt-4 lg:grid-cols-2">
        <Disclosure label="Add income" testId="income-add-toggle">
          <AddIncomeForm
            accounts={income.cashAccounts}
            currencies={currencies}
            bounds={bounds}
            defaultCurrency={defaultCurrency}
          />
        </Disclosure>
        <Disclosure label="Add income source" testId="source-add-toggle">
          <AddIncomeSourceForm
            accounts={income.cashAccounts}
            currencies={currencies}
            defaultCurrency={defaultCurrency}
            today={today}
            locale={formatting.locale}
          />
        </Disclosure>
      </div>
    </div>
  );
}
