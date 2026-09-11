import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  AccountOpeningDto,
  CashMonthStateDto,
  CompletedAccountDto,
  CompletedClosingDto,
  CurrentAccountDto,
} from '@vaultide/application';

// The editors call server actions and the app router; neither exists outside
// Next, and neither is what the markup tests are about. The save rules are
// exercised below through the functions the editors call.
vi.mock('@/server/actions/positions', () => ({
  confirmMonthEndAction: vi.fn(),
  confirmUnchangedAction: vi.fn(),
  confirmUnchangedBatchAction: vi.fn(),
  correctValuationAction: vi.fn(),
  quickUpdateAction: vi.fn(),
  recordValuationAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement('a', { href, ...rest }, children),
}));

const { CompletedAccountsEditor, CurrentAccountsEditor, SaveStatus } = await import(
  '@/features/monthly/accounts-editor'
);
const { accountStatus, quickUpdatePositionsOf, untouchedUnchangedTargets } = await import(
  '@/features/monthly/accounts-presentation'
);
const {
  canonicalDecimal,
  decideOnBlur,
  fieldValueOf,
  outcomeState,
  runSave,
  sameDecimal,
} = await import('@/features/monthly/autosave');

/**
 * Monthly's Accounts section (blueprint 8.1, 8.6, 15.3 section 4, 16.6, 20.3).
 *
 * Every state here arrives from the server: these tests pin how each one reads,
 * which controls it offers and which it must never offer, and the autosave rules
 * — when a field saves, how the save reports, and that a conflict overwrites
 * nothing. Nothing financial is computed in the browser, so nothing here
 * restates an engine.
 */

const eur = (amount: string) => ({ amount, currency: 'EUR' });
const formatting = { locale: 'en-GB', minorUnitsByCurrency: { EUR: 2 } };

function state(over: Partial<CashMonthStateDto> = {}): CashMonthStateDto {
  return {
    month: '2026-09',
    open: 'month_end',
    close: 'month_end',
    included: true,
    firstBalance: false,
    monthEnd: null,
    confirmable: null,
    canConfirmUnchanged: true,
    ...over,
  };
}

/** The month state a server would send beside these cells — fixture coherence only. */
function stateFor(opening: AccountOpeningDto, closing: CompletedClosingDto): CashMonthStateDto {
  const open = opening.kind === 'statement' ? 'month_end' : opening.kind === 'no_statement' ? opening.state : opening.kind;
  const close =
    closing.kind === 'statement'
      ? 'month_end'
      : closing.kind === 'no_statement'
        ? closing.state
        : closing.kind === 'last_day_snapshot'
          ? 'carried'
          : closing.kind;
  const settled = ['month_end', 'opened_zero', 'closed_zero', 'dormant_zero'];
  return state({
    open,
    close,
    included: settled.includes(open) && settled.includes(close),
    firstBalance: open === 'first_balance',
  });
}

let nextId = 0;
function completedAccount(
  name: string,
  opening: AccountOpeningDto,
  closing: CompletedClosingDto,
  over: Partial<CompletedAccountDto> = {},
): CompletedAccountDto {
  nextId += 1;
  return {
    positionId: `00000000-0000-4000-8000-${String(nextId).padStart(12, '0')}`,
    name,
    currency: 'EUR',
    dormant: false,
    state: stateFor(opening, closing),
    opening,
    closing,
    ...over,
  };
}

const august: AccountOpeningDto = { kind: 'statement', amount: eur('8055'), valuedOn: '2026-08-31' };

type Hint = { readonly amount: { amount: string; currency: string }; readonly valuedOn: string } | null;

const needsStatement = (canConfirmUnchanged: boolean, latestSnapshot: Hint = null): CompletedClosingDto => ({
  kind: 'no_statement',
  state: 'carried',
  latestSnapshot,
  canConfirmUnchanged,
});

function renderCompleted(accounts: readonly CompletedAccountDto[]): string {
  return renderToStaticMarkup(
    createElement(CompletedAccountsEditor, {
      month: '2026-09',
      monthName: 'September 2026',
      monthEndsOn: '2026-09-30',
      previousMonthName: 'August 2026',
      accounts: { previousMonth: '2026-08', accounts },
      formatting,
    }),
  );
}

/** One table row's markup, found by the account's name. */
function rowOf(html: string, name: string): string {
  const rows = html.split('<tr').slice(1);
  const row = rows.find((candidate) => candidate.includes(`>${name}<`));
  if (row === undefined) throw new Error(`no row for ${name}`);
  return row;
}

/** One cell's markup within a row, by its test id. */
const cellOf = (row: string, testId: string): string =>
  new RegExp(`data-testid="${testId}"[^>]*>(.*?)</td>`, 'u').exec(row)?.[1] ?? '';

const inputValue = (row: string, testId: string): string | null =>
  new RegExp(`<input[^>]*data-testid="${testId}"[^>]*value="([^"]*)"`, 'u').exec(row)?.[1] ??
  (new RegExp(`<input[^>]*data-testid="${testId}"`, 'u').test(row) ? '' : null);

describe('a completed month', () => {
  it('makes an existing statement editable, showing its exact amount', () => {
    const html = renderCompleted([
      completedAccount('BBVA', august, {
        kind: 'statement',
        valuationId: 'v1',
        version: 3,
        amount: eur('7880'),
        confirmedUnchanged: false,
      }),
    ]);
    const row = rowOf(html, 'BBVA');
    expect(inputValue(row, 'closing-amount')).toBe('7880.00');
    expect(row).toContain('Statement balance');
    expect(row).toContain('€8,055.00');
    expect(row).toContain('Statement, 31 Aug 2026');
    // A statement is corrected, never confirmed again or replaced by "unchanged".
    expect(row).not.toContain('confirm-statement');
    expect(row).not.toContain('confirm-unchanged');
  });

  it('offers a missing statement as an empty field, never as zero', () => {
    const row = rowOf(renderCompleted([completedAccount('BBVA', august, needsStatement(false))]), 'BBVA');
    expect(inputValue(row, 'closing-amount')).toBe('');
    expect(row).not.toMatch(/0\.00/u);
    expect(row).toContain('Needs statement balance');
  });

  it('says a last-day snapshot is not yet a statement, and offers to confirm it', () => {
    const row = rowOf(
      renderCompleted([
        completedAccount('BBVA', august, {
          kind: 'last_day_snapshot',
          valuationId: 'v2',
          version: 1,
          amount: eur('7880'),
        }),
      ]),
      'BBVA',
    );
    expect(row).toContain('Confirm as statement balance');
    expect(row).toMatch(/Snapshot on 30 Sept? 2026 — not yet a statement balance/u);
    expect(inputValue(row, 'closing-amount')).toBe('7880.00');
    expect(row).not.toContain('confirm-unchanged');
  });

  it('shows an earlier snapshot inside the month only as a hint', () => {
    const row = rowOf(
      renderCompleted([
        completedAccount(
          'BBVA',
          august,
          needsStatement(true, { amount: eur('8120'), valuedOn: '2026-09-24' }),
        ),
      ]),
      'BBVA',
    );
    expect(row).toMatch(/Last snapshot .*€8,120\.00.* on 24 Sept? 2026/u);
    // The hint does not become the statement: the field stays empty.
    expect(inputValue(row, 'closing-amount')).toBe('');
    expect(row).not.toContain('Confirm as statement balance');
  });

  it('offers "Unchanged this month" only where it can be written', () => {
    const html = renderCompleted([
      completedAccount('Eligible', august, needsStatement(true)),
      completedAccount('No August', { kind: 'no_statement', state: 'carried' }, needsStatement(false)),
      completedAccount('Snapshot', august, { kind: 'last_day_snapshot', valuationId: 'v', version: 1, amount: eur('1') }),
    ]);
    expect(rowOf(html, 'Eligible')).toContain('data-testid="confirm-unchanged"');
    expect(rowOf(html, 'No August')).not.toContain('confirm-unchanged');
    expect(rowOf(html, 'Snapshot')).not.toContain('confirm-unchanged');
  });

  it('confirms all untouched accounts unchanged only where each could be, and never one that was touched', () => {
    const eligible = completedAccount('Eligible', august, needsStatement(true));
    const touched = completedAccount('Touched', august, needsStatement(true));
    const accounts = [
      eligible,
      touched,
      completedAccount('No August', { kind: 'no_statement', state: 'carried' }, needsStatement(false)),
      completedAccount('Closed', august, { kind: 'closed_zero' }),
      completedAccount('Dormant', { kind: 'dormant_zero' }, { kind: 'dormant_zero' }, { dormant: true }),
      completedAccount('Statement', august, {
        kind: 'statement',
        valuationId: 'v',
        version: 1,
        amount: eur('1'),
        confirmedUnchanged: false,
      }),
    ];

    expect(untouchedUnchangedTargets(accounts, new Set()).map((account) => account.name)).toEqual([
      'Eligible',
      'Touched',
    ]);
    expect(untouchedUnchangedTargets(accounts, new Set([touched.positionId])).map((a) => a.name)).toEqual([
      'Eligible',
    ]);

    const html = renderCompleted(accounts);
    expect(html).toContain('Confirm all untouched as unchanged');
    expect(html).toContain('for the 2 accounts you have not edited here: Eligible, Touched.');

    // Nothing eligible: no batch control at all.
    expect(renderCompleted(accounts.slice(2))).not.toContain('confirm-all-unchanged');
  });

  it('explains structural zeros instead of offering a balance to edit', () => {
    const html = renderCompleted([
      completedAccount('New savings', { kind: 'opened_zero' }, needsStatement(false)),
      completedAccount('Old bank', august, { kind: 'closed_zero' }),
      completedAccount('Dormant', { kind: 'dormant_zero' }, { kind: 'dormant_zero' }, { dormant: true }),
    ]);
    expect(rowOf(html, 'New savings')).toContain('Opened this month — previous balance 0');
    const closed = rowOf(html, 'Old bank');
    expect(closed).toContain('Closed this month — current balance 0');
    expect(closed).not.toContain('closing-amount');
    const dormant = rowOf(html, 'Dormant');
    expect(dormant.match(/Dormant \(0\)/gu)).toHaveLength(2);
    expect(dormant).not.toContain('closing-amount');
    expect(dormant).not.toContain('confirm-unchanged');
  });

  it('names a first balance as not part of the month’s spending', () => {
    const account = completedAccount(
      'Found account',
      { kind: 'first_balance' },
      { kind: 'statement', valuationId: 'v', version: 1, amount: eur('3000'), confirmedUnchanged: false },
      { state: state({ open: 'first_balance', firstBalance: true, included: false }) },
    );
    const row = rowOf(renderCompleted([account]), 'Found account');
    expect(row).toContain('First balance — not part of this month’s spending');
    expect(accountStatus(account, 'August 2026').label).toBe('First balance');
  });

  it('never shows unknown evidence as a number', () => {
    const row = rowOf(
      renderCompleted([
        completedAccount(
          'Unvalued',
          { kind: 'no_statement', state: 'missing' },
          { kind: 'no_statement', state: 'missing', latestSnapshot: null, canConfirmUnchanged: false },
          { state: state({ open: 'missing', close: 'missing', included: false }) },
        ),
      ]),
      'Unvalued',
    );
    expect(row).toContain('No balance recorded');
    expect(row).not.toMatch(/€|\b0\.00\b|value="0/u);
  });

  it('keeps every digit of a large or finely divided amount', () => {
    const row = rowOf(
      renderCompleted([
        completedAccount(
          'Large',
          { kind: 'statement', amount: eur('98765432109876.54'), valuedOn: '2026-08-31' },
          {
            kind: 'statement',
            valuationId: 'v',
            version: 1,
            amount: eur('12345678901234.5'),
            confirmedUnchanged: true,
          },
        ),
      ]),
      'Large',
    );
    expect(row).toContain('€98,765,432,109,876.54');
    expect(inputValue(row, 'closing-amount')).toBe('12345678901234.50');
    expect(row).toContain('Confirmed unchanged');
  });

  it('labels every field for assistive technology and ties it to a polite status', () => {
    const html = renderCompleted([completedAccount('BBVA', august, needsStatement(true))]);
    const label = /<label[^>]*for="([^"]+)"[^>]*>BBVA: balance at the end of 30 Sept? 2026 \(EUR\)<\/label>/u.exec(html);
    expect(label).not.toBeNull();
    const input = new RegExp(`<input[^>]*id="${label?.[1] ?? ''}"[^>]*>`, 'u').exec(html)?.[0] ?? '';
    expect(input).toContain('inputMode="decimal"');
    const describedBy = /aria-describedby="([^"]+)"/u.exec(input)?.[1] ?? '';
    const statusId = describedBy.split(' ')[0] ?? '';
    expect(html).toMatch(new RegExp(`id="${statusId}" role="status" aria-live="polite"`, 'u'));
    expect(input).toContain('aria-invalid="false"');
  });
});

/* -------------------------------------------------------------------------- */
/* The current month                                                           */
/* -------------------------------------------------------------------------- */

function currentAccount(name: string, over: Partial<CurrentAccountDto> = {}): CurrentAccountDto {
  nextId += 1;
  return {
    positionId: `00000000-0000-4000-9000-${String(nextId).padStart(12, '0')}`,
    name,
    currency: 'EUR',
    status: 'active',
    dormant: false,
    opening: august,
    latest: { state: 'carried', amount: eur('8120'), valuedOn: '2026-09-06', statement: false },
    todaySnapshot: null,
    canUpdateToday: true,
    ...over,
  };
}

function renderCurrent(accounts: readonly CurrentAccountDto[], today = '2026-09-10'): string {
  return renderToStaticMarkup(
    createElement(CurrentAccountsEditor, {
      monthName: 'September 2026',
      monthEndsOn: '2026-09-30',
      today,
      previousMonthName: 'August 2026',
      accounts: { previousMonth: '2026-08', closableFrom: '2026-10-01', accounts },
      formatting,
    }),
  );
}

describe('the current month', () => {
  it('shows the previous statement and the latest balance with its own date', () => {
    const row = rowOf(renderCurrent([currentAccount('BBVA')]), 'BBVA');
    expect(cellOf(row, 'account-opening')).toContain('€8,055.00');
    const latest = cellOf(row, 'account-latest');
    expect(latest).toContain('€8,120.00');
    expect(latest).toMatch(/Snapshot, 6 Sept? 2026/u);
    // An older balance is never presented as today's.
    expect(latest).not.toContain('today');
  });

  it('says so when the latest balance is today’s, or is the statement', () => {
    const today = rowOf(
      renderCurrent([
        currentAccount('Today', {
          latest: { state: 'exact', amount: eur('8100'), valuedOn: '2026-09-10', statement: false },
          todaySnapshot: { valuationId: 'v', version: 2, amount: eur('8100') },
        }),
      ]),
      'Today',
    );
    expect(today).toContain('Snapshot, today');
    // Today's row is what the field edits.
    expect(inputValue(today, 'today-amount')).toBe('8100.00');

    const statement = rowOf(
      renderCurrent([
        currentAccount('Statement', {
          latest: { state: 'carried', amount: eur('8055'), valuedOn: '2026-08-31', statement: true },
        }),
      ]),
      'Statement',
    );
    expect(statement).toMatch(/Statement balance, 31 Aug 2026/u);
    expect(inputValue(statement, 'today-amount')).toBe('');
  });

  it('offers "Update today" for an active account that is not dormant, and only there', () => {
    const html = renderCurrent([
      currentAccount('Active'),
      currentAccount('Dormant', { dormant: true, canUpdateToday: false, opening: { kind: 'dormant_zero' } }),
      currentAccount('Closed', {
        status: 'closed',
        canUpdateToday: false,
        latest: { state: 'closed', amount: eur('0'), valuedOn: '2026-09-04', statement: false },
      }),
    ]);
    expect(inputValue(rowOf(html, 'Active'), 'today-amount')).toBe('');
    const dormant = rowOf(html, 'Dormant');
    expect(dormant).not.toContain('today-amount');
    expect(dormant).toContain('Dormant (0) — left out of updates');
    const closed = rowOf(html, 'Closed');
    expect(closed).not.toContain('today-amount');
    expect(closed).toMatch(/Closed on 4 Sept? 2026/u);
  });

  it('leaves dormant and closed accounts out of "Update all today"', () => {
    const accounts = [
      currentAccount('Active'),
      currentAccount('Dormant', { dormant: true, canUpdateToday: false }),
      currentAccount('Closed', { status: 'closed', canUpdateToday: false }),
    ];
    expect(quickUpdatePositionsOf(accounts, { EUR: 2 }).map((position) => position.name)).toEqual(['Active']);
    expect(renderCurrent(accounts)).toContain('Update all today');
  });

  it('opens an account opened this month at zero, and a first balance as such', () => {
    const html = renderCurrent([
      currentAccount('New savings', {
        opening: { kind: 'opened_zero' },
        latest: { state: 'opened_zero', amount: eur('0'), valuedOn: '2026-09-05', statement: false },
      }),
      currentAccount('Found account', { opening: { kind: 'first_balance' } }),
    ]);
    const opened = rowOf(html, 'New savings');
    expect(opened).toContain('Opened this month — previous balance 0');
    expect(opened).toMatch(/Opened 5 Sept? 2026; nothing recorded since/u);
    expect(rowOf(html, 'Found account')).toContain('First balance — not part of this month’s spending');
  });

  it('never offers a month-end control, not even on the month’s last day', () => {
    for (const today of ['2026-09-10', '2026-09-30']) {
      const html = renderCurrent(
        [
          currentAccount('BBVA', {
            todaySnapshot: today === '2026-09-30' ? { valuationId: 'v', version: 1, amount: eur('7880') } : null,
          }),
        ],
        today,
      );
      expect(html).not.toContain('closing-amount');
      expect(html).not.toContain('Confirm as statement balance');
      expect(html).not.toContain('Unchanged this month');
      expect(html).not.toContain('Confirm all untouched');
      expect(html).toMatch(/September 2026 can be closed from 1 Oct 2026/u);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Autosave                                                                    */
/* -------------------------------------------------------------------------- */

describe('when a field saves', () => {
  it('compares amounts exactly, as decimal strings', () => {
    expect(canonicalDecimal('008055.500')).toBe('8055.5');
    expect(canonicalDecimal('-0.00')).toBe('0');
    expect(canonicalDecimal('1,5')).toBeNull();
    expect(sameDecimal('8055.00', '8055')).toBe(true);
    expect(sameDecimal('12345678901234567.89', '12345678901234567.88')).toBe(false);
  });

  it('shows an amount with every digit, padded but never rounded', () => {
    expect(fieldValueOf('8055', 2)).toBe('8055.00');
    expect(fieldValueOf('-12.5', 2)).toBe('-12.50');
    expect(fieldValueOf('8055.125', 2)).toBe('8055.125');
    expect(fieldValueOf('7', 0)).toBe('7');
  });

  it('saves only a valid amount that differs from the server’s', () => {
    expect(decideOnBlur({ draft: '8055.00', saved: '8055', minorUnits: 2 })).toEqual({ kind: 'unchanged' });
    expect(decideOnBlur({ draft: '8.055,50', saved: '8055', minorUnits: 2 })).toEqual({
      kind: 'save',
      amount: '8055.50',
    });
    expect(decideOnBlur({ draft: '100', saved: null, minorUnits: 2 })).toEqual({ kind: 'save', amount: '100' });
    expect(decideOnBlur({ draft: '10.005', saved: null, minorUnits: 2 })).toMatchObject({ kind: 'invalid' });
    expect(decideOnBlur({ draft: 'abc', saved: '1', minorUnits: 2 })).toMatchObject({ kind: 'invalid' });
    // Clearing a field deletes nothing.
    expect(decideOnBlur({ draft: '  ', saved: '8055', minorUnits: 2 })).toEqual({ kind: 'unchanged' });
  });
});

describe('how a save reports', () => {
  const run = async (send: () => Promise<unknown>) => {
    const states: string[] = [];
    const refresh = vi.fn();
    const final = await runSave(send as never, (state) => states.push(state.kind), refresh);
    return { states, refresh, final };
  };

  it('goes from saving to saved, then asks the server for the page again', async () => {
    const { states, refresh } = await run(() => Promise.resolve({ ok: true, data: {} }));
    expect(states).toEqual(['saving', 'saved']);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('reports a version conflict, and neither retries nor refreshes over what was typed', async () => {
    const { states, refresh, final } = await run(() =>
      Promise.resolve({ ok: false, error: { code: 'CONFLICT_VERSION', message: 'This was changed elsewhere.' } }),
    );
    expect(states).toEqual(['saving', 'conflict']);
    expect(refresh).not.toHaveBeenCalled();
    expect(final).toEqual({ kind: 'conflict', message: 'This was changed elsewhere.' });
    expect(outcomeState({ ok: false, error: { code: 'CONFLICT_DUPLICATE', message: 'x' } }).kind).toBe('conflict');
  });

  it('reports any other refusal, or no answer at all, as an error', async () => {
    const refused = await run(() =>
      Promise.resolve({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'This month has not ended yet.' } }),
    );
    expect(refused.states).toEqual(['saving', 'error']);
    expect(refused.refresh).not.toHaveBeenCalled();

    const unreachable = await run(() => Promise.reject(new Error('network')));
    expect(unreachable.final).toMatchObject({ kind: 'error' });
  });

  it('announces each state politely, saying a conflict overwrote nothing', () => {
    const render = (state: Parameters<typeof SaveStatus>[0]['state']) =>
      renderToStaticMarkup(createElement(SaveStatus, { id: 's', state }));
    expect(render({ kind: 'idle' })).toMatch(/role="status" aria-live="polite"[^>]*><\/span>/u);
    expect(render({ kind: 'saving' })).toContain('Saving…');
    expect(render({ kind: 'saved' })).toContain('Saved.');
    expect(render({ kind: 'error', message: 'Refused.' })).toContain('Refused.');
    expect(render({ kind: 'conflict', message: 'Changed elsewhere.' })).toContain(
      'Changed elsewhere. Nothing was overwritten.',
    );
  });
});
