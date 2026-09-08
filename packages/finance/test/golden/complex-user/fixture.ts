import { plainDate } from '../../../src/dates/plain-date';
import { entry, fxTable, monthEnd, position, valuation } from '../../helpers/records';

/**
 * Golden fixture `complex-user` — the Phase 2 slice (blueprint 21.6).
 *
 * The full fixture is "everything above plus a car excluded from financial net
 * worth, a personal loan, transfers, a skipped month, an unexplained inflow, a
 * self-paid untracked expense and a partner-paid expense, a dormant account, an
 * account closed mid-month". Three of those exist in Phase 2 and are what this
 * slice carries: **the excluded car, a dormant account, and an account closed
 * mid-month**. The rest arrive with the phases that create them, on top of these
 * same positions.
 *
 * The car is the point. It is a tracked asset, so it is in total net worth and
 * nothing a user can switch removes it from there; it is excluded from
 * *financial* net worth, so the headline figure differs by exactly its value
 * (12.1, R18, M15).
 */

export const TODAY = plainDate('2026-09-06');
export const REPORTING = 'EUR';

const bbva = position('BBVA checking', { id: 'cx-bbva', currency: 'EUR' });

/** Emptied and left open. Dormant accounts carry at zero without a monthly
 *  confirmation — the only automatic carry there is (R22, 8.1). */
const oldBank = position('Old bank', { id: 'cx-old', currency: 'EUR', isDormant: true });

/** Emptied and closed on 20 August: it contributes nothing after that (12.1). */
const closedSavings = position('Closed savings', {
  id: 'cx-closed',
  currency: 'EUR',
  status: 'closed',
  closedOn: '2026-08-20',
});

const car = position('Car', {
  id: 'cx-car',
  kind: 'other_asset',
  currency: 'EUR',
  includeInFinancialNetWorth: false,
});

const artwork = position('Artwork', {
  id: 'cx-art',
  kind: 'other_asset',
  currency: 'EUR',
  includeInFinancialNetWorth: true,
});

const carValuations = [valuation(car.id, '2026-08-31', '20000.00')];

const base = [
  entry(bbva, [
    monthEnd(bbva.id, '2026-07-31', '8010.00'),
    monthEnd(bbva.id, '2026-08-31', '8055.00'),
  ]),
  entry(oldBank, [monthEnd(oldBank.id, '2026-06-30', '0.00')]),
  entry(closedSavings, [
    monthEnd(closedSavings.id, '2026-07-31', '1000.00'),
    // The close flow writes the final zero valuation in the same transaction (M6).
    valuation(closedSavings.id, '2026-08-20', '0.00'),
  ]),
  entry(car, carValuations),
  entry(artwork, [valuation(artwork.id, '2026-08-31', '5000.00')]),
];

export const positions = base;

/** The same balance sheet with the car's inclusion preference turned on. */
export const positionsWithCarIncluded = base.map((item) =>
  item.position.id === car.id
    ? entry({ ...car, includeInFinancialNetWorth: true }, carValuations)
    : item,
);

/** A tracked asset nobody has valued: unknown, and never zero. */
const coins = position('Coin collection', {
  id: 'cx-coins',
  kind: 'other_asset',
  currency: 'EUR',
  includeInFinancialNetWorth: true,
});

export const positionsWithUnvaluedAsset = [...base, entry(coins, [])];

export const fx = fxTable([], '2026-09-06');

export const ids = {
  bbva: bbva.id,
  oldBank: oldBank.id,
  closedSavings: closedSavings.id,
  car: car.id,
  artwork: artwork.id,
  coins: coins.id,
};
