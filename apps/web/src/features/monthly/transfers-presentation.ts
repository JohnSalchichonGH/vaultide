import type {
  MonthlyTransferDto,
  MonthlyTransfersDto,
  TransferAccountDto,
  TransferFeeStateDto,
  TransferProblemDto,
  TransferReadOnlyReasonDto,
} from '@vaultide/application';
import { isCalendarDate, moneyString } from '@vaultide/validation';
import { fieldValueOf, sameDecimal } from '@/features/monthly/autosave';
import { normalizeMoneyInput } from '@/lib/money-input';

/**
 * How Monthly's transfer maintenance holds a draft and says what it holds
 * (blueprint 7.5, 8.1, 15.3 section 4, 20.1, 20.3, v2.1.16 §30.19; ADR 0006).
 *
 * Draft state, choices and words — never a financial result. Every rule here
 * judges what was typed against a rule the server enforces again: two different
 * accounts, each open on the date, amounts in their currency's minor units, and
 * a fee paid by one of the two on a date not after today. Nothing here works out
 * a reconciliation, a spending figure, an exchange rate or a status; the server
 * recomputes the month after a save and the page is refreshed from it.
 */

export type TransferAccounts = MonthlyTransfersDto['cashAccounts'];

/** The dates a transfer this page owns may carry: the month on screen, never past today. */
export interface DateRange {
  readonly min: string;
  readonly max: string;
}

/** 8.1's participation window, on one day. ISO dates order as text. */
export const openOn = (
  account: Pick<TransferAccountDto, 'openedOn' | 'closedOn'>,
  on: string,
): boolean =>
  (account.openedOn === null || account.openedOn <= on) &&
  (account.closedOn === null || account.closedOn >= on);

const accountOf = (accounts: TransferAccounts, positionId: string): TransferAccountDto | undefined =>
  positionId === '' ? undefined : accounts.find((row) => row.positionId === positionId);

const minorUnitsIn = (minorUnitsByCurrency: Readonly<Record<string, number>>, currency: string): number =>
  minorUnitsByCurrency[currency] ?? 2;

/* -------------------------------------------------------------------------- */
/* Whether a transfer can be added                                             */
/* -------------------------------------------------------------------------- */

export type AddTransferAvailability =
  | { readonly enabled: true; readonly defaultDate: string }
  | { readonly enabled: false; readonly reason: 'fewer_than_two_accounts' | 'no_shared_day' };

/**
 * Whether this page can record a transfer, and the day a new one starts on.
 *
 * A transfer needs two accounts open on the same day inside the range. Counting
 * the month's accounts is not enough: one that closed on the 10th and one that
 * opened on the 20th both take part in the month and never share a day. Each
 * account's window is one interval (8.1), so the days two accounts share are one
 * interval too, and the latest day any pair shares is the latest end among the
 * pairs that share any. Dormant accounts count: recording a transfer clears
 * dormancy (8.8).
 */
export function addTransferAvailability(
  accounts: TransferAccounts,
  range: DateRange,
): AddTransferAvailability {
  if (accounts.length < 2) return { enabled: false, reason: 'fewer_than_two_accounts' };

  const latestOf = (a: string, b: string): string => (a > b ? a : b);
  const earliestOf = (a: string, b: string): string => (a < b ? a : b);
  const sharedEnds: string[] = [];
  accounts.forEach((first, index) => {
    for (const second of accounts.slice(index + 1)) {
      const start = latestOf(latestOf(range.min, first.openedOn ?? range.min), second.openedOn ?? range.min);
      const end = earliestOf(earliestOf(range.max, first.closedOn ?? range.max), second.closedOn ?? range.max);
      if (start <= end) sharedEnds.push(end);
    }
  });

  const latest = sharedEnds.reduce<string | null>(
    (best, end) => (best === null || end > best ? end : best),
    null,
  );
  return latest === null
    ? { enabled: false, reason: 'no_shared_day' }
    : { enabled: true, defaultDate: latest };
}

export function addTransferUnavailableText(
  reason: Extract<AddTransferAvailability, { enabled: false }>['reason'],
  period: string,
): string {
  return reason === 'fewer_than_two_accounts'
    ? `A transfer moves money between two of your cash accounts, and fewer than two take part in ${period}.`
    : `No two of your cash accounts are open on the same day in ${period}, so there is nothing to transfer between.`;
}

/* -------------------------------------------------------------------------- */
/* The draft                                                                   */
/* -------------------------------------------------------------------------- */

export interface TransferFeeDraft {
  readonly enabled: boolean;
  readonly amount: string;
  /** `''` until an account is chosen. */
  readonly payerId: string;
  readonly incurredOn: string;
  /**
   * Whether the user has set the fee's date, or who paid it. A new fee's date
   * and payer follow the transfer's date and From account until then. A stored
   * fee starts with both set: it is a source fact of its own and never follows a
   * change to the transfer (ADR 0006 §5).
   */
  readonly dateTouched: boolean;
  readonly payerTouched: boolean;
}

export interface TransferDraft {
  readonly occurredOn: string;
  /** `''` until an account is chosen. */
  readonly fromPositionId: string;
  readonly toPositionId: string;
  /** As typed. Within one currency this is the only amount, and it moves both ways. */
  readonly fromAmount: string;
  readonly toAmount: string;
  readonly description: string;
  readonly fee: TransferFeeDraft;
}

/**
 * A side's currency when it is fixed before any account is chosen: a stored
 * leg's, which a correction may not change (ADR 0006 §3), or one a caller asked
 * for when opening the dialog.
 */
export interface LegCurrencies {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

/** What a caller may prefill for one side of a new transfer. */
export interface TransferLegInitialValues {
  readonly positionId?: string | undefined;
  /** Narrows the accounts offered to this currency. It never chooses one. */
  readonly currency?: string | undefined;
  readonly amount?: string | undefined;
}

/**
 * What a caller may prefill when it opens the dialog to record a transfer.
 *
 * The generic editor's own contract, with no issue's shape in it: whatever later
 * finds a transfer missing maps what it found onto this, and the editor neither
 * knows nor cares where the values came from. A currency without an account
 * narrows the choices and still leaves the choice to the user.
 */
export interface TransferInitialValues {
  /** `null` says the date is unknown and must be chosen; absent takes the page's default. */
  readonly occurredOn?: string | null | undefined;
  readonly from?: TransferLegInitialValues | undefined;
  readonly to?: TransferLegInitialValues | undefined;
  readonly description?: string | undefined;
}

const NO_FEE: TransferFeeDraft = {
  enabled: false,
  amount: '',
  payerId: '',
  incurredOn: '',
  dateTouched: false,
  payerTouched: false,
};

export function draftFromInitialValues(
  initial: TransferInitialValues,
  defaultDate: string | null,
): { readonly draft: TransferDraft; readonly legCurrencies: LegCurrencies } {
  return {
    draft: {
      occurredOn: initial.occurredOn === null ? '' : (initial.occurredOn ?? defaultDate ?? ''),
      fromPositionId: initial.from?.positionId ?? '',
      toPositionId: initial.to?.positionId ?? '',
      fromAmount: initial.from?.amount ?? '',
      toAmount: initial.to?.amount ?? '',
      description: initial.description ?? '',
      fee: NO_FEE,
    },
    legCurrencies: { from: initial.from?.currency, to: initial.to?.currency },
  };
}

/**
 * A stored transfer as a draft to correct.
 *
 * Whatever a correction must restate starts empty rather than pre-answered: an
 * endpoint that names no account of its leg's currency, a fee payer that is
 * neither side, and a fee amount recorded in a currency its payer does not hold.
 * Saving the draft unchanged can therefore never keep one of them (ADR 0006 §3,
 * §6), and nothing is relabelled on the user's behalf.
 */
export function draftFromTransfer(
  transfer: MonthlyTransferDto,
  accounts: TransferAccounts,
  minorUnitsByCurrency: Readonly<Record<string, number>>,
): TransferDraft {
  const legAccount = (positionId: string | null, currency: string): string => {
    const account = positionId === null ? undefined : accountOf(accounts, positionId);
    return account !== undefined && account.currency === currency ? account.positionId : '';
  };
  const stored = transfer.fee.kind === 'one' ? transfer.fee.fee : null;
  const payer =
    stored === null || stored.cashPositionId === null ? undefined : accountOf(accounts, stored.cashPositionId);

  return {
    occurredOn: transfer.occurredOn,
    fromPositionId: legAccount(transfer.from.positionId, transfer.from.currency),
    toPositionId: legAccount(transfer.to.positionId, transfer.to.currency),
    fromAmount: fieldValueOf(transfer.from.amount.amount, minorUnitsIn(minorUnitsByCurrency, transfer.from.currency)),
    toAmount: fieldValueOf(transfer.to.amount.amount, minorUnitsIn(minorUnitsByCurrency, transfer.to.currency)),
    description: transfer.description ?? '',
    fee:
      stored === null
        ? NO_FEE
        : {
            enabled: true,
            amount:
              payer !== undefined && payer.currency === stored.currency
                ? fieldValueOf(stored.amount.amount, minorUnitsIn(minorUnitsByCurrency, stored.currency))
                : '',
            payerId: stored.paidBy !== null && payer !== undefined ? payer.positionId : '',
            incurredOn: stored.incurredOn,
            dateTouched: true,
            payerTouched: true,
          },
  };
}

export type TransferDraftChange =
  | { readonly field: 'occurredOn'; readonly value: string }
  | { readonly field: 'fromPositionId'; readonly value: string }
  | { readonly field: 'toPositionId'; readonly value: string }
  | { readonly field: 'fromAmount'; readonly value: string }
  | { readonly field: 'toAmount'; readonly value: string }
  | { readonly field: 'description'; readonly value: string }
  | { readonly field: 'feeEnabled'; readonly value: boolean }
  | { readonly field: 'feeAmount'; readonly value: string }
  | { readonly field: 'feePayer'; readonly value: string }
  | { readonly field: 'feeDate'; readonly value: string };

/**
 * The fee with another payer. An amount typed in one currency is not an amount
 * in another, so a payer holding a different currency empties it to be entered
 * again — never converted, never relabelled.
 */
function withPayer(fee: TransferFeeDraft, payerId: string, accounts: TransferAccounts): TransferFeeDraft {
  const before = accountOf(accounts, fee.payerId)?.currency;
  const after = accountOf(accounts, payerId)?.currency;
  const currencyChanged = before !== undefined && after !== undefined && before !== after;
  return { ...fee, payerId, amount: currencyChanged ? '' : fee.amount };
}

export function changeDraft(
  draft: TransferDraft,
  change: TransferDraftChange,
  accounts: TransferAccounts,
): TransferDraft {
  const { fee } = draft;
  switch (change.field) {
    case 'occurredOn':
      return {
        ...draft,
        occurredOn: change.value,
        fee: fee.enabled && !fee.dateTouched ? { ...fee, incurredOn: change.value } : fee,
      };
    case 'fromPositionId':
      return {
        ...draft,
        fromPositionId: change.value,
        fee: fee.enabled && !fee.payerTouched ? withPayer(fee, change.value, accounts) : fee,
      };
    case 'toPositionId':
      return { ...draft, toPositionId: change.value };
    case 'fromAmount':
      return { ...draft, fromAmount: change.value };
    case 'toAmount':
      return { ...draft, toAmount: change.value };
    case 'description':
      return { ...draft, description: change.value };
    case 'feeEnabled': {
      if (!change.value) return { ...draft, fee: { ...fee, enabled: false } };
      const dated = fee.dateTouched ? fee : { ...fee, incurredOn: draft.occurredOn };
      const paid = fee.payerTouched ? dated : withPayer(dated, draft.fromPositionId, accounts);
      return { ...draft, fee: { ...paid, enabled: true } };
    }
    case 'feeAmount':
      return { ...draft, fee: { ...fee, amount: change.value } };
    case 'feePayer':
      return { ...draft, fee: { ...withPayer(fee, change.value, accounts), payerTouched: true } };
    case 'feeDate':
      return { ...draft, fee: { ...fee, incurredOn: change.value, dateTouched: true } };
  }
}

/* -------------------------------------------------------------------------- */
/* Shape and choices                                                           */
/* -------------------------------------------------------------------------- */

export type TransferMode =
  | { readonly kind: 'pending' }
  | { readonly kind: 'same'; readonly currency: string }
  | { readonly kind: 'cross'; readonly fromCurrency: string; readonly toCurrency: string };

/**
 * One amount or two (M13, 7.5). Within one currency a transfer moves one
 * amount; between two, both native amounts are facts the user states, and the
 * dialog asks for both rather than working either out from the other.
 */
export function transferModeOf(
  draft: TransferDraft,
  accounts: TransferAccounts,
  legCurrencies: LegCurrencies,
): TransferMode {
  const from = accountOf(accounts, draft.fromPositionId)?.currency ?? legCurrencies.from;
  const to = accountOf(accounts, draft.toPositionId)?.currency ?? legCurrencies.to;
  if (from === undefined || to === undefined) return { kind: 'pending' };
  return from === to
    ? { kind: 'same', currency: from }
    : { kind: 'cross', fromCurrency: from, toCurrency: to };
}

export interface ChoiceOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

/**
 * The accounts one side may name: of the side's fixed currency when it has one,
 * and not open on the draft's date marked and not choosable (8.1). A dormant
 * account is offered like any other.
 */
export function endpointOptions(
  accounts: TransferAccounts,
  args: { readonly currency?: string | undefined; readonly occurredOn: string },
): readonly ChoiceOption[] {
  const dated = isCalendarDate(args.occurredOn);
  return [
    { value: '', label: 'Choose an account', disabled: true },
    ...accounts
      .filter((row) => args.currency === undefined || row.currency === args.currency)
      .map((row) => {
        const closed = dated && !openOn(row, args.occurredOn);
        const notes = [row.currency, row.dormant ? 'dormant' : null, closed ? 'not open on this date' : null]
          .filter((note): note is string => note !== null)
          .join(' · ');
        return { value: row.positionId, label: `${row.name} (${notes})`, disabled: closed };
      }),
  ];
}

/** Who may have paid the fee: one of the transfer's two accounts (ADR 0006 §6). */
export function payerOptions(draft: TransferDraft, accounts: TransferAccounts): readonly ChoiceOption[] {
  const endpoints = [draft.fromPositionId, draft.toPositionId].filter((id) => id !== '');
  const options: ChoiceOption[] = [{ value: '', label: 'Choose who paid it', disabled: true }];
  for (const id of new Set(endpoints)) {
    const account = accountOf(accounts, id);
    options.push({ value: id, label: account === undefined ? 'Unknown account' : `${account.name} (${account.currency})` });
  }
  const current = draft.fee.payerId;
  if (current !== '' && !endpoints.includes(current)) {
    // Shown so the stored choice reads truthfully, and not choosable again.
    const account = accountOf(accounts, current);
    options.push({
      value: current,
      label: `${account?.name ?? 'Another account'} (not part of this transfer)`,
      disabled: true,
    });
  }
  return options;
}

/* -------------------------------------------------------------------------- */
/* What a draft still needs                                                    */
/* -------------------------------------------------------------------------- */

export type DraftField =
  | 'occurredOn'
  | 'fromPositionId'
  | 'toPositionId'
  | 'fromAmount'
  | 'toAmount'
  | 'description'
  | 'fee.amount'
  | 'fee.cashPositionId'
  | 'fee.incurredOn';

export type DraftProblems = Partial<Record<DraftField, string>>;

export interface DraftContext {
  readonly accounts: TransferAccounts;
  readonly range: DateRange;
  readonly today: string;
  readonly minorUnitsByCurrency: Readonly<Record<string, number>>;
  readonly legCurrencies: LegCurrencies;
  /** How a date is written in a message, in the reader's locale. */
  readonly dayName: (date: string) => string;
}

/** The same scale rule the server's schema applies, for immediate feedback (7.2, 20.1). */
function amountProblem(value: string, minorUnits: number): string | null {
  const normalized = normalizeMoneyInput(value);
  if (normalized === '') return 'Enter an amount.';
  const parsed = moneyString({ positive: true, minorUnits }).safeParse(normalized);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Enter an amount.');
}

/**
 * What stops this draft being saved, by field.
 *
 * Only what the draft itself shows: every rule is also the server's, which
 * judges the save again, and which alone knows what the database holds.
 */
export function draftProblems(draft: TransferDraft, context: DraftContext): DraftProblems {
  const { accounts, range, today, legCurrencies, dayName } = context;
  const problems: Record<string, string> = {};

  if (draft.occurredOn === '') problems.occurredOn = 'Choose the day the money moved.';
  else if (!isCalendarDate(draft.occurredOn)) problems.occurredOn = 'Enter a real calendar date.';
  else if (draft.occurredOn < range.min || draft.occurredOn > range.max) {
    problems.occurredOn = `Choose a day from ${dayName(range.min)} to ${dayName(range.max)}.`;
  }
  const dated = problems.occurredOn === undefined;

  for (const side of ['from', 'to'] as const) {
    const field = side === 'from' ? 'fromPositionId' : 'toPositionId';
    const account = accountOf(accounts, draft[field]);
    const currency = legCurrencies[side];
    if (account === undefined || (currency !== undefined && account.currency !== currency)) {
      problems[field] = currency === undefined ? 'Choose an account.' : `Choose a ${currency} account.`;
    } else if (dated && !openOn(account, draft.occurredOn)) {
      problems[field] = `${account.name} is not open on ${dayName(draft.occurredOn)}.`;
    }
  }
  if (
    problems.toPositionId === undefined &&
    draft.toPositionId !== '' &&
    draft.toPositionId === draft.fromPositionId
  ) {
    problems.toPositionId = 'Choose a different account from the one the money left.';
  }

  const mode = transferModeOf(draft, accounts, legCurrencies);
  const minor = (currency: string): number => minorUnitsIn(context.minorUnitsByCurrency, currency);
  if (mode.kind !== 'pending') {
    const sent = amountProblem(draft.fromAmount, minor(mode.kind === 'same' ? mode.currency : mode.fromCurrency));
    if (sent !== null) problems.fromAmount = sent;
    if (mode.kind === 'cross') {
      const received = amountProblem(draft.toAmount, minor(mode.toCurrency));
      if (received !== null) problems.toAmount = received;
    }
  }

  if (draft.description.trim().length > 500) problems.description = 'That description is too long.';

  if (draft.fee.enabled) {
    const { fee } = draft;
    const isEndpoint = fee.payerId !== '' && [draft.fromPositionId, draft.toPositionId].includes(fee.payerId);
    const payer = isEndpoint ? accountOf(accounts, fee.payerId) : undefined;
    if (payer === undefined) {
      problems['fee.cashPositionId'] =
        fee.payerId === ''
          ? 'Choose the account that paid the fee.'
          : 'The fee has to come out of one of the two accounts this transfer touches.';
    }

    if (fee.incurredOn === '') problems['fee.incurredOn'] = 'Choose the day the fee was charged.';
    else if (!isCalendarDate(fee.incurredOn)) problems['fee.incurredOn'] = 'Enter a real calendar date.';
    else if (fee.incurredOn > today) {
      problems['fee.incurredOn'] = 'This date is in the future. Records can only be dated up to today.';
    } else if (payer !== undefined && !openOn(payer, fee.incurredOn)) {
      problems['fee.incurredOn'] = `${payer.name} is not open on ${dayName(fee.incurredOn)}.`;
    }

    const amount = payer === undefined ? null : amountProblem(fee.amount, minor(payer.currency));
    if (amount !== null) problems['fee.amount'] = amount;
    else if (payer === undefined && normalizeMoneyInput(fee.amount) === '') {
      problems['fee.amount'] = 'Enter the fee amount.';
    }
  }

  return problems;
}

/**
 * Whether a correction would save exactly what is stored.
 *
 * Compared as exact decimals and ids — never as numbers — so retyping an amount
 * with another spelling is not a change, and nothing is offered for saving that
 * would only consume the transfer's version.
 */
export function draftUnchanged(
  draft: TransferDraft,
  transfer: MonthlyTransferDto,
  accounts: TransferAccounts,
  legCurrencies: LegCurrencies,
): boolean {
  const sameAmount = (typed: string, stored: string): boolean => sameDecimal(normalizeMoneyInput(typed), stored);
  const received = transferModeOf(draft, accounts, legCurrencies).kind === 'same' ? draft.fromAmount : draft.toAmount;
  const description = draft.description.trim() === '' ? null : draft.description.trim();

  const transferUnchanged =
    draft.occurredOn === transfer.occurredOn &&
    draft.fromPositionId === (transfer.from.positionId ?? '') &&
    draft.toPositionId === (transfer.to.positionId ?? '') &&
    sameAmount(draft.fromAmount, transfer.from.amount.amount) &&
    sameAmount(received, transfer.to.amount.amount) &&
    description === transfer.description;
  if (!transferUnchanged) return false;

  if (transfer.fee.kind === 'none') return !draft.fee.enabled;
  if (transfer.fee.kind === 'multiple') return true;
  const stored = transfer.fee.fee;
  return (
    draft.fee.enabled &&
    sameAmount(draft.fee.amount, stored.amount.amount) &&
    draft.fee.payerId === (stored.cashPositionId ?? '') &&
    draft.fee.incurredOn === stored.incurredOn
  );
}

/* -------------------------------------------------------------------------- */
/* What a Save sends                                                           */
/* -------------------------------------------------------------------------- */

function feePayloadOf(fee: TransferFeeDraft) {
  return {
    amount: normalizeMoneyInput(fee.amount),
    cashPositionId: fee.payerId,
    incurredOn: fee.incurredOn,
  };
}

function amountsOf(draft: TransferDraft, accounts: TransferAccounts, legCurrencies: LegCurrencies) {
  const fromAmount = normalizeMoneyInput(draft.fromAmount);
  const same = transferModeOf(draft, accounts, legCurrencies).kind === 'same';
  // Within one currency the one amount typed is both legs (M13).
  return { fromAmount, toAmount: same ? fromAmount : normalizeMoneyInput(draft.toAmount) };
}

/** The create action's input: the facts typed, and no category, currency or settlement. */
export function createTransferPayload(
  draft: TransferDraft,
  accounts: TransferAccounts,
  legCurrencies: LegCurrencies,
) {
  const description = draft.description.trim();
  return {
    occurredOn: draft.occurredOn,
    fromPositionId: draft.fromPositionId,
    toPositionId: draft.toPositionId,
    ...amountsOf(draft, accounts, legCurrencies),
    ...(description === '' ? {} : { description }),
    ...(draft.fee.enabled ? { fee: feePayloadOf(draft.fee) } : {}),
  };
}

/**
 * The correction action's input: the whole aggregate, with the versions the
 * dialog was opened on — never what the server may hold by now (20.3).
 */
export function updateTransferPayload(
  draft: TransferDraft,
  transfer: MonthlyTransferDto,
  accounts: TransferAccounts,
  legCurrencies: LegCurrencies,
) {
  const description = draft.description.trim();
  return {
    transferId: transfer.transferId,
    expectedVersion: transfer.version,
    occurredOn: draft.occurredOn,
    fromPositionId: draft.fromPositionId,
    toPositionId: draft.toPositionId,
    ...amountsOf(draft, accounts, legCurrencies),
    description: description === '' ? null : description,
    fee: draft.fee.enabled ? feePayloadOf(draft.fee) : null,
    expectedFee:
      transfer.fee.kind === 'one'
        ? { state: 'version' as const, version: transfer.fee.fee.version }
        : { state: 'absent' as const },
  };
}

/* -------------------------------------------------------------------------- */
/* After a Save                                                                */
/* -------------------------------------------------------------------------- */

/** A server action's result, as far as the dialog needs it. */
export type TransferOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly fieldErrors?: Readonly<Record<string, readonly string[]>>;
      };
    };

export type DialogProblem =
  /** Changed elsewhere: the draft stays, and only Reload replaces it (20.3). */
  | { readonly kind: 'conflict'; readonly message: string }
  /** Gone, or something it names is: Reload shows what exists now. */
  | { readonly kind: 'gone'; readonly message: string }
  | { readonly kind: 'refused'; readonly message: string; readonly fields: DraftProblems };

const DRAFT_FIELDS: readonly DraftField[] = [
  'occurredOn',
  'fromPositionId',
  'toPositionId',
  'fromAmount',
  'toAmount',
  'description',
  'fee.amount',
  'fee.cashPositionId',
  'fee.incurredOn',
];

/**
 * What a finished Save leaves the dialog saying. `null` is success.
 *
 * Nothing here touches the draft: a refused or conflicting save keeps every
 * value the user entered, and nothing is retried.
 */
export function problemAfterSave(outcome: TransferOutcome): DialogProblem | null {
  if (outcome.ok) return null;
  const { code, message, fieldErrors } = outcome.error;
  if (code === 'CONFLICT_VERSION' || code === 'CONFLICT_DUPLICATE') {
    return { kind: 'conflict', message: `${message} Nothing was saved.` };
  }
  if (code === 'NOT_FOUND') return { kind: 'gone', message };

  const fields: Record<string, string> = {};
  for (const field of DRAFT_FIELDS) {
    const first = fieldErrors?.[field]?.[0];
    if (first !== undefined) fields[field] = first;
  }
  return { kind: 'refused', message, fields };
}

/* -------------------------------------------------------------------------- */
/* Words                                                                       */
/* -------------------------------------------------------------------------- */

export function readOnlyText(reason: TransferReadOnlyReasonDto, fee: TransferFeeStateDto): string {
  switch (reason) {
    case 'multiple_fees':
      return `This transfer has ${String(fee.kind === 'multiple' ? fee.fees.length : 2)} linked fees, and a transfer can have only one, so it cannot be edited. Deleting it removes every one of them.`;
    case 'fee_not_transfer_fee':
      return 'The record linked to this transfer as its fee is not filed as a transfer fee, so the transfer cannot be edited. Deleting it removes that record too.';
    case 'fee_not_tracked_cash':
      return 'The record linked to this transfer as its fee was not paid from a tracked account, so the transfer cannot be edited. Deleting it removes that record too.';
  }
}

/** What a correction has to repair, in words (ADR 0006 §3, §6). */
export function storedProblemText(
  problem: TransferProblemDto,
  transfer: MonthlyTransferDto,
  dayName: (date: string) => string,
): string {
  switch (problem.kind) {
    case 'endpoint_not_open': {
      const leg = transfer[problem.side];
      return `${leg.accountName ?? 'Its account'} is not open on ${dayName(transfer.occurredOn)}. Choose another day or account.`;
    }
    case 'endpoint_unavailable':
      return `The ${problem.side === 'from' ? 'sending' : 'receiving'} side names no ${transfer[problem.side].currency} cash account. Choose one.`;
    case 'fee_payer_not_endpoint':
      return 'The fee was charged to an account this transfer does not touch. Choose which of its two accounts paid it.';
    case 'fee_payer_not_open':
      return 'The account that paid the fee is not open on the fee’s date. Correct the date, or who paid it.';
    case 'fee_currency':
      return 'The fee is recorded in a currency its account does not hold. Enter its amount again.';
  }
}

/** Whether the fee was charged on another day than the transfer, which the list then shows. */
export const feeDateDiffers = (transfer: MonthlyTransferDto): boolean =>
  transfer.fee.kind === 'one' && transfer.fee.fee.incurredOn !== transfer.occurredOn;

/** Which stored copy of a transfer this is: its own version and its fees'. */
export function editorKeyOf(transfer: MonthlyTransferDto): string {
  const fee =
    transfer.fee.kind === 'none'
      ? 'none'
      : transfer.fee.kind === 'one'
        ? `${transfer.fee.fee.feeId}@${String(transfer.fee.fee.version)}`
        : transfer.fee.fees.map((row) => `${row.feeId}@${String(row.version)}`).join(',');
  return `${transfer.transferId}@${String(transfer.version)}:${fee}`;
}

/**
 * Whether an open editor takes in a newer stored copy of its transfer.
 *
 * Only while nothing has been typed, no save has been refused and none is
 * running. Otherwise the draft stays, and so do the versions a Save will claim,
 * until the user chooses Reload: a newer copy arriving is never a reason to
 * discard what was typed, and never a licence to save it over what changed
 * elsewhere (20.3).
 */
export function adoptsNewerTransfer(args: {
  readonly base: MonthlyTransferDto;
  readonly latest: MonthlyTransferDto;
  readonly edited: boolean;
  readonly refused: boolean;
  readonly saving: boolean;
}): boolean {
  return (
    editorKeyOf(args.latest) !== editorKeyOf(args.base) && !args.edited && !args.refused && !args.saving
  );
}
