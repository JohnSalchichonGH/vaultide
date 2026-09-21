'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type {
  CorrectionDraft,
  MonthlyTransferDto,
  MonthlyTransfersDto,
  TransferLegDto,
} from '@vaultide/application';
import {
  createTransferAction,
  deleteTransferAction,
  updateTransferAction,
} from '@/server/actions/flows';
import { Card, CardContent } from '@/components/ui/card';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MoneyText } from '@/components/finance/money-text';
import { formatRate } from '@/lib/format';
import { useHydrated } from '@/lib/use-hydrated';
import { cn } from '@/lib/utils';
import { dayTitle } from '@/features/monthly/presentation';
import { ownedEntryDateBounds } from '@/features/monthly/income-presentation';
import {
  addTransferAvailability,
  addTransferUnavailableText,
  adoptsNewerTransfer,
  changeForm,
  createTransferPayload,
  draftProblems,
  draftUnchanged,
  editorFormOf,
  endpointOptions,
  feeDateDiffers,
  payerOptions,
  problemAfterSave,
  readOnlyText,
  storedProblemText,
  transferModeOf,
  deleteTransferPayload,
  updateTransferPayload,
  type ChoiceOption,
  type DateRange,
  type DialogProblem,
  type DraftField,
  type TransferAccounts,
  type TransferDraftChange,
  type TransferEditorForm,
  type TransferInitialValues,
  type TransferOutcome,
} from '@/features/monthly/transfers-presentation';
import { CorrectionHost } from '@/features/corrections/host';
import { useCorrection } from '@/features/corrections/use-correction';

/**
 * Transfers between the user's own cash accounts, maintained from Monthly →
 * Accounts (blueprint 7.5, 15.3 section 4, 16.5, 16.6, 20.3, v2.1.16 §30.19;
 * ADR 0006).
 *
 * The month's transfers are listed as the read returned them, each once, and
 * one dialog records, corrects, views or deletes one. A transfer is saved as an
 * aggregate — its date, both accounts, one amount or two, and its fee — with
 * one explicit Save, never field by field, because its fields are valid only
 * together (ADR 0006 §2).
 *
 * Nothing is calculated here. The dialog checks what was typed against rules
 * the server applies again, sends the whole aggregate with the versions it was
 * opened on, and after a successful save asks the server for the page: the
 * reconciliation, the balances and the list all come back recomputed there. A
 * refused save keeps the draft; a conflict is never retried and never
 * overwrites what changed elsewhere; Reload is the one deliberate way back.
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
  'min-h-9 rounded-[var(--radius-control)] border border-transparent bg-[var(--color-accent)] px-4 py-2 font-medium text-[var(--color-accent-foreground)] disabled:opacity-60',
);
const SECONDARY = 'min-h-9 rounded-[var(--radius-control)] border px-4 py-2 disabled:opacity-60';
const SELECT =
  'w-full rounded-[var(--radius-control)] border bg-[var(--color-surface)] px-2 py-1.5 text-[length:var(--text-table)] aria-[invalid=true]:border-[var(--color-negative)]';
const NEGATIVE = 'text-[length:var(--text-meta)] text-[var(--color-negative)]';

const UNREACHABLE =
  'The transfer could not be saved — the server did not answer. Check your connection and try again.';

/* -------------------------------------------------------------------------- */
/* The list                                                                    */
/* -------------------------------------------------------------------------- */

function legName(leg: TransferLegDto): string {
  return leg.accountName ?? `No ${leg.currency} account`;
}

function Amount({ leg, formatting }: { readonly leg: TransferLegDto; readonly formatting: Formatting }) {
  return (
    <MoneyText
      amount={leg.amount.amount}
      currency={leg.currency}
      locale={formatting.locale}
      minorUnits={minorUnitsOf(formatting, leg.currency)}
      className="whitespace-nowrap"
    />
  );
}

function FeeLine({
  transfer,
  formatting,
}: {
  readonly transfer: MonthlyTransferDto;
  readonly formatting: Formatting;
}) {
  const { fee } = transfer;
  if (fee.kind === 'none') return null;
  if (fee.kind === 'multiple') {
    return (
      <p className={META} data-testid="transfer-fee">
        {fee.fees.length} linked fees
      </p>
    );
  }
  return (
    <p className={META} data-testid="transfer-fee">
      Fee{' '}
      <MoneyText
        amount={fee.fee.amount.amount}
        currency={fee.fee.currency}
        locale={formatting.locale}
        minorUnits={minorUnitsOf(formatting, fee.fee.currency)}
        className="whitespace-nowrap"
      />{' '}
      from {fee.fee.cashAccountName ?? 'an account that is not tracked here'}
      {feeDateDiffers(transfer) ? (
        <span data-testid="transfer-fee-date">, charged on {dayTitle(fee.fee.incurredOn, formatting.locale)}</span>
      ) : null}
    </p>
  );
}

function TransferItem({
  transfer,
  formatting,
  disabled,
  onOpen,
}: {
  readonly transfer: MonthlyTransferDto;
  readonly formatting: Formatting;
  readonly disabled: boolean;
  readonly onOpen: () => void;
}) {
  const day = dayTitle(transfer.occurredOn, formatting.locale);
  const cross = transfer.from.currency !== transfer.to.currency;
  const editable = transfer.readOnly === null;
  const [firstProblem] = transfer.problems;

  return (
    <li
      className="space-y-1.5 border-b py-3 last:border-0"
      data-testid="transfer"
      data-transfer-id={transfer.transferId}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className={cn('tabular', META)} data-testid="transfer-day">
            {day}
          </p>
          <p className="break-words font-medium" data-testid="transfer-accounts">
            {legName(transfer.from)} → {legName(transfer.to)}
          </p>
        </div>
        <p className="tabular text-right" data-testid="transfer-amounts">
          {cross ? (
            <>
              <Amount leg={transfer.from} formatting={formatting} /> sent ·{' '}
              <Amount leg={transfer.to} formatting={formatting} /> received
            </>
          ) : (
            <Amount leg={transfer.from} formatting={formatting} />
          )}
        </p>
      </div>
      {transfer.achievedRate === null ? null : (
        <p className={META} data-testid="transfer-rate">
          Rate achieved: {formatRate({ ...transfer.achievedRate, locale: formatting.locale })}
        </p>
      )}
      {transfer.description === null ? null : (
        <p className={cn('break-words', META)} data-testid="transfer-description">
          {transfer.description}
        </p>
      )}
      <FeeLine transfer={transfer} formatting={formatting} />
      {transfer.readOnly === null ? null : (
        <p className={META} data-testid="transfer-read-only" data-reason={transfer.readOnly}>
          {readOnlyText(transfer.readOnly, transfer.fee)}
        </p>
      )}
      {firstProblem === undefined ? null : (
        <p className={NEGATIVE} data-testid="transfer-needs-correction">
          Needs correcting: {storedProblemText(firstProblem, transfer, (date) => dayTitle(date, formatting.locale))}
        </p>
      )}
      <button
        type="button"
        className={ACTION}
        data-testid={editable ? 'transfer-edit' : 'transfer-view'}
        aria-label={`${editable ? 'Edit' : 'View'} the transfer of ${day} from ${legName(transfer.from)} to ${legName(transfer.to)}`}
        disabled={disabled}
        onClick={onOpen}
      >
        {editable ? 'Edit' : 'View'}
      </button>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* The dialog                                                                  */
/* -------------------------------------------------------------------------- */

function FieldMessage({ id, error, hint }: { readonly id: string; readonly error?: string | undefined; readonly hint?: string | undefined }) {
  if (error === undefined && hint === undefined) return null;
  return (
    <p id={id} role={error === undefined ? undefined : 'alert'} className={error === undefined ? META : NEGATIVE}>
      {error ?? hint}
    </p>
  );
}

function SelectField({
  id,
  label,
  testId,
  value,
  options,
  error,
  hint,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly testId: string;
  readonly value: string;
  readonly options: readonly ChoiceOption[];
  readonly error?: string | undefined;
  readonly hint?: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        data-testid={testId}
        value={value}
        disabled={disabled}
        aria-invalid={error !== undefined}
        aria-describedby={`${id}-message`}
        className={SELECT}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <FieldMessage id={`${id}-message`} error={error} hint={hint} />
    </div>
  );
}

function TextField({
  id,
  label,
  testId,
  value,
  error,
  hint,
  disabled,
  money,
  type,
  min,
  max,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly testId: string;
  readonly value: string;
  readonly error?: string | undefined;
  readonly hint?: string | undefined;
  readonly disabled: boolean;
  readonly money?: boolean;
  readonly type?: 'date';
  readonly min?: string | undefined;
  readonly max?: string | undefined;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        data-testid={testId}
        value={value}
        type={type}
        min={min}
        max={max}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        inputMode={money === true ? 'decimal' : undefined}
        aria-invalid={error !== undefined}
        aria-describedby={`${id}-message`}
        className={cn(money === true && 'tabular text-right', type === 'date' && 'tabular')}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      <FieldMessage id={`${id}-message`} error={error} hint={hint} />
    </div>
  );
}

export interface TransferEditorProps {
  readonly accounts: TransferAccounts;
  readonly range: DateRange;
  readonly today: string;
  readonly formatting: Formatting;
  /** The stored transfer to correct or view; `null` records a new one. */
  readonly transfer: MonthlyTransferDto | null;
  /** A new transfer's prefilled values. Ignored when correcting. */
  readonly initial?: TransferInitialValues | undefined;
  /** The day a new transfer starts on when nothing else says. */
  readonly defaultDate: string | null;
  readonly onDone: (message: string) => void;
  readonly onCancel: () => void;
  readonly onBusyChange?: ((busy: boolean) => void) | undefined;
}

/**
 * The transfer form, without the dialog around it: the reusable part (ADR 0006
 * §1). Recording, correcting and viewing are the same form; a later caller that
 * knows what a missing transfer looked like opens it with `initial`.
 */
export function TransferEditor({
  accounts,
  range,
  today,
  formatting,
  transfer,
  initial,
  defaultDate,
  onDone,
  onCancel,
  onBusyChange,
}: TransferEditorProps) {
  const router = useRouter();
  const hydrated = useHydrated();
  const correction = useCorrection();
  // What to say once the correction this save became is confirmed. Saving and
  // deleting are different words, and the review sits between the click and
  // the outcome.
  const [correctionMessage, setCorrectionMessage] = useState('Transfer saved.');
  const [pending, startTransition] = useTransition();
  const ids = {
    date: useId(),
    from: useId(),
    to: useId(),
    sent: useId(),
    received: useId(),
    description: useId(),
    fee: useId(),
    feeAmount: useId(),
    feePayer: useId(),
    feeDate: useId(),
  };

  const formOf = (stored: MonthlyTransferDto | null): TransferEditorForm =>
    editorFormOf(stored, {
      accounts,
      minorUnitsByCurrency: formatting.minorUnitsByCurrency,
      initial: initial ?? {},
      defaultDate,
    });

  // The stored transfer this draft was built from. A Save claims its versions,
  // whatever newer copy has reached the page since (20.3): a server action's
  // response can carry a fresh page, and a draft that quietly took the newer
  // versions would overwrite whatever changed elsewhere.
  const [base, setBase] = useState<MonthlyTransferDto | null>(transfer);
  const [{ draft, legCurrencies, visited, edited }, setForm] = useState<TransferEditorForm>(() => formOf(transfer));
  const [problem, setProblem] = useState<DialogProblem | null>(null);

  const rebase = (stored: MonthlyTransferDto): void => {
    setBase(stored);
    setForm(formOf(stored));
    setProblem(null);
  };

  if (
    base !== null &&
    transfer !== null &&
    adoptsNewerTransfer({
      base,
      latest: transfer,
      edited,
      refused: problem !== null,
      saving: pending,
    })
  ) {
    rebase(transfer);
  }

  const readOnly = base !== null && base.readOnly !== null;
  const busy = pending || !hydrated;
  const dayName = (date: string): string => dayTitle(date, formatting.locale);
  const mode = transferModeOf(draft, accounts, legCurrencies);
  const problems = draftProblems(draft, {
    accounts,
    range,
    today,
    minorUnitsByCurrency: formatting.minorUnitsByCurrency,
    legCurrencies,
    dayName,
  });
  const serverFields = problem?.kind === 'refused' ? problem.fields : {};
  const shown = (field: DraftField): string | undefined =>
    serverFields[field] ?? (visited.has(field) ? problems[field] : undefined);
  const firstProblem = Object.values(problems)[0];
  const unchanged = base !== null && draftUnchanged(draft, base, accounts, legCurrencies);
  const canSave = !readOnly && !busy && firstProblem === undefined && !unchanged;

  const change = (next: TransferDraftChange): void => {
    setForm((current) => changeForm(current, next, accounts));
  };

  /**
   * One save of the aggregate, asking first whether it rewrites closed history.
   *
   * A transfer is judged on **every** date it carries — its own, and its fee's,
   * which is its own fact and may fall in another month (ADR 0006 §5, §14). So
   * an edit whose visible date is this month can still be a correction, and the
   * server is the only thing that can say so.
   */
  const run = (
    correctionDraft: CorrectionDraft,
    send: () => Promise<TransferOutcome>,
    message: string,
  ): void => {
    setProblem(null);
    setCorrectionMessage(message);
    onBusyChange?.(true);
    startTransition(async () => {
      let outcome: TransferOutcome;
      try {
        const attempted = await correction.attempt(correctionDraft, send);
        if (attempted.kind === 'review') {
          // Nothing was written, and the form keeps every value the user typed
          // so Back returns them to it (§67).
          onBusyChange?.(false);
          return;
        }
        outcome = attempted.result;
      } catch {
        outcome = { ok: false, error: { code: 'INTERNAL', message: UNREACHABLE } };
      }
      const next = problemAfterSave(outcome);
      if (next !== null) {
        onBusyChange?.(false);
        setProblem(next);
        return;
      }
      // Closed before anything else: the refresh this save already brought may
      // have taken the transfer off the list, which is not a transfer vanishing.
      onDone(message);
      router.refresh();
    });
  };

  const save = (): void => {
    if (!canSave) return;
    if (base === null) {
      const payload = createTransferPayload(draft, accounts, legCurrencies);
      run({ kind: 'transfer_create', ...payload }, () => createTransferAction(payload), 'Transfer added.');
      return;
    }
    const payload = updateTransferPayload(draft, base, accounts, legCurrencies);
    run({ kind: 'transfer_update', ...payload }, () => updateTransferAction(payload), 'Transfer saved.');
  };

  const remove = (): void => {
    if (base === null || busy) return;
    const payload = deleteTransferPayload(base);
    run({ kind: 'transfer_delete', ...payload }, () => deleteTransferAction(payload), 'Transfer deleted.');
  };

  const payer = accounts.find((row) => row.positionId === draft.fee.payerId);
  const storedFee = base?.fee.kind === 'one' ? base.fee.fee : null;
  const disabled = busy || readOnly;

  return (
    <form
      className="flex flex-col"
      data-testid="transfer-form"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      {/* `relative` keeps the visually hidden legend inside the scroller's box. */}
      <div className="relative max-h-[70vh] space-y-4 overflow-y-auto px-4 py-4 sm:px-6">
        {base === null || base.problems.length === 0 ? null : (
          <div className="space-y-1" data-testid="transfer-stored-problems">
            <p className="text-[length:var(--text-meta)] font-medium">This transfer needs correcting before it can be saved:</p>
            <ul className={cn('list-disc space-y-1 pl-5', NEGATIVE)}>
              {base.problems.map((item) => (
                <li key={`${item.kind}-${'side' in item ? item.side : ''}`}>{storedProblemText(item, base, dayName)}</li>
              ))}
            </ul>
          </div>
        )}
        {base === null || base.readOnly === null ? null : (
          <p className={META} data-testid="transfer-read-only-reason">
            {readOnlyText(base.readOnly, base.fee)}
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            id={ids.date}
            label="Date"
            testId="transfer-date"
            type="date"
            value={draft.occurredOn}
            min={range.min}
            max={range.max}
            disabled={disabled}
            error={shown('occurredOn')}
            onChange={(value) => {
              change({ field: 'occurredOn', value });
            }}
          />
          <div aria-hidden="true" className="hidden sm:block" />
          <SelectField
            id={ids.from}
            label="From"
            testId="transfer-from"
            value={draft.fromPositionId}
            options={endpointOptions(accounts, { currency: legCurrencies.from, occurredOn: draft.occurredOn })}
            disabled={disabled}
            error={shown('fromPositionId')}
            onChange={(value) => {
              change({ field: 'fromPositionId', value });
            }}
          />
          <SelectField
            id={ids.to}
            label="To"
            testId="transfer-to"
            value={draft.toPositionId}
            options={endpointOptions(accounts, { currency: legCurrencies.to, occurredOn: draft.occurredOn })}
            disabled={disabled}
            error={shown('toPositionId')}
            onChange={(value) => {
              change({ field: 'toPositionId', value });
            }}
          />

          {mode.kind === 'pending' ? (
            <p className={cn('sm:col-span-2', META)} data-testid="transfer-amount-pending">
              Choose both accounts to enter the amount.
            </p>
          ) : mode.kind === 'same' ? (
            <TextField
              id={ids.sent}
              label={`Amount (${mode.currency})`}
              testId="transfer-amount"
              money
              value={draft.fromAmount}
              disabled={disabled}
              error={shown('fromAmount')}
              onChange={(value) => {
                change({ field: 'fromAmount', value });
              }}
            />
          ) : (
            <>
              <TextField
                id={ids.sent}
                label={`Amount sent (${mode.fromCurrency})`}
                testId="transfer-amount-sent"
                money
                value={draft.fromAmount}
                disabled={disabled}
                error={shown('fromAmount')}
                onChange={(value) => {
                  change({ field: 'fromAmount', value });
                }}
              />
              <TextField
                id={ids.received}
                label={`Amount received (${mode.toCurrency})`}
                testId="transfer-amount-received"
                money
                value={draft.toAmount}
                disabled={disabled}
                error={shown('toAmount')}
                hint="Both amounts as your accounts show them. Neither is worked out from the other."
                onChange={(value) => {
                  change({ field: 'toAmount', value });
                }}
              />
            </>
          )}

          <div className="sm:col-span-2">
            <TextField
              id={ids.description}
              label="Description (optional)"
              testId="transfer-description"
              value={draft.description}
              disabled={disabled}
              error={shown('description')}
              onChange={(value) => {
                change({ field: 'description', value });
              }}
            />
          </div>
        </div>

        <fieldset className="space-y-3 border-t pt-3" disabled={disabled}>
          <legend className="sr-only">Transfer fee</legend>
          <label className="flex items-center gap-2 text-[length:var(--text-table)]" htmlFor={ids.fee}>
            <input
              id={ids.fee}
              type="checkbox"
              data-testid="transfer-fee-toggle"
              checked={draft.fee.enabled}
              onChange={(event) => {
                change({ field: 'feeEnabled', value: event.target.checked });
              }}
            />
            The bank charged a fee for this transfer
          </label>
          {!draft.fee.enabled ? (
            storedFee === null ? null : (
              <p className={META} data-testid="transfer-fee-removal">
                The fee is removed when you save.
              </p>
            )
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                id={ids.feeAmount}
                label={payer === undefined ? 'Fee amount' : `Fee amount (${payer.currency})`}
                testId="transfer-fee-amount"
                money
                value={draft.fee.amount}
                disabled={disabled}
                error={shown('fee.amount')}
                onChange={(value) => {
                  change({ field: 'feeAmount', value });
                }}
              />
              <SelectField
                id={ids.feePayer}
                label="Paid from"
                testId="transfer-fee-payer"
                value={draft.fee.payerId}
                options={payerOptions(draft, accounts)}
                disabled={disabled}
                error={shown('fee.cashPositionId')}
                onChange={(value) => {
                  change({ field: 'feePayer', value });
                }}
              />
              <TextField
                id={ids.feeDate}
                label="Fee date"
                testId="transfer-fee-date"
                type="date"
                value={draft.fee.incurredOn}
                max={today}
                disabled={disabled}
                error={shown('fee.incurredOn')}
                hint={
                  storedFee === null
                    ? 'The day the fee was charged. It can be another day than the transfer’s.'
                    : 'The fee keeps its own date: changing the transfer’s date does not move it.'
                }
                onChange={(value) => {
                  change({ field: 'feeDate', value });
                }}
              />
            </div>
          )}
        </fieldset>

        {base === null ? null : (
          <div className="space-y-2 border-t pt-3" data-testid="transfer-delete-zone">
            <p className={META}>
              Deleting removes this transfer
              {base.fee.kind === 'none' ? '' : ' and every fee linked to it, whichever month it is dated in'}.
            </p>
            <button
              type="button"
              data-testid="transfer-delete"
              className={cn(SECONDARY, 'border-[var(--color-negative)] text-[var(--color-negative)]')}
              disabled={busy}
              onClick={remove}
            >
              Delete transfer
            </button>
          </div>
        )}
      </div>

      <div className="space-y-2 border-t px-4 py-3 sm:px-6">
        {problem === null ? null : (
          <div role="alert" className="space-y-2" data-testid="transfer-problem" data-kind={problem.kind}>
            <p className={NEGATIVE}>{problem.message}</p>
            {problem.kind === 'refused' ? null : (
              <button
                type="button"
                data-testid="transfer-reload"
                className={ACTION}
                onClick={() => {
                  // The newest copy this page holds, and — until the user changes
                  // something — whatever newer one the refresh brings.
                  if (transfer === null) setProblem(null);
                  else rebase(transfer);
                  router.refresh();
                }}
              >
                Reload
              </button>
            )}
          </div>
        )}
        {readOnly || firstProblem === undefined || unchanged ? null : (
          <p className={META} data-testid="transfer-save-hint">
            To save: {firstProblem}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={SECONDARY} data-testid="transfer-cancel" disabled={pending} onClick={onCancel}>
            {readOnly ? 'Close' : 'Cancel'}
          </button>
          {readOnly ? null : (
            <button type="submit" className={PRIMARY} data-testid="transfer-save" disabled={!canSave}>
              {pending ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </div>

      <CorrectionHost
        flow={correction}
        labels={{
          accounts: Object.fromEntries(
            accounts.map((account) => [account.positionId, account.name]),
          ),
          categories: {},
          locale: formatting.locale,
        }}
        onCommitted={() => {
          onDone(correctionMessage);
          router.refresh();
        }}
      />
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* The section                                                                 */
/* -------------------------------------------------------------------------- */

type OpenDialog =
  | { readonly mode: 'create' }
  /** `opened` is the copy the dialog was opened on, kept while its own save or delete runs. */
  | { readonly mode: 'edit'; readonly opened: MonthlyTransferDto }
  | null;

export interface MonthlyTransfersSectionProps {
  readonly transfers: MonthlyTransfersDto;
  readonly month: string;
  readonly monthName: string;
  readonly monthEndsOn: string;
  readonly today: string;
  readonly formatting: Formatting;
}

export function MonthlyTransfersSection({
  transfers,
  month,
  monthName,
  monthEndsOn,
  today,
  formatting,
}: MonthlyTransfersSectionProps) {
  const hydrated = useHydrated();
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const range = ownedEntryDateBounds({ month, monthEndsOn, today });
  const current = today <= monthEndsOn;
  const availability = addTransferAvailability(transfers.cashAccounts, range);
  const latest =
    dialog?.mode === 'edit'
      ? transfers.transfers.find((row) => row.transferId === dialog.opened.transferId)
      : undefined;
  // Gone from the server's page while the dialog itself was doing nothing: its
  // own delete takes the transfer off the list before the dialog has closed.
  const gone = dialog?.mode === 'edit' && latest === undefined && !busy;
  const editing = dialog?.mode === 'edit' ? (latest ?? dialog.opened) : undefined;

  const close = (): void => {
    setDialog(null);
    setBusy(false);
  };
  const done = (message: string): void => {
    setStatus(message);
    close();
  };

  return (
    <Card data-testid="monthly-transfers">
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h3 className="text-[length:var(--text-table)] font-semibold">Transfers between your accounts</h3>
            <p className={META}>
              Money you moved from one of your cash accounts to another in {monthName}. A transfer is
              neither income nor spending; a fee the bank charged for one counts in the month it was
              charged.
            </p>
          </div>
          <button
            type="button"
            data-testid="transfer-add"
            className={ACTION}
            disabled={!hydrated || !availability.enabled}
            onClick={() => {
              setStatus(null);
              setDialog({ mode: 'create' });
            }}
          >
            Add transfer
          </button>
        </div>

        {availability.enabled ? null : (
          <p className={META} data-testid="transfer-add-unavailable">
            {addTransferUnavailableText(availability.reason, current ? `${monthName} so far` : monthName)}
          </p>
        )}

        <p role="status" aria-live="polite" data-testid="transfer-status" className={META}>
          {status}
        </p>

        {transfers.transfers.length === 0 ? (
          <p className={META} data-testid="transfers-empty">
            No transfers between your tracked accounts in {monthName}.
          </p>
        ) : (
          <ul data-testid="transfer-list" aria-label={`Transfers in ${monthName}`}>
            {transfers.transfers.map((transfer) => (
              <TransferItem
                key={transfer.transferId}
                transfer={transfer}
                formatting={formatting}
                disabled={!hydrated}
                onOpen={() => {
                  setStatus(null);
                  setDialog({ mode: 'edit', opened: transfer });
                }}
              />
            ))}
          </ul>
        )}

        {gone ? (
          <div role="alert" className="space-y-2" data-testid="transfer-gone">
            <p className={NEGATIVE}>That transfer no longer exists.</p>
            <button type="button" className={ACTION} onClick={close}>
              Close
            </button>
          </div>
        ) : null}

        {dialog === null || gone ? null : (
          <Modal
            title={
              editing === undefined
                ? 'Add transfer'
                : editing.readOnly === null
                  ? 'Edit transfer'
                  : 'Transfer'
            }
            busy={busy}
            testId="transfer-dialog"
            onClose={close}
          >
            <TransferEditor
              // One editor per transfer opened. A refresh never replaces a draft by
              // remounting it; the editor decides when a newer copy is taken in.
              key={editing === undefined ? 'create' : editing.transferId}
              accounts={transfers.cashAccounts}
              range={range}
              today={today}
              formatting={formatting}
              transfer={editing ?? null}
              defaultDate={availability.enabled ? availability.defaultDate : null}
              onDone={done}
              onCancel={close}
              onBusyChange={setBusy}
            />
          </Modal>
        )}
      </CardContent>
    </Card>
  );
}
