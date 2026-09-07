import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, fxRates, withoutUser } from '@vaultide/db';
import { createHarness, type Harness } from '../helpers/harness';
import { createFrankfurterProvider, FRANKFURTER_BASE_URL } from '../../src/fx/frankfurter';
import { createFxService, type FxService } from '../../src/fx/service';
import { supportedFxCurrencyCodes } from '../../src/currencies/service';

/**
 * Adapter compatibility with the **real** Frankfurter v2 service.
 *
 * This is the one suite that talks to the public API, and it is deliberately
 * separate from everything else:
 *
 *  - the ordinary browser matrix runs against a deterministic fixture, because
 *    three Playwright projects each picking a currency is several concurrent
 *    long-range requests to a free public service, which stalls under exactly
 *    that pattern — a transient upstream slowdown must not make Vaultide's own
 *    suite flaky;
 *  - the integration suite stubs the provider, because gap filling, failure
 *    tolerance and immutability are rules about our code, not about the ECB.
 *
 * What is left is the question only the live service can answer: does the
 * adapter still speak to v2 correctly? That runs **once**, serially, on
 * demand — `pnpm test:live` — and never per browser or per project.
 *
 * It is skipped unless `FX_LIVE=1`, so an offline runner and an ordinary
 * `pnpm test:integration` are unaffected.
 */

const live = process.env['FX_LIVE'] === '1';
const suite = live ? describe : describe.skip;

let harness: Harness;
let fx: FxService;

/** A recent window, so this asks the live service for days rather than decades. */
const today = new Date();
const iso = (date: Date): string => date.toISOString().slice(0, 10);
const daysAgo = (days: number): string =>
  iso(new Date(today.getTime() - days * 24 * 60 * 60 * 1000));

suite('the Frankfurter v2 adapter against the live service', () => {
  beforeAll(async () => {
    harness = await createHarness({ fxProvider: createFrankfurterProvider() });
    fx = createFxService({
      db: harness.db,
      provider: harness.services.fxProvider,
      logger: harness.services.logger,
    });
  }, 240_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('addresses /v2 and reports the approved chain of banks', () => {
    expect(FRANKFURTER_BASE_URL).toBe('https://api.frankfurter.dev/v2');
    expect(harness.services.fxProvider.id).toBe('frankfurter-v2');
  });

  it('GET /v2/currencies still yields exactly the committed supported set', async () => {
    const report = await fx.reconcileSupportedCurrencies();

    // Both directions, so a currency added upstream is as loud as one removed.
    expect(report.missingFromProvider).toEqual([]);
    expect(report.missingFromSeed).toEqual([]);
    expect(report.provider).toHaveLength((await supportedFxCurrencyCodes(harness.db)).length);
  });

  it('retrieves each bank pinned, and attributes every row to it', async () => {
    const ecb = await createFrankfurterProvider({ providers: ['ECB'] }).fetchLatest('EUR', ['USD']);
    const bdi = await createFrankfurterProvider({ providers: ['BDI'] }).fetchLatest('EUR', ['USD']);

    expect(ecb.map((row) => row.source)).toEqual(['ecb']);
    expect(bdi.map((row) => row.source)).toEqual(['bdi']);
    // Never the redistributor: 10.1 wants the bank that published the rate.
    for (const row of [...ecb, ...bdi]) expect(row.source).not.toBe('frankfurter');

    // AED is published by Banca d'Italia and not by the ECB — the reason the
    // chain has a second bank at all.
    const aed = await createFrankfurterProvider({ providers: ['BDI'] }).fetchLatest('EUR', ['AED']);
    expect(aed).toHaveLength(1);
  });

  it('keeps the publisher’s own digits, checked against the raw body', async () => {
    const response = await fetch(`${FRANKFURTER_BASE_URL}/rates?base=EUR&providers=BDI`);
    const body = await response.text();

    // Literal digits, straight off the wire — not via JSON.parse, which would
    // hand back a float64 and lose the very thing being checked (7.1, R31).
    const published = new Map<string, string>();
    for (const match of body.matchAll(/"quote":"([A-Z]{3})","rate":([0-9.eE+-]+)/gu)) {
      published.set(match[1] as string, match[2] as string);
    }

    const wide = [...published].filter(([, rate]) => (rate.split('.')[1] ?? '').length >= 5);
    expect(wide.length).toBeGreaterThan(0);

    const [code, literal] = wide[0] as [string, string];
    const rows = await createFrankfurterProvider({ providers: ['BDI'] }).fetchLatest('EUR', [code]);

    expect(rows[0]?.rate).toBe(literal);
    expect(typeof rows[0]?.rate).toBe('string');
  });

  it('refreshes the current window, idempotently, with no weekend rows', async () => {
    const first = await fx.refreshAll();
    expect(first.rowsInserted).toBeGreaterThan(0);
    expect(first.currencies).toBe((await supportedFxCurrencyCodes(harness.db)).length - 1);

    // Immutability is a constraint, not a check: the same fetch again inserts
    // nothing at all (6.2).
    const second = await fx.refreshAll();
    expect(second.rowsFetched).toBeGreaterThan(0);
    expect(second.rowsInserted).toBe(0);

    const stored = await withoutUser(harness.db, async (tx) =>
      tx.select({ rateDate: fxRates.rateDate, source: fxRates.source }).from(fxRates),
    );

    // A central bank publishes on business days, and nothing here invents the
    // days it skipped (10.2).
    for (const row of stored) {
      const day = new Date(`${row.rateDate}T00:00:00Z`).getUTCDay();
      expect(day).not.toBe(0);
      expect(day).not.toBe(6);
    }

    // Both approved banks are represented, each under its own key.
    const sources = new Set(stored.map((row) => row.source));
    expect([...sources].sort()).toEqual(['bdi', 'ecb']);

    // EUR is 1 by definition and is never stored against itself (10.1).
    const pivotRows = await withoutUser(harness.db, async (tx) =>
      tx.select({ quote: fxRates.quote }).from(fxRates).where(eq(fxRates.quote, 'EUR')),
    );
    expect(pivotRows).toHaveLength(0);
  });

  it('backfills history only as far as a dated need asks for', async () => {
    const earliestNeeded = daysAgo(120);
    const result = await fx.ensureHistory('GBP', earliestNeeded);

    expect(result.skipped).toBe(false);
    expect(result.rowsInserted).toBeGreaterThan(0);
    // A month of lead time before the earliest needed date, and no further
    // (10.4). Decades are not fetched to satisfy a four-month question.
    // ISO dates compare correctly as text.
    const from = result.from ?? '';
    expect(from < earliestNeeded).toBe(true);
    expect(from > daysAgo(160)).toBe(true);

    const dates = await withoutUser(harness.db, async (tx) =>
      tx.select({ rateDate: fxRates.rateDate }).from(fxRates).where(eq(fxRates.quote, 'GBP')),
    );
    const earliestStored = dates.map((row) => row.rateDate).sort()[0] ?? '';
    expect(earliestStored <= earliestNeeded).toBe(true);

    // And repeating it is free.
    const again = await fx.ensureHistory('GBP', earliestNeeded);
    expect(again.skipped).toBe(true);
    expect(again.rowsInserted).toBe(0);
  });
});
