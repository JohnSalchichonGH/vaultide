import { describe, expect, it } from 'vitest';
import { refusedEntriesOf } from '@/features/accounts/quick-update-refusal';

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
