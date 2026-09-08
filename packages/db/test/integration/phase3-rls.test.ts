import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  adminUrl,
  connect,
  dropDatabase,
  errorCodeOf,
  provisionDatabase,
  type ProvisionedDatabase,
} from '../../src/testing/provision';

/**
 * Row Level Security and the schema invariants for the Phase 3 flow tables
 * (blueprint 6.2, 17.4, 21.3, 21.4; v2.1.6 §30.9).
 *
 * Raw SQL as `app_user`, with no ORM and no repository in the way: the point is
 * what the **database** does when the guard rails above it are absent. Every
 * case of 17.4 is exercised on every new table, and every constraint that
 * decides money has a test that proves it rejects the bad row.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FK_VIOLATION = '23503';
const NOT_NULL_VIOLATION = '23502';
const INVALID_ENUM = '22P02';
const INSUFFICIENT_PRIVILEGE = '42501';

const CASH_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const CASH_B = 'bbbbbbbb-0000-4000-8000-000000000001';
const ASSET_A = 'aaaaaaaa-0000-4000-8000-000000000002';
const CATEGORY_A = 'aaaaaaaa-0000-4000-8000-000000000003';
const CATEGORY_B = 'bbbbbbbb-0000-4000-8000-000000000003';
const TEMPLATE_A = 'aaaaaaaa-0000-4000-8000-000000000004';
const TEMPLATE_B = 'bbbbbbbb-0000-4000-8000-000000000004';
const TRANSFER_A = 'aaaaaaaa-0000-4000-8000-000000000005';

let db: ProvisionedDatabase;
let owner: pg.Client;
let user: pg.Client;
let backup: pg.Client;

async function setGuc(client: pg.Client, value: string | null): Promise<void> {
  await client.query(`SELECT set_config('app.current_user_id', $1, false)`, [value]);
}

async function countAs(client: pg.Client, table: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(rows[0]?.n ?? '0');
}

async function seed(): Promise<void> {
  for (const [userId, cashId, categoryId, templateId] of [
    [USER_A, CASH_A, CATEGORY_A, TEMPLATE_A],
    [USER_B, CASH_B, CATEGORY_B, TEMPLATE_B],
  ] as const) {
    await owner.query(
      `INSERT INTO positions (id, user_id, kind, name, currency)
       VALUES ($1, $2, 'cash', 'Probe cash', 'EUR')`,
      [cashId, userId],
    );
    await owner.query(
      `INSERT INTO cash_accounts (position_id, user_id, account_type)
       VALUES ($1, $2, 'checking')`,
      [cashId, userId],
    );
    await owner.query(
      `INSERT INTO categories (id, user_id, kind, name) VALUES ($1, $2, 'food', 'Groceries')`,
      [categoryId, userId],
    );
    await owner.query(
      `INSERT INTO recurring_templates
         (id, user_id, kind, name, income_kind, currency, frequency, day_of_month, start_date,
          cash_position_id, cash_position_kind)
       VALUES ($1, $2, 'income', 'Salary', 'employment', 'EUR', 'monthly', 25, DATE '2026-01-01',
               $3, 'cash')`,
      [templateId, userId, cashId],
    );
    await owner.query(
      `INSERT INTO recurring_template_terms (user_id, template_id, effective_from, amount)
       VALUES ($1, $2, DATE '2026-01-01', 2100)`,
      [userId, templateId],
    );
    await owner.query(
      `INSERT INTO recurring_template_skips (user_id, template_id, occurrence_date, reason)
       VALUES ($1, $2, DATE '2026-03-25', 'skipped')`,
      [userId, templateId],
    );
    await owner.query(
      `INSERT INTO income_entries
         (user_id, template_id, occurrence_date, kind, received_on, net_amount, currency,
          settlement, cash_position_id, cash_position_kind)
       VALUES ($1, $2, DATE '2026-02-25', 'employment', DATE '2026-02-25', 2100, 'EUR',
               'tracked_cash', $3, 'cash')`,
      [userId, templateId, cashId],
    );
    await owner.query(
      `INSERT INTO expense_entries
         (user_id, category_id, incurred_on, amount, currency, settlement,
          cash_position_id, cash_position_kind)
       VALUES ($1, $2, DATE '2026-02-12', 300, 'EUR', 'tracked_cash', $3, 'cash')`,
      [userId, categoryId, cashId],
    );
    await owner.query(
      `INSERT INTO month_reviews (user_id, month) VALUES ($1, DATE '2026-02-01')`,
      [userId],
    );
  }

  // One more cash account and a transfer, for user A only.
  await owner.query(
    `INSERT INTO positions (id, user_id, kind, name, currency)
     VALUES ($1, $2, 'cash', 'Savings', 'EUR')`,
    [ASSET_A, USER_A],
  );
  await owner.query(
    `INSERT INTO cash_accounts (position_id, user_id, account_type)
     VALUES ($1, $2, 'savings')`,
    [ASSET_A, USER_A],
  );
  await owner.query(
    `INSERT INTO transfers
       (id, user_id, kind, occurred_on, from_position_id, from_currency, from_amount,
        to_position_id, to_currency, to_amount)
     VALUES ($1, $2, 'cash_transfer', DATE '2026-02-05', $3, 'EUR', 200, $4, 'EUR', 200)`,
    [TRANSFER_A, USER_A, CASH_A, ASSET_A],
  );
  await owner.query(
    `INSERT INTO transfers
       (user_id, kind, occurred_on, from_position_id, from_currency, from_amount,
        to_position_id, to_currency, to_amount)
     VALUES ($1, 'cash_transfer', DATE '2026-02-06', $2, 'EUR', 50, NULL, 'EUR', 50)`,
    [USER_B, CASH_B],
  );
}

async function clear(): Promise<void> {
  await owner.query('DELETE FROM expense_entries');
  await owner.query('DELETE FROM transfers');
  await owner.query('DELETE FROM income_entries');
  await owner.query('DELETE FROM recurring_template_skips');
  await owner.query('DELETE FROM recurring_template_terms');
  await owner.query('DELETE FROM recurring_templates');
  await owner.query('DELETE FROM month_reviews');
  await owner.query('DELETE FROM audit_entries');
  await owner.query('DELETE FROM position_valuations');
  await owner.query('DELETE FROM cash_accounts');
  await owner.query('DELETE FROM other_assets');
  await owner.query('DELETE FROM categories');
  await owner.query('DELETE FROM positions');
}

beforeAll(async () => {
  db = await provisionDatabase({});
  owner = await connect(db.ownerUrl);
  user = await connect(db.userUrl);
  backup = await connect(db.backupUrl);

  for (const [id, email] of [
    [USER_A, 'a@example.test'],
    [USER_B, 'b@example.test'],
  ] as const) {
    await owner.query(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $2, true)`,
      [id, email],
    );
  }
}, 180_000);

afterAll(async () => {
  await Promise.allSettled([owner?.end(), user?.end(), backup?.end()]);
  if (db) await dropDatabase(adminUrl(), db.databaseName);
});

beforeEach(async () => {
  await clear();
  await seed();
});

const PHASE_3_TABLES = [
  'recurring_templates',
  'recurring_template_terms',
  'recurring_template_skips',
  'income_entries',
  'expense_entries',
  'month_reviews',
] as const;

/** One forged insert per table, claiming a given owner. */
const FORGED: Record<string, (userId: string) => string> = {
  recurring_templates: (userId) =>
    `INSERT INTO recurring_templates (user_id, kind, name, income_kind, currency, frequency, start_date)
     VALUES ('${userId}', 'income', 'Forged', 'other', 'EUR', 'monthly', DATE '2026-01-01')`,
  recurring_template_terms: (userId) =>
    `INSERT INTO recurring_template_terms (user_id, template_id, effective_from, amount)
     VALUES ('${userId}', '${userId === USER_A ? TEMPLATE_A : TEMPLATE_B}', DATE '2026-06-01', 1)`,
  recurring_template_skips: (userId) =>
    `INSERT INTO recurring_template_skips (user_id, template_id, occurrence_date, reason)
     VALUES ('${userId}', '${userId === USER_A ? TEMPLATE_A : TEMPLATE_B}', DATE '2026-06-25', 'other')`,
  income_entries: (userId) =>
    `INSERT INTO income_entries (user_id, kind, received_on, net_amount, currency)
     VALUES ('${userId}', 'other', DATE '2026-06-01', 10, 'EUR')`,
  expense_entries: (userId) =>
    `INSERT INTO expense_entries (user_id, category_id, incurred_on, amount, currency)
     VALUES ('${userId}', '${userId === USER_A ? CATEGORY_A : CATEGORY_B}', DATE '2026-06-01', 10, 'EUR')`,
  transfers: (userId) =>
    `INSERT INTO transfers (user_id, kind, occurred_on, from_position_id, from_currency, from_amount, to_currency, to_amount)
     VALUES ('${userId}', 'cash_transfer', DATE '2026-06-01', '${userId === USER_A ? CASH_A : CASH_B}', 'EUR', 10, 'EUR', 10)`,
  month_reviews: (userId) =>
    `INSERT INTO month_reviews (user_id, month) VALUES ('${userId}', DATE '2026-07-01')`,
};

describe.each([...PHASE_3_TABLES, 'transfers'] as const)('RLS on %s', (name) => {
  it('returns nothing, without erroring, when the setting was never set', async () => {
    await setGuc(user, null);
    expect(await countAs(user, name)).toBe(0);
  });

  it('returns nothing, without erroring, when the setting is empty', async () => {
    // A pooler can reset a GUC to the empty string; `NULLIF` turns that into
    // NULL so the policy denies rather than raising a cast error.
    await setGuc(user, '');
    expect(await countAs(user, name)).toBe(0);
  });

  it('shows exactly one tenant’s rows', async () => {
    await setGuc(user, USER_A);
    const a = await user.query<{ user_id: string }>(`SELECT user_id FROM ${name}`);
    expect(a.rows.length).toBeGreaterThan(0);
    expect(a.rows.every((row) => row.user_id === USER_A)).toBe(true);

    await setGuc(user, USER_B);
    const b = await user.query<{ user_id: string }>(`SELECT user_id FROM ${name}`);
    expect(b.rows.length).toBeGreaterThan(0);
    expect(b.rows.every((row) => row.user_id === USER_B)).toBe(true);
  });

  it('refuses a row forged into another tenant', async () => {
    await setGuc(user, USER_A);
    expect(await errorCodeOf(user, FORGED[name]?.(USER_B) as string)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('lets the backup role read across tenants but never write', async () => {
    expect(await countAs(backup, name)).toBeGreaterThan(1);
    expect(await errorCodeOf(backup, FORGED[name]?.(USER_A) as string)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('does not let the runtime role disable its own policy', async () => {
    expect(await errorCodeOf(user, `ALTER TABLE ${name} DISABLE ROW LEVEL SECURITY`)).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe('the occurrence pair is all or nothing', () => {
  it('accepts a manual flow carrying neither half', async () => {
    expect(await errorCodeOf(owner, `INSERT INTO income_entries (user_id, kind, received_on, net_amount, currency)
         VALUES ($1, 'other', DATE '2026-04-01', 10, 'EUR')`, [USER_A])).toBeNull();
  });

  it('accepts a materialized occurrence carrying both halves', async () => {
    expect(await errorCodeOf(owner, `INSERT INTO income_entries
           (user_id, template_id, occurrence_date, kind, received_on, net_amount, currency)
         VALUES ($1, $2, DATE '2026-04-25', 'employment', DATE '2026-04-25', 2100, 'EUR')`,
        [USER_A, TEMPLATE_A],
      ),
    ).toBeNull();
  });

  it.each(['income_entries', 'expense_entries', 'transfers'] as const)(
    'refuses a template with no occurrence on %s',
    async (table) => {
      const sql =
        table === 'income_entries'
          ? `INSERT INTO income_entries (user_id, template_id, kind, received_on, net_amount, currency)
             VALUES ($1, $2, 'employment', DATE '2026-04-25', 1, 'EUR')`
          : table === 'expense_entries'
            ? `INSERT INTO expense_entries (user_id, template_id, category_id, incurred_on, amount, currency)
               VALUES ($1, $2, '${CATEGORY_A}', DATE '2026-04-25', 1, 'EUR')`
            : `INSERT INTO transfers (user_id, template_id, kind, occurred_on, from_position_id, from_currency, from_amount, to_currency, to_amount)
               VALUES ($1, $2, 'cash_transfer', DATE '2026-04-25', '${CASH_A}', 'EUR', 1, 'EUR', 1)`;

      expect(await errorCodeOf(owner, sql, [USER_A, TEMPLATE_A])).toBe(CHECK_VIOLATION);
    },
  );

  it.each(['income_entries', 'expense_entries', 'transfers'] as const)(
    'refuses an occurrence with no template on %s',
    async (table) => {
      const sql =
        table === 'income_entries'
          ? `INSERT INTO income_entries (user_id, occurrence_date, kind, received_on, net_amount, currency)
             VALUES ($1, DATE '2026-04-25', 'employment', DATE '2026-04-25', 1, 'EUR')`
          : table === 'expense_entries'
            ? `INSERT INTO expense_entries (user_id, occurrence_date, category_id, incurred_on, amount, currency)
               VALUES ($1, DATE '2026-04-25', '${CATEGORY_A}', DATE '2026-04-25', 1, 'EUR')`
            : `INSERT INTO transfers (user_id, occurrence_date, kind, occurred_on, from_position_id, from_currency, from_amount, to_currency, to_amount)
               VALUES ($1, DATE '2026-04-25', 'cash_transfer', DATE '2026-04-25', '${CASH_A}', 'EUR', 1, 'EUR', 1)`;

      expect(await errorCodeOf(owner, sql, [USER_A])).toBe(CHECK_VIOLATION);
    },
  );

  it('refuses a second acceptance of one occurrence', async () => {
    // The seed already holds the 25 Feb occurrence of template A.
    expect(await errorCodeOf(owner, `INSERT INTO income_entries
           (user_id, template_id, occurrence_date, kind, received_on, net_amount, currency)
         VALUES ($1, $2, DATE '2026-02-25', 'employment', DATE '2026-02-26', 2100, 'EUR')`, [USER_A, TEMPLATE_A])).toBe(UNIQUE_VIOLATION);
  });

  it('does not accidentally make manual rows unique', async () => {
    // The index is partial, so the many rows carrying neither column are not
    // constrained against each other.
    for (let i = 0; i < 3; i += 1) {
      await owner.query(
        `INSERT INTO income_entries (user_id, kind, received_on, net_amount, currency)
         VALUES ($1, 'other', DATE '2026-05-01', 10, 'EUR')`,
        [USER_A],
      );
    }
    await setGuc(user, USER_A);
    expect(await countAs(user, 'income_entries')).toBe(4);
  });

  it('lets two different templates share an occurrence date', async () => {
    await owner.query(
      `INSERT INTO recurring_templates
         (id, user_id, kind, name, income_kind, currency, frequency, day_of_month, start_date)
       VALUES ('aaaaaaaa-0000-4000-8000-00000000000a', $1, 'income', 'Rent', 'rental', 'EUR',
               'monthly', 25, DATE '2026-01-01')`,
      [USER_A],
    );
    expect(await errorCodeOf(owner, `INSERT INTO income_entries
           (user_id, template_id, occurrence_date, kind, received_on, net_amount, currency)
         VALUES ($1, 'aaaaaaaa-0000-4000-8000-00000000000a', DATE '2026-02-25', 'rental',
                 DATE '2026-02-25', 900, 'EUR')`, [USER_A])).toBeNull();
  });
});

describe('composite tenant ownership', () => {
  it('refuses a flow pointing at another tenant’s template', async () => {
    expect(await errorCodeOf(owner, `INSERT INTO income_entries
           (user_id, template_id, occurrence_date, kind, received_on, net_amount, currency)
         VALUES ($1, $2, DATE '2026-04-25', 'employment', DATE '2026-04-25', 1, 'EUR')`, [USER_A, TEMPLATE_B])).toBe(FK_VIOLATION);
  });

  it('refuses an expense pointing at another tenant’s category', async () => {
    expect(await errorCodeOf(owner, `INSERT INTO expense_entries (user_id, category_id, incurred_on, amount, currency)
         VALUES ($1, $2, DATE '2026-04-01', 10, 'EUR')`,
        [USER_A, CATEGORY_B])).toBe(FK_VIOLATION);
  });

  it('refuses a transfer pointing at another tenant’s account', async () => {
    expect(await errorCodeOf(owner, `INSERT INTO transfers
           (user_id, kind, occurred_on, from_position_id, from_currency, from_amount, to_currency, to_amount)
         VALUES ($1, 'cash_transfer', DATE '2026-04-01', $2, 'EUR', 10, 'EUR', 10)`,
        [USER_A, CASH_B])).toBe(FK_VIOLATION);
  });

  it('refuses a fee pointing at another tenant’s transfer', async () => {
    expect(await errorCodeOf(owner, `INSERT INTO expense_entries
           (user_id, category_id, incurred_on, amount, currency, transfer_id)
         VALUES ($1, $2, DATE '2026-02-05', 3, 'EUR', $3)`,
        [USER_B, CATEGORY_B, TRANSFER_A])).toBe(FK_VIOLATION);
  });
});

describe('typed position references', () => {
  it('refuses a cash reference that points at a non-cash position', async () => {
    await owner.query(
      `INSERT INTO positions (id, user_id, kind, name, currency)
       VALUES ('aaaaaaaa-0000-4000-8000-0000000000ff', $1, 'other_asset', 'Car', 'EUR')`,
      [USER_A],
    );
    expect(await errorCodeOf(owner, `INSERT INTO income_entries
           (user_id, kind, received_on, net_amount, currency, cash_position_id, cash_position_kind)
         VALUES ($1, 'other', DATE '2026-04-01', 10, 'EUR',
                 'aaaaaaaa-0000-4000-8000-0000000000ff', 'cash')`,
        [USER_A])).toBe(FK_VIOLATION);
  });

  it('refuses a kind column that disagrees with the reference it guards', async () => {
    expect(await errorCodeOf(owner, `INSERT INTO income_entries
           (user_id, kind, received_on, net_amount, currency, cash_position_id, cash_position_kind)
         VALUES ($1, 'other', DATE '2026-04-01', 10, 'EUR', $2, 'property')`,
        [USER_A, CASH_A])).toBe(CHECK_VIOLATION);
  });

  it('refuses an id with no kind, which MATCH SIMPLE would otherwise wave through', async () => {
    // This is the case the shape CHECK exists for: a multi-column foreign key
    // is satisfied whenever any referencing column is NULL, so an id with a
    // NULL kind would reference nothing and be accepted.
    expect(await errorCodeOf(owner, `INSERT INTO income_entries
           (user_id, kind, received_on, net_amount, currency, cash_position_id)
         VALUES ($1, 'other', DATE '2026-04-01', 10, 'EUR', $2)`,
        [USER_A, CASH_A])).toBe(CHECK_VIOLATION);
  });

  it('accepts both columns NULL', async () => {
    expect(await errorCodeOf(owner, `INSERT INTO income_entries (user_id, kind, received_on, net_amount, currency, settlement)
         VALUES ($1, 'other', DATE '2026-04-01', 10, 'EUR', 'external')`, [USER_A])).toBeNull();
  });
});

describe('the constraints that decide money', () => {
  it('refuses a same-currency transfer whose amounts differ (M13)', async () => {
    expect(
      await errorCodeOf(
        owner,
        `INSERT INTO transfers
           (user_id, kind, occurred_on, from_position_id, from_currency, from_amount,
            to_position_id, to_currency, to_amount)
         VALUES ($1, 'cash_transfer', DATE '2026-04-01', $2, 'EUR', 200, $3, 'EUR', 190)`,
        [USER_A, CASH_A, ASSET_A],
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('accepts a cross-currency transfer with two different amounts', async () => {
    await owner.query(
      `INSERT INTO positions (id, user_id, kind, name, currency)
       VALUES ('aaaaaaaa-0000-4000-8000-0000000000ee', $1, 'cash', 'USD account', 'USD')`,
      [USER_A],
    );
    await owner.query(
      `INSERT INTO cash_accounts (position_id, user_id, account_type)
       VALUES ('aaaaaaaa-0000-4000-8000-0000000000ee', $1, 'checking')`,
      [USER_A],
    );
    expect(await errorCodeOf(owner, `INSERT INTO transfers
           (user_id, kind, occurred_on, from_position_id, from_currency, from_amount,
            to_position_id, to_currency, to_amount)
         VALUES ($1, 'cash_transfer', DATE '2026-04-01', $2, 'EUR', 200,
                 'aaaaaaaa-0000-4000-8000-0000000000ee', 'USD', 216.45)`, [USER_A, CASH_A])).toBeNull();
  });

  it('refuses a transfer with the same account on both sides', async () => {
    expect(await errorCodeOf(owner, `INSERT INTO transfers
           (user_id, kind, occurred_on, from_position_id, from_currency, from_amount,
            to_position_id, to_currency, to_amount)
         VALUES ($1, 'cash_transfer', DATE '2026-04-01', $2, 'EUR', 10, $2, 'EUR', 10)`, [USER_A, CASH_A])).toBe(CHECK_VIOLATION);
  });

  it('refuses a transfer with no endpoint at all', async () => {
    expect(await errorCodeOf(owner, `INSERT INTO transfers
           (user_id, kind, occurred_on, from_currency, from_amount, to_currency, to_amount)
         VALUES ($1, 'cash_transfer', DATE '2026-04-01', 'EUR', 10, 'EUR', 10)`,
        [USER_A])).toBe(CHECK_VIOLATION);
  });

  it('refuses a non-tracked settlement that carries a cash position', async () => {
    // 6.2: an untracked expense never touched a tracked account, so a cash leg
    // on it would put somebody else's money into the reconciliation identity.
    expect(await errorCodeOf(owner, `INSERT INTO expense_entries
           (user_id, category_id, incurred_on, amount, currency, settlement,
            cash_position_id, cash_position_kind)
         VALUES ($1, $2, DATE '2026-04-01', 10, 'EUR', 'third_party', $3, 'cash')`,
        [USER_A, CATEGORY_A, CASH_A])).toBe(CHECK_VIOLATION);
  });

  it('refuses a reinvested income that is not an investment distribution', async () => {
    expect(await errorCodeOf(owner, `INSERT INTO income_entries (user_id, kind, received_on, net_amount, currency, settlement)
         VALUES ($1, 'employment', DATE '2026-04-01', 10, 'EUR', 'reinvested')`,
        [USER_A])).toBe(CHECK_VIOLATION);
  });

  it('refuses a zero or negative expense', async () => {
    for (const amount of ['0', '-5']) {
      expect(await errorCodeOf(owner, `INSERT INTO expense_entries (user_id, category_id, incurred_on, amount, currency)
           VALUES ($1, $2, DATE '2026-04-01', ${amount}, 'EUR')`,
          [USER_A, CATEGORY_A])).toBe(CHECK_VIOLATION);
    }
  });

  it('refuses a negative income amount', async () => {
    expect(await errorCodeOf(owner, `INSERT INTO income_entries (user_id, kind, received_on, net_amount, currency)
         VALUES ($1, 'other', DATE '2026-04-01', -1, 'EUR')`,
        [USER_A])).toBe(CHECK_VIOLATION);
  });

  it('refuses a template whose income kind contradicts its kind', async () => {
    expect(await errorCodeOf(owner, `INSERT INTO recurring_templates
           (user_id, kind, name, currency, frequency, start_date)
         VALUES ($1, 'income', 'No kind', 'EUR', 'monthly', DATE '2026-01-01')`,
        [USER_A])).toBe(CHECK_VIOLATION);
  });

  it('refuses a template that schedules an external inflow or an adjustment', async () => {
    for (const kind of ['external_inflow', 'adjustment']) {
      expect(await errorCodeOf(owner, `INSERT INTO recurring_templates
             (user_id, kind, name, income_kind, currency, frequency, start_date)
           VALUES ($1, 'income', 'Bad', '${kind}', 'EUR', 'monthly', DATE '2026-01-01')`,
          [USER_A])).toBe(CHECK_VIOLATION);
    }
  });

  it('refuses an expense template with no category', async () => {
    expect(await errorCodeOf(owner, `INSERT INTO recurring_templates (user_id, kind, name, currency, frequency, start_date)
         VALUES ($1, 'expense', 'Rent', 'EUR', 'monthly', DATE '2026-01-01')`,
        [USER_A])).toBe(CHECK_VIOLATION);
  });

  it('refuses a day_of_month outside 1..31', async () => {
    for (const day of ['0', '32']) {
      expect(await errorCodeOf(owner, `INSERT INTO recurring_templates
             (user_id, kind, name, income_kind, currency, frequency, day_of_month, start_date)
           VALUES ($1, 'income', 'Bad day', 'other', 'EUR', 'monthly', ${day}, DATE '2026-01-01')`,
          [USER_A])).toBe(CHECK_VIOLATION);
    }
  });

  it('refuses a month review not dated the first of its month', async () => {
    expect(await errorCodeOf(owner, `INSERT INTO month_reviews (user_id, month) VALUES ($1, DATE '2026-05-15')`, [
        USER_A,
      ])).toBe(CHECK_VIOLATION);
  });
});

describe('uniqueness', () => {
  it('allows one term per template and effective date', async () => {
    expect(await errorCodeOf(owner, `INSERT INTO recurring_template_terms (user_id, template_id, effective_from, amount)
         VALUES ($1, $2, DATE '2026-01-01', 9)`,
        [USER_A, TEMPLATE_A])).toBe(UNIQUE_VIOLATION);
  });

  it('allows one skip per template occurrence', async () => {
    expect(await errorCodeOf(owner, `INSERT INTO recurring_template_skips (user_id, template_id, occurrence_date, reason)
         VALUES ($1, $2, DATE '2026-03-25', 'vacant')`,
        [USER_A, TEMPLATE_A])).toBe(UNIQUE_VIOLATION);
  });

  it('allows one month review per month', async () => {
    expect(await errorCodeOf(owner, `INSERT INTO month_reviews (user_id, month) VALUES ($1, DATE '2026-02-01')`, [
        USER_A,
      ])).toBe(UNIQUE_VIOLATION);
  });
});

describe('required columns and closed sets', () => {
  const REQUIRED: Record<string, string[]> = {
    recurring_templates: ['kind', 'name', 'currency', 'frequency', 'start_date'],
    recurring_template_terms: ['template_id', 'effective_from', 'amount'],
    recurring_template_skips: ['template_id', 'occurrence_date', 'reason'],
    income_entries: ['kind', 'received_on', 'net_amount', 'currency', 'settlement'],
    expense_entries: ['category_id', 'incurred_on', 'amount', 'currency', 'settlement'],
    transfers: ['kind', 'occurred_on', 'from_currency', 'from_amount', 'to_currency', 'to_amount'],
    month_reviews: ['month'],
  };

  it('marks every column 6.2 requires as NOT NULL', async () => {
    for (const [table, columns] of Object.entries(REQUIRED)) {
      const { rows } = await owner.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_name = $1 AND column_name = ANY($2)`,
        [table, columns],
      );
      expect(rows.length, table).toBe(columns.length);
      for (const row of rows) {
        expect(row.is_nullable, `${table}.${row.column_name}`).toBe('NO');
      }
    }
  });

  it('rejects a NULL in a required column', async () => {
    expect(await errorCodeOf(owner, `INSERT INTO income_entries (user_id, kind, received_on, net_amount, currency)
         VALUES ($1, 'other', NULL, 10, 'EUR')`,
        [USER_A])).toBe(NOT_NULL_VIOLATION);
  });

  it('rejects a value outside a closed set', async () => {
    expect(await errorCodeOf(owner, `INSERT INTO income_entries (user_id, kind, received_on, net_amount, currency, settlement)
         VALUES ($1, 'other', DATE '2026-04-01', 10, 'EUR', 'wishful')`,
        [USER_A])).toBe(INVALID_ENUM);
  });

  it('rejects an unknown skip reason', async () => {
    expect(await errorCodeOf(owner, `INSERT INTO recurring_template_skips (user_id, template_id, occurrence_date, reason)
         VALUES ($1, $2, DATE '2026-07-25', 'because')`,
        [USER_A, TEMPLATE_A])).toBe(INVALID_ENUM);
  });
});

describe('delete behaviour', () => {
  it('refuses to delete a template a materialized flow still points at', async () => {
    // v2.1.6 §30.9 item 4: accepted history keeps its template identity, so the
    // foreign key is NO ACTION and archiving is how a source is retired.
    expect(await errorCodeOf(owner, `DELETE FROM recurring_templates WHERE id = $1`, [TEMPLATE_A])).toBe(FK_VIOLATION);
  });

  it('lets an unreferenced template go, taking its terms and skips with it', async () => {
    await owner.query(`DELETE FROM income_entries WHERE template_id = $1`, [TEMPLATE_A]);
    await owner.query(`DELETE FROM recurring_templates WHERE id = $1`, [TEMPLATE_A]);

    const terms = await owner.query(
      `SELECT 1 FROM recurring_template_terms WHERE template_id = $1`,
      [TEMPLATE_A],
    );
    const skips = await owner.query(
      `SELECT 1 FROM recurring_template_skips WHERE template_id = $1`,
      [TEMPLATE_A],
    );
    expect(terms.rows).toHaveLength(0);
    expect(skips.rows).toHaveLength(0);
  });

  it('archives a referenced template instead, keeping every row', async () => {
    await owner.query(`UPDATE recurring_templates SET archived_at = now() WHERE id = $1`, [
      TEMPLATE_A,
    ]);
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM income_entries WHERE template_id = $1`,
      [TEMPLATE_A],
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('cascades a transfer’s fee as a structural safeguard', async () => {
    // The ordinary product path deletes the fee first, with its own audit
    // before-image; this proves the constraint is still there for account
    // deletion, where the audit rows go in the same cascade (6.3, 18.1).
    await owner.query(
      `INSERT INTO expense_entries
         (user_id, category_id, incurred_on, amount, currency, transfer_id,
          cash_position_id, cash_position_kind)
       VALUES ($1, $2, DATE '2026-02-05', 3, 'EUR', $3, $4, 'cash')`,
      [USER_A, CATEGORY_A, TRANSFER_A, CASH_A],
    );
    await owner.query(`DELETE FROM transfers WHERE id = $1`, [TRANSFER_A]);
    const { rows } = await owner.query(`SELECT 1 FROM expense_entries WHERE transfer_id = $1`, [
      TRANSFER_A,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('refuses to delete a category an expense still points at', async () => {
    expect(await errorCodeOf(owner, `DELETE FROM categories WHERE id = $1`, [CATEGORY_A])).toBe(FK_VIOLATION);
  });

  it('removes every Phase 3 row when the account is deleted', async () => {
    await owner.query(`DELETE FROM "user" WHERE id = $1`, [USER_A]);

    for (const table of [...PHASE_3_TABLES, 'transfers']) {
      const { rows } = await owner.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table} WHERE user_id = $1`,
        [USER_A],
      );
      expect(rows[0]?.n, table).toBe('0');
    }

    // Re-created for the next test by `beforeEach`; the other tenant is intact.
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM income_entries WHERE user_id = $1`,
      [USER_B],
    );
    expect(rows[0]?.n).toBe('1');
    await owner.query(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $2, true)`,
      [USER_A, 'a@example.test'],
    );
  });
});

describe('optimistic concurrency and timestamps', () => {
  it('starts every versioned Phase 3 row at 1', async () => {
    for (const table of PHASE_3_TABLES) {
      const { rows } = await owner.query<{ version: number }>(
        `SELECT version FROM ${table} WHERE user_id = $1 LIMIT 1`,
        [USER_A],
      );
      expect(rows[0]?.version, table).toBe(1);
    }
  });

  it('maintains updated_at by trigger, not by the client', async () => {
    const before = await owner.query<{ updated_at: Date }>(
      `SELECT updated_at FROM income_entries WHERE user_id = $1 LIMIT 1`,
      [USER_A],
    );
    await owner.query(
      `UPDATE income_entries SET net_amount = 2200, updated_at = TIMESTAMPTZ '2000-01-01 00:00:00Z'
        WHERE user_id = $1`,
      [USER_A],
    );
    const after = await owner.query<{ updated_at: Date }>(
      `SELECT updated_at FROM income_entries WHERE user_id = $1 LIMIT 1`,
      [USER_A],
    );
    expect(after.rows[0]?.updated_at.getTime()).toBeGreaterThan(
      before.rows[0]?.updated_at.getTime() ?? 0,
    );
  });
});

describe('the schema still contains no moving clock', () => {
  it('has no CHECK on a Phase 3 table referencing now() or current_date', async () => {
    // 6.1: a constraint that reads the present would change its verdict on a
    // row that never changed, and would make a restored backup unrestorable.
    const { rows } = await owner.query<{ conname: string; def: string }>(
      `SELECT c.conname, pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE c.contype = 'c' AND t.relname = ANY($1)`,
      [[...PHASE_3_TABLES, 'transfers']],
    );

    expect(rows.length).toBeGreaterThan(0);
    const moving = rows.filter((row) =>
      /now\(\)|current_date|current_timestamp|localtimestamp|statement_timestamp|clock_timestamp/iu.test(
        row.def,
      ),
    );
    expect(moving.map((row) => row.conname)).toEqual([]);
  });
});

describe('the runtime role stays inside its box', () => {
  it('cannot create a table', async () => {
    await setGuc(user, USER_A);
    expect(await errorCodeOf(user, 'CREATE TABLE probe_phase3 (id int)')).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('cannot alter a Phase 3 table', async () => {
    await setGuc(user, USER_A);
    expect(await errorCodeOf(user, 'ALTER TABLE income_entries ADD COLUMN probe int')).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('is not allowed to bypass row level security', async () => {
    const { rows } = await owner.query<{ rolbypassrls: boolean }>(
      `SELECT rolbypassrls FROM pg_roles WHERE rolname = 'app_user'`,
    );
    expect(rows[0]?.rolbypassrls).toBe(false);
  });
});
