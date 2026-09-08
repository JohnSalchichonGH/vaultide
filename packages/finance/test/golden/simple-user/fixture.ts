import { plainDate } from '../../../src/dates/plain-date';
import { entry, fxTable, monthEnd, position, valuation } from '../../helpers/records';

/**
 * Golden fixture `simple-user` — the Phase 2 slice (blueprint 21.6).
 *
 * Two EUR checking accounts, six completed months of statement month-end
 * balances, then a current month in which both accounts were snapshotted on the
 * 6th. Phase 3 extends the same fixture with a salary, inferred spending and
 * the month-to-date variants; the balances here are the ones those tests build
 * on, and the August figures are the opening balances of the worked example in
 * blueprint 12.7.
 *
 * See README.md for the hand computation of every number the tests assert.
 */

export const TODAY = plainDate('2026-09-06');
export const REPORTING = 'EUR';

const bbva = position('BBVA checking', { id: 'simple-bbva', currency: 'EUR' });
const savings = position('Savings', { id: 'simple-savings', currency: 'EUR' });

export const positions = [
  entry(bbva, [
    monthEnd(bbva.id, '2026-03-31', '7200.00'),
    monthEnd(bbva.id, '2026-04-30', '7450.00'),
    monthEnd(bbva.id, '2026-05-31', '7610.00'),
    monthEnd(bbva.id, '2026-06-30', '7905.00'),
    monthEnd(bbva.id, '2026-07-31', '8010.00'),
    monthEnd(bbva.id, '2026-08-31', '8055.00'),
    // The current month: an ordinary snapshot, not a month end (8.8).
    valuation(bbva.id, '2026-09-06', '8120.00'),
  ]),
  entry(savings, [
    monthEnd(savings.id, '2026-03-31', '8000.00'),
    monthEnd(savings.id, '2026-04-30', '8100.00'),
    monthEnd(savings.id, '2026-05-31', '8200.00'),
    monthEnd(savings.id, '2026-06-30', '8300.00'),
    monthEnd(savings.id, '2026-07-31', '8400.00'),
    monthEnd(savings.id, '2026-08-31', '8509.00'),
    valuation(savings.id, '2026-09-06', '8509.00'),
  ]),
];

/** A single-currency user never needs a rate: EUR -> EUR is exactly 1 (10.1). */
export const fx = fxTable([], '2026-09-06');

export const ids = { bbva: bbva.id, savings: savings.id };
