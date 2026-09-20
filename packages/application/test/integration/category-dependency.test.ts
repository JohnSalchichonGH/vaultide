import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, withUser, withoutUser } from '@vaultide/db';
import { createHarness, type Harness } from '../helpers/harness';
import { testContext, type RequestContext } from '../../src/context';
import { withUserWrite } from '../../src/coordination';
import { provisionUser } from '../../src/users/provisioning';
import { archiveUserCategory, createCategory, listCategories } from '../../src/users/categories';
import { createCashAccount } from '../../src/positions/service';
import { recordValuation } from '../../src/positions/valuations';
import {
  createExpenseEntry,
  requireLiveCategoryIn,
  updateExpenseEntry,
} from '../../src/flows/expenses';
import { createTemplate } from '../../src/recurring/templates';
import { acceptSuggestion } from '../../src/recurring/suggestions';
import { getMonthReconciliation, parseMonth } from '../../src/reconciliation/service';

/**
 * `categories.archived_at` as a **reference dependency**, against a real
 * PostgreSQL (blueprint 20.3, 30.22 items 8 and 9; ADR 0010 §9).
 *
 * A category decides whether a financial write is *allowed*; it does not
 * reinterpret history. So it is not on the per-user financial mutex — category
 * administration stays an ordinary, non-financial write — and the financial
 * transaction instead holds the row it chose under `SELECT … FOR SHARE` until
 * it commits.
 *
 * Both orderings are exercised with two real connections, because what makes
 * this correct is what PostgreSQL does when they meet, not what the code says.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';

let harness: Harness;

const on = (today: string, userId = USER_A): RequestContext =>
  testContext({ today, userId, reportingCurrency: 'EUR' });

const SEPT_15 = on('2026-09-15');
const OCT_1 = on('2026-10-01');

const flowDeps = () => harness.services.flows;
const readDeps = () => ({ db: harness.db, fx: harness.services.fx });

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function createAuthUser(id: string, email: string): Promise<void> {
  await withoutUser(harness.db, async (tx) => {
    await tx.execute(
      sql`INSERT INTO "user" (id, name, email, email_verified)
          VALUES (${id}, ${email}, ${email}, true)
          ON CONFLICT (id) DO NOTHING`,
    );
  });
}

async function categoryNamed(name: string): Promise<string> {
  const category = await createCategory(harness.db, USER_A, { kind: 'food', name });
  return category.id;
}

async function isArchived(categoryId: string): Promise<boolean> {
  const rows = await listCategories(harness.db, USER_A, { includeArchived: true });
  return rows.find((row) => row.id === categoryId)?.archived === true;
}

async function expenseCount(): Promise<number> {
  const rows = await withUser(harness.db, { userId: USER_A }, async (tx) =>
    tx.execute(sql`SELECT count(*)::text AS n FROM expense_entries`),
  );
  return Number((rows.rows[0] as { n: string }).n);
}

let bbva: string;

beforeAll(async () => {
  harness = await createHarness();
  await createAuthUser(USER_A, 'a@example.test');
  await provisionUser(harness.db, { userId: USER_A });

  const account = await createCashAccount(harness.services.positions, SEPT_15, {
    name: 'BBVA',
    currency: 'EUR',
    accountType: 'checking',
    openedOn: null,
  });
  bbva = account.id;
}, 240_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.asOwner('DELETE FROM expense_entries WHERE user_id = $1', [USER_A]);
});

describe('a financial write holds the category it chose (30.22 item 8)', () => {
  it('makes an archive wait until the expense that chose it has committed', async () => {
    const categoryId = await categoryNamed('Groceries — financial first');
    const entered = deferred();
    const release = deferred();

    // The financial transaction, in the order the invariant states: the mutex,
    // then the reference-dependency lock, then the write.
    const financial = withUserWrite(harness.db, { userId: USER_A }, async (tx) => {
      await requireLiveCategoryIn(tx, categoryId);
      entered.resolve();
      await release.promise;
      await tx.execute(
        sql`INSERT INTO expense_entries
              (user_id, category_id, incurred_on, amount, currency, settlement,
               cash_position_id, cash_position_kind)
            VALUES (${USER_A}, ${categoryId}, DATE '2026-09-12', 40, 'EUR', 'tracked_cash',
                    ${bbva}, 'cash')`,
      );
    });

    let archived: Promise<unknown> | undefined;
    let archiveFinished = false;
    try {
      await entered.promise;

      archived = archiveUserCategory(harness.db, USER_A, categoryId).then((row) => {
        archiveFinished = true;
        return row;
      });

      await delay(250);
      // `FOR SHARE` conflicts with the archive's `UPDATE`, so it waits.
      expect(archiveFinished).toBe(false);
      expect(await isArchived(categoryId)).toBe(false);
    } finally {
      release.resolve();
    }

    await financial;
    await archived;

    // The expense that was accepted against a live category is recorded, and
    // the archive then proceeds.
    expect(await expenseCount()).toBe(1);
    expect(await isArchived(categoryId)).toBe(true);
  });

  it('refuses the financial write when the archive got there first', async () => {
    const categoryId = await categoryNamed('Groceries — archive first');
    const holding = deferred();
    const release = deferred();

    // The archive's own `UPDATE`, held open on its own connection.
    const archive = withUser(harness.db, { userId: USER_A }, async (tx) => {
      await tx.execute(
        sql`UPDATE categories SET archived_at = now() WHERE id = ${categoryId}`,
      );
      holding.resolve();
      await release.promise;
    });

    let refusal: unknown;
    try {
      await holding.promise;

      const financial = createExpenseEntry(flowDeps(), SEPT_15, {
        categoryId,
        incurredOn: '2026-09-12',
        amount: '40.00',
        currency: 'EUR',
        settlement: 'tracked_cash',
        cashPositionId: bbva,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      await delay(150);
      release.resolve();
      refusal = await financial;
    } finally {
      release.resolve();
      await archive;
    }

    // Under read committed the locking read re-reads after the archive commits,
    // and sees the archived row.
    expect(refusal).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await expenseCount()).toBe(0);
    expect(await isArchived(categoryId)).toBe(true);
  });

  it('does not put category administration on the financial mutex', async () => {
    const categoryId = await categoryNamed('Groceries — no mutex');
    const entered = deferred();
    const release = deferred();

    // A financial write that touches no category at all.
    const financial = withUserWrite(harness.db, { userId: USER_A }, async (tx) => {
      entered.resolve();
      await release.promise;
      await tx.execute(sql`SELECT 1`);
    });

    try {
      await entered.promise;
      // Archiving an unrelated category is not a financial write and queues
      // behind nothing.
      await archiveUserCategory(harness.db, USER_A, categoryId);
      expect(await isArchived(categoryId)).toBe(true);
    } finally {
      release.resolve();
    }
    await financial;
  });
});

describe('choosing a category afresh versus carrying history (30.22 item 9)', () => {
  it('refuses an expense filed under an archived category', async () => {
    const categoryId = await categoryNamed('Archived outright');
    await archiveUserCategory(harness.db, USER_A, categoryId);

    await expect(
      createExpenseEntry(flowDeps(), SEPT_15, {
        categoryId,
        incurredOn: '2026-09-12',
        amount: '40.00',
        currency: 'EUR',
        settlement: 'tracked_cash',
        cashPositionId: bbva,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('lets a correction that changes nothing about the category through', async () => {
    const categoryId = await categoryNamed('Archived after the fact');
    const created = await createExpenseEntry(flowDeps(), SEPT_15, {
      categoryId,
      incurredOn: '2026-09-12',
      amount: '40.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: bbva,
    });
    await archiveUserCategory(harness.db, USER_A, categoryId);

    // The correction carries the category it already had; it is not choosing
    // one afresh, so liveness is not its question.
    const corrected = await updateExpenseEntry(flowDeps(), SEPT_15, {
      entryId: created.id,
      expectedVersion: created.version,
      amount: '41.00',
    });
    expect(corrected.amount).toBe('41.00000000');

    // Moving it **to** an archived category is still refused.
    await expect(
      updateExpenseEntry(flowDeps(), SEPT_15, {
        entryId: corrected.id,
        expectedVersion: corrected.version,
        categoryId,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('materializes a recurring occurrence whose category was archived afterwards', async () => {
    const categoryId = await categoryNamed('Gym — archived later');
    const { template } = await createTemplate(flowDeps(), SEPT_15, {
      kind: 'expense',
      name: 'Gym',
      categoryId,
      currency: 'EUR',
      frequency: 'monthly',
      dayOfMonth: 10,
      startDate: '2026-01-10',
      cashPositionId: bbva,
      amount: '30.00',
    });
    await archiveUserCategory(harness.db, USER_A, categoryId);

    // Archiving a category after a template was created does not change what
    // its historical occurrences are (7.4, R12).
    const accepted = await acceptSuggestion(flowDeps(), SEPT_15, {
      templateId: template.id,
      occurrenceDate: '2026-09-10',
    });
    expect(accepted.kind).toBe('expense');
  });

  it('keeps classifying history by an archived category’s kind', async () => {
    const categoryId = await categoryNamed('Classified after archiving');
    await recordValuation(harness.services.positions, SEPT_15, {
      positionId: bbva,
      valuedOn: '2026-08-31',
      amount: '1000.00',
      datePrecision: 'month_end',
    });
    await createExpenseEntry(flowDeps(), SEPT_15, {
      categoryId,
      incurredOn: '2026-09-12',
      amount: '40.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: bbva,
    });
    await recordValuation(harness.services.positions, OCT_1, {
      positionId: bbva,
      valuedOn: '2026-09-30',
      amount: '960.00',
      datePrecision: 'month_end',
    });

    const before = await getMonthReconciliation(readDeps(), OCT_1, parseMonth('2026-09'));
    await archiveUserCategory(harness.db, USER_A, categoryId);
    const after = await getMonthReconciliation(readDeps(), OCT_1, parseMonth('2026-09'));

    // Tidying up a category must never rewrite what a month said.
    expect(after.buckets).toEqual(before.buckets);
  });
});
