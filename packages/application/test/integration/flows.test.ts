import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, withUser, withoutUser } from '@vaultide/db';
import { createHarness, type Harness } from '../helpers/harness';
import { testContext, type RequestContext } from '../../src/context';
import { provisionUser } from '../../src/users/provisioning';
import { createCashAccount, createOtherAsset, updateCashAccount } from '../../src/positions/service';
import { recordValuation } from '../../src/positions/valuations';
import { listCategories } from '../../src/users/categories';
import {
  createExpenseEntry,
  deleteExpenseEntry,
  updateExpenseEntry,
} from '../../src/flows/expenses';
import {
  createIncomeEntry,
  deleteIncomeEntry,
  updateIncomeEntry,
} from '../../src/flows/income';
import {
  createCashTransfer,
  deleteCashTransfer,
  updateCashTransfer,
} from '../../src/flows/transfers';
import { archiveTemplate, createTemplate, setTemplateTerm, unarchiveTemplate, updateTemplateDetails } from '../../src/recurring/templates';
import {
  acceptSuggestion,
  listSuggestions,
  skipSuggestion,
  unskipSuggestion,
} from '../../src/recurring/suggestions';
import { listUserTemplates } from '../../src/recurring/templates';

/**
 * Phase 3 flow services against a real database (blueprint 21.3, v2.1.6 §30.9).
 *
 * Two users exist throughout, so every assertion about one is also an assertion
 * that the other cannot see or reach it. "Today" is an explicit input in every
 * context — never a read of the process clock — which is what makes the date
 * rules testable at all (7.7).
 */

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

let harness: Harness;
let bbva: string;
let savings: string;
let groceries: string;
let transferFeeCategory: string;

const on = (today: string, userId = USER_A): RequestContext =>
  testContext({ today, userId, reportingCurrency: 'EUR' });

const SEPT_15 = on('2026-09-15');
const SEPT_30 = on('2026-09-30');

function deps() {
  return harness.services.flows;
}

async function createAuthUser(id: string, email: string): Promise<void> {
  await withoutUser(harness.db, async (tx) => {
    await tx.execute(
      sql`INSERT INTO "user" (id, name, email, email_verified)
          VALUES (${id}, ${email}, ${email}, true)
          ON CONFLICT (id) DO NOTHING`,
    );
  });
}

async function auditFor(userId: string, entityId: string) {
  return withUser(harness.db, { userId }, async (tx) => {
    const result = await tx.execute(
      sql`SELECT action, before, after FROM audit_entries
           WHERE entity_id = ${entityId} ORDER BY occurred_at, action`,
    );
    return result.rows as { action: string; before: unknown; after: unknown }[];
  });
}

async function countRows(userId: string, table: string): Promise<number> {
  return withUser(harness.db, { userId }, async (tx) => {
    const result = await tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`);
    return (result.rows[0] as { n: number }).n;
  });
}

beforeAll(async () => {
  harness = await createHarness();
  for (const [id, email] of [
    [USER_A, 'a@example.test'],
    [USER_B, 'b@example.test'],
  ] as const) {
    await createAuthUser(id, email);
    await provisionUser(harness.db, { userId: id });
  }
}, 240_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.asOwner('DELETE FROM expense_entries');
  await harness.asOwner('DELETE FROM transfers');
  await harness.asOwner('DELETE FROM income_entries');
  await harness.asOwner('DELETE FROM recurring_template_skips');
  await harness.asOwner('DELETE FROM recurring_template_terms');
  await harness.asOwner('DELETE FROM recurring_templates');
  await harness.asOwner('DELETE FROM audit_entries');
  await harness.asOwner('DELETE FROM position_valuations');
  await harness.asOwner('DELETE FROM cash_accounts');
  await harness.asOwner('DELETE FROM other_assets');
  await harness.asOwner('DELETE FROM positions');

  const checking = await createCashAccount(harness.services.positions, SEPT_15, {
    name: 'BBVA',
    currency: 'EUR',
    accountType: 'checking',
    openedOn: null,
  });
  bbva = checking.id;

  const savingsAccount = await createCashAccount(harness.services.positions, SEPT_15, {
    name: 'Savings',
    currency: 'EUR',
    accountType: 'savings',
    openedOn: null,
  });
  savings = savingsAccount.id;

  const categories = await listCategories(harness.db, USER_A);
  groceries = categories.find((row) => row.name === 'Groceries')?.id as string;
  transferFeeCategory = categories.find((row) => row.kind === 'transfer_fee')?.id as string;
});

describe('income entries', () => {
  it('records tracked income and audits the insert', async () => {
    const created = await createIncomeEntry(deps(), SEPT_15, {
      kind: 'employment',
      receivedOn: '2026-09-15',
      netAmount: '2100.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: bbva,
    });

    expect(created.settlement).toBe('tracked_cash');
    expect(created.templateId).toBeNull();
    expect(created.occurrenceDate).toBeNull();

    const audit = await auditFor(USER_A, created.id);
    expect(audit.map((row) => row.action)).toEqual(['insert']);
    expect(audit[0]?.after).toMatchObject({ netAmount: '2100.00000000' });
  });

  it('records ordinary income received outside tracked accounts', async () => {
    // 7.4: informational, no cash leg, in no total. Phase 3 supports it so a
    // user is not pushed into recording it as tracked cash, which would inflate
    // the reconciliation identity.
    const created = await createIncomeEntry(deps(), SEPT_15, {
      kind: 'freelance',
      receivedOn: '2026-09-15',
      netAmount: '400.00',
      currency: 'EUR',
      settlement: 'external',
    });
    expect(created.settlement).toBe('external');
    expect(created.cashPositionId).toBeNull();
  });

  it('refuses external settlement for a dividend or interest', async () => {
    // 7.4 defines an external distribution only when it links an investment,
    // and Phase 3 has none — so the row it could write is the case the matrix
    // does not cover (v2.1.6 §30.9 item 5).
    for (const kind of ['dividend', 'interest'] as const) {
      await expect(
        createIncomeEntry(deps(), SEPT_15, {
          kind,
          receivedOn: '2026-09-15',
          netAmount: '31.00',
          currency: 'EUR',
          settlement: 'external',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
  });

  it('accepts tracked-cash interest, which the September golden needs', async () => {
    const created = await createIncomeEntry(deps(), SEPT_15, {
      kind: 'interest',
      receivedOn: '2026-09-15',
      netAmount: '31.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: savings,
    });
    expect(created.netAmount).toBe('31.00000000');
  });

  it('refuses an external external_inflow or adjustment', async () => {
    // Both exist to explain tracked cash, so an external one could not affect
    // the discrepancy it was created for.
    for (const kind of ['external_inflow', 'adjustment'] as const) {
      await expect(
        createIncomeEntry(deps(), SEPT_15, {
          kind,
          receivedOn: '2026-09-15',
          netAmount: '100.00',
          currency: 'EUR',
          settlement: 'external',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
  });

  it('refuses a future-dated record', async () => {
    await expect(
      createIncomeEntry(deps(), SEPT_15, {
        kind: 'employment',
        receivedOn: '2026-09-16',
        netAmount: '10.00',
        currency: 'EUR',
        settlement: 'tracked_cash',
        cashPositionId: bbva,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('keeps a tracked flow with no account tracked, given a usable bucket', async () => {
    // 8.1: a null cash leg means "I have not said which account", never "this
    // was not tracked". It is accepted because a EUR account participates.
    const created = await createIncomeEntry(deps(), SEPT_15, {
      kind: 'other',
      receivedOn: '2026-09-15',
      netAmount: '15.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: null,
    });
    expect(created.settlement).toBe('tracked_cash');
    expect(created.cashPositionId).toBeNull();
  });

  it('refuses a null-leg tracked flow in a currency with no account', async () => {
    await expect(
      createIncomeEntry(deps(), SEPT_15, {
        kind: 'other',
        receivedOn: '2026-09-15',
        netAmount: '15.00',
        currency: 'USD',
        settlement: 'tracked_cash',
        cashPositionId: null,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses another tenant’s account without revealing it exists', async () => {
    const theirs = await createCashAccount(harness.services.positions, on('2026-09-15', USER_B), {
      name: 'Theirs',
      currency: 'EUR',
      accountType: 'checking',
      openedOn: null,
    });

    await expect(
      createIncomeEntry(deps(), SEPT_15, {
        kind: 'other',
        receivedOn: '2026-09-15',
        netAmount: '10.00',
        currency: 'EUR',
        settlement: 'tracked_cash',
        cashPositionId: theirs.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('corrects an entry under its version, with a before and after image', async () => {
    const created = await createIncomeEntry(deps(), SEPT_15, {
      kind: 'employment',
      receivedOn: '2026-09-15',
      netAmount: '2100.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: bbva,
    });

    const updated = await updateIncomeEntry(deps(), SEPT_15, {
      entryId: created.id,
      expectedVersion: created.version,
      netAmount: '2150.00',
      reason: 'Payslip corrected',
    });
    expect(updated.netAmount).toBe('2150.00000000');

    await expect(
      updateIncomeEntry(deps(), SEPT_15, {
        entryId: created.id,
        expectedVersion: created.version,
        netAmount: '9.00',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_VERSION' });

    const audit = await auditFor(USER_A, created.id);
    expect(audit.map((row) => row.action)).toEqual(['insert', 'update']);
    expect(audit[1]?.before).toMatchObject({ netAmount: '2100.00000000' });
    expect(audit[1]?.after).toMatchObject({ netAmount: '2150.00000000' });
  });

  it('deletes with a before-image', async () => {
    const created = await createIncomeEntry(deps(), SEPT_15, {
      kind: 'employment',
      receivedOn: '2026-09-15',
      netAmount: '2100.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: bbva,
    });
    await deleteIncomeEntry(deps(), SEPT_15, { entryId: created.id });

    const audit = await auditFor(USER_A, created.id);
    expect(audit.map((row) => row.action)).toEqual(['insert', 'delete']);
    expect(audit[1]?.before).toMatchObject({ netAmount: '2100.00000000' });
    expect(await countRows(USER_A, 'income_entries')).toBe(0);
  });
});

describe('expense entries', () => {
  it('records the three Phase 3 settlements and refuses the fourth', async () => {
    const tracked = await createExpenseEntry(deps(), SEPT_15, {
      categoryId: groceries,
      incurredOn: '2026-09-12',
      amount: '300.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: bbva,
    });
    expect(tracked.cashPositionId).toBe(bbva);

    const self = await createExpenseEntry(deps(), SEPT_30, {
      categoryId: groceries,
      incurredOn: '2026-09-22',
      amount: '50.00',
      currency: 'EUR',
      settlement: 'untracked_self',
    });
    expect(self.cashPositionId).toBeNull();

    const other = await createExpenseEntry(deps(), SEPT_30, {
      categoryId: groceries,
      incurredOn: '2026-09-20',
      amount: '80.00',
      currency: 'EUR',
      settlement: 'third_party',
    });
    expect(other.cashPositionId).toBeNull();

    await expect(
      createExpenseEntry(deps(), SEPT_30, {
        categoryId: groceries,
        incurredOn: '2026-09-20',
        amount: '10.00',
        currency: 'EUR',
        settlement: 'deducted_from_asset',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('drops a cash position that an untracked settlement may not carry', async () => {
    // 6.2 domain rule and a database CHECK: an untracked expense never touched
    // a tracked account, so it must not claim one.
    const created = await createExpenseEntry(deps(), SEPT_30, {
      categoryId: groceries,
      incurredOn: '2026-09-22',
      amount: '50.00',
      currency: 'EUR',
      settlement: 'untracked_self',
      cashPositionId: bbva,
    });
    expect(created.cashPositionId).toBeNull();
  });

  it('refuses a capital improvement, which needs an asset Phase 3 has not got', async () => {
    const categories = await listCategories(harness.db, USER_A);
    const capital = categories.find((row) => row.kind === 'capital_improvement')?.id as string;
    await expect(
      createExpenseEntry(deps(), SEPT_15, {
        categoryId: capital,
        incurredOn: '2026-09-12',
        amount: '20000.00',
        currency: 'EUR',
        settlement: 'tracked_cash',
        cashPositionId: bbva,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('updates and deletes with audit images', async () => {
    const created = await createExpenseEntry(deps(), SEPT_15, {
      categoryId: groceries,
      incurredOn: '2026-09-12',
      amount: '300.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: bbva,
    });
    await updateExpenseEntry(deps(), SEPT_15, {
      entryId: created.id,
      expectedVersion: created.version,
      amount: '310.00',
    });
    await deleteExpenseEntry(deps(), SEPT_15, { entryId: created.id });

    const audit = await auditFor(USER_A, created.id);
    expect(audit.map((row) => row.action)).toEqual(['insert', 'update', 'delete']);
  });
});

describe('explicit cash attribution is validated on every path', () => {
  // 20.1 lists these as domain rules: "leg currency = position currency" and
  // "date within position window". They are asked of every flow that names an
  // account, on every service.

  it('refuses a leg whose currency is not the account’s', async () => {
    const usd = await createCashAccount(harness.services.positions, SEPT_15, {
      name: 'USD',
      currency: 'USD',
      accountType: 'checking',
      openedOn: null,
    });

    await expect(
      createIncomeEntry(deps(), SEPT_15, {
        kind: 'other',
        receivedOn: '2026-09-15',
        netAmount: '10.00',
        currency: 'EUR',
        settlement: 'tracked_cash',
        cashPositionId: usd.id,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    await expect(
      createExpenseEntry(deps(), SEPT_15, {
        categoryId: groceries,
        incurredOn: '2026-09-15',
        amount: '10.00',
        currency: 'EUR',
        settlement: 'tracked_cash',
        cashPositionId: usd.id,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses a flow dated before the account opened', async () => {
    const opened = await createCashAccount(harness.services.positions, SEPT_15, {
      name: 'Opened in September',
      currency: 'EUR',
      accountType: 'checking',
      openedOn: '2026-09-10',
    });

    await expect(
      createIncomeEntry(deps(), SEPT_15, {
        kind: 'other',
        receivedOn: '2026-09-05',
        netAmount: '10.00',
        currency: 'EUR',
        settlement: 'tracked_cash',
        cashPositionId: opened.id,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    // On the opening day itself it is fine.
    await expect(
      createIncomeEntry(deps(), SEPT_15, {
        kind: 'other',
        receivedOn: '2026-09-10',
        netAmount: '10.00',
        currency: 'EUR',
        settlement: 'tracked_cash',
        cashPositionId: opened.id,
      }),
    ).resolves.toBeDefined();
  });

  it('refuses an expense attributed to a position that is not cash', async () => {
    const car = await createOtherAsset(harness.services.positions, SEPT_15, {
      name: 'Car',
      currency: 'EUR',
      assetType: 'vehicle',
      includeInFinancialNetWorth: false,
    });

    await expect(
      createExpenseEntry(deps(), SEPT_15, {
        categoryId: groceries,
        incurredOn: '2026-09-15',
        amount: '10.00',
        currency: 'EUR',
        settlement: 'tracked_cash',
        cashPositionId: car.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('accepts a null-leg flow when the only account of that currency opens later in the month', async () => {
    // 8.1 defines a bucket as the accounts "open at any time during M", so an
    // account opened on the 20th participates in September and a null-leg flow
    // dated the 5th has somewhere to go. Judging by the flow's own day instead
    // would reject a flow the engine will happily reconcile.
    //
    // CHF isolates the case: the only CHF account is the late one, so nothing
    // else can satisfy the check.
    await createCashAccount(harness.services.positions, SEPT_30, {
      name: 'Opened late',
      currency: 'CHF',
      accountType: 'checking',
      openedOn: '2026-09-20',
    });

    await expect(
      createIncomeEntry(deps(), SEPT_30, {
        kind: 'other',
        receivedOn: '2026-09-05',
        netAmount: '10.00',
        currency: 'CHF',
        settlement: 'tracked_cash',
        cashPositionId: null,
      }),
    ).resolves.toBeDefined();

    // And a month in which it does not participate at all is still refused.
    await expect(
      createIncomeEntry(deps(), SEPT_30, {
        kind: 'other',
        receivedOn: '2026-08-05',
        netAmount: '10.00',
        currency: 'CHF',
        settlement: 'tracked_cash',
        cashPositionId: null,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses a transfer whose endpoint is not open on the day', async () => {
    const opened = await createCashAccount(harness.services.positions, SEPT_15, {
      name: 'Opened in September',
      currency: 'EUR',
      accountType: 'checking',
      openedOn: '2026-09-10',
    });

    await expect(
      createCashTransfer(deps(), SEPT_15, {
        occurredOn: '2026-09-05',
        fromPositionId: bbva,
        toPositionId: opened.id,
        fromAmount: '50.00',
        toAmount: '50.00',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses another tenant’s account as a transfer endpoint, without leaking it', async () => {
    const theirs = await createCashAccount(harness.services.positions, on('2026-09-15', USER_B), {
      name: 'Theirs',
      currency: 'EUR',
      accountType: 'checking',
      openedOn: null,
    });

    await expect(
      createCashTransfer(deps(), SEPT_15, {
        occurredOn: '2026-09-05',
        fromPositionId: bbva,
        toPositionId: theirs.id,
        fromAmount: '50.00',
        toAmount: '50.00',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a fee charged to an account the transfer does not touch', async () => {
    const third = await createCashAccount(harness.services.positions, SEPT_15, {
      name: 'Third',
      currency: 'EUR',
      accountType: 'checking',
      openedOn: null,
    });

    await expect(
      createCashTransfer(deps(), SEPT_15, {
        occurredOn: '2026-09-05',
        fromPositionId: bbva,
        toPositionId: savings,
        fromAmount: '200.00',
        toAmount: '200.00',
        fee: {
          amount: '1.50',
          categoryId: transferFeeCategory,
          cashPositionId: third.id,
          currency: 'EUR',
        },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses a fee in a currency the paying account does not hold', async () => {
    await expect(
      createCashTransfer(deps(), SEPT_15, {
        occurredOn: '2026-09-05',
        fromPositionId: bbva,
        toPositionId: savings,
        fromAmount: '200.00',
        toAmount: '200.00',
        fee: {
          amount: '1.50',
          categoryId: transferFeeCategory,
          cashPositionId: bbva,
          currency: 'USD',
        },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('the protected transfer-fee category belongs to the transfer', () => {
  it('refuses an ordinary expense filed under it', async () => {
    // 7.4 defines the `transfer_fee` row only "(linked to a transfer)", and a
    // fee is one row owned by the transfer aggregate (M14). An unlinked one
    // would land in "Interest & fees" belonging to no transfer.
    await expect(
      createExpenseEntry(deps(), SEPT_15, {
        categoryId: transferFeeCategory,
        incurredOn: '2026-09-05',
        amount: '1.50',
        currency: 'EUR',
        settlement: 'tracked_cash',
        cashPositionId: bbva,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('still creates one through the transfer, filed under that same category', async () => {
    const { fee } = await createCashTransfer(deps(), SEPT_15, {
      occurredOn: '2026-09-05',
      fromPositionId: bbva,
      toPositionId: savings,
      fromAmount: '200.00',
      toAmount: '200.00',
      fee: {
        amount: '1.50',
        categoryId: transferFeeCategory,
        cashPositionId: bbva,
        currency: 'EUR',
      },
    });
    expect(fee?.categoryId).toBe(transferFeeCategory);
  });

  it('exposes no way for an expense mutation to claim a transfer', async () => {
    // The field is absent from the service args and from the Zod input, so a
    // caller cannot forge a linkage; this asserts the shape rather than a
    // rejection, because there is nothing to send.
    const args: Record<string, unknown> = {
      categoryId: groceries,
      incurredOn: '2026-09-05',
      amount: '5.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: bbva,
      transferId: '00000000-0000-4000-8000-000000000000',
    };
    const created = await createExpenseEntry(
      deps(),
      SEPT_15,
      args as unknown as Parameters<typeof createExpenseEntry>[2],
    );
    expect(created.transferId).toBeNull();
  });
});

describe('cash transfers and their fee', () => {
  it('creates the transfer and its fee in one transaction, both audited', async () => {
    const { transfer, fee } = await createCashTransfer(deps(), SEPT_15, {
      occurredOn: '2026-09-05',
      fromPositionId: bbva,
      toPositionId: savings,
      fromAmount: '200.00',
      toAmount: '200.00',
      fee: {
        amount: '1.50',
        categoryId: transferFeeCategory,
        cashPositionId: bbva,
        currency: 'EUR',
      },
    });

    expect(transfer.kind).toBe('cash_transfer');
    // Phase 3 materializes no recurring transfer occurrence (§30.9 item 3).
    expect(transfer.templateId).toBeNull();
    expect(transfer.occurrenceDate).toBeNull();
    expect(fee?.transferId).toBe(transfer.id);

    expect((await auditFor(USER_A, transfer.id)).map((row) => row.action)).toEqual(['insert']);
    expect((await auditFor(USER_A, fee?.id as string)).map((row) => row.action)).toEqual(['insert']);
  });

  it('writes neither row when the fee is invalid', async () => {
    await expect(
      createCashTransfer(deps(), SEPT_15, {
        occurredOn: '2026-09-05',
        fromPositionId: bbva,
        toPositionId: savings,
        fromAmount: '200.00',
        toAmount: '200.00',
        fee: {
          amount: '1.50',
          // An ordinary consumption category: a fee belongs in "Interest &
          // fees", so filing it under groceries would move it into spending.
          categoryId: groceries,
          cashPositionId: bbva,
          currency: 'EUR',
        },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    expect(await countRows(USER_A, 'transfers')).toBe(0);
    expect(await countRows(USER_A, 'expense_entries')).toBe(0);
  });

  it('keeps both native amounts across currencies and refuses a mismatch within one', async () => {
    const usd = await createCashAccount(harness.services.positions, SEPT_15, {
      name: 'USD',
      currency: 'USD',
      accountType: 'checking',
      openedOn: null,
    });

    const { transfer } = await createCashTransfer(deps(), SEPT_15, {
      occurredOn: '2026-09-05',
      fromPositionId: bbva,
      toPositionId: usd.id,
      fromAmount: '200.00',
      toAmount: '216.45',
    });
    expect(transfer.fromAmount).toBe('200.00000000');
    expect(transfer.toAmount).toBe('216.45000000');

    await expect(
      createCashTransfer(deps(), SEPT_15, {
        occurredOn: '2026-09-05',
        fromPositionId: bbva,
        toPositionId: savings,
        fromAmount: '200.00',
        toAmount: '190.00',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses a date change that would strand the fee, and accepts an explicit one', async () => {
    const { transfer, fee } = await createCashTransfer(deps(), SEPT_15, {
      occurredOn: '2026-09-05',
      fromPositionId: bbva,
      toPositionId: savings,
      fromAmount: '200.00',
      toAmount: '200.00',
      fee: {
        amount: '1.50',
        categoryId: transferFeeCategory,
        cashPositionId: bbva,
        currency: 'EUR',
      },
    });

    await expect(
      updateCashTransfer(deps(), SEPT_15, {
        transferId: transfer.id,
        expectedVersion: transfer.version,
        occurredOn: '2026-09-06',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const moved = await updateCashTransfer(deps(), SEPT_15, {
      transferId: transfer.id,
      expectedVersion: transfer.version,
      occurredOn: '2026-09-06',
      fee: { expectedVersion: fee?.version as number, incurredOn: '2026-09-06' },
    });
    expect(moved.transfer.occurredOn).toBe('2026-09-06');
    expect(moved.fee?.incurredOn).toBe('2026-09-06');
  });

  it('deletes the fee explicitly before the transfer, so both keep a before-image', async () => {
    const { transfer, fee } = await createCashTransfer(deps(), SEPT_15, {
      occurredOn: '2026-09-05',
      fromPositionId: bbva,
      toPositionId: savings,
      fromAmount: '200.00',
      toAmount: '200.00',
      fee: {
        amount: '1.50',
        categoryId: transferFeeCategory,
        cashPositionId: bbva,
        currency: 'EUR',
      },
    });

    const removed = await deleteCashTransfer(deps(), SEPT_15, { transferId: transfer.id });
    expect(removed.fees).toHaveLength(1);

    // The cascade would have removed the fee with no audit row at all; this is
    // the assertion that the ordinary path does not rely on it (6.3, 18.1).
    const feeAudit = await auditFor(USER_A, fee?.id as string);
    expect(feeAudit.map((row) => row.action)).toEqual(['insert', 'delete']);
    expect(feeAudit[1]?.before).toMatchObject({ amount: '1.50000000' });

    const transferAudit = await auditFor(USER_A, transfer.id);
    expect(transferAudit.map((row) => row.action)).toEqual(['insert', 'delete']);
    expect(await countRows(USER_A, 'expense_entries')).toBe(0);
  });

  it('will not let a fee be edited or deleted behind its transfer’s back', async () => {
    const { transfer, fee } = await createCashTransfer(deps(), SEPT_15, {
      occurredOn: '2026-09-05',
      fromPositionId: bbva,
      toPositionId: savings,
      fromAmount: '200.00',
      toAmount: '200.00',
      fee: {
        amount: '1.50',
        categoryId: transferFeeCategory,
        cashPositionId: bbva,
        currency: 'EUR',
      },
    });
    void transfer;

    await expect(
      updateExpenseEntry(deps(), SEPT_15, {
        entryId: fee?.id as string,
        expectedVersion: fee?.version as number,
        amount: '2.00',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    await expect(
      deleteExpenseEntry(deps(), SEPT_15, { entryId: fee?.id as string }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('dormancy', () => {
  async function makeDormant(): Promise<void> {
    await recordValuation(harness.services.positions, SEPT_15, {
      positionId: savings,
      valuedOn: '2026-09-01',
      amount: '0',
      datePrecision: 'exact',
    });
    const positions = await withUser(harness.db, { userId: USER_A }, async (tx) => {
      const result = await tx.execute(
        sql`SELECT version FROM positions WHERE id = ${savings}`,
      );
      return result.rows as { version: number }[];
    });
    await updateCashAccount(harness.services.positions, SEPT_15, {
      positionId: savings,
      expectedVersion: positions[0]?.version as number,
      isDormant: true,
    });
  }

  async function isDormant(): Promise<boolean> {
    return withUser(harness.db, { userId: USER_A }, async (tx) => {
      const result = await tx.execute(
        sql`SELECT is_dormant FROM cash_accounts WHERE position_id = ${savings}`,
      );
      return (result.rows[0] as { is_dormant: boolean }).is_dormant;
    });
  }

  it('is cleared by an attributed income, in the same transaction and audited', async () => {
    await makeDormant();
    expect(await isDormant()).toBe(true);

    await createIncomeEntry(deps(), SEPT_15, {
      kind: 'interest',
      receivedOn: '2026-09-10',
      netAmount: '31.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: savings,
    });

    expect(await isDormant()).toBe(false);
    const audit = await auditFor(USER_A, savings);
    expect(audit.some((row) => row.action === 'update')).toBe(true);
  });

  it('is cleared by an attributed expense', async () => {
    await makeDormant();
    await createExpenseEntry(deps(), SEPT_15, {
      categoryId: groceries,
      incurredOn: '2026-09-10',
      amount: '5.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: savings,
    });
    expect(await isDormant()).toBe(false);
  });

  it('is cleared from either side of a transfer', async () => {
    await makeDormant();
    await createCashTransfer(deps(), SEPT_15, {
      occurredOn: '2026-09-05',
      fromPositionId: bbva,
      toPositionId: savings,
      fromAmount: '200.00',
      toAmount: '200.00',
    });
    expect(await isDormant()).toBe(false);
  });

  it('is cleared by a back-dated flow, which is the conservative direction', async () => {
    // Clearing only ever asks for more evidence; leaving the flag would let an
    // assumption make a past month look reliable (8.8).
    await makeDormant();
    await createIncomeEntry(deps(), SEPT_15, {
      kind: 'other',
      receivedOn: '2026-08-02',
      netAmount: '5.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: savings,
    });
    expect(await isDormant()).toBe(false);
  });

  it('is not cleared by a flow attributed to no account', async () => {
    await makeDormant();
    await createIncomeEntry(deps(), SEPT_15, {
      kind: 'other',
      receivedOn: '2026-09-10',
      netAmount: '5.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: null,
    });
    expect(await isDormant()).toBe(true);
  });

  it('is not restored by deleting the flow that cleared it', async () => {
    // Dormancy is a user assertion, re-made only through the explicit action.
    await makeDormant();
    const created = await createIncomeEntry(deps(), SEPT_15, {
      kind: 'other',
      receivedOn: '2026-09-10',
      netAmount: '5.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: savings,
    });
    await deleteIncomeEntry(deps(), SEPT_15, { entryId: created.id });
    expect(await isDormant()).toBe(false);
  });
});

describe('recurring templates', () => {
  async function salary(over: Partial<Parameters<typeof createTemplate>[2]> = {}) {
    return createTemplate(deps(), SEPT_15, {
      kind: 'income',
      name: 'Salary',
      incomeKind: 'employment',
      currency: 'EUR',
      frequency: 'monthly',
      dayOfMonth: 25,
      startDate: '2026-01-01',
      cashPositionId: bbva,
      amount: '2100.00',
      ...over,
    });
  }

  it('creates a template with its opening term', async () => {
    const { template, term } = await salary();
    expect(template.kind).toBe('income');
    expect(term.effectiveFrom).toBe('2026-01-01');
    expect(term.amount).toBe('2100.00000000');
  });

  it('refuses a contribution template, which arrives with investments', async () => {
    await expect(
      createTemplate(deps(), SEPT_15, {
        // The service type accepts it; Phase 3 refuses it (Phase 4 owns the workflow).
        kind: 'contribution',
        name: 'S&P',
        currency: 'EUR',
        frequency: 'monthly',
        startDate: '2026-01-01',
        amount: '1000.00',
      }),
    ).rejects.toMatchObject({ code: 'IMPOSSIBLE_OPERATION' });
  });

  it('archives a template that has history, and unarchives it', async () => {
    // Archiving is always allowed: it stops the suggestions and keeps the rows.
    const { template } = await salary();
    await acceptSuggestion(deps(), SEPT_15, {
      templateId: template.id,
      occurrenceDate: '2026-08-25',
    });

    const archived = await archiveTemplate(deps(), SEPT_15, {
      templateId: template.id,
      expectedVersion: template.version,
    });
    expect(archived.archivedAt).not.toBeNull();

    const restored = await unarchiveTemplate(deps(), SEPT_15, {
      templateId: template.id,
      expectedVersion: archived.version,
    });
    expect(restored.archivedAt).toBeNull();
  });

  it('refuses an end date that would erase a recorded occurrence', async () => {
    const { template } = await salary();
    await acceptSuggestion(deps(), SEPT_15, {
      templateId: template.id,
      occurrenceDate: '2026-08-25',
    });

    await expect(
      updateTemplateDetails(deps(), SEPT_15, {
        templateId: template.id,
        expectedVersion: template.version,
        endDate: '2026-07-01',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('still allows renaming a template with history', async () => {
    const { template } = await salary();
    await acceptSuggestion(deps(), SEPT_15, {
      templateId: template.id,
      occurrenceDate: '2026-08-25',
    });
    const renamed = await updateTemplateDetails(deps(), SEPT_15, {
      templateId: template.id,
      expectedVersion: template.version,
      name: 'Salary (Acme)',
    });
    expect(renamed.name).toBe('Salary (Acme)');
  });
});

describe('accepting and skipping occurrences', () => {
  async function salaryTemplate() {
    const { template } = await createTemplate(deps(), SEPT_15, {
      kind: 'income',
      name: 'Salary',
      incomeKind: 'employment',
      currency: 'EUR',
      frequency: 'monthly',
      dayOfMonth: 25,
      startDate: '2026-01-01',
      cashPositionId: bbva,
      amount: '2100.00',
    });
    return template;
  }

  it('materializes a tracked-cash flow carrying the occurrence identity', async () => {
    const template = await salaryTemplate();
    const accepted = await acceptSuggestion(deps(), SEPT_15, {
      templateId: template.id,
      occurrenceDate: '2026-08-25',
    });

    expect(accepted.kind).toBe('income');
    // §30.9 item 1: a template has no settlement column, so Phase 3
    // materializes tracked cash and never infers otherwise.
    expect(accepted.entry).toMatchObject({
      settlement: 'tracked_cash',
      templateId: template.id,
      occurrenceDate: '2026-08-25',
      receivedOn: '2026-08-25',
      cashPositionId: bbva,
    });
  });

  it('materializes tracked cash even when the template has no default account', async () => {
    const { template } = await createTemplate(deps(), SEPT_15, {
      kind: 'income',
      name: 'Odd jobs',
      incomeKind: 'other',
      currency: 'EUR',
      frequency: 'monthly',
      dayOfMonth: 10,
      startDate: '2026-01-01',
      amount: '100.00',
    });

    const accepted = await acceptSuggestion(deps(), SEPT_15, {
      templateId: template.id,
      occurrenceDate: '2026-09-10',
    });
    expect(accepted.entry.settlement).toBe('tracked_cash');
    expect(accepted.entry.cashPositionId).toBeNull();
  });

  it('rejects a second acceptance of one occurrence', async () => {
    const template = await salaryTemplate();
    await acceptSuggestion(deps(), SEPT_15, {
      templateId: template.id,
      occurrenceDate: '2026-08-25',
    });
    await expect(
      acceptSuggestion(deps(), SEPT_15, {
        templateId: template.id,
        occurrenceDate: '2026-08-25',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_DUPLICATE' });
  });

  it('keeps the occurrence identity when the financial date is corrected', async () => {
    const template = await salaryTemplate();
    const accepted = await acceptSuggestion(deps(), SEPT_15, {
      templateId: template.id,
      occurrenceDate: '2026-08-25',
    });

    const updated = await updateIncomeEntry(deps(), SEPT_15, {
      entryId: accepted.entry.id,
      expectedVersion: accepted.entry.version,
      receivedOn: '2026-08-27',
    });
    expect(updated.receivedOn).toBe('2026-08-27');
    expect(updated.occurrenceDate).toBe('2026-08-25');

    // And the occurrence stays fulfilled, so it is not suggested again.
    await expect(
      acceptSuggestion(deps(), SEPT_15, {
        templateId: template.id,
        occurrenceDate: '2026-08-25',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_DUPLICATE' });
  });

  it('records an occurrence received early, keeping its scheduled date', async () => {
    // "Received today" on 30 September for the 1 October occurrence: September
    // sees the cash, October never suggests it again (§30.9 item 2).
    const template = await salaryTemplate();
    const sept30 = on('2026-09-30');

    const accepted = await acceptSuggestion(deps(), sept30, {
      templateId: template.id,
      occurrenceDate: '2026-10-25',
      financialDate: '2026-09-30',
    });

    expect(accepted.kind).toBe('income');
    if (accepted.kind !== 'income') throw new Error('expected an income entry');
    expect(accepted.entry.occurrenceDate).toBe('2026-10-25');
    expect(accepted.entry.receivedOn).toBe('2026-09-30');
  });

  it('refuses a financial date in the future while allowing a future occurrence', async () => {
    const template = await salaryTemplate();
    await expect(
      acceptSuggestion(deps(), SEPT_15, {
        templateId: template.id,
        occurrenceDate: '2026-10-25',
        financialDate: '2026-09-16',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses a date the template does not actually schedule', async () => {
    const template = await salaryTemplate();
    await expect(
      acceptSuggestion(deps(), SEPT_15, {
        templateId: template.id,
        occurrenceDate: '2026-08-24',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('will not skip an occurrence that has been accepted', async () => {
    const template = await salaryTemplate();
    await acceptSuggestion(deps(), SEPT_15, {
      templateId: template.id,
      occurrenceDate: '2026-08-25',
    });
    await expect(
      skipSuggestion(deps(), SEPT_15, {
        templateId: template.id,
        occurrenceDate: '2026-08-25',
        reason: 'skipped',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_DUPLICATE' });
  });

  it('will not accept an occurrence that has been skipped', async () => {
    const template = await salaryTemplate();
    await skipSuggestion(deps(), SEPT_15, {
      templateId: template.id,
      occurrenceDate: '2026-08-25',
      reason: 'skipped',
    });
    await expect(
      acceptSuggestion(deps(), SEPT_15, {
        templateId: template.id,
        occurrenceDate: '2026-08-25',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_DUPLICATE' });
  });

  it('refuses a second skip of one occurrence', async () => {
    const template = await salaryTemplate();
    await skipSuggestion(deps(), SEPT_15, {
      templateId: template.id,
      occurrenceDate: '2026-08-25',
      reason: 'skipped',
    });
    await expect(
      skipSuggestion(deps(), SEPT_15, {
        templateId: template.id,
        occurrenceDate: '2026-08-25',
        reason: 'other',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_DUPLICATE' });
  });

  it('lets exactly one of a concurrent accept and skip win', async () => {
    // Both facts live in different tables, so the template row's lock is what
    // serializes them (20.3). Without it both could commit.
    const template = await salaryTemplate();

    const results = await Promise.allSettled([
      acceptSuggestion(deps(), SEPT_15, {
        templateId: template.id,
        occurrenceDate: '2026-08-25',
      }),
      skipSuggestion(deps(), SEPT_15, {
        templateId: template.id,
        occurrenceDate: '2026-08-25',
        reason: 'skipped',
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const entries = await countRows(USER_A, 'income_entries');
    const skips = await countRows(USER_A, 'recurring_template_skips');
    expect(entries + skips).toBe(1);
  });

  it('lets exactly one of two concurrent accepts win', async () => {
    const template = await salaryTemplate();
    const results = await Promise.allSettled([
      acceptSuggestion(deps(), SEPT_15, {
        templateId: template.id,
        occurrenceDate: '2026-08-25',
      }),
      acceptSuggestion(deps(), SEPT_15, {
        templateId: template.id,
        occurrenceDate: '2026-08-25',
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await countRows(USER_A, 'income_entries')).toBe(1);
  });

  it('lets exactly one of two concurrent skips win', async () => {
    const template = await salaryTemplate();
    const results = await Promise.allSettled([
      skipSuggestion(deps(), SEPT_15, {
        templateId: template.id,
        occurrenceDate: '2026-08-25',
        reason: 'skipped',
      }),
      skipSuggestion(deps(), SEPT_15, {
        templateId: template.id,
        occurrenceDate: '2026-08-25',
        reason: 'other',
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await countRows(USER_A, 'recurring_template_skips')).toBe(1);
  });

  it('makes an occurrence due again when its accepted flow is deleted', async () => {
    const template = await salaryTemplate();
    const accepted = await acceptSuggestion(deps(), SEPT_15, {
      templateId: template.id,
      occurrenceDate: '2026-08-25',
    });
    await deleteIncomeEntry(deps(), SEPT_15, { entryId: accepted.entry.id });

    const again = await acceptSuggestion(deps(), SEPT_15, {
      templateId: template.id,
      occurrenceDate: '2026-08-25',
    });
    expect(again.entry.occurrenceDate).toBe('2026-08-25');
  });

  it('makes an occurrence due again when its skip is removed', async () => {
    const template = await salaryTemplate();
    const skip = await skipSuggestion(deps(), SEPT_15, {
      templateId: template.id,
      occurrenceDate: '2026-08-25',
      reason: 'skipped',
    });
    await unskipSuggestion(deps(), SEPT_15, { skipId: skip.id });

    const accepted = await acceptSuggestion(deps(), SEPT_15, {
      templateId: template.id,
      occurrenceDate: '2026-08-25',
    });
    expect(accepted.entry.occurrenceDate).toBe('2026-08-25');
  });

  it('restricts vacancy and non-payment to rental income', async () => {
    // F18: these are the only occupancy facts the product records, so they
    // cannot be attached to a salary.
    const template = await salaryTemplate();
    for (const reason of ['vacant', 'non_payment'] as const) {
      await expect(
        skipSuggestion(deps(), SEPT_15, {
          templateId: template.id,
          occurrenceDate: '2026-08-25',
          reason,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }

    const { template: rent } = await createTemplate(deps(), SEPT_15, {
      kind: 'income',
      name: 'Rent',
      incomeKind: 'rental',
      currency: 'EUR',
      frequency: 'monthly',
      dayOfMonth: 1,
      startDate: '2026-01-01',
      amount: '900.00',
    });
    const skip = await skipSuggestion(deps(), SEPT_15, {
      templateId: rent.id,
      occurrenceDate: '2026-08-01',
      reason: 'vacant',
    });
    expect(skip.reason).toBe('vacant');
  });

  it('takes the term the scheduled occurrence falls under, not the payment date', async () => {
    const template = await salaryTemplate();
    await setTemplateTerm(deps(), SEPT_15, {
      templateId: template.id,
      effectiveFrom: '2026-10-25',
      amount: '2250.00',
    });

    const sept30 = on('2026-09-30');
    const accepted = await acceptSuggestion(deps(), sept30, {
      templateId: template.id,
      occurrenceDate: '2026-10-25',
      financialDate: '2026-09-30',
    });
    if (accepted.kind !== 'income') throw new Error('expected an income entry');
    expect(accepted.entry.netAmount).toBe('2250.00000000');
  });

  it('lists occurrences with their state', async () => {
    const template = await salaryTemplate();
    await acceptSuggestion(deps(), SEPT_15, {
      templateId: template.id,
      occurrenceDate: '2026-07-25',
    });
    await skipSuggestion(deps(), SEPT_15, {
      templateId: template.id,
      occurrenceDate: '2026-08-25',
      reason: 'skipped',
    });

    // Judged from 30 September, so the 25th is due and October is still upcoming.
    const templates = await listUserTemplates(deps(), SEPT_30);
    const suggestions = await listSuggestions(deps(), SEPT_30, {
      from: '2026-07-01',
      to: '2026-10-31',
      templates,
    });

    const byDate = new Map(suggestions.map((row) => [String(row.occurrenceDate), row]));
    expect(byDate.get('2026-07-25')?.state).toBe('accepted');
    expect(byDate.get('2026-08-25')?.state).toBe('skipped');
    expect(byDate.get('2026-09-25')?.state).toBe('due');
    expect(byDate.get('2026-10-25')?.state).toBe('upcoming');
    expect(byDate.get('2026-09-25')?.amount).toBe('2100');
  });
});
