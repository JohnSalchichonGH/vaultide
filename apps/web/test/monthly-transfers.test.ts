import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  MonthlyTransferDto,
  MonthlyTransfersDto,
  TransferAccountDto,
  TransferFeeDto,
} from '@vaultide/application';

// The section calls server actions and the app router; neither exists outside
// Next, and neither is what these tests are about.
vi.mock('@/server/actions/flows', () => ({
  createTransferAction: vi.fn(),
  deleteTransferAction: vi.fn(),
  updateTransferAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const { MonthlyTransfersSection, TransferEditor } = await import('@/features/monthly/transfers-editor');
const {
  addTransferAvailability,
  adoptsNewerTransfer,
  changeDraft,
  createTransferPayload,
  draftFromInitialValues,
  draftFromTransfer,
  draftProblems,
  draftUnchanged,
  editorKeyOf,
  endpointOptions,
  payerOptions,
  problemAfterSave,
  transferModeOf,
  updateTransferPayload,
} = await import('@/features/monthly/transfers-presentation');
const { TRANSFER_FEE_NOTE } = await import('@/features/monthly/expenses-presentation');

type TransferDraft = ReturnType<typeof draftFromTransfer>;

/**
 * Monthly's transfer maintenance (blueprint 7.5, 8.1, 15.3 section 4, 16.6,
 * 20.3, v2.1.16 §30.19; ADR 0006).
 *
 * Every transfer arrives from the server. These tests pin how the list reads,
 * what the dialog asks for and refuses, what a Save sends, and — as often the
 * point — what the section must never do: offer a category, work out an amount
 * from a rate, follow a stored fee around, or recompute a figure.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const formatting = { locale: 'en-GB', minorUnitsByCurrency: { EUR: 2, USD: 2, JPY: 0 } };
const SEPTEMBER = { min: '2026-09-01', max: '2026-09-30' };
const TODAY = '2026-10-06';
const dayName = (date: string): string => date;

function account(over: Partial<TransferAccountDto> & Pick<TransferAccountDto, 'positionId' | 'name'>): TransferAccountDto {
  return { currency: 'EUR', openedOn: null, closedOn: null, dormant: false, ...over };
}

const BBVA = account({ positionId: 'pos-bbva', name: 'BBVA' });
const SAVINGS = account({ positionId: 'pos-savings', name: 'Savings' });
const CAIXA = account({ positionId: 'pos-caixa', name: 'Caixa' });
const DOLLARS = account({ positionId: 'pos-usd', name: 'Dollars', currency: 'USD' });
const WISE = account({ positionId: 'pos-wise', name: 'Wise', currency: 'USD' });
const YEN = account({ positionId: 'pos-jpy', name: 'Yen', currency: 'JPY' });
const ACCOUNTS = [BBVA, SAVINGS, CAIXA, DOLLARS, WISE, YEN];

function fee(over: Partial<TransferFeeDto> = {}): TransferFeeDto {
  return {
    feeId: 'fee-1',
    version: 4,
    amount: { amount: '1.5', currency: 'EUR' },
    currency: 'EUR',
    incurredOn: '2026-09-12',
    incurredMonth: '2026-09',
    cashPositionId: 'pos-bbva',
    cashAccountName: 'BBVA',
    paidBy: 'from',
    ...over,
  };
}

function transfer(over: Partial<MonthlyTransferDto> = {}): MonthlyTransferDto {
  return {
    transferId: 'tr-1',
    version: 3,
    occurredOn: '2026-09-12',
    from: { positionId: 'pos-bbva', accountName: 'BBVA', currency: 'EUR', amount: { amount: '200', currency: 'EUR' } },
    to: { positionId: 'pos-savings', accountName: 'Savings', currency: 'EUR', amount: { amount: '200', currency: 'EUR' } },
    description: null,
    achievedRate: null,
    fee: { kind: 'none' },
    readOnly: null,
    problems: [],
    ...over,
  };
}

const CROSS = transfer({
  to: { positionId: 'pos-usd', accountName: 'Dollars', currency: 'USD', amount: { amount: '216.45', currency: 'USD' } },
  achievedRate: { rate: '1.08225', from: 'EUR', to: 'USD' },
});

const WITH_FEE = transfer({ fee: { kind: 'one', fee: fee() } });

function section(dto: Partial<MonthlyTransfersDto> = {}, today = TODAY): string {
  return renderToStaticMarkup(
    createElement(MonthlyTransfersSection, {
      transfers: { transfers: [], cashAccounts: ACCOUNTS, ...dto },
      month: '2026-09',
      monthName: 'September 2026',
      monthEndsOn: '2026-09-30',
      today,
      formatting,
    }),
  );
}

function editor(props: Partial<Parameters<typeof TransferEditor>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(TransferEditor, {
      accounts: ACCOUNTS,
      range: SEPTEMBER,
      today: TODAY,
      formatting,
      transfer: null,
      defaultDate: '2026-09-30',
      onDone: () => undefined,
      onCancel: () => undefined,
      ...props,
    }),
  );
}

const has = (html: string, testId: string): boolean => html.includes(`data-testid="${testId}"`);
const count = (html: string, testId: string): number => html.split(`data-testid="${testId}"`).length - 1;

function selectMarkup(html: string, testId: string): string {
  return new RegExp(`<select[^>]*data-testid="${testId}".*?</select>`, 'su').exec(html)?.[0] ?? '';
}

const context = (over: Partial<Parameters<typeof draftProblems>[1]> = {}) => ({
  accounts: ACCOUNTS,
  range: SEPTEMBER,
  today: TODAY,
  minorUnitsByCurrency: formatting.minorUnitsByCurrency,
  legCurrencies: {},
  dayName,
  ...over,
});

function newDraft(over: Partial<TransferDraft> = {}): TransferDraft {
  return {
    ...draftFromInitialValues({ from: { positionId: 'pos-bbva' }, to: { positionId: 'pos-savings' } }, '2026-09-12').draft,
    ...over,
  };
}

/* -------------------------------------------------------------------------- */
/* Placement                                                                   */
/* -------------------------------------------------------------------------- */

describe('where transfers are maintained', () => {
  it('sits inside Accounts, below the balances, and adds no section of its own', () => {
    const source = readFileSync(path.join(here, '..', 'src', 'app', '(app)', 'monthly', '[month]', 'page.tsx'), 'utf8');
    const accounts = source.slice(source.indexOf('<section id="accounts"'), source.indexOf('<section id="reconciliation"'));

    expect(accounts).toContain('<MonthlyTransfersSection');
    expect(accounts.indexOf('<MonthlyTransfersSection')).toBeGreaterThan(accounts.indexOf('<CurrentAccountsEditor'));
    expect(accounts.indexOf('<MonthlyTransfersSection')).toBeGreaterThan(accounts.indexOf('</Card>'));

    const nav = source.slice(source.indexOf('aria-label="Month sections"'), source.indexOf('</nav>'));
    expect([...nav.matchAll(/href="#([^"]+)"/gu)].map((match) => match[1])).toEqual([
      'overview',
      'income',
      'known-expenses',
      'accounts',
      'reconciliation',
    ]);
  });

  it('computes no financial figure in the browser', () => {
    // The section formats what the server sent (v2.1.16 §30.19). It reaches no
    // engine: nothing from `@vaultide/finance` beyond what formatting already uses,
    // and no reconciliation presentation.
    for (const file of ['transfers-editor.tsx', 'transfers-presentation.ts']) {
      const source = readFileSync(path.join(here, '..', 'src', 'features', 'monthly', file), 'utf8');
      expect(source, file).not.toMatch(/from '@vaultide\/finance/u);
      expect(source, file).not.toContain("from '@/features/monthly/reconciliation'");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The list                                                                    */
/* -------------------------------------------------------------------------- */

describe('the month’s transfers', () => {
  it('says plainly when a month has none', () => {
    const html = section();
    expect(has(html, 'transfers-empty')).toBe(true);
    expect(html).toContain('No transfers between your tracked accounts in September 2026.');
  });

  it('renders a cross-currency transfer once, with both native amounts and the rate it achieved', () => {
    const html = section({ transfers: [CROSS] });
    expect(count(html, 'transfer')).toBe(1);
    const amounts = /data-testid="transfer-amounts"[^>]*>(.*?)<\/p>/su.exec(html)?.[1] ?? '';
    expect(amounts).toContain('200.00');
    expect(amounts).toContain('216.45');
    expect(html).toContain('Rate achieved: 1 EUR = 1.08225 USD');
    expect(html).toContain('BBVA → Dollars');
  });

  it('shows one amount within a currency, and no rate', () => {
    const html = section({ transfers: [transfer()] });
    expect(has(html, 'transfer-rate')).toBe(false);
    expect(html).not.toContain('sent');
  });

  it('shows a fee, and its own date only when it differs from the transfer’s', () => {
    const sameDay = section({ transfers: [WITH_FEE] });
    expect(has(sameDay, 'transfer-fee')).toBe(true);
    expect(has(sameDay, 'transfer-fee-date')).toBe(false);

    const nextMonth = section({
      transfers: [transfer({ fee: { kind: 'one', fee: fee({ incurredOn: '2026-10-01', incurredMonth: '2026-10' }) } })],
    });
    expect(nextMonth).toContain('charged on 1 Oct 2026');
  });

  it('offers View rather than Edit for a transfer that cannot be corrected, and says why', () => {
    const html = section({
      transfers: [
        transfer({
          fee: { kind: 'multiple', fees: [fee(), fee({ feeId: 'fee-2' })] },
          readOnly: 'multiple_fees',
        }),
      ],
    });
    expect(has(html, 'transfer-view')).toBe(true);
    expect(has(html, 'transfer-edit')).toBe(false);
    expect(html).toContain('2 linked fees');
    expect(html).toContain('cannot be edited');
  });

  it('names what a stored transfer needs corrected, and still offers Edit', () => {
    const html = section({
      transfers: [transfer({ fee: { kind: 'one', fee: fee({ paidBy: null, cashPositionId: 'pos-caixa' }) }, problems: [{ kind: 'fee_payer_not_endpoint' }] })],
    });
    expect(has(html, 'transfer-needs-correction')).toBe(true);
    expect(has(html, 'transfer-edit')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Add transfer                                                                */
/* -------------------------------------------------------------------------- */

describe('whether a transfer can be added', () => {
  it('is refused, with the reason, when no two accounts are open on the same day', () => {
    const accounts = [
      account({ positionId: 'a', name: 'Closed on the 10th', closedOn: '2026-09-10' }),
      account({ positionId: 'b', name: 'Opened on the 20th', openedOn: '2026-09-20' }),
    ];
    expect(addTransferAvailability(accounts, SEPTEMBER)).toEqual({ enabled: false, reason: 'no_shared_day' });

    const html = section({ cashAccounts: accounts });
    expect(html).toMatch(/<button[^>]*data-testid="transfer-add"[^>]*disabled=""/u);
    expect(html).toContain('No two of your cash accounts are open on the same day in September 2026');
  });

  it('needs two accounts at all', () => {
    expect(addTransferAvailability([BBVA], SEPTEMBER)).toEqual({
      enabled: false,
      reason: 'fewer_than_two_accounts',
    });
  });

  it('starts on the latest day two accounts share, inside the month and never past today', () => {
    const accounts = [
      account({ positionId: 'a', name: 'Everyday' }),
      account({ positionId: 'b', name: 'Closed on the 20th', closedOn: '2026-09-20' }),
      account({ positionId: 'c', name: 'Short-lived', openedOn: '2026-09-25', closedOn: '2026-09-27' }),
    ];
    expect(addTransferAvailability(accounts, SEPTEMBER)).toEqual({ enabled: true, defaultDate: '2026-09-27' });
    // The current month on the 26th: its range ends today.
    expect(addTransferAvailability(accounts, { min: '2026-09-01', max: '2026-09-26' })).toEqual({
      enabled: true,
      defaultDate: '2026-09-26',
    });
  });

  it('counts a dormant account like any other', () => {
    const accounts = [BBVA, { ...SAVINGS, dormant: true }];
    expect(addTransferAvailability(accounts, SEPTEMBER)).toEqual({ enabled: true, defaultDate: '2026-09-30' });
    expect(endpointOptions(accounts, { occurredOn: '2026-09-12' })).toContainEqual({
      value: 'pos-savings',
      label: 'Savings (EUR · dormant)',
      disabled: false,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The dialog                                                                  */
/* -------------------------------------------------------------------------- */

describe('what the dialog asks for', () => {
  it('asks for one amount within a currency', () => {
    const html = editor({ initial: { from: { positionId: 'pos-bbva' }, to: { positionId: 'pos-savings' } } });
    expect(has(html, 'transfer-amount')).toBe(true);
    expect(has(html, 'transfer-amount-sent')).toBe(false);
    expect(html).toContain('Amount (EUR)');
  });

  it('asks for both native amounts between two currencies, and works neither out', () => {
    const html = editor({ initial: { from: { positionId: 'pos-bbva' }, to: { positionId: 'pos-usd' } } });
    expect(has(html, 'transfer-amount-sent')).toBe(true);
    expect(has(html, 'transfer-amount-received')).toBe(true);
    expect(html).toContain('Amount sent (EUR)');
    expect(html).toContain('Amount received (USD)');
    expect(html).not.toMatch(/rate/iu);

    const draft = newDraft({ toPositionId: 'pos-usd', fromAmount: '200.00' });
    expect(transferModeOf(draft, ACCOUNTS, {})).toEqual({ kind: 'cross', fromCurrency: 'EUR', toCurrency: 'USD' });
    // Nothing typed on one side appears on the other.
    expect(draft.toAmount).toBe('');
  });

  it('offers each side of a stored transfer only accounts of that side’s currency', () => {
    const html = editor({ transfer: CROSS });
    const to = selectMarkup(html, 'transfer-to');
    expect(to).toContain('Dollars');
    expect(to).toContain('Wise');
    expect(to).not.toContain('BBVA');
    const from = selectMarkup(html, 'transfer-from');
    expect(from).toContain('Caixa');
    expect(from).not.toContain('Wise');
  });

  it('marks an account not open on the date, and does not let it be chosen', () => {
    const closed = account({ positionId: 'pos-old', name: 'Old card', closedOn: '2026-09-05' });
    expect(endpointOptions([BBVA, closed], { occurredOn: '2026-09-12' })).toContainEqual({
      value: 'pos-old',
      label: 'Old card (EUR · not open on this date)',
      disabled: true,
    });
  });

  it('asks for the fee’s amount, payer and date — and for no category, currency or description', () => {
    const html = editor({ transfer: WITH_FEE });
    for (const control of ['transfer-fee-toggle', 'transfer-fee-amount', 'transfer-fee-payer', 'transfer-fee-date']) {
      expect(has(html, control), control).toBe(true);
    }
    expect(html).not.toMatch(/categor/iu);
    expect(html).not.toContain('Fee description');
    expect(html).not.toContain('Fee currency');
    expect(html).not.toMatch(/\btags?\b/iu);
  });

  it('shows a read-only transfer without Save, and keeps Delete', () => {
    const html = editor({
      transfer: transfer({ fee: { kind: 'one', fee: fee() }, readOnly: 'fee_not_tracked_cash' }),
    });
    expect(has(html, 'transfer-save')).toBe(false);
    expect(has(html, 'transfer-delete')).toBe(true);
    expect(has(html, 'transfer-read-only-reason')).toBe(true);
    expect(html).toMatch(/<select[^>]*data-testid="transfer-from"[^>]*disabled=""/u);
  });
});

describe('a fee’s draft', () => {
  it('takes the transfer’s date and From account while the user has not set them', () => {
    let draft = changeDraft(newDraft(), { field: 'feeEnabled', value: true }, ACCOUNTS);
    expect(draft.fee).toMatchObject({ enabled: true, incurredOn: '2026-09-12', payerId: 'pos-bbva' });

    draft = changeDraft(draft, { field: 'occurredOn', value: '2026-09-14' }, ACCOUNTS);
    draft = changeDraft(draft, { field: 'fromPositionId', value: 'pos-caixa' }, ACCOUNTS);
    expect(draft.fee).toMatchObject({ incurredOn: '2026-09-14', payerId: 'pos-caixa' });
  });

  it('stops following once the user sets the fee’s date or who paid it', () => {
    let draft = changeDraft(newDraft(), { field: 'feeEnabled', value: true }, ACCOUNTS);
    draft = changeDraft(draft, { field: 'feeDate', value: '2026-09-10' }, ACCOUNTS);
    draft = changeDraft(draft, { field: 'feePayer', value: 'pos-savings' }, ACCOUNTS);

    draft = changeDraft(draft, { field: 'occurredOn', value: '2026-09-20' }, ACCOUNTS);
    draft = changeDraft(draft, { field: 'fromPositionId', value: 'pos-caixa' }, ACCOUNTS);
    expect(draft.fee).toMatchObject({ incurredOn: '2026-09-10', payerId: 'pos-savings' });
  });

  it('never moves a stored fee when the transfer changes', () => {
    let draft = draftFromTransfer(WITH_FEE, ACCOUNTS, formatting.minorUnitsByCurrency);
    draft = changeDraft(draft, { field: 'occurredOn', value: '2026-09-20' }, ACCOUNTS);
    draft = changeDraft(draft, { field: 'fromPositionId', value: 'pos-caixa' }, ACCOUNTS);
    expect(draft.fee).toMatchObject({ incurredOn: '2026-09-12', payerId: 'pos-bbva', amount: '1.50' });
    // …and what it would now have to repair is said, not silently fixed.
    expect(draftProblems(draft, context({ legCurrencies: { from: 'EUR', to: 'EUR' } }))['fee.cashPositionId']).toBe(
      'The fee has to come out of one of the two accounts this transfer touches.',
    );
  });

  it('empties the fee’s amount when its payer holds another currency, and keeps it otherwise', () => {
    let cross = changeDraft(newDraft({ toPositionId: 'pos-usd' }), { field: 'feeEnabled', value: true }, ACCOUNTS);
    cross = changeDraft(cross, { field: 'feeAmount', value: '1.50' }, ACCOUNTS);
    expect(changeDraft(cross, { field: 'feePayer', value: 'pos-usd' }, ACCOUNTS).fee.amount).toBe('');

    let same = changeDraft(newDraft(), { field: 'feeEnabled', value: true }, ACCOUNTS);
    same = changeDraft(same, { field: 'feeAmount', value: '1.50' }, ACCOUNTS);
    expect(changeDraft(same, { field: 'feePayer', value: 'pos-savings' }, ACCOUNTS).fee.amount).toBe('1.50');
  });

  it('restates a stored fee its payer cannot hold, and asks who paid one charged elsewhere', () => {
    const foreign = draftFromTransfer(
      transfer({ fee: { kind: 'one', fee: fee({ currency: 'USD', amount: { amount: '1.5', currency: 'USD' } }) } }),
      ACCOUNTS,
      formatting.minorUnitsByCurrency,
    );
    expect(foreign.fee.amount).toBe('');

    const elsewhere = draftFromTransfer(
      transfer({ fee: { kind: 'one', fee: fee({ cashPositionId: 'pos-caixa', paidBy: null }) } }),
      ACCOUNTS,
      formatting.minorUnitsByCurrency,
    );
    expect(elsewhere.fee.payerId).toBe('');
    expect(payerOptions({ ...elsewhere, fee: { ...elsewhere.fee, payerId: 'pos-caixa' } }, ACCOUNTS)).toContainEqual({
      value: 'pos-caixa',
      label: 'Caixa (not part of this transfer)',
      disabled: true,
    });
  });

  it('refuses a fee dated after today, or on a day its payer is not open', () => {
    const future = changeDraft(changeDraft(newDraft(), { field: 'feeEnabled', value: true }, ACCOUNTS), { field: 'feeDate', value: '2026-10-07' }, ACCOUNTS);
    expect(draftProblems(future, context())['fee.incurredOn']).toBe(
      'This date is in the future. Records can only be dated up to today.',
    );

    // Not bound by the transfer's month: October is fine for a September transfer.
    const october = changeDraft(future, { field: 'feeDate', value: '2026-10-01' }, ACCOUNTS);
    expect(draftProblems(october, context())['fee.incurredOn']).toBeUndefined();

    const closing = account({ positionId: 'pos-closing', name: 'Closing', closedOn: '2026-09-15' });
    const accounts = [...ACCOUNTS, closing];
    let draft = changeDraft(newDraft({ fromPositionId: 'pos-closing' }), { field: 'feeEnabled', value: true }, accounts);
    draft = changeDraft(draft, { field: 'feeDate', value: '2026-09-20' }, accounts);
    expect(draftProblems(draft, context({ accounts }))['fee.incurredOn']).toBe('Closing is not open on 2026-09-20.');
  });

  it('removes a stored fee only through the Save that sends none', () => {
    const draft = changeDraft(
      draftFromTransfer(WITH_FEE, ACCOUNTS, formatting.minorUnitsByCurrency),
      { field: 'feeEnabled', value: false },
      ACCOUNTS,
    );
    expect(updateTransferPayload(draft, WITH_FEE, ACCOUNTS, { from: 'EUR', to: 'EUR' })).toMatchObject({
      fee: null,
      expectedFee: { state: 'version', feeId: 'fee-1', version: 4 },
    });
  });
});

describe('what a Save sends, and when there is one to make', () => {
  it('sends the whole aggregate with the versions the dialog was opened on', () => {
    let draft = draftFromTransfer(WITH_FEE, ACCOUNTS, formatting.minorUnitsByCurrency);
    draft = changeDraft(draft, { field: 'fromAmount', value: '250,00' }, ACCOUNTS);
    draft = changeDraft(draft, { field: 'description', value: '  Deposit  ' }, ACCOUNTS);

    expect(updateTransferPayload(draft, WITH_FEE, ACCOUNTS, { from: 'EUR', to: 'EUR' })).toEqual({
      transferId: 'tr-1',
      expectedVersion: 3,
      occurredOn: '2026-09-12',
      fromPositionId: 'pos-bbva',
      toPositionId: 'pos-savings',
      // One amount within a currency, sent to both legs (M13).
      fromAmount: '250.00',
      toAmount: '250.00',
      description: 'Deposit',
      fee: { amount: '1.50', cashPositionId: 'pos-bbva', incurredOn: '2026-09-12' },
      expectedFee: { state: 'version', feeId: 'fee-1', version: 4 },
    });
  });

  it('sends a new fee as its three facts, and never a category, currency or settlement', () => {
    let draft = changeDraft(newDraft({ fromAmount: '200.00' }), { field: 'feeEnabled', value: true }, ACCOUNTS);
    draft = changeDraft(draft, { field: 'feeAmount', value: '1.50' }, ACCOUNTS);

    const payload = createTransferPayload(draft, ACCOUNTS, {});
    expect(payload).toEqual({
      occurredOn: '2026-09-12',
      fromPositionId: 'pos-bbva',
      toPositionId: 'pos-savings',
      fromAmount: '200.00',
      toAmount: '200.00',
      fee: { amount: '1.50', cashPositionId: 'pos-bbva', incurredOn: '2026-09-12' },
    });
  });

  it('sends each native amount as typed between two currencies', () => {
    const draft = newDraft({ toPositionId: 'pos-usd', fromAmount: '200.00', toAmount: '216.45' });
    expect(createTransferPayload(draft, ACCOUNTS, {})).toMatchObject({ fromAmount: '200.00', toAmount: '216.45' });
  });

  it('has nothing to save when every fact is the stored one, however it is spelt', () => {
    const stored = draftFromTransfer(WITH_FEE, ACCOUNTS, formatting.minorUnitsByCurrency);
    const legs = { from: 'EUR', to: 'EUR' };
    expect(draftUnchanged(stored, WITH_FEE, ACCOUNTS, legs)).toBe(true);
    expect(draftUnchanged({ ...stored, fromAmount: '200.0', description: '   ' }, WITH_FEE, ACCOUNTS, legs)).toBe(true);
    expect(draftUnchanged({ ...stored, fromAmount: '200.01' }, WITH_FEE, ACCOUNTS, legs)).toBe(false);
    expect(draftUnchanged({ ...stored, fee: { ...stored.fee, incurredOn: '2026-09-13' } }, WITH_FEE, ACCOUNTS, legs)).toBe(false);
  });

  it('checks each amount against its own currency’s minor units', () => {
    const toYen = newDraft({ toPositionId: 'pos-jpy', fromAmount: '1.234', toAmount: '100.5' });
    const problems = draftProblems(toYen, context());
    expect(problems.fromAmount).toBe('Use at most 2 decimals for this currency.');
    expect(problems.toAmount).toBe('This currency has no decimals.');
  });

  it('keeps a stored side in its currency, and two different accounts', () => {
    const legs = { from: 'EUR', to: 'EUR' };
    expect(draftProblems(newDraft({ fromPositionId: 'pos-usd' }), context({ legCurrencies: legs })).fromPositionId).toBe(
      'Choose a EUR account.',
    );
    expect(draftProblems(newDraft({ toPositionId: 'pos-bbva' }), context()).toPositionId).toBe(
      'Choose a different account from the one the money left.',
    );
  });

  it('keeps the transfer’s date inside the month on screen', () => {
    expect(draftProblems(newDraft({ occurredOn: '2026-10-01' }), context()).occurredOn).toBe(
      'Choose a day from 2026-09-01 to 2026-09-30.',
    );
  });
});

describe('after a Save', () => {
  it('reports a conflict without touching the draft, and never as saved', () => {
    expect(
      problemAfterSave({ ok: false, error: { code: 'CONFLICT_VERSION', message: 'This transfer changed while you were editing it.' } }),
    ).toEqual({ kind: 'conflict', message: 'This transfer changed while you were editing it. Nothing was saved.' });
  });

  it('explains a transfer that no longer exists', () => {
    expect(problemAfterSave({ ok: false, error: { code: 'NOT_FOUND', message: 'That transfer no longer exists.' } })).toEqual({
      kind: 'gone',
      message: 'That transfer no longer exists.',
    });
  });

  it('puts the server’s field errors on the fields they name, and keeps the rest for the form', () => {
    expect(
      problemAfterSave({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Please check the highlighted fields.',
          fieldErrors: { 'fee.incurredOn': ['Too early.'], fromPositionId: ['Closed.'], fee: ['Something else.'] },
        },
      }),
    ).toEqual({
      kind: 'refused',
      message: 'Please check the highlighted fields.',
      fields: { 'fee.incurredOn': 'Too early.', fromPositionId: 'Closed.' },
    });
  });

  it('tells a newer stored transfer or fee apart from the copy a draft was built from', () => {
    expect(editorKeyOf(WITH_FEE)).toBe(editorKeyOf({ ...WITH_FEE }));
    expect(editorKeyOf({ ...WITH_FEE, version: 4 })).not.toBe(editorKeyOf(WITH_FEE));
    expect(editorKeyOf(transfer({ fee: { kind: 'one', fee: fee({ version: 5 }) } }))).not.toBe(editorKeyOf(WITH_FEE));
  });

  it('takes in a newer copy only while nothing is typed, refused or saving', () => {
    const latest = { ...WITH_FEE, version: 4 };
    const quiet = { base: WITH_FEE, latest, edited: false, refused: false, saving: false };
    expect(adoptsNewerTransfer(quiet)).toBe(true);
    // A conflict's page refresh must not wipe the draft, nor hand it the new
    // versions to save over what changed elsewhere.
    expect(adoptsNewerTransfer({ ...quiet, edited: true })).toBe(false);
    expect(adoptsNewerTransfer({ ...quiet, refused: true })).toBe(false);
    expect(adoptsNewerTransfer({ ...quiet, saving: true })).toBe(false);
    expect(adoptsNewerTransfer({ ...quiet, latest: { ...WITH_FEE } })).toBe(false);
  });

  it('refreshes from the server rather than applying its own result', () => {
    const source = readFileSync(path.join(here, '..', 'src', 'features', 'monthly', 'transfers-editor.tsx'), 'utf8');
    expect(source).toContain('router.refresh()');
  });
});

describe('initial values a later caller may pass', () => {
  it('narrows a side to a currency without choosing an account', () => {
    const { draft, legCurrencies } = draftFromInitialValues({ from: { currency: 'USD' } }, '2026-09-30');
    expect(draft.fromPositionId).toBe('');
    expect(legCurrencies).toEqual({ from: 'USD', to: undefined });
    expect(endpointOptions(ACCOUNTS, { currency: 'USD', occurredOn: draft.occurredOn }).map((option) => option.value)).toEqual([
      '',
      'pos-usd',
      'pos-wise',
    ]);
  });

  it('keeps an unknown date unknown, and uses the page’s default only when none was given', () => {
    expect(draftFromInitialValues({ occurredOn: null }, '2026-09-30').draft.occurredOn).toBe('');
    expect(draftFromInitialValues({}, '2026-09-30').draft.occurredOn).toBe('2026-09-30');
  });

  it('prefills the accounts, amounts and description it is given', () => {
    const { draft } = draftFromInitialValues(
      {
        occurredOn: '2026-09-15',
        from: { positionId: 'pos-bbva', amount: '200.00' },
        to: { positionId: 'pos-usd', amount: '216.45' },
        description: 'Moved to dollars',
      },
      null,
    );
    expect(draft).toMatchObject({
      occurredOn: '2026-09-15',
      fromPositionId: 'pos-bbva',
      toPositionId: 'pos-usd',
      fromAmount: '200.00',
      toAmount: '216.45',
      description: 'Moved to dollars',
      fee: { enabled: false },
    });
  });
});

describe('a transfer’s fee in Known expenses', () => {
  it('says where its transfer is maintained', () => {
    expect(TRANSFER_FEE_NOTE).toContain('under Accounts in the month the transfer occurred');
  });
});
