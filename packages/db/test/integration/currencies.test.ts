import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  adminUrl,
  connect,
  dropDatabase,
  errorCodeOf,
  provisionDatabase,
  runCurrencySeed,
  type ProvisionedDatabase,
} from '../../src/testing/provision';
import { currencySeed } from '../../src/seed/currencies';

/**
 * The `currencies` seed (blueprint 6.2, Phase 0): fiat/official currencies with
 * their real ISO 4217 minor units, 0 through 4 — the reason input validation
 * and the formatter can round-trip a four-decimal currency exactly.
 */

let db: ProvisionedDatabase;
let owner: pg.Client;
let user: pg.Client;

beforeAll(async () => {
  db = await provisionDatabase();
  owner = await connect(db.ownerUrl);
  user = await connect(db.userUrl);
}, 120_000);

afterAll(async () => {
  await Promise.allSettled([owner?.end(), user?.end()]);
  if (db) await dropDatabase(adminUrl(), db.databaseName);
});

describe('currency seed', () => {
  it('loads every seeded currency', async () => {
    const { rows } = await owner.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM currencies',
    );
    expect(Number(rows[0]?.count)).toBe(currencySeed.length);
  });

  it('carries the real minor units, including 0, 3 and 4 decimals', async () => {
    const { rows } = await owner.query<{ code: string; minor_units: number }>(
      `SELECT code, minor_units FROM currencies WHERE code IN ('EUR','JPY','ISK','KWD','BHD','CLF','UYW') ORDER BY code`,
    );
    expect(Object.fromEntries(rows.map((row) => [row.code, row.minor_units]))).toEqual({
      BHD: 3,
      CLF: 4,
      EUR: 2,
      ISK: 0,
      JPY: 0,
      KWD: 3,
      UYW: 4,
    });
  });

  it('contains no crypto codes (R28, D35)', async () => {
    const { rows } = await owner.query<{ code: string }>(
      `SELECT code FROM currencies WHERE code IN ('BTC','ETH','USDT','XBT','SOL','ADA')`,
    );
    expect(rows).toEqual([]);
  });

  it('marks the FX-provider set and keeps EUR as the pivot', async () => {
    const supported = await owner.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM currencies WHERE is_fx_supported',
    );
    expect(Number(supported.rows[0]?.count)).toBeGreaterThanOrEqual(30);

    const eur = await owner.query<{ is_fx_supported: boolean }>(
      `SELECT is_fx_supported FROM currencies WHERE code = 'EUR'`,
    );
    expect(eur.rows[0]?.is_fx_supported).toBe(true);
  });

  it('enforces the row invariants in the database', async () => {
    expect(
      await errorCodeOf(
        owner,
        `INSERT INTO currencies (code, name, minor_units) VALUES ('ZZZ','Too precise',9)`,
      ),
    ).toBe('23514'); // check_violation: minor_units BETWEEN 0 AND 8
    expect(
      await errorCodeOf(
        owner,
        `INSERT INTO currencies (code, name, minor_units) VALUES ('eur','Lowercase',2)`,
      ),
    ).toBe('23514'); // check_violation: code shape
    expect(
      await errorCodeOf(
        owner,
        `INSERT INTO currencies (code, name, minor_units) VALUES ('USD','Duplicate',2)`,
      ),
    ).toBe('23505'); // unique_violation on the primary key
    expect(
      await errorCodeOf(owner, `INSERT INTO currencies (code, name) VALUES ('ZZZ','No units')`),
    ).toBe('23502'); // not_null_violation
  });

  it('is idempotent and never deletes a currency', async () => {
    await owner.query(`UPDATE currencies SET name = 'Renamed' WHERE code = 'EUR'`);
    runCurrencySeed(db.ownerUrl);

    const { rows } = await owner.query<{ name: string; count: string }>(
      `SELECT (SELECT name FROM currencies WHERE code = 'EUR') AS name,
              (SELECT count(*)::text FROM currencies) AS count`,
    );
    expect(rows[0]?.name).toBe('Euro');
    expect(Number(rows[0]?.count)).toBe(currencySeed.length);
  }, 60_000);

  it('is read-only for the runtime role', async () => {
    const readable = await user.query<{ minor_units: number }>(
      `SELECT minor_units FROM currencies WHERE code = 'CLF'`,
    );
    expect(readable.rows[0]?.minor_units).toBe(4);

    expect(
      await errorCodeOf(
        user,
        `INSERT INTO currencies (code, name, minor_units) VALUES ('ZZZ','Nope',2)`,
      ),
    ).toBe('42501');
  });
});
