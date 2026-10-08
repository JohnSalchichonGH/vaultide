import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { refusedEntriesOf } from '@/features/accounts/quick-update-refusal';

// The modal saves through a server action and refreshes through the app
// router; neither exists outside Next, and neither is what its words are about.
vi.mock('@/server/actions/positions', () => ({ quickUpdateAction: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const { QuickUpdate } = await import('@/features/accounts/quick-update');

/**
 * Quick update's refusals, on the rows they name (15.3).
 *
 * The server keys a refusal about one balance to `entries.<i>.amount`, by the
 * entry's place in the request, and the dialog marks that account's row.
 */
describe('the accounts a refused quick update names', () => {
  const sent = ['pos-bbva', 'pos-savings', 'pos-cash'];

  it('are the entries the refusal keys, by their place in the request', () => {
    expect(
      refusedEntriesOf(
        {
          'entries.1.amount': ['Use at most 2 decimals for this currency.'],
          'entries.2.amount': ['This currency has no decimals.', 'and more'],
        },
        sent,
      ),
    ).toEqual(
      new Map([
        ['pos-savings', 'Use at most 2 decimals for this currency.'],
        ['pos-cash', 'This currency has no decimals.'],
      ]),
    );
  });

  it('are none for a refusal that names no entry that was sent', () => {
    expect(refusedEntriesOf(undefined, sent).size).toBe(0);
    expect(
      refusedEntriesOf(
        {
          entries: ['Enter at least one balance.'],
          'entries.3.amount': ['Past the request.'],
          'entries.0.positionId': ['Not an amount.'],
          'entries.0.amount': [],
        },
        sent,
      ).size,
    ).toBe(0);
  });
});

/** What the modal says above its fields (15.3). */
describe('what Quick update says about a blank field', () => {
  const noteOf = (today: string): string => {
    const html = renderToStaticMarkup(
      createElement(QuickUpdate, {
        positions: [
          {
            id: 'pos-bbva',
            name: 'BBVA',
            currency: 'EUR',
            minorUnits: 2,
            status: 'active',
            isDormant: false,
            value: { native: { amount: '1000', currency: 'EUR' }, valuedOn: '2026-09-06' },
          },
        ],
        today,
        locale: 'en-GB',
        monthEndsOn: '2026-09-30',
      }),
    );
    const at = html.indexOf('data-testid="quick-update-note"');
    return html.slice(at, html.indexOf('</p>', at)).replaceAll(/<[^>]+>/gu, '');
  };

  it('says a blank account keeps its older snapshot, and month to date stays at the shared date', () => {
    expect(noteOf('2026-09-10')).toContain(
      'Leave one blank to keep its older snapshot; month to date then stays at the latest date every cash account shares.',
    );
    expect(noteOf('2026-09-10')).not.toContain('last day of the month');
  });

  it('keeps the last day’s note beside it', () => {
    const note = noteOf('2026-09-30');
    expect(note).toContain('month to date then stays at the latest date every cash account shares.');
    expect(note).toContain(
      'Today is the last day of the month, so these are ordinary snapshots — you can confirm them as statement balances from tomorrow.',
    );
  });
});
