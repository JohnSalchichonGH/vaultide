import { plainDate } from '../../../src/dates/plain-date';
import { entry, fxTable, monthEnd, position, rate } from '../../helpers/records';

/**
 * Golden fixture `multi-currency` — the Phase 2 slice (blueprint 21.6).
 *
 * A EUR account and a USD account, reported in EUR. Phase 3 and 4 extend it
 * with a USD salary, a EUR->USD conversion and a USD loan; Phase 2 asserts the
 * part that already exists: native amounts stay authoritative, the reporting
 * total is derived at the as-of date's rate, and a missing rate produces a
 * partial total that names what is not in it — never a silent zero.
 *
 * The rates are the real ECB reference series for the last days of August 2026.
 */

export const TODAY = plainDate('2026-09-06');
export const REPORTING = 'EUR';

const bbva = position('BBVA checking', { id: 'mc-bbva', currency: 'EUR' });
const chase = position('US checking', { id: 'mc-chase', currency: 'USD' });

export const positions = [
  entry(bbva, [
    monthEnd(bbva.id, '2026-07-31', '8010.00'),
    monthEnd(bbva.id, '2026-08-31', '8055.00'),
  ]),
  entry(chase, [
    monthEnd(chase.id, '2026-07-31', '2900.00'),
    monthEnd(chase.id, '2026-08-31', '3000.00'),
  ]),
];

/** EUR -> USD, the last week of August 2026. */
export const RATES = [
  rate('USD', '2026-07-31', '1.1571'),
  rate('USD', '2026-08-27', '1.1602'),
  rate('USD', '2026-08-28', '1.1588'),
  rate('USD', '2026-08-31', '1.1596'),
  rate('USD', '2026-09-04', '1.1622'),
];

export const fx = fxTable(RATES, '2026-09-06');

/** The same user during an FX outage: not one rate has ever been stored. */
export const fxUnavailable = fxTable([], '2026-09-06');

export const ids = { bbva: bbva.id, chase: chase.id };
