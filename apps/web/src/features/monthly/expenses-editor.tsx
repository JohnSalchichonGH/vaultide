'use client';

import { useId, useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import type {
  CurrentMonthlyExpensesDto,
  ExpenseCategoryDto,
  ExpenseOccurrenceDto,
  ExpenseSourceDto,
  ExpenseTermDto,
  MonthlyExpenseEntryDto,
  MonthlyExpensesDto,
  PaidTodayCandidateDto,
} from '@vaultide/application';
import {
  createExpenseEntryAction,
  deleteExpenseEntryAction,
  updateExpenseEntryAction,
} from '@/server/actions/flows';
import {
  acceptSuggestionAction,
  createTemplateAction,
  setTemplateTermAction,
  skipSuggestionAction,
  unskipSuggestionAction,
  updateTemplateAction,
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
  defaultPickerCurrency,
  ownedEntryDateBounds,
  pickerCurrencies,
  startsInThePast,
} from '@/features/monthly/income-presentation';
import {
  EXPENSE_FREQUENCIES,
  EXPENSE_HISTORICAL_START_NOTE,
  EXPENSE_SKIP_REASON_LABEL,
  MONEY_OUT_GROUP_LABEL,
  MONEY_OUT_NOTE,
  NO_ACCOUNT,
  SPENDING_GROUP_LABEL,
  TRANSFER_FEE_NOTE,
  accountAfterChange,
  accountChoices,
  adjustmentAmountDefault,
  categoryOptionGroups,
  decideExpenseAmountOnBlur,
  defaultCategoryId,
  endDateChangeOf,
  endDateChangeSummary,
  expenseAmountProblem,
  expenseCrossMonthNotice,
  expenseOccurrenceStateLabel,
  expenseSkipReasonOptions,
  knownExpensesHref,
  otherWorkflowNote,
  ownsExpense,
  paymentMethodFor,
  paymentMethodLabel,
  paymentMethodOptions,
  termAmountProblem,
} from '@/features/monthly/expenses-presentation';
import {
  IDLE,
  canWrite,
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
 * Monthly's Known-expenses section (blueprint 15.3 section 3, 16.4–16.6, 20.1,
 * 20.3).
 *
 * Three groups, and the read decided which row is in which: the expense
 * occurrences the schedule placed in this month, the recurring spending incurred
 * here for another month's occurrence, and the expenses nothing scheduled.
 * Nothing is partitioned, priced, dated or classified here, and nothing is
 * totalled: the section holds tracked, self-paid and somebody else's spending
 * alike, and the known tracked figure belongs to Reconciliation.
 *
 * ## Controls are state-specific on purpose
 *
 * The same rule Income follows. An unresolved occurrence has nowhere to put an
 * amount except a materialized expense, so adjusting one **is** recording it; a
 * future occurrence can only be recorded through "Paid today", and only when the
 * server says it is next; a recorded one is corrected on its own row. "From this
 * month on" writes a term and rewrites nothing recorded, and "Ends on…" changes
 * a source's schedule — each a separate, separately labelled action.
 *
 * A zero or missing term is known in advance not to be an expense, so one-click
 * recording is not offered for it: the amount is stated, or the occurrence is
 * skipped when nothing was charged.
 *
 * ## The month with the money owns the row
 *
 * A row's financial date decides which page may correct or delete it; the
 * schedule's month shows it recorded and links there. A transfer's fee, and a
 * row filed under a kind another workflow owns, are shown as recorded and not
 * offered for change at all.
 *
 * Every write is an existing action behind `financialAction` (ADR 0003), and the
 * server judges all of it again. After a successful save the page asks the
 * server for itself; a refused one keeps what the user attempted.
 */

interface Formatting {
  readonly locale: string;
  readonly minorUnitsByCurrency: Readonly<Record<string, number>>;
}

type CashAccounts = MonthlyExpensesDto['cashAccounts'];
type Bounds = { readonly min: string; readonly max: string };

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
  'tabular h-9 w-24 rounded-[var(--radius-control)] border bg-[var(--color-surface)] px-2 text-right text-[length:var(--text-table)] sm:w-28 aria-[invalid=true]:border-[var(--color-negative)]';
const SELECT =
  'w-full rounded-[var(--radius-control)] border bg-[var(--color-surface)] px-2 py-1.5 text-[length:var(--text-table)]';
const ROW = 'border-b align-top last:border-0';
const NAME_CELL =
  'sticky left-0 z-10 bg-[var(--color-surface)] py-2 pr-2 text-left font-normal sm:pr-4';

/* -------------------------------------------------------------------------- */
/* Shared pieces                                                               */
/* -------------------------------------------------------------------------- */

function SaveStatus({ id, state }: { readonly id: string; readonly state: SaveState }) {
  return (
    <span
      id={id}
      role="status"
      aria-live="polite"
      data-testid="expense-save-status"
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
 * One expense amount, saved when the field is left (15.3). Clearing it saves
 * nothing and a zero is refused: an expense is removed with Delete, never by
 * writing it down to nothing.
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
  readonly saved: string;
  readonly minorUnits: number;
  readonly disabled: boolean;
  readonly describedBy: string;
  readonly onCommit: (amount: string) => Promise<SaveState>;
  readonly onInvalid: (message: string) => void;
  readonly onReverted: () => void;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? fieldValueOf(saved, minorUnits);

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
          const decision = decideExpenseAmountOnBlur({ draft, saved, minorUnits });
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

interface Option {
  readonly value: string;
  readonly label: string;
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
  readonly options: readonly Option[];
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
        className={SELECT}
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

/**
 * The category picker: ordinary spending, and money leaving tracked accounts
 * apart from it, so the picker never calls that consumption (7.4). A row's own
 * category that the picker does not offer is shown and cannot be chosen again.
 */
function CategorySelect({
  id,
  label,
  value,
  eligible,
  current,
  onChange,
  testId,
  disabled,
  hideLabel,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly eligible: readonly ExpenseCategoryDto[];
  readonly current?: ExpenseCategoryDto;
  readonly onChange: (value: string) => void;
  readonly testId: string;
  readonly disabled?: boolean;
  readonly hideLabel?: boolean;
}) {
  const groups = categoryOptionGroups(eligible, current);
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
        className={SELECT}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {groups.current === null ? null : (
          <option value={groups.current.value} disabled>
            {groups.current.label}
          </option>
        )}
        {groups.spending.length === 0 ? null : (
          <optgroup label={SPENDING_GROUP_LABEL}>
            {groups.spending.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </optgroup>
        )}
        {groups.moneyOut.length === 0 ? null : (
          <optgroup label={MONEY_OUT_GROUP_LABEL}>
            {groups.moneyOut.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
  );
}

/** The tracked accounts an expense could go through, and the unattributed state (8.1). */
function accountOptions(
  accounts: CashAccounts,
  currency: string,
  on: string,
  keep: string | null,
  none = 'Not attributed yet',
): Option[] {
  return [
    { value: NO_ACCOUNT, label: none },
    ...accountChoices(accounts, currency, on, keep).map((account) => ({
      value: account.positionId,
      label: account.name,
    })),
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
      data-testid="expense-error"
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
    // `relative` is load-bearing: it makes the scroller the containing block of
    // the visually hidden labels inside the cells, which would otherwise escape
    // the clip and widen a phone's page instead of the table.
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

/* -------------------------------------------------------------------------- */
/* From this month on                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A term effective at the occurrence's **scheduled** date (§30.9 item 4): an
 * amount alone, which may be zero, submitted with the expectation the row was
 * rendered from.
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
  readonly term: ExpenseTermDto;
  readonly formatting: Formatting;
  readonly onDone: () => void;
}) {
  const router = useRouter();
  const ids = { amount: useId(), note: useId() };
  const [amount, setAmount] = useState(term.amount?.amount ?? '');
  // A new term gets no note: an older one's explains why *that* term began.
  const [note, setNote] = useState(term.exact.state === 'version' ? (term.exact.note ?? '') : '');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const hydrated = useHydrated();

  return (
    <Panel
      title={`Amount from ${dayTitle(occurrenceDate, formatting.locale)} on`}
      testId="expense-term-panel"
    >
      <p className={META}>
        This changes what this and later occurrences are expected to cost. It does not change
        anything already recorded.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={ids.amount}>Amount ({currency})</Label>
          <Input
            id={ids.amount}
            data-testid="expense-term-amount"
            value={amount}
            inputMode="decimal"
            className="tabular text-right"
            onChange={(event) => {
              setAmount(event.target.value);
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ids.note}>Note</Label>
          <Input
            id={ids.note}
            data-testid="expense-term-note"
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
          data-testid="expense-term-save"
          className={PRIMARY}
          disabled={!hydrated || pending}
          onClick={() => {
            setError(null);
            const normalized = normalizeMoneyInput(amount);
            const problem = termAmountProblem(normalized, minorUnitsOf(formatting, currency));
            if (problem !== null) {
              setError(problem);
              return;
            }
            startTransition(async () => {
              const result = await setTemplateTermAction({
                templateId,
                effectiveFrom: occurrenceDate,
                amount: normalized,
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
/* Adjust & record, and Paid today                                             */
/* -------------------------------------------------------------------------- */

/**
 * Recording one occurrence with its own amount, account and financial date.
 *
 * The amount lands on the expense this creates and writes no term ("this
 * occurrence only", 6.2). `due` may take any date up to today — before the
 * scheduled one as well as after. `paidToday` records today by definition, and
 * the occurrence keeps its own scheduled date (§30.10).
 */
function AdjustAndRecord({
  templateId,
  occurrenceDate,
  currency,
  term,
  recordableAsExpected,
  defaultCashPositionId,
  accounts,
  formatting,
  month,
  today,
  mode,
  onDone,
}: {
  readonly templateId: string;
  readonly occurrenceDate: string;
  readonly currency: string;
  readonly term: ExpenseTermDto;
  readonly recordableAsExpected: boolean;
  readonly defaultCashPositionId: string | null;
  readonly accounts: CashAccounts;
  readonly formatting: Formatting;
  readonly month: string;
  readonly today: string;
  readonly mode: 'due' | 'paidToday';
  readonly onDone: () => void;
}) {
  const router = useRouter();
  const ids = { date: useId(), amount: useId(), account: useId(), description: useId() };
  const initialDate = mode === 'paidToday' ? today : occurrenceDate;
  const [incurredOn, setIncurredOn] = useState(initialDate);
  const [amount, setAmount] = useState(adjustmentAmountDefault(term, recordableAsExpected));
  const [account, setAccount] = useState(
    accountAfterChange(accounts, defaultCashPositionId ?? NO_ACCOUNT, currency, initialDate),
  );
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const hydrated = useHydrated();

  const notice = expenseCrossMonthNotice(incurredOn, month, (value) =>
    monthTitle(value, formatting.locale),
  );

  return (
    <Panel title={mode === 'paidToday' ? 'Paid today' : 'Adjust & record'} testId="expense-accept-panel">
      <div className="grid gap-3 sm:grid-cols-2">
        {mode === 'due' ? (
          <div className="space-y-1.5">
            <Label htmlFor={ids.date}>Incurred on</Label>
            <Input
              id={ids.date}
              data-testid="expense-accept-date"
              type="date"
              value={incurredOn}
              max={today}
              className="tabular"
              onChange={(event) => {
                const next = event.target.value;
                setIncurredOn(next);
                setAccount((current) => accountAfterChange(accounts, current, currency, next));
              }}
            />
          </div>
        ) : (
          <p className={META} data-testid="expense-accept-today-note">
            Recorded as paid today, {dayTitle(today, formatting.locale)}. The occurrence keeps its
            scheduled date of {dayTitle(occurrenceDate, formatting.locale)}.
          </p>
        )}

        <div className="space-y-1.5">
          <Label htmlFor={ids.amount}>Amount ({currency})</Label>
          <Input
            id={ids.amount}
            data-testid="expense-accept-amount"
            value={amount}
            inputMode="decimal"
            className="tabular text-right"
            onChange={(event) => {
              setAmount(event.target.value);
            }}
          />
        </div>

        <Select
          id={ids.account}
          testId="expense-accept-account"
          label="Tracked account"
          value={account}
          options={accountOptions(accounts, currency, incurredOn, null)}
          onChange={setAccount}
        />

        <div className="space-y-1.5">
          <Label htmlFor={ids.description}>Note</Label>
          <Input
            id={ids.description}
            data-testid="expense-accept-description"
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </div>
      </div>

      {notice === null ? null : (
        <p className={META} data-testid="expense-accept-cross-month">
          {notice}
        </p>
      )}
      <Problem message={error} />

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="expense-accept-submit"
          className={PRIMARY}
          disabled={!hydrated || pending}
          onClick={() => {
            setError(null);
            const normalized = normalizeMoneyInput(amount);
            const problem = expenseAmountProblem(normalized, minorUnitsOf(formatting, currency));
            if (problem !== null) {
              setError(problem);
              return;
            }
            startTransition(async () => {
              const result = await acceptSuggestionAction({
                templateId,
                occurrenceDate,
                amount: normalized,
                ...(mode === 'paidToday' ? { receivedToday: true } : { financialDate: incurredOn }),
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
  templateId,
  occurrenceDate,
  onDone,
}: {
  readonly templateId: string;
  readonly occurrenceDate: string;
  readonly onDone: () => void;
}) {
  const router = useRouter();
  const ids = { reason: useId(), note: useId() };
  const options = expenseSkipReasonOptions();
  const [reason, setReason] = useState(options[0]?.value ?? 'skipped');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const hydrated = useHydrated();

  return (
    <Panel title="Skip this occurrence" testId="expense-skip-panel">
      <p className={META}>
        A skip records that this was not charged. It creates no expense, and it is the honest answer
        when nothing was due.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          id={ids.reason}
          testId="expense-skip-reason"
          label="Why"
          value={reason}
          options={options}
          onChange={setReason}
        />
        <div className="space-y-1.5">
          <Label htmlFor={ids.note}>Note</Label>
          <Input
            id={ids.note}
            data-testid="expense-skip-note"
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
          data-testid="expense-skip-submit"
          className={PRIMARY}
          disabled={!hydrated || pending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await skipSuggestionAction({
                templateId,
                occurrenceDate,
                reason,
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
/* Ends on…                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A source's end date, and nothing else about it (6.2, §30.10).
 *
 * Changing it changes what the schedule expects — possibly in months whose
 * completeness is already reported — so the change is reviewed before it is
 * written, in words drawn from dates the read generated. The service decides
 * whether it is allowed, and its refusal is shown as it was given.
 */
function EndsOn({
  source,
  formatting,
  onDone,
}: {
  readonly source: ExpenseSourceDto;
  readonly formatting: Formatting;
  readonly onDone: () => void;
}) {
  const router = useRouter();
  const dateId = useId();
  const [date, setDate] = useState(source.endDate ?? '');
  const [proposal, setProposal] = useState<{ readonly endDate: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const hydrated = useHydrated();
  const day = (value: string): string => dayTitle(value, formatting.locale);
  const change = proposal === null ? null : endDateChangeOf(source, proposal.endDate);

  return (
    <Panel title={`When ${source.name} ends`} testId="expense-end-panel">
      <p className={META}>
        {source.endDate === null ? 'It has no end date, so it goes on.' : `It ends on ${day(source.endDate)}.`}{' '}
        An end date says the source genuinely stopped; archiving does not.
      </p>

      {proposal === null || change === null || change.kind === 'unchanged' ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor={dateId}>Ends on</Label>
            <Input
              id={dateId}
              data-testid="expense-end-date"
              type="date"
              min={source.startDate}
              value={date}
              className="tabular"
              onChange={(event) => {
                setDate(event.target.value);
                setError(null);
              }}
            />
          </div>
          <Problem message={error} />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="expense-end-review"
              className={PRIMARY}
              disabled={!hydrated || date === '' || date === source.endDate}
              onClick={() => {
                setError(null);
                setProposal({ endDate: date });
              }}
            >
              Review change
            </button>
            {source.endDate === null ? null : (
              <button
                type="button"
                data-testid="expense-end-clear"
                className={ACTION}
                disabled={!hydrated}
                onClick={() => {
                  setError(null);
                  setProposal({ endDate: null });
                }}
              >
                Remove end date
              </button>
            )}
            <button type="button" className={ACTION} onClick={onDone}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div role="group" aria-label="Confirm the change" data-testid="expense-end-confirmation" className="space-y-2">
          {endDateChangeSummary(change, {
            source: source.name,
            day,
            month: (value) => monthTitle(value, formatting.locale),
          }).map((sentence) => (
            <p key={sentence} className="text-[length:var(--text-meta)]">
              {sentence}
            </p>
          ))}
          <Problem message={error} />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="expense-end-confirm"
              className={PRIMARY}
              disabled={!hydrated || pending}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await updateTemplateAction({
                    templateId: source.templateId,
                    expectedVersion: source.version,
                    endDate: proposal.endDate,
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
              {pending ? 'Saving…' : 'Confirm'}
            </button>
            <button
              type="button"
              data-testid="expense-end-back"
              className={ACTION}
              disabled={pending}
              onClick={() => {
                setProposal(null);
              }}
            >
              Back
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* A recorded expense's editable facts                                         */
/* -------------------------------------------------------------------------- */

/**
 * What Monthly may correct on a row it owns.
 *
 * A direct row may correct everything that says what the expense was: amount,
 * date, category and how it was paid, account, note and the one-off flag. A
 * recorded occurrence corrects amount, date, account and note: its category, its
 * tracked-cash settlement and its identity are its source's. Currency is never
 * here — `updateExpenseEntry` does not take one.
 */
interface ExpensePatch {
  readonly categoryId?: string;
  readonly settlement?: string;
  readonly amount?: string;
  readonly incurredOn?: string;
  readonly cashPositionId?: string | null;
  readonly description?: string | null;
  readonly isOneOff?: boolean;
}

interface ExpenseDrafts extends Readonly<Record<string, unknown>> {
  readonly categoryId?: string;
  readonly settlement?: string;
  readonly incurredOn?: string;
  readonly cashPositionId?: string | null;
  readonly description?: string;
  readonly isOneOff?: boolean;
}

/**
 * One row's drafts, save state and writes — the same rules as Income's row
 * (15.3, 20.3): a draft is cleared only by the save that succeeds for it, a
 * refusal refreshes nothing over what was attempted, a second write waits for
 * the first, and Reload is the one deliberate way back to the server's row.
 */
function useExpenseSave(entry: MonthlyExpenseEntryDto) {
  const router = useRouter();
  const [state, setState] = useState<SaveState>(IDLE);
  const [drafts, setDrafts] = useState<ExpenseDrafts>({});
  // Keys the amount input, whose draft is its own state: only a remount reaches it.
  const [generation, setGeneration] = useState(0);
  const busy = state.kind === 'saving';

  const setDraft = (partial: ExpenseDrafts): void => {
    setDrafts((current) => ({ ...current, ...partial }));
  };

  const clearDraft = (key: string): void => {
    setDrafts((current) => withoutDraft(current, key));
  };

  const commit = async (patch: ExpensePatch, draft: ExpenseDrafts = {}): Promise<SaveState> => {
    if (!canWrite(state)) return state;
    setDraft(draft);
    const fields = Object.keys(draft);
    const final = await runSave(
      () =>
        updateExpenseEntryAction({
          entryId: entry.entryId,
          expectedVersion: entry.version,
          ...patch,
        }),
      setState,
      () => {
        router.refresh();
      },
    );
    setDrafts((current) => draftsAfterSave(current, fields, final));
    return final;
  };

  const reload = (): void => {
    setDrafts({});
    setState(IDLE);
    setGeneration((current) => current + 1);
    router.refresh();
  };

  const remove = async (): Promise<SaveState> => {
    if (!canWrite(state)) return state;
    return runSave(() => deleteExpenseEntryAction({ entryId: entry.entryId }), setState, () => {
      router.refresh();
    });
  };

  return { state, setState, drafts, busy, generation, setDraft, clearDraft, commit, reload, remove };
}

/**
 * Category and how it was paid, corrected together.
 *
 * One fact in two fields: money leaving tracked accounts is paid from a tracked
 * account on this section, so choosing it narrows the methods, and choosing
 * something else opens them again. Both are held as drafts and one explicit
 * action writes the pair, so nothing is reclassified by a stray selection.
 */
function Classification({
  entry,
  drafts,
  eligible,
  disabled,
  onDraft,
  onApply,
}: {
  readonly entry: MonthlyExpenseEntryDto;
  readonly drafts: ExpenseDrafts;
  readonly eligible: readonly ExpenseCategoryDto[];
  readonly disabled: boolean;
  readonly onDraft: (partial: ExpenseDrafts) => void;
  readonly onApply: (categoryId: string, settlement: string) => void;
}) {
  const ids = { category: useId(), payment: useId() };
  const categoryId = drafts.categoryId ?? entry.category.categoryId;
  const category =
    eligible.find((row) => row.categoryId === categoryId) ??
    (categoryId === entry.category.categoryId ? entry.category : undefined);
  const payment = paymentMethodFor(category, drafts.settlement ?? entry.settlement);
  const changed = categoryId !== entry.category.categoryId || payment !== entry.settlement;

  return (
    <>
      <CategorySelect
        id={ids.category}
        testId="expense-category"
        label="Category"
        hideLabel
        value={categoryId}
        eligible={eligible}
        current={entry.category}
        disabled={disabled}
        onChange={(value) => {
          const next = eligible.find((row) => row.categoryId === value);
          onDraft({ categoryId: value, settlement: paymentMethodFor(next, payment) });
        }}
      />
      <Select
        id={ids.payment}
        testId="expense-payment"
        label="How it was paid"
        hideLabel
        value={payment}
        options={paymentMethodOptions(category)}
        disabled={disabled}
        onChange={(value) => {
          onDraft({ settlement: value });
        }}
      />
      {category?.use === 'money_out' ? (
        <p className={cn(META, 'sm:col-span-2')} data-testid="expense-money-out-note">
          {MONEY_OUT_NOTE}
        </p>
      ) : null}
      {changed ? (
        <button
          type="button"
          data-testid="expense-apply-classification"
          className={cn(PRIMARY, 'self-end')}
          disabled={disabled}
          onClick={() => {
            onApply(categoryId, payment);
          }}
        >
          Apply
        </button>
      ) : null}
    </>
  );
}

function EntryFields({
  entry,
  accounts,
  eligibleCategories,
  formatting,
  bounds,
  mode,
}: {
  readonly entry: MonthlyExpenseEntryDto;
  readonly accounts: CashAccounts;
  readonly eligibleCategories: readonly ExpenseCategoryDto[];
  readonly formatting: Formatting;
  readonly bounds: Bounds;
  readonly mode: 'direct' | 'recurring';
}) {
  const statusId = useId();
  const ids = { account: useId(), date: useId(), description: useId(), oneOff: useId() };
  const { state, setState, drafts, busy, generation, setDraft, clearDraft, commit, reload, remove } =
    useExpenseSave(entry);
  const hydrated = useHydrated();
  const disabled = !hydrated || busy;

  const incurredOn = drafts.incurredOn ?? entry.incurredOn;
  const cashPositionId =
    drafts.cashPositionId === undefined ? entry.cashPositionId : drafts.cashPositionId;
  const description = drafts.description ?? entry.description ?? '';
  const isOneOff = drafts.isOneOff ?? entry.isOneOff;

  const onInvalid = (message: string): void => {
    setState({ kind: 'invalid', message });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end justify-end gap-2">
        <div className="flex flex-col items-end gap-0.5">
          <span className={META}>Amount</span>
          <AmountField
            key={`amount-${String(generation)}`}
            label={`Amount (${entry.currency})`}
            testId="expense-amount"
            saved={entry.amount.amount}
            minorUnits={minorUnitsOf(formatting, entry.currency)}
            disabled={disabled}
            describedBy={statusId}
            onCommit={(amount) => commit({ amount })}
            onInvalid={onInvalid}
            onReverted={() => {
              setState(IDLE);
            }}
          />
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={ids.date} className="sr-only">
            Incurred on
          </Label>
          <Input
            id={ids.date}
            data-testid="expense-incurred-on"
            type="date"
            value={incurredOn}
            min={bounds.min}
            max={bounds.max}
            disabled={disabled}
            className="tabular"
            onChange={(event) => {
              const next = event.target.value;
              // Inside this month only; any occurrence the row fulfils keeps its
              // own scheduled date whatever happens here.
              if (next < bounds.min || next > bounds.max) {
                setDraft({ incurredOn: next });
                onInvalid(`Choose a date between ${bounds.min} and ${bounds.max}.`);
                return;
              }
              void commit({ incurredOn: next }, { incurredOn: next });
            }}
          />
        </div>

        {mode === 'direct' ? (
          <Classification
            entry={entry}
            drafts={drafts}
            eligible={eligibleCategories}
            disabled={disabled}
            onDraft={setDraft}
            onApply={(categoryId, settlement) => {
              void commit(
                {
                  // An unchanged category is not resent: an archived one takes
                  // no new classification, and this is not one.
                  ...(categoryId === entry.category.categoryId ? {} : { categoryId }),
                  settlement,
                  // A payment that never touched tracked cash carries no account.
                  ...(settlement === 'tracked_cash' ? {} : { cashPositionId: null }),
                },
                { categoryId, settlement },
              );
            }}
          />
        ) : null}

        {entry.settlement === 'tracked_cash' ? (
          <Select
            id={ids.account}
            testId="expense-account"
            label="Tracked account"
            hideLabel
            value={cashPositionId ?? NO_ACCOUNT}
            options={accountOptions(accounts, entry.currency, incurredOn, entry.cashPositionId)}
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
            data-testid="expense-description"
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

        {mode === 'direct' ? (
          <label className="flex items-center gap-2 text-[length:var(--text-meta)]" htmlFor={ids.oneOff}>
            <input
              id={ids.oneOff}
              type="checkbox"
              data-testid="expense-one-off"
              checked={isOneOff}
              disabled={disabled}
              onChange={(event) => {
                const next = event.target.checked;
                void commit({ isOneOff: next }, { isOneOff: next });
              }}
            />
            One-off
          </label>
        ) : null}
      </div>

      <SaveStatus id={statusId} state={state} />

      <div className="flex justify-end gap-2">
        {state.kind === 'conflict' || state.kind === 'error' ? (
          <button type="button" data-testid="expense-reload" className={ACTION} onClick={reload}>
            Reload
          </button>
        ) : null}
        <button
          type="button"
          data-testid="expense-delete"
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

/** A row this page shows but does not own: the expense belongs to another month. */
function ElsewhereNotice({
  entry,
  locale,
}: {
  readonly entry: MonthlyExpenseEntryDto;
  readonly locale: string;
}) {
  const name = monthTitle(entry.incurredMonth, locale);
  return (
    <p className={META} data-testid="expense-elsewhere">
      Incurred in {name}.{' '}
      <Link href={knownExpensesHref(entry.incurredMonth) as Route} className="underline">
        Open {name} to change it
      </Link>
    </p>
  );
}

/** A row shown as recorded because another aggregate owns it. */
function ReadOnlyNotice({ entry }: { readonly entry: MonthlyExpenseEntryDto }) {
  return (
    <p className={META} data-testid="expense-read-only" data-reason={entry.readOnly ?? undefined}>
      {entry.readOnly === 'transfer_fee' ? TRANSFER_FEE_NOTE : otherWorkflowNote(entry)}
    </p>
  );
}

/** Which of the three a row gets on this page: its fields, a notice, or a link. */
function EntryControls({
  entry,
  accounts,
  eligibleCategories,
  formatting,
  month,
  bounds,
  mode,
}: {
  readonly entry: MonthlyExpenseEntryDto;
  readonly accounts: CashAccounts;
  readonly eligibleCategories: readonly ExpenseCategoryDto[];
  readonly formatting: Formatting;
  readonly month: string;
  readonly bounds: Bounds;
  readonly mode: 'direct' | 'recurring';
}) {
  if (!ownsExpense(entry, month)) return <ElsewhereNotice entry={entry} locale={formatting.locale} />;
  if (entry.readOnly !== null) return <ReadOnlyNotice entry={entry} />;
  return (
    <EntryFields
      entry={entry}
      accounts={accounts}
      eligibleCategories={eligibleCategories}
      formatting={formatting}
      bounds={bounds}
      mode={mode}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Scheduled occurrences                                                       */
/* -------------------------------------------------------------------------- */

type OpenPanel = 'adjust' | 'paidToday' | 'term' | 'skip' | 'end' | null;

function OccurrenceRow({
  occurrence,
  accounts,
  eligibleCategories,
  formatting,
  month,
  today,
  bounds,
}: {
  readonly occurrence: ExpenseOccurrenceDto;
  readonly accounts: CashAccounts;
  readonly eligibleCategories: readonly ExpenseCategoryDto[];
  readonly formatting: Formatting;
  readonly month: string;
  readonly today: string;
  readonly bounds: Bounds;
}) {
  const router = useRouter();
  const [panel, setPanel] = useState<OpenPanel>(null);
  const [state, setState] = useState<SaveState>(IDLE);
  const statusId = useId();
  const hydrated = useHydrated();
  const { state: occurrenceState, source, term } = occurrence;
  const busy = !hydrated || state.kind === 'saving';
  const archived = source.archived;
  const day = (date: string): string => dayTitle(date, formatting.locale);
  const close = (): void => {
    setPanel(null);
  };
  const toggle = (next: Exclude<OpenPanel, null>): void => {
    setPanel(panel === next ? null : next);
  };

  const run = (send: () => Promise<SaveOutcome>): Promise<SaveState> =>
    runSave(send, setState, () => {
      router.refresh();
    });

  const unresolved = occurrenceState.kind === 'due' || occurrenceState.kind === 'upcoming';

  return (
    <tr
      className={ROW}
      data-testid="expense-occurrence"
      data-template-id={occurrence.templateId}
      data-occurrence-date={occurrence.occurrenceDate}
      data-state={occurrenceState.kind}
    >
      <th scope="row" className={NAME_CELL}>
        <span className="font-medium">{source.name}</span>
        <span className={cn('block', META)}>
          {source.category.name}
          {source.counterparty === null ? '' : ` · ${source.counterparty}`} · {source.currency}
        </span>
        {source.endDate === null ? null : (
          <span className={cn('block', META)} data-testid="expense-source-ends">
            Ends {day(source.endDate)}
          </span>
        )}
      </th>

      <td className="py-2 pr-2 sm:pr-4" data-testid="expense-occurrence-dates">
        <span className="block whitespace-nowrap">Scheduled {day(occurrence.occurrenceDate)}</span>
        {occurrenceState.kind === 'accepted' ? (
          <span
            className={cn('block whitespace-nowrap', META)}
            data-testid="expense-occurrence-incurred-on"
          >
            Incurred {day(occurrenceState.entry.incurredOn)}
          </span>
        ) : null}
      </td>

      <td className="py-2 pr-2 text-right sm:pr-4" data-testid="expense-occurrence-amount">
        {occurrenceState.kind === 'accepted' ? (
          <>
            <Money
              amount={occurrenceState.entry.amount.amount}
              currency={source.currency}
              formatting={formatting}
            />
            <span className={cn('block', META)}>
              {occurrenceState.entry.cashAccountName ?? 'Not attributed yet'}
            </span>
          </>
        ) : (
          <>
            <Money amount={term.amount?.amount ?? null} currency={source.currency} formatting={formatting} />
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
          data-testid="expense-occurrence-status"
        >
          {expenseOccurrenceStateLabel(occurrenceState)}
        </Badge>
        {archived ? (
          <span className={cn('block', META)} data-testid="expense-occurrence-archived">
            Source archived
          </span>
        ) : null}
        {occurrenceState.kind === 'skipped' ? (
          <span className={cn('block', META)} data-testid="expense-occurrence-skip-reason">
            {EXPENSE_SKIP_REASON_LABEL[occurrenceState.reason] ?? occurrenceState.reason}
            {occurrenceState.note === null ? '' : ` — ${occurrenceState.note}`}
          </span>
        ) : null}
      </td>

      <td className="py-2">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap justify-end gap-2">
            {occurrenceState.kind === 'due' && !archived ? (
              <>
                {occurrence.recordableAsExpected ? (
                  <button
                    type="button"
                    data-testid="expense-record"
                    className={PRIMARY}
                    disabled={busy}
                    onClick={() => {
                      void run(() =>
                        acceptSuggestionAction({
                          templateId: occurrence.templateId,
                          occurrenceDate: occurrence.occurrenceDate,
                        }),
                      );
                    }}
                  >
                    Record it
                  </button>
                ) : null}
                <button
                  type="button"
                  data-testid="expense-adjust"
                  className={ACTION}
                  disabled={busy}
                  onClick={() => {
                    toggle('adjust');
                  }}
                >
                  Adjust &amp; record
                </button>
              </>
            ) : null}

            {occurrenceState.kind === 'upcoming' && occurrenceState.paidTodayEligible && !archived ? (
              <button
                type="button"
                data-testid="expense-paid-today"
                className={PRIMARY}
                disabled={busy}
                onClick={() => {
                  toggle('paidToday');
                }}
              >
                Paid today
              </button>
            ) : null}

            {unresolved && !archived ? (
              <button
                type="button"
                data-testid="expense-skip"
                className={ACTION}
                disabled={busy}
                onClick={() => {
                  toggle('skip');
                }}
              >
                Skip
              </button>
            ) : null}

            {occurrenceState.kind === 'skipped' ? (
              <button
                type="button"
                data-testid="expense-restore"
                className={ACTION}
                disabled={busy}
                onClick={() => {
                  void run(() => unskipSuggestionAction({ skipId: occurrenceState.skipId }));
                }}
              >
                Restore
              </button>
            ) : null}

            {archived ? null : (
              <button
                type="button"
                data-testid="expense-term"
                className={ACTION}
                disabled={busy}
                onClick={() => {
                  toggle('term');
                }}
              >
                From this month on
              </button>
            )}

            <button
              type="button"
              data-testid="expense-end"
              className={ACTION}
              disabled={busy}
              onClick={() => {
                toggle('end');
              }}
            >
              Ends on…
            </button>
          </div>

          {occurrenceState.kind === 'due' && !occurrence.recordableAsExpected && !archived ? (
            <p className={META} data-testid="expense-needs-amount">
              {term.amount === null
                ? 'No amount is set for this date. Record it with what it cost, or skip it.'
                : 'Its expected amount is zero. Record it with what it actually cost, or skip it if nothing was charged.'}
            </p>
          ) : null}

          <SaveStatus id={statusId} state={state} />

          {occurrenceState.kind === 'accepted' ? (
            <EntryControls
              entry={occurrenceState.entry}
              accounts={accounts}
              eligibleCategories={eligibleCategories}
              formatting={formatting}
              month={month}
              bounds={bounds}
              mode="recurring"
            />
          ) : null}

          {panel === 'adjust' || panel === 'paidToday' ? (
            <AdjustAndRecord
              templateId={occurrence.templateId}
              occurrenceDate={occurrence.occurrenceDate}
              currency={source.currency}
              term={term}
              recordableAsExpected={occurrence.recordableAsExpected}
              defaultCashPositionId={source.defaultCashPositionId}
              accounts={accounts}
              formatting={formatting}
              month={month}
              today={today}
              mode={panel === 'paidToday' ? 'paidToday' : 'due'}
              onDone={close}
            />
          ) : null}
          {panel === 'skip' ? (
            <SkipOccurrence
              templateId={occurrence.templateId}
              occurrenceDate={occurrence.occurrenceDate}
              onDone={close}
            />
          ) : null}
          {panel === 'term' ? (
            <ChangeFutureAmount
              templateId={occurrence.templateId}
              occurrenceDate={occurrence.occurrenceDate}
              currency={source.currency}
              term={term}
              formatting={formatting}
              onDone={close}
            />
          ) : null}
          {panel === 'end' ? <EndsOn source={source} formatting={formatting} onDone={close} /> : null}
        </div>
      </td>
    </tr>
  );
}

/* -------------------------------------------------------------------------- */
/* Paid today beyond the month                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The one occurrence per source that "Paid today" may reach when it lies past
 * the end of the month on screen (§30.10). No horizon; the server checks the
 * same rule again under the template's lock.
 */
function PaidTodayRow({
  candidate,
  accounts,
  formatting,
  month,
  today,
  offerEnd,
}: {
  readonly candidate: PaidTodayCandidateDto;
  readonly accounts: CashAccounts;
  readonly formatting: Formatting;
  readonly month: string;
  readonly today: string;
  /** Only when the source has no row above to end it from. */
  readonly offerEnd: boolean;
}) {
  const [panel, setPanel] = useState<'paidToday' | 'end' | null>(null);
  const hydrated = useHydrated();
  const { source } = candidate;

  return (
    <tr
      className={ROW}
      data-testid="expense-paid-today-candidate"
      data-template-id={candidate.templateId}
      data-occurrence-date={candidate.occurrenceDate}
    >
      <th scope="row" className={NAME_CELL}>
        <span className="font-medium">{source.name}</span>
        <span className={cn('block', META)}>
          {source.category.name} · {source.currency}
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
        <Money amount={candidate.term.amount?.amount ?? null} currency={source.currency} formatting={formatting} />
      </td>
      <td className="py-2">
        <div className="flex flex-col items-end gap-2">
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              data-testid="expense-candidate-paid-today"
              className={PRIMARY}
              disabled={!hydrated}
              onClick={() => {
                setPanel((current) => (current === 'paidToday' ? null : 'paidToday'));
              }}
            >
              Paid today
            </button>
            {offerEnd ? (
              <button
                type="button"
                data-testid="expense-end"
                className={ACTION}
                disabled={!hydrated}
                onClick={() => {
                  setPanel((current) => (current === 'end' ? null : 'end'));
                }}
              >
                Ends on…
              </button>
            ) : null}
          </div>
          {panel === 'paidToday' ? (
            <AdjustAndRecord
              templateId={candidate.templateId}
              occurrenceDate={candidate.occurrenceDate}
              currency={source.currency}
              term={candidate.term}
              recordableAsExpected={candidate.recordableAsExpected}
              defaultCashPositionId={source.defaultCashPositionId}
              accounts={accounts}
              formatting={formatting}
              month={month}
              today={today}
              mode="paidToday"
              onDone={() => {
                setPanel(null);
              }}
            />
          ) : null}
          {panel === 'end' ? (
            <EndsOn
              source={source}
              formatting={formatting}
              onDone={() => {
                setPanel(null);
              }}
            />
          ) : null}
        </div>
      </td>
    </tr>
  );
}

/* -------------------------------------------------------------------------- */
/* Recorded expense rows                                                       */
/* -------------------------------------------------------------------------- */

function EntryRow({
  entry,
  accounts,
  eligibleCategories,
  formatting,
  month,
  bounds,
}: {
  readonly entry: MonthlyExpenseEntryDto;
  readonly accounts: CashAccounts;
  readonly eligibleCategories: readonly ExpenseCategoryDto[];
  readonly formatting: Formatting;
  readonly month: string;
  readonly bounds: Bounds;
}) {
  const day = (date: string): string => dayTitle(date, formatting.locale);

  return (
    <tr className={ROW} data-testid="expense-entry" data-entry-id={entry.entryId}>
      <th scope="row" className={NAME_CELL}>
        <span className="font-medium">
          {entry.occurrence === null ? entry.category.name : entry.occurrence.templateName}
        </span>
        <span className={cn('block', META)} data-testid="expense-entry-meta">
          {entry.occurrence === null ? '' : `${entry.category.name} · `}
          {paymentMethodLabel(entry.settlement)}
          {entry.isOneOff ? ' · one-off' : ''}
          {entry.category.archived ? ' · archived category' : ''}
        </span>
      </th>

      <td className="py-2 pr-2 sm:pr-4">
        <span className="block whitespace-nowrap">Incurred {day(entry.incurredOn)}</span>
        {entry.occurrence === null ? null : (
          <span className={cn('block whitespace-nowrap', META)} data-testid="expense-entry-occurrence">
            For the occurrence scheduled {day(entry.occurrence.occurrenceDate)} ·{' '}
            <Link href={knownExpensesHref(entry.occurrence.occurrenceMonth) as Route} className="underline">
              {monthTitle(entry.occurrence.occurrenceMonth, formatting.locale)}
            </Link>
          </span>
        )}
        {entry.description === null ? null : (
          <span className={cn('block', META)}>{entry.description}</span>
        )}
      </td>

      <td className="py-2 pr-2 text-right sm:pr-4">
        <Money amount={entry.amount.amount} currency={entry.currency} formatting={formatting} />
        <span className={cn('block', META)} data-testid="expense-attribution">
          {entry.settlement === 'tracked_cash'
            ? (entry.cashAccountName ?? 'Not attributed yet')
            : paymentMethodLabel(entry.settlement)}
        </span>
      </td>

      <td className="py-2">
        <EntryControls
          entry={entry}
          accounts={accounts}
          eligibleCategories={eligibleCategories}
          formatting={formatting}
          month={month}
          bounds={bounds}
          mode={entry.occurrence === null ? 'direct' : 'recurring'}
        />
      </td>
    </tr>
  );
}

/* -------------------------------------------------------------------------- */
/* Add a known expense                                                         */
/* -------------------------------------------------------------------------- */

export function AddExpenseForm({
  accounts,
  eligibleCategories,
  currencies,
  bounds,
  defaultCurrency,
  formatting,
}: {
  readonly accounts: CashAccounts;
  readonly eligibleCategories: readonly ExpenseCategoryDto[];
  readonly currencies: readonly string[];
  readonly bounds: Bounds;
  readonly defaultCurrency: string;
  readonly formatting: Formatting;
}) {
  const router = useRouter();
  const ids = {
    category: useId(),
    date: useId(),
    amount: useId(),
    currency: useId(),
    payment: useId(),
    account: useId(),
    description: useId(),
    oneOff: useId(),
  };
  const [categoryId, setCategoryId] = useState(defaultCategoryId(eligibleCategories));
  const [incurredOn, setIncurredOn] = useState(bounds.max);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(defaultCurrency);
  const [payment, setPayment] = useState('tracked_cash');
  const [account, setAccount] = useState(NO_ACCOUNT);
  const [description, setDescription] = useState('');
  const [isOneOff, setIsOneOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const hydrated = useHydrated();

  const category = eligibleCategories.find((row) => row.categoryId === categoryId);
  const effectivePayment = paymentMethodFor(category, payment);

  return (
    <form
      className="space-y-3"
      data-testid="add-expense"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        setSaved(null);
        if (category === undefined) {
          setError('Choose a category.');
          return;
        }
        const normalized = normalizeMoneyInput(amount);
        const problem = expenseAmountProblem(normalized, minorUnitsOf(formatting, currency));
        if (problem !== null) {
          setError(problem);
          return;
        }

        startTransition(async () => {
          const result = await createExpenseEntryAction({
            categoryId,
            incurredOn,
            amount: normalized,
            currency,
            settlement: effectivePayment,
            cashPositionId:
              effectivePayment === 'tracked_cash' && account !== NO_ACCOUNT ? account : null,
            ...(description.trim() === '' ? {} : { description: description.trim() }),
            isOneOff,
          });
          if (!result.ok) {
            setError(result.error.message);
            return;
          }
          setSaved('Expense added.');
          setAmount('');
          setDescription('');
          setIsOneOff(false);
          router.refresh();
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <CategorySelect
          id={ids.category}
          testId="expense-add-category"
          label="Category"
          value={categoryId}
          eligible={eligibleCategories}
          onChange={setCategoryId}
        />
        <div className="space-y-1.5">
          <Label htmlFor={ids.date}>Incurred on</Label>
          <Input
            id={ids.date}
            data-testid="expense-add-date"
            type="date"
            value={incurredOn}
            min={bounds.min}
            max={bounds.max}
            className="tabular"
            onChange={(event) => {
              const next = event.target.value;
              setIncurredOn(next);
              setAccount((current) => accountAfterChange(accounts, current, currency, next));
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ids.amount}>Amount ({currency})</Label>
          <Input
            id={ids.amount}
            data-testid="expense-add-amount"
            value={amount}
            inputMode="decimal"
            required
            className="tabular text-right"
            onChange={(event) => {
              setAmount(event.target.value);
            }}
          />
        </div>
        <Select
          id={ids.currency}
          testId="expense-add-currency"
          label="Currency"
          value={currency}
          options={currencies.map((code) => ({ value: code, label: code }))}
          onChange={(value) => {
            setCurrency(value);
            setAccount((current) => accountAfterChange(accounts, current, value, incurredOn));
          }}
        />
        <Select
          id={ids.payment}
          testId="expense-add-payment"
          label="How it was paid"
          value={effectivePayment}
          options={paymentMethodOptions(category)}
          onChange={setPayment}
        />
        {effectivePayment === 'tracked_cash' ? (
          <Select
            id={ids.account}
            testId="expense-add-account"
            label="Tracked account"
            value={account}
            options={accountOptions(accounts, currency, incurredOn, null)}
            onChange={setAccount}
          />
        ) : null}
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={ids.description}>Note</Label>
          <Input
            id={ids.description}
            data-testid="expense-add-description"
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </div>
        <label className="flex items-center gap-2 self-end text-[length:var(--text-meta)]" htmlFor={ids.oneOff}>
          <input
            id={ids.oneOff}
            type="checkbox"
            data-testid="expense-add-one-off"
            checked={isOneOff}
            onChange={(event) => {
              setIsOneOff(event.target.checked);
            }}
          />
          One-off
        </label>
      </div>

      {category?.use === 'money_out' ? (
        <p className={META} data-testid="expense-add-money-out-note">
          {MONEY_OUT_NOTE}
        </p>
      ) : null}
      <Problem message={error} />
      {saved === null ? null : (
        <p role="status" aria-live="polite" data-testid="expense-add-saved" className={META}>
          {saved}
        </p>
      )}

      <button type="submit" data-testid="expense-add-submit" className={PRIMARY} disabled={!hydrated || pending}>
        {pending ? 'Saving…' : 'Add expense'}
      </button>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Add a recurring expense source                                              */
/* -------------------------------------------------------------------------- */

/**
 * Creating a recurring expense source (6.2), and nothing else about one.
 *
 * The existing creation input as it is: no settlement — a source materializes
 * tracked cash only (§30.9 item 1) — no tags, and a start date that may be
 * historical, stated plainly rather than prevented. The usual amount may be zero.
 */
export function AddExpenseSourceForm({
  accounts,
  eligibleCategories,
  currencies,
  defaultCurrency,
  today,
  formatting,
}: {
  readonly accounts: CashAccounts;
  readonly eligibleCategories: readonly ExpenseCategoryDto[];
  readonly currencies: readonly string[];
  readonly defaultCurrency: string;
  readonly today: string;
  readonly formatting: Formatting;
}) {
  const router = useRouter();
  const ids = {
    name: useId(),
    payee: useId(),
    category: useId(),
    currency: useId(),
    frequency: useId(),
    dayOfMonth: useId(),
    startDate: useId(),
    endDate: useId(),
    amount: useId(),
    account: useId(),
  };
  const [name, setName] = useState('');
  const [payee, setPayee] = useState('');
  const [categoryId, setCategoryId] = useState(defaultCategoryId(eligibleCategories));
  const [currency, setCurrency] = useState(defaultCurrency);
  const [frequency, setFrequency] = useState<string>('monthly');
  const [dayOfMonth, setDayOfMonth] = useState('1');
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState('');
  const [amount, setAmount] = useState('');
  const [account, setAccount] = useState(NO_ACCOUNT);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const hydrated = useHydrated();

  const category = eligibleCategories.find((row) => row.categoryId === categoryId);

  return (
    <form
      className="space-y-3"
      data-testid="add-expense-source"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        setSaved(null);
        if (category === undefined) {
          setError('Choose a category.');
          return;
        }
        const usual = normalizeMoneyInput(amount);
        const problem = termAmountProblem(usual, minorUnitsOf(formatting, currency));
        if (problem !== null) {
          setError(problem);
          return;
        }
        const day = Number.parseInt(dayOfMonth, 10);

        startTransition(async () => {
          const result = await createTemplateAction({
            kind: 'expense',
            name,
            ...(payee.trim() === '' ? {} : { counterparty: payee.trim() }),
            categoryId,
            currency,
            frequency,
            ...(Number.isNaN(day) ? {} : { dayOfMonth: day }),
            startDate,
            ...(endDate === '' ? {} : { endDate }),
            ...(account === NO_ACCOUNT ? {} : { cashPositionId: account }),
            amount: usual,
          });
          if (!result.ok) {
            setError(result.error.message);
            return;
          }
          setSaved(`${name} added.`);
          setName('');
          setPayee('');
          setAmount('');
          router.refresh();
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor={ids.name}>Name</Label>
          <Input
            id={ids.name}
            data-testid="expense-source-name"
            value={name}
            required
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ids.payee}>Paid to (optional)</Label>
          <Input
            id={ids.payee}
            data-testid="expense-source-payee"
            value={payee}
            onChange={(event) => {
              setPayee(event.target.value);
            }}
          />
        </div>
        <CategorySelect
          id={ids.category}
          testId="expense-source-category"
          label="Category"
          value={categoryId}
          eligible={eligibleCategories}
          onChange={setCategoryId}
        />
        <Select
          id={ids.currency}
          testId="expense-source-currency"
          label="Currency"
          value={currency}
          options={currencies.map((code) => ({ value: code, label: code }))}
          onChange={(value) => {
            setCurrency(value);
            setAccount((current) => accountAfterChange(accounts, current, value, ''));
          }}
        />
        <Select
          id={ids.frequency}
          testId="expense-source-frequency"
          label="How often"
          value={frequency}
          options={EXPENSE_FREQUENCIES}
          onChange={setFrequency}
        />
        <div className="space-y-1.5">
          <Label htmlFor={ids.dayOfMonth}>Day of the month</Label>
          <Input
            id={ids.dayOfMonth}
            data-testid="expense-source-day"
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
            data-testid="expense-source-start-date"
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
            data-testid="expense-source-end-date"
            type="date"
            value={endDate}
            className="tabular"
            onChange={(event) => {
              setEndDate(event.target.value);
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ids.amount}>Usual amount ({currency})</Label>
          <Input
            id={ids.amount}
            data-testid="expense-source-amount"
            value={amount}
            inputMode="decimal"
            required
            className="tabular text-right"
            onChange={(event) => {
              setAmount(event.target.value);
            }}
          />
        </div>
        <Select
          id={ids.account}
          testId="expense-source-account"
          label="Usual tracked account"
          value={account}
          options={accountOptions(accounts, currency, '', null, 'No usual account')}
          onChange={setAccount}
        />
      </div>

      <p className={META}>
        Each occurrence is recorded as paid from a tracked account. An expense paid another way is
        added by hand.
      </p>
      {category?.use === 'money_out' ? (
        <p className={META} data-testid="expense-source-money-out-note">
          {MONEY_OUT_NOTE}
        </p>
      ) : null}
      {startsInThePast(startDate, today) ? (
        <p role="status" className={META} data-testid="expense-source-historical-note">
          {EXPENSE_HISTORICAL_START_NOTE} It starts on {dayTitle(startDate, formatting.locale)}.
        </p>
      ) : null}

      <Problem message={error} />
      {saved === null ? null : (
        <p role="status" aria-live="polite" data-testid="expense-source-saved" className={META}>
          {saved}
        </p>
      )}

      <button type="submit" data-testid="expense-source-submit" className={PRIMARY} disabled={!hydrated || pending}>
        {pending ? 'Saving…' : 'Add expense source'}
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

export interface KnownExpensesSectionProps {
  readonly expenses: MonthlyExpensesDto | CurrentMonthlyExpensesDto;
  readonly month: string;
  readonly monthName: string;
  readonly monthEndsOn: string;
  readonly today: string;
  readonly reportingCurrency: string;
  /** The active FX-supported catalogue (10.5) — never the currencies the user holds accounts in. */
  readonly selectableCurrencyCodes: readonly string[];
  readonly formatting: Formatting;
}

export function KnownExpensesSection({
  expenses,
  month,
  monthName,
  monthEndsOn,
  today,
  reportingCurrency,
  selectableCurrencyCodes,
  formatting,
}: KnownExpensesSectionProps) {
  const bounds = ownedEntryDateBounds({ month, monthEndsOn, today });
  const candidates = 'paidTodayCandidates' in expenses ? expenses.paidTodayCandidates : [];
  const currencies = pickerCurrencies(selectableCurrencyCodes, reportingCurrency);
  const defaultCurrency = defaultPickerCurrency(currencies, reportingCurrency);
  const shownAbove = new Set(expenses.occurrences.map((row) => row.templateId));

  return (
    <div className="space-y-6" data-testid="monthly-known-expenses">
      <Subsection
        title="Scheduled this month"
        description={`What your recurring expense sources expected in ${monthName}. A date here is the schedule's; the expense keeps its own.`}
      >
        {expenses.occurrences.length === 0 ? (
          <p className={META} data-testid="expense-occurrences-empty">
            No recurring expense source has an occurrence in {monthName}.
          </p>
        ) : (
          <Table
            testId="expense-occurrences"
            caption={`Recurring expenses scheduled in ${monthName}`}
            columns={[
              { label: 'Source' },
              { label: 'Dates' },
              { label: 'Amount', numeric: true },
              { label: 'State' },
              { label: 'Actions' },
            ]}
          >
            {expenses.occurrences.map((occurrence) => (
              <OccurrenceRow
                key={`${occurrence.templateId}-${occurrence.occurrenceDate}`}
                occurrence={occurrence}
                accounts={expenses.cashAccounts}
                eligibleCategories={expenses.eligibleCategories}
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
          title="Paid something early?"
          description="The next occurrence of each source that nothing has recorded yet. Recording one dates the expense today and leaves the occurrence on its own scheduled date."
        >
          <Table
            testId="expense-paid-today-candidates"
            caption="Expense sources whose next occurrence is after this month"
            columns={[
              { label: 'Source' },
              { label: 'Next occurrence' },
              { label: 'Amount', numeric: true },
              { label: 'Actions' },
            ]}
          >
            {candidates.map((candidate) => (
              <PaidTodayRow
                key={candidate.templateId}
                candidate={candidate}
                accounts={expenses.cashAccounts}
                formatting={formatting}
                month={month}
                today={today}
                offerEnd={!shownAbove.has(candidate.templateId)}
              />
            ))}
          </Table>
        </Subsection>
      )}

      {expenses.otherRecurring.length === 0 ? null : (
        <Subsection
          title="Recurring expenses incurred here for another month"
          description="Spending that happened in this month against an occurrence scheduled in a different one."
        >
          <Table
            testId="expense-other-recurring"
            caption={`Recurring expenses incurred in ${monthName} for another month's occurrence`}
            columns={[
              { label: 'Source' },
              { label: 'Dates' },
              { label: 'Amount', numeric: true },
              { label: 'Actions' },
            ]}
          >
            {expenses.otherRecurring.map((entry) => (
              <EntryRow
                key={entry.entryId}
                entry={entry}
                accounts={expenses.cashAccounts}
                eligibleCategories={expenses.eligibleCategories}
                formatting={formatting}
                month={month}
                bounds={bounds}
              />
            ))}
          </Table>
        </Subsection>
      )}

      <Subsection title="Other known expenses this month" description="Expenses no recurring source scheduled.">
        {expenses.direct.length === 0 ? (
          <p className={META} data-testid="expense-direct-empty">
            Nothing else recorded in {monthName}.
          </p>
        ) : (
          <Table
            testId="expense-direct"
            caption={`Expenses incurred in ${monthName} that no source scheduled`}
            columns={[
              { label: 'What' },
              { label: 'Date' },
              { label: 'Amount', numeric: true },
              { label: 'Actions' },
            ]}
          >
            {expenses.direct.map((entry) => (
              <EntryRow
                key={entry.entryId}
                entry={entry}
                accounts={expenses.cashAccounts}
                eligibleCategories={expenses.eligibleCategories}
                formatting={formatting}
                month={month}
                bounds={bounds}
              />
            ))}
          </Table>
        )}
      </Subsection>

      <div className="grid gap-6 border-t pt-4 lg:grid-cols-2">
        <Disclosure label="Add expense" testId="expense-add-toggle">
          <AddExpenseForm
            accounts={expenses.cashAccounts}
            eligibleCategories={expenses.eligibleCategories}
            currencies={currencies}
            bounds={bounds}
            defaultCurrency={defaultCurrency}
            formatting={formatting}
          />
        </Disclosure>
        <Disclosure label="Add expense source" testId="expense-source-add-toggle">
          <AddExpenseSourceForm
            accounts={expenses.cashAccounts}
            eligibleCategories={expenses.eligibleCategories}
            currencies={currencies}
            defaultCurrency={defaultCurrency}
            today={today}
            formatting={formatting}
          />
        </Disclosure>
      </div>
    </div>
  );
}
