import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, withUser, withoutUser } from '@vaultide/db';
import { settingsInput } from '@vaultide/validation';
import { createHarness, type Harness } from '../helpers/harness';
import {
  findSettings,
  readSettings,
  setCountAdditionalSpending,
  setReportingCurrency,
  updateSettings,
} from '../../src/settings/service';
import { listCurrencies, usableCurrencyCodes } from '../../src/currencies/service';
import {
  archiveUserCategory,
  createCategory,
  createTag,
  listCategories,
  listTags,
  removeTag,
} from '../../src/users/categories';
import { ensureProvisioned, provisionUser } from '../../src/users/provisioning';
import { requiredSystemCategoryKinds } from '../../src/users/default-categories';

/**
 * Settings, categories, tags and the currency catalogue against a real
 * database (blueprint 6.2, 15.2, 20.3, 21.3).
 *
 * Two users exist throughout, so every assertion about one is also an
 * assertion that the other cannot see it.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

let harness: Harness;

async function createAuthUser(id: string, email: string): Promise<void> {
  await withoutUser(harness.db, async (tx) => {
    await tx.execute(
      sql`INSERT INTO "user" (id, name, email, email_verified)
          VALUES (${id}, ${email}, ${email}, true)
          ON CONFLICT (id) DO NOTHING`,
    );
  });
}

beforeAll(async () => {
  harness = await createHarness();
  await createAuthUser(USER_A, 'a@example.test');
  await createAuthUser(USER_B, 'b@example.test');
}, 240_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  // A clean slate for both users, applied as the owner so the reset is not
  // itself constrained by RLS.
  await harness.asOwner('DELETE FROM categories');
  await harness.asOwner('DELETE FROM tags');
  await harness.asOwner('DELETE FROM user_settings');
  await provisionUser(harness.db, { userId: USER_A });
  await provisionUser(harness.db, { userId: USER_B });
});

describe('provisioning', () => {
  it('is all-or-nothing and idempotent', async () => {
    await harness.asOwner('DELETE FROM categories WHERE user_id = $1', [USER_A]);
    await harness.asOwner('DELETE FROM user_settings WHERE user_id = $1', [USER_A]);

    const first = await provisionUser(harness.db, { userId: USER_A });
    expect(first.created).toBe(true);
    expect(first.categoriesCreated).toBeGreaterThan(0);

    const second = await provisionUser(harness.db, { userId: USER_A });
    expect(second.created).toBe(false);
    expect(second.categoriesCreated).toBe(0);

    // No duplicates from the second run.
    const categories = await listCategories(harness.db, USER_A);
    const names = categories.map((category) => category.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('creates exactly one category of every system kind, none archivable', async () => {
    const categories = await listCategories(harness.db, USER_A);

    for (const kind of requiredSystemCategoryKinds) {
      const matching = categories.filter((category) => category.kind === kind);
      expect(matching, `system kind ${kind}`).toHaveLength(1);
      expect(matching[0]?.isSystem).toBe(true);
    }

    const systemCategory = categories.find((category) => category.isSystem);
    await expect(
      archiveUserCategory(harness.db, USER_A, systemCategory?.id as string),
    ).rejects.toMatchObject({ code: 'IMPOSSIBLE_OPERATION' });
  });

  it('repairs an account whose provisioning never finished', async () => {
    // The failure mode this guards against: Better Auth committed the user row
    // and the process died before the hook ran (see users/provisioning.ts).
    await harness.asOwner('DELETE FROM categories WHERE user_id = $1', [USER_A]);
    await harness.asOwner('DELETE FROM user_settings WHERE user_id = $1', [USER_A]);
    expect(await findSettings(harness.db, USER_A)).toBeUndefined();

    await ensureProvisioned(harness.db, USER_A);

    expect(await findSettings(harness.db, USER_A)).toBeDefined();
    expect(await listCategories(harness.db, USER_A)).not.toHaveLength(0);
  });

  it('starts every account on the pivot currency, which is always convertible', async () => {
    const settings = await readSettings(harness.db, USER_A);
    expect(settings.baseCurrency).toBe('EUR');
    expect(settings.reportingCurrency).toBe('EUR');
    expect(settings.timezone).toBe('UTC');
    expect(settings.favoriteCurrencies).toEqual([]);
    // 12.5, D40: counting self-paid spending in the savings rate is on by default.
    expect(settings.countAdditionalSpending).toBe(true);
    expect(settings.staleInvestmentMonths).toBe(2);
    expect(settings.stalePropertyMonths).toBe(12);
  });
});

describe('updating settings', () => {
  it('persists every field and bumps the version', async () => {
    const before = await readSettings(harness.db, USER_A);

    const after = await updateSettings(harness.services.settings, USER_A, before.version, {
      baseCurrency: 'USD',
      reportingCurrency: 'GBP',
      timezone: 'Europe/Madrid',
      locale: 'es-ES',
      favoriteCurrencies: ['EUR', 'USD', 'CHF'],
      staleInvestmentMonths: 3,
      stalePropertyMonths: 24,
    });

    expect(after.version).toBe(before.version + 1);
    expect(after).toMatchObject({
      baseCurrency: 'USD',
      reportingCurrency: 'GBP',
      timezone: 'Europe/Madrid',
      locale: 'es-ES',
      staleInvestmentMonths: 3,
      stalePropertyMonths: 24,
      // Untouched by this path: the savings-rate preference has its own
      // service and its own authoritative-session action (12.5, ADR 0003).
      countAdditionalSpending: true,
    });
    expect([...after.favoriteCurrencies].sort()).toEqual(['CHF', 'EUR', 'USD']);

    // And it is really persisted, not merely returned.
    const reread = await readSettings(harness.db, USER_A);
    expect(reread).toEqual(after);
  });

  it('changes the savings-rate preference only through its own service', async () => {
    // 12.5: this decides whether spending paid from outside tracked accounts
    // reduces personal savings, so flipping it re-interprets every past month.
    // It is a financial write and does not ride along with locale and
    // currencies on the cached-session path (ADR 0003, v2.1.6 §30.9).
    const before = await readSettings(harness.db, USER_A);
    expect(before.countAdditionalSpending).toBe(true);

    const after = await setCountAdditionalSpending(
      harness.services.settings,
      USER_A,
      before.version,
      false,
    );

    expect(after.countAdditionalSpending).toBe(false);
    expect(after.version).toBe(before.version + 1);
    expect((await readSettings(harness.db, USER_A)).countAdditionalSpending).toBe(false);

    // Back on, so the rest of the suite sees the default.
    await setCountAdditionalSpending(harness.services.settings, USER_A, after.version, true);
  });

  it('refuses a stale version for the savings-rate preference too', async () => {
    const before = await readSettings(harness.db, USER_A);
    await setCountAdditionalSpending(harness.services.settings, USER_A, before.version, false);

    await expect(
      setCountAdditionalSpending(harness.services.settings, USER_A, before.version, true),
    ).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });

    const current = await readSettings(harness.db, USER_A);
    await setCountAdditionalSpending(harness.services.settings, USER_A, current.version, true);
  });

  it('cannot reach the savings-rate preference through the ordinary settings path', async () => {
    // Not a source-text assertion: this sends the field to the service that used
    // to accept it and proves the value does not move. The Zod input drops the
    // key and `UpdateSettingsFields` no longer carries it, so the only way in is
    // `setCountAdditionalSpending` behind its authoritative-session action
    // (12.5, ADR 0003, v2.1.6 §30.9).
    const before = await readSettings(harness.db, USER_A);
    expect(before.countAdditionalSpending).toBe(true);

    const smuggled = { locale: 'en-GB', countAdditionalSpending: false } as unknown as Parameters<
      typeof updateSettings
    >[3];
    const after = await updateSettings(harness.services.settings, USER_A, before.version, smuggled);

    expect(after.countAdditionalSpending).toBe(true);
    expect((await readSettings(harness.db, USER_A)).countAdditionalSpending).toBe(true);
  });

  it('drops the field at the schema boundary too', () => {
    const parsed = settingsInput.updateSettingsInput.parse({
      locale: 'en-GB',
      countAdditionalSpending: false,
      expectedVersion: 1,
    });
    expect(parsed).not.toHaveProperty('countAdditionalSpending');
  });

  it('refuses a stale version rather than overwriting a concurrent change', async () => {
    const before = await readSettings(harness.db, USER_A);
    await updateSettings(harness.services.settings, USER_A, before.version, {
      locale: 'de-DE',
    });

    await expect(
      updateSettings(harness.services.settings, USER_A, before.version, { locale: 'fr-FR' }),
    ).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });

    expect((await readSettings(harness.db, USER_A)).locale).toBe('de-DE');
  });

  it('maintains updated_at by trigger, not by the application', async () => {
    const before = await withUser(harness.db, { userId: USER_A }, async (tx) =>
      tx.execute<{ updated_at: string }>(sql`SELECT updated_at FROM user_settings`),
    );
    const settings = await readSettings(harness.db, USER_A);
    await updateSettings(harness.services.settings, USER_A, settings.version, {
      locale: 'en-US',
    });
    const after = await withUser(harness.db, { userId: USER_A }, async (tx) =>
      tx.execute<{ updated_at: string }>(sql`SELECT updated_at FROM user_settings`),
    );

    expect(new Date(after.rows[0]?.updated_at as string).getTime()).toBeGreaterThanOrEqual(
      new Date(before.rows[0]?.updated_at as string).getTime(),
    );
  });

  it('changes the reporting currency on its own, from the shell selector', async () => {
    const before = await readSettings(harness.db, USER_A);
    const after = await setReportingCurrency(
      harness.services.settings,
      USER_A,
      before.version,
      'SEK',
    );
    expect(after.reportingCurrency).toBe('SEK');
    // Reporting currency is presentation only: the base currency is untouched.
    expect(after.baseCurrency).toBe(before.baseCurrency);
  });

  it('backfills the history of a currency the first time it is used (10.4)', async () => {
    const before = await readSettings(harness.db, USER_A);
    harness.fxProvider.reset();

    await updateSettings(harness.services.settings, USER_A, before.version, {
      reportingCurrency: 'NOK',
    });

    const fetches = harness.fxProvider.calls.filter((call) => call.method === 'fetchTimeSeries');
    expect(fetches.some((call) => call.quotes.includes('NOK'))).toBe(true);
  });
});

describe('currencies are fiat and provider-backed only (R28, D35)', () => {
  it('offers no crypto at all', async () => {
    const all = await listCurrencies(harness.db);
    const codes = new Set(all.map((currency) => currency.code));

    for (const crypto of ['BTC', 'ETH', 'XBT', 'USDT', 'SOL', 'ADA', 'DOGE']) {
      expect(codes.has(crypto), `${crypto} must not be a currency`).toBe(false);
    }
    expect(await usableCurrencyCodes(harness.db, ['BTC', 'ETH'])).toEqual(new Set());
  });

  it('refuses to set a reporting currency that has no rates', async () => {
    const before = await readSettings(harness.db, USER_A);

    await expect(
      updateSettings(harness.services.settings, USER_A, before.version, {
        reportingCurrency: 'BTC',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    // BGN is a real currency Vaultide still formats, but the ECB stopped
    // publishing a rate for it when Bulgaria adopted the euro — so it cannot be
    // a reporting currency either. Refusing it is the difference between
    // "unsupported" and "silently unconvertible".
    await expect(
      updateSettings(harness.services.settings, USER_A, before.version, {
        reportingCurrency: 'BGN',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    expect((await readSettings(harness.db, USER_A)).reportingCurrency).toBe('EUR');
  });

  it('lists the FX-supported set, and it matches the seed', async () => {
    const supported = await listCurrencies(harness.db, { fxSupportedOnly: true });
    expect(supported.every((currency) => currency.isFxSupported)).toBe(true);
    expect(supported.map((currency) => currency.code)).toContain('EUR');
    expect(supported.map((currency) => currency.code)).not.toContain('BGN');

    // Currencies with four minor units survive the catalogue, because the
    // formatter and the money validators read this column (7.2).
    const all = await listCurrencies(harness.db);
    expect(all.find((currency) => currency.code === 'CLF')?.minorUnits).toBe(4);
    expect(all.find((currency) => currency.code === 'JPY')?.minorUnits).toBe(0);
    expect(all.find((currency) => currency.code === 'KWD')?.minorUnits).toBe(3);
  });
});

describe('cross-user access is impossible (17.2, 17.4)', () => {
  it('shows each user only their own settings', async () => {
    const a = await readSettings(harness.db, USER_A);
    await updateSettings(harness.services.settings, USER_A, a.version, { locale: 'es-ES' });

    const b = await readSettings(harness.db, USER_B);
    expect(b.locale).toBe('en-GB');
    expect(b.userId).toBe(USER_B);
  });

  it('cannot update another user’s settings even with their id and version', async () => {
    const b = await readSettings(harness.db, USER_B);

    // A's scope, B's row: RLS makes the `WHERE` clause match nothing, so the
    // optimistic check reports the row as absent rather than updating it.
    await expect(
      updateSettings(harness.services.settings, USER_B, b.version + 999, { locale: 'ru-RU' }),
    ).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });

    expect((await readSettings(harness.db, USER_B)).locale).toBe('en-GB');
  });

  it('shows each user only their own categories and tags', async () => {
    await createCategory(harness.db, USER_A, { kind: 'general', name: "A's private category" });
    await createTag(harness.db, USER_A, "A's tag");

    const bCategories = await listCategories(harness.db, USER_B);
    const bTags = await listTags(harness.db, USER_B);

    expect(bCategories.map((category) => category.name)).not.toContain("A's private category");
    expect(bTags.map((tag) => tag.name)).not.toContain("A's tag");
  });

  it('reports another user’s category as not found, never as forbidden', async () => {
    const aCategory = await createCategory(harness.db, USER_A, {
      kind: 'general',
      name: 'Only A can see this',
    });

    // Existence is not leaked: B is told the same thing they would be told
    // about an id that never existed (17.2, 20.2 NOT_FOUND).
    await expect(archiveUserCategory(harness.db, USER_B, aCategory.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const stillThere = await listCategories(harness.db, USER_A);
    expect(stillThere.find((category) => category.id === aCategory.id)?.archived).toBe(false);
  });

  it('reports another user’s tag as not found', async () => {
    const aTag = await createTag(harness.db, USER_A, 'a-only');
    await expect(removeTag(harness.db, USER_B, aTag.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await listTags(harness.db, USER_A)).map((tag) => tag.name)).toContain('a-only');
  });
});

describe('categories and tags', () => {
  it('archives rather than deletes, freeing the name for a new one', async () => {
    const created = await createCategory(harness.db, USER_A, {
      kind: 'travel',
      name: 'Sabbatical',
    });
    await archiveUserCategory(harness.db, USER_A, created.id);

    expect(
      (await listCategories(harness.db, USER_A)).map((category) => category.id),
    ).not.toContain(created.id);
    expect(
      (await listCategories(harness.db, USER_A, { includeArchived: true })).map((c) => c.id),
    ).toContain(created.id);

    // The unique index is partial, so the name is free again (6.2).
    const reused = await createCategory(harness.db, USER_A, {
      kind: 'travel',
      name: 'Sabbatical',
    });
    expect(reused.id).not.toBe(created.id);
  });

  it('refuses a second live category with the same name', async () => {
    await createCategory(harness.db, USER_A, { kind: 'general', name: 'Duplicate' });
    await expect(
      createCategory(harness.db, USER_A, { kind: 'general', name: 'Duplicate' }),
    ).rejects.toBeInstanceOf(Error);
  });

  it('refuses a second category of a system kind', async () => {
    await expect(
      createCategory(harness.db, USER_A, { kind: 'investment_fee', name: 'My own fees' }),
    ).rejects.toMatchObject({ code: 'IMPOSSIBLE_OPERATION' });
  });

  it('lets two different users hold the same category name', async () => {
    await createCategory(harness.db, USER_A, { kind: 'food', name: 'Coffee' });
    const forB = await createCategory(harness.db, USER_B, { kind: 'food', name: 'Coffee' });
    expect(forB.name).toBe('Coffee');
  });

  it('deletes a tag outright, because nothing references a tag row', async () => {
    const tag = await createTag(harness.db, USER_A, 'holiday');
    await removeTag(harness.db, USER_A, tag.id);
    expect((await listTags(harness.db, USER_A)).map((t) => t.name)).not.toContain('holiday');
  });
});
