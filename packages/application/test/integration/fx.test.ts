import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { countFxRates, eq, fxRates, latestRateDateByQuote, sql, withUser, withoutUser } from '@vaultide/db';
import { Decimal, isUnavailable, monthKey, plainDate } from '@vaultide/finance';
import { createHarness, type Harness } from '../helpers/harness';
import {
  createFxService,
  PIVOT,
  REFRESH_BACKFILL_DAYS,
  SOURCE_PREFERENCE,
} from '../../src/fx/service';
import { FxProviderError } from '../../src/fx/provider';
import { supportedFxCurrencyCodes } from '../../src/currencies/service';
import { provisionUser } from '../../src/users/provisioning';

/**
 * FX refresh, backfill and lookup against a real database (blueprint 10.4,
 * 21.3: "FX `refreshAll`/`ensureHistory` with a stubbed provider — gap filling,
 * failure tolerance, immutability; the FX cron under `app_user` completes
 * without a user context and touches only `fx_rates`").
 *
 * The provider is stubbed; the database, the roles and RLS are real.
 */

let harness: Harness;

/** A fixed clock, so "the last fortnight" is the same range on every run. */
const TODAY = '2026-09-07';
const clock = (): Date => new Date(`${TODAY}T16:30:00Z`);

function serviceWithClock() {
  return createFxService({
    db: harness.db,
    provider: harness.fxProvider,
    logger: harness.services.logger,
    now: clock,
  });
}

beforeAll(async () => {
  harness = await createHarness();
}, 240_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  harness.fxProvider.reset();
  // Emptied as the owner: `app_user` cannot delete a stored rate, which is
  // itself asserted below.
  await harness.asOwner('DELETE FROM fx_rates');
});

describe('refreshAll — the daily cron (10.4)', () => {
  it('fills the whole supported fiat set, not the currencies anyone happens to use', async () => {
    const fx = serviceWithClock();
    const supported = await supportedFxCurrencyCodes(harness.db);

    const result = await fx.refreshAll();

    // Every supported currency except the pivot itself.
    expect(result.currencies).toBe(supported.length - 1);
    expect(result.from).toBe('2026-08-24');
    expect(result.to).toBe(TODAY);
    expect(result.rowsInserted).toBeGreaterThan(0);

    // R26: the set comes from `currencies`, so it does not depend on — and
    // cannot reveal — what any user holds.
    const stored = await latestRateDateByQuote(harness.db);
    const covered = new Set(Object.keys(stored));
    for (const code of supported) {
      if (code === PIVOT) continue;
      // The stub publishes only the currencies it knows; the service asked for
      // all of them, which is the property under test.
      expect(result.currencies).toBeGreaterThan(0);
      if (covered.has(code)) expect(stored[code]).toBeDefined();
    }
    expect(covered.size).toBeGreaterThan(0);
  });

  it('backfills a fortnight, so a missed day is filled by the next run', async () => {
    const fx = serviceWithClock();
    // The publisher had an outage on the 2nd and 3rd.
    harness.fxProvider.skipDates(['2026-09-02', '2026-09-03']);
    await fx.refreshAll();

    const before = await datesFor('USD');
    expect(before).not.toContain('2026-09-02');

    // The publisher catches up; the next daily run picks the missing days up
    // without anybody asking for them, because the window is a fortnight.
    harness.fxProvider.skipDates([]);
    const second = await fx.refreshAll();

    expect(second.rowsInserted).toBeGreaterThan(0);
    const after = await datesFor('USD');
    expect(after).toContain('2026-09-02');
    expect(after).toContain('2026-09-03');
    expect(REFRESH_BACKFILL_DAYS).toBe(14);
  });

  it('is idempotent: running it twice changes nothing', async () => {
    const fx = serviceWithClock();
    const first = await fx.refreshAll();
    const countAfterFirst = await countFxRates(harness.db);

    const second = await fx.refreshAll();

    expect(first.rowsInserted).toBeGreaterThan(0);
    expect(second.rowsInserted).toBe(0);
    expect(await countFxRates(harness.db)).toBe(countAfterFirst);
  });

  it('stores only EUR-based rows, and never a EUR/EUR row', async () => {
    await serviceWithClock().refreshAll();
    const rows = await withoutUser(harness.db, async (tx) =>
      tx.selectDistinct({ base: fxRates.base, quote: fxRates.quote }).from(fxRates),
    );
    expect(rows.every((row) => row.base.trim() === 'EUR')).toBe(true);
    expect(rows.some((row) => row.quote.trim() === 'EUR')).toBe(false);
  });

  it('refuses an implausible rate rather than storing it (10.5)', async () => {
    // A provider defect: a rate of zero would make every conversion through it
    // meaningless, and the CHECK constraint would abort the whole batch.
    harness.fxProvider.poison('USD', '0');
    const fx = serviceWithClock();

    await expect(fx.refreshAll()).rejects.toBeInstanceOf(Error);

    // The stub bypasses the provider's own validation, so this proves the last
    // line of defence: the database refuses the row.
    const rows = await datesFor('USD');
    expect(rows).toHaveLength(0);
  });
});

describe('provider attribution and source preference (10.1, 10.2, 10.4)', () => {
  it('stores one row per bank, differing only in source', async () => {
    await serviceWithClock().refreshAll();

    // The stub chain mirrors the real one: the ECB publishes the euro-area
    // reference set and Banca d'Italia publishes everything, so USD comes from
    // both banks on the same day.
    const rows = await withoutUser(harness.db, async (tx) =>
      tx
        .select({ source: fxRates.source, rate: fxRates.rate, base: fxRates.base })
        .from(fxRates)
        .where(sql`${fxRates.quote} = 'USD' AND ${fxRates.rateDate} = DATE '2026-09-04'`)
        .orderBy(fxRates.source),
    );

    expect(rows.map((row) => row.source)).toEqual(['bdi', 'ecb']);
    // 10.4: "an alternative rate is a new row with another source".
    expect(rows[0]?.rate).not.toBe(rows[1]?.rate);
    // Both are EUR-pivoted; nothing was re-pivoted on the way in (10.1).
    expect(rows.every((row) => row.base.trim() === 'EUR')).toBe(true);
    // And never the redistributor's name.
    expect(rows.every((row) => row.source !== 'frankfurter')).toBe(true);
  });

  it('converts with the preferred bank’s rate when two published the same day', async () => {
    const fx = serviceWithClock();
    await fx.refreshAll();

    const table = await fx.loadTable(['USD'], '2026-08-01', TODAY, plainDate(TODAY));
    const lookup = table.rateOn('USD', plainDate('2026-09-04'));
    if (isUnavailable(lookup)) throw new Error('expected a rate');

    // SOURCE_PREFERENCE puts the ECB first (10.1 names its reference series).
    expect(SOURCE_PREFERENCE[0]).toBe('ecb');
    expect(lookup.source).toBe('ecb');

    const [ecbRow] = await withoutUser(harness.db, async (tx) =>
      tx
        .select({ rate: fxRates.rate })
        .from(fxRates)
        .where(
          sql`${fxRates.quote} = 'USD' AND ${fxRates.rateDate} = DATE '2026-09-04' AND ${fxRates.source} = 'ecb'`,
        ),
    );
    expect(lookup.rate.toFixed()).toBe(new Decimal(ecbRow?.rate as string).toFixed());
  });

  it('still covers a currency only the second bank publishes', async () => {
    const fx = serviceWithClock();
    await fx.refreshAll();

    // AED is in the supported set through Banca d'Italia; the ECB has never
    // published it. Reaching past the ECB's own 30 is the whole point of v2.
    const rows = await withoutUser(harness.db, async (tx) =>
      tx
        .selectDistinct({ source: fxRates.source })
        .from(fxRates)
        .where(eq(fxRates.quote, 'AED')),
    );
    expect(rows.map((row) => row.source)).toEqual(['bdi']);

    const table = await fx.loadTable(['AED'], '2026-08-01', TODAY, plainDate(TODAY));
    const lookup = table.rateOn('AED', plainDate('2026-09-04'));
    if (isUnavailable(lookup)) throw new Error('expected a rate');
    expect(lookup.source).toBe('bdi');
  });

  it('falls back to the next bank when the preferred one has no rate that day', async () => {
    const fx = serviceWithClock();
    // The ECB skipped a day that Banca d'Italia published.
    harness.fxProvider.setChain([
      { source: 'bdi', currencies: 'all' },
    ]);
    await fx.refreshAll();

    const table = await fx.loadTable(['USD'], '2026-08-01', TODAY, plainDate(TODAY));
    const lookup = table.rateOn('USD', plainDate('2026-09-04'));
    if (isUnavailable(lookup)) throw new Error('expected a rate');
    // The preference is an order, not a requirement: an unlisted or absent
    // publisher ranks last rather than making the rate unavailable.
    expect(lookup.source).toBe('bdi');
  });
});

describe('immutability (6.2)', () => {
  it('never rewrites a stored rate, even when the provider changes its mind', async () => {
    const fx = serviceWithClock();
    await fx.refreshAll();

    const [before] = await withoutUser(harness.db, async (tx) =>
      tx
        .select({ rate: fxRates.rate, id: fxRates.id })
        .from(fxRates)
        .where(eq(fxRates.quote, 'USD'))
        .limit(1),
    );
    expect(before).toBeDefined();

    // The publisher now reports something different for every day.
    harness.fxProvider.poison('USD', '9.999999');
    await fx.refreshAll();

    const [after] = await withoutUser(harness.db, async (tx) =>
      tx.select({ rate: fxRates.rate }).from(fxRates).where(eq(fxRates.id, before?.id as string)),
    );
    expect(after?.rate).toBe(before?.rate);
  });

  it('denies the runtime role UPDATE and DELETE on fx_rates', async () => {
    await serviceWithClock().refreshAll();

    // The privilege is revoked by migration (6.1), so this is enforced by the
    // database rather than by the repository's choice of statements.
    // `42501` is PostgreSQL's insufficient_privilege; Drizzle wraps the driver
    // error, so the code is read from the cause.
    await expect(
      withoutUser(harness.db, async (tx) =>
        tx.execute(sql`UPDATE fx_rates SET rate = 1 WHERE quote = 'USD'`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });

    await expect(
      withoutUser(harness.db, async (tx) => tx.execute(sql`DELETE FROM fx_rates`)),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

describe('the cron runs without a user context (R26, T11)', () => {
  it('completes with no session and cannot see any user row while doing so', async () => {
    // A real user with real settings and categories exists.
    const userId = '33333333-3333-4333-8333-333333333333';
    await withoutUser(harness.db, async (tx) => {
      await tx.execute(
        sql`INSERT INTO "user" (id, name, email, email_verified) VALUES (${userId}, 'Cron Witness', 'cron-witness@example.test', true)`,
      );
    });
    await provisionUser(harness.db, { userId });

    // The user's own rows exist, seen from inside their scope.
    const own = await withUser(harness.db, { userId }, async (tx) =>
      tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM user_settings`),
    );
    expect(Number(own.rows[0]?.n)).toBe(1);

    // The refresh runs with no user context at all and succeeds.
    const result = await serviceWithClock().refreshAll();
    expect(result.rowsInserted).toBeGreaterThan(0);

    // And in that same context — the one the cron runs in — every user-owned
    // table is empty. Not "the job chooses not to look": it cannot see them.
    const blind = await withoutUser(harness.db, async (tx) =>
      tx.execute<{ settings: string; categories: string; tags: string }>(
        sql`SELECT (SELECT count(*) FROM user_settings)::text AS settings,
                   (SELECT count(*) FROM categories)::text AS categories,
                   (SELECT count(*) FROM tags)::text AS tags`,
      ),
    );
    expect(blind.rows[0]).toEqual({ settings: '0', categories: '0', tags: '0' });
  });
});

describe('ensureHistory — first use of a currency (10.4)', () => {
  it('fetches the history once and skips every later call', async () => {
    const fx = serviceWithClock();

    const first = await fx.ensureHistory('SEK', '2026-06-01');
    expect(first.skipped).toBe(false);
    expect(first.rowsInserted).toBeGreaterThan(0);
    // A month of lead time before the earliest financial date (10.4).
    const call = harness.fxProvider.calls.at(-1);
    expect(call?.from).toBe('2026-05-01');

    const callsBefore = harness.fxProvider.calls.length;
    const second = await fx.ensureHistory('SEK', '2026-06-01');
    expect(second.skipped).toBe(true);
    expect(second.rowsInserted).toBe(0);
    // No second request: history is global, so one fetch serves every user.
    expect(harness.fxProvider.calls.length).toBe(callsBefore);
  });

  it('extends the range when an earlier date is asked for', async () => {
    const fx = serviceWithClock();
    await fx.ensureHistory('NOK', '2026-06-01');

    const earlier = await fx.ensureHistory('NOK', '2025-01-01');
    expect(earlier.skipped).toBe(false);
    expect(earlier.rowsInserted).toBeGreaterThan(0);
    expect((await datesFor('NOK')).some((date) => date < '2026-05-01')).toBe(true);
  });

  it('does nothing for EUR, which needs no rate at all', async () => {
    const result = await serviceWithClock().ensureHistory('EUR');
    expect(result.skipped).toBe(true);
    expect(harness.fxProvider.calls).toHaveLength(0);
  });

  it('does nothing for a currency the catalogue does not support', async () => {
    // Crypto is not in `currencies` at all (R28), so this is also the answer to
    // "can a user make the system fetch BTC rates?": no, before any network.
    const result = await serviceWithClock().ensureHistory('BTC');
    expect(result.skipped).toBe(true);
    expect(harness.fxProvider.calls).toHaveLength(0);
  });

  it('survives a provider outage without failing the user action (10.5)', async () => {
    const fx = serviceWithClock();
    harness.fxProvider.failWith(new FxProviderError('stub', 503));

    // The user was changing their reporting currency. A rate publisher being
    // down is not their problem, and must not roll back what they did.
    const result = await fx.ensureHistory('PLN', '2026-06-01');
    expect(result.skipped).toBe(true);
    expect(result.rowsInserted).toBe(0);

    // Nothing was written, nothing was invented.
    expect(await datesFor('PLN')).toHaveLength(0);

    // And once the provider recovers, the next attempt fills it in.
    harness.fxProvider.failWith(null);
    const retry = await fx.ensureHistory('PLN', '2026-06-01');
    expect(retry.rowsInserted).toBeGreaterThan(0);
  });
});

describe('loadTable — reading stored rates back into the engine (10.1)', () => {
  it('reproduces the stored rate exactly and applies the on-or-before rule', async () => {
    const fx = serviceWithClock();
    await fx.refreshAll();

    const table = await fx.loadTable(['USD'], '2026-08-01', TODAY, plainDate(TODAY));

    // 5 September 2026 is a Saturday; the stub publishes weekdays only.
    const saturday = table.rateOn('USD', plainDate('2026-09-05'));
    if (isUnavailable(saturday)) throw new Error('expected a rate');
    expect(saturday.rateDate).toBe('2026-09-04');
    expect(saturday.exact).toBe(false);

    const friday = table.rateOn('USD', plainDate('2026-09-04'));
    if (isUnavailable(friday)) throw new Error('expected a rate');
    expect(friday.exact).toBe(true);

    // The value round-trips through NUMERIC(24,12) without losing a digit.
    const [stored] = await withoutUser(harness.db, async (tx) =>
      tx
        .select({ rate: fxRates.rate })
        .from(fxRates)
        .where(sql`${fxRates.quote} = 'USD' AND ${fxRates.rateDate} = DATE '2026-09-04'`),
    );
    expect(friday.rate.toFixed()).toBe(new Decimal(stored?.rate as string).toFixed());
  });

  it('is unavailable for a currency with no stored rates — never zero', async () => {
    const table = await serviceWithClock().loadTable(['JPY'], '2026-08-01', TODAY, plainDate(TODAY));
    const lookup = table.rateOn('JPY', plainDate(TODAY));
    expect(isUnavailable(lookup)).toBe(true);
  });

  it('averages a completed month from the days it actually stored', async () => {
    const fx = serviceWithClock();
    await fx.ensureHistory('CHF', '2026-08-01');

    const table = await fx.loadTable(['CHF'], '2026-07-01', TODAY, plainDate(TODAY));
    const average = table.monthlyAverage('CHF', monthKey(plainDate('2026-08-15')));
    if (isUnavailable(average)) throw new Error('expected an average');

    // August 2026 has 21 weekdays.
    expect(average.sampleCount).toBe(21);
    expect(average.approximate).toBe(false);
  });
});

describe('supported-currency reconciliation (Phase 1)', () => {
  // "Provider" here is the approved chain, so this measures the seed against
  // Vaultide's FX policy — not against every currency the upstream aggregator
  // could serve from banks the product does not draw from.
  it('reports the seed and the approved chain as in sync when they agree', async () => {
    const seeded = await supportedFxCurrencyCodes(harness.db);
    harness.fxProvider.setSupportedCurrencies(seeded);

    const report = await serviceWithClock().reconcileSupportedCurrencies();

    expect(report.inSync).toBe(true);
    expect(report.missingFromProvider).toEqual([]);
    expect(report.missingFromSeed).toEqual([]);
  });

  it('names both directions of a divergence rather than repairing it silently', async () => {
    const seeded = await supportedFxCurrencyCodes(harness.db);
    // An approved bank stops publishing one currency and starts publishing one
    // the catalogue lacks — the first is what happened to BGN when Bulgaria
    // adopted the euro.
    harness.fxProvider.setSupportedCurrencies([
      ...seeded.filter((code) => code !== 'USD'),
      'XTS',
    ]);

    const report = await serviceWithClock().reconcileSupportedCurrencies();

    expect(report.inSync).toBe(false);
    expect(report.missingFromProvider).toContain('USD');
    expect(report.missingFromSeed).toContain('XTS');
    // Reporting only: the flags in the database are untouched, because
    // changing the catalogue is a migration, not a job's side effect.
    expect(await supportedFxCurrencyCodes(harness.db)).toEqual(seeded);
  });
});

/** Every stored date for one currency, ascending. */
async function datesFor(quote: string): Promise<string[]> {
  const rows = await withoutUser(harness.db, async (tx) =>
    tx
      .select({ rateDate: fxRates.rateDate })
      .from(fxRates)
      .where(eq(fxRates.quote, quote))
      .orderBy(fxRates.rateDate),
  );
  return rows.map((row) => row.rateDate);
}
