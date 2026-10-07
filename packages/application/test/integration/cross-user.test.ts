import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { USER_OWNED_TABLES, sql, withUser, withoutUser } from '@vaultide/db';
import { createHarness, type Harness } from '../helpers/harness';
import { REGISTERED_MUTATIONS } from '../helpers/write-boundary';
import { testContext, type RequestContext } from '../../src/context';
import { DomainError } from '../../src/errors';
import { provisionUser } from '../../src/users/provisioning';
import { listCategories } from '../../src/users/categories';
import {
  closePosition,
  createCashAccount,
  createOtherAsset,
  removePosition,
  updateCashAccount,
  updateOtherAsset,
} from '../../src/positions/service';
import {
  confirmMonthEnd,
  confirmUnchanged,
  confirmUnchangedBatch,
  correctValuation,
  quickUpdate,
  recordValuation,
  removeValuation,
} from '../../src/positions/valuations';
import { getNetWorth, getPositionDetail } from '../../src/positions/queries';
import { createIncomeEntry, deleteIncomeEntry, updateIncomeEntry } from '../../src/flows/income';
import { createExpenseEntry, deleteExpenseEntry, updateExpenseEntry } from '../../src/flows/expenses';
import { createCashTransfer, deleteCashTransfer, updateCashTransfer } from '../../src/flows/transfers';
import { acceptUnexplainedInflowAsAdjustment } from '../../src/flows/adjustments';
import {
  archiveTemplate,
  createTemplate,
  setTemplateTerm,
  unarchiveTemplate,
  updateTemplateDetails,
} from '../../src/recurring/templates';
import { acceptSuggestion, skipSuggestion, unskipSuggestion } from '../../src/recurring/suggestions';
import { readSettings, setCountAdditionalSpending } from '../../src/settings/service';
import {
  confirmHistoricalCorrection,
  previewHistoricalCorrection,
  type CorrectionDraft,
} from '../../src/corrections/index';
import {
  dismissMonthAdvisory,
  markMonthReviewed,
  readMonthReview,
  restoreMonthAdvisory,
} from '../../src/monthly/review-service';
import { getMonthlyPage } from '../../src/monthly/service';
import { getSpendingPage } from '../../src/spending/service';
import { getIncomePage } from '../../src/income/service';
import { getIncomeSourcePage } from '../../src/income/source';
import { getBulkHistoryPage } from '../../src/bulk-history/page';
import { parseMonth } from '../../src/reconciliation/service';
import type { CompletedMonthlyPageDto } from '../../src/monthly/types';
import type { NetWorthDto } from '../../src/positions/types';

/**
 * One user can never reach another's records (blueprint 21.4, 17.2, 20.2;
 * cold review P3-02).
 *
 * §21.4: "Parametrized over every server action and query service: user A with
 * user B's ids gets `NOT_FOUND`/empty; registry fails the suite if an action is
 * missing." So the mutation cases are a table keyed by name, and the suite
 * fails unless its names are exactly `REGISTERED_MUTATIONS`. That registry is
 * itself checked against the web app's `financialAction` declarations by
 * `financial-write-boundary.test.ts`, so a new financial action cannot escape
 * both suites.
 *
 * Every case that takes an id is asked twice — once with B's ids, once with
 * ids that exist nowhere — and must give the same `NOT_FOUND`, code and
 * message alike, so nothing tells A that B's record exists. Around each attempt
 * every user-owned table is read as each user, `audit_entries` included, and
 * must be identical afterwards: a row moved from one user to the other would
 * show in both snapshots.
 *
 * Both users hold the same kinds of records on the same days, all in EUR with
 * EUR as the reporting currency. Exchange rates are shared by every user, so a second
 * currency would let a rate fetched for B's records change A's page and look
 * like a leak; with one currency there is no rate to fetch.
 *
 * The month-review writes take a month rather than an id and are declared
 * with the ordinary `action` wrapper (ADR 0003), so they are not in the
 * registry; they have their own case below. The non-financial actions that take
 * an id — archiving a category, deleting a tag — are covered in
 * `settings.test.ts` ("cross-user access is impossible") and are not repeated.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const TODAY = '2026-10-05';

let harness: Harness;

const on = (today: string, userId: string): RequestContext =>
  testContext({ today, userId, reportingCurrency: 'EUR' });

/** Every case runs as user A, on 5 October. */
const AS_A = on(TODAY, USER_A);
const SEPTEMBER = parseMonth('2026-09');
const OCTOBER = parseMonth('2026-10');

const positions = () => harness.services.positions;
const flows = () => harness.services.flows;
const corrections = () => harness.services.corrections;
const reads = () => ({ db: harness.db });

/* -------------------------------------------------------------------------- */
/* The two worlds                                                              */
/* -------------------------------------------------------------------------- */

/** One user's records, by role. Every value is an id the user owns. */
interface WorldIds {
  readonly checking: string;
  readonly savings: string;
  /** A cash account opened today, with no balance at all. */
  readonly spare: string;
  readonly car: string;
  readonly groceries: string;
  /** The car's ordinary snapshot dated 30 September: confirmable as a statement. */
  readonly carSnapshot: string;
  /** Checking's statement balance at 30 September. */
  readonly septemberEnd: string;
  /** Checking's quick-update balance on 4 October. */
  readonly latest: string;
  readonly income: string;
  readonly expense: string;
  readonly transfer: string;
  readonly fee: string;
  readonly salary: string;
  /** The salary's accepted 25 September occurrence. */
  readonly accepted: string;
  readonly gym: string;
  /** The gym's skipped 5 September occurrence. */
  readonly skip: string;
}

/** The version of each row a case names, keyed by id. The same for both runs. */
type Versions = Readonly<Record<string, number>>;

async function createAuthUser(id: string, email: string): Promise<void> {
  await withoutUser(harness.db, async (tx) => {
    await tx.execute(
      sql`INSERT INTO "user" (id, name, email, email_verified)
          VALUES (${id}, ${email}, ${email}, true)
          ON CONFLICT (id) DO NOTHING`,
    );
  });
}

/**
 * Build one user's month of records, each written on the day it describes, so
 * every row is valid exactly as the services would store it.
 *
 * September reconciles for A (302.00 spent, all of it known). B's 30 September
 * balance is 500.00 higher than its records explain, so B's September is
 * unresolved with an unexplained inflow of 500.00 — the figure A later presents
 * to the adjustment action. Only B reviews September.
 */
async function buildWorld(
  userId: string,
  options: { readonly unexplained: 0 | 500; readonly review: boolean },
): Promise<WorldIds> {
  const day = (today: string) => on(today, userId);
  const extra = options.unexplained;

  const account = (name: string, accountType: 'checking' | 'savings' | 'cash', openedOn: string | null) =>
    createCashAccount(positions(), day(openedOn ?? '2026-08-01'), {
      name,
      currency: 'EUR',
      accountType,
      openedOn,
    });
  const checking = (await account('Checking', 'checking', null)).id;
  const savings = (await account('Savings', 'savings', null)).id;

  const statement = (positionId: string, amount: string) =>
    recordValuation(positions(), day('2026-09-01'), {
      positionId,
      valuedOn: '2026-08-31',
      amount,
      datePrecision: 'month_end',
    });
  await statement(checking, '1000.00');
  await statement(savings, '500.00');

  const sept10 = day('2026-09-10');
  const categories = await listCategories(harness.db, userId);
  const groceries = categories.find((row) => row.name === 'Groceries')?.id as string;

  const income = await createIncomeEntry(flows(), sept10, {
    kind: 'employment',
    receivedOn: '2026-09-10',
    netAmount: '2000.00',
    currency: 'EUR',
    settlement: 'tracked_cash',
    cashPositionId: checking,
  });
  const expense = await createExpenseEntry(flows(), sept10, {
    categoryId: groceries,
    incurredOn: '2026-09-10',
    amount: '300.00',
    currency: 'EUR',
    settlement: 'tracked_cash',
    cashPositionId: checking,
  });
  const transfer = await createCashTransfer(flows(), sept10, {
    occurredOn: '2026-09-10',
    fromPositionId: checking,
    toPositionId: savings,
    fromAmount: '200.00',
    toAmount: '200.00',
    fee: { amount: '2.00', cashPositionId: checking, incurredOn: '2026-09-10' },
  });
  const salary = await createTemplate(flows(), sept10, {
    kind: 'income',
    name: 'Salary',
    incomeKind: 'employment',
    currency: 'EUR',
    frequency: 'monthly',
    dayOfMonth: 25,
    startDate: '2026-09-01',
    cashPositionId: checking,
    amount: '2000.00',
  });
  const gym = await createTemplate(flows(), sept10, {
    kind: 'expense',
    name: 'Gym',
    categoryId: groceries,
    currency: 'EUR',
    frequency: 'monthly',
    dayOfMonth: 5,
    startDate: '2026-09-01',
    cashPositionId: checking,
    amount: '40.00',
  });
  const skip = await skipSuggestion(flows(), sept10, {
    templateId: gym.template.id,
    occurrenceDate: '2026-09-05',
    reason: 'skipped',
  });

  const accepted = await acceptSuggestion(flows(), day('2026-09-25'), {
    templateId: salary.template.id,
    occurrenceDate: '2026-09-25',
  });

  // 1,000 + 2,000 − 300 − 200 − 2 + 2,000 = 4,498, and B's 500 nobody recorded.
  const sept30 = day('2026-09-30');
  const checkingEnd = await recordValuation(positions(), sept30, {
    positionId: checking,
    valuedOn: '2026-09-30',
    amount: (4498 + extra).toFixed(2),
    datePrecision: 'exact',
  });
  const savingsEnd = await recordValuation(positions(), sept30, {
    positionId: savings,
    valuedOn: '2026-09-30',
    amount: '700.00',
    datePrecision: 'exact',
  });
  const car = await createOtherAsset(positions(), sept30, {
    name: 'Car',
    currency: 'EUR',
    assetType: 'vehicle',
    includeInFinancialNetWorth: false,
    currentValue: '5000.00',
    currentValueOn: '2026-09-30',
  });

  const oct1 = day('2026-10-01');
  for (const snapshot of [checkingEnd, savingsEnd]) {
    await confirmMonthEnd(positions(), oct1, {
      valuationId: snapshot.id,
      expectedVersion: snapshot.version,
    });
  }

  if (options.review) {
    await markMonthReviewed(reads(), day('2026-10-02'), SEPTEMBER);
    await dismissMonthAdvisory(reads(), day('2026-10-02'), SEPTEMBER, 'possible_missing_interest');
  }

  const oct3 = day('2026-10-03');
  await createIncomeEntry(flows(), oct3, {
    kind: 'other',
    receivedOn: '2026-10-03',
    netAmount: '100.00',
    currency: 'EUR',
    settlement: 'tracked_cash',
    cashPositionId: checking,
  });
  await createExpenseEntry(flows(), oct3, {
    categoryId: groceries,
    incurredOn: '2026-10-03',
    amount: '50.00',
    currency: 'EUR',
    settlement: 'tracked_cash',
    cashPositionId: checking,
  });
  await quickUpdate(positions(), day('2026-10-04'), {
    entries: [
      { positionId: checking, amount: (4548 + extra).toFixed(2) },
      { positionId: savings, amount: '700.00' },
    ],
  });

  const spare = (await account('Spare', 'cash', TODAY)).id;

  return withUser(harness.db, { userId }, async (tx) => {
    const one = async (query: ReturnType<typeof sql>): Promise<string> => {
      const result = await tx.execute(query);
      return (result.rows[0] as { id: string }).id;
    };
    return {
      checking,
      savings,
      spare,
      car: car.id,
      groceries,
      carSnapshot: await one(
        sql`SELECT id FROM position_valuations WHERE position_id = ${car.id} AND valued_on = '2026-09-30'`,
      ),
      septemberEnd: checkingEnd.id,
      latest: await one(
        sql`SELECT id FROM position_valuations WHERE position_id = ${checking} AND valued_on = '2026-10-04'`,
      ),
      income: income.id,
      expense: expense.id,
      transfer: transfer.transfer.id,
      fee: transfer.fee?.id as string,
      salary: salary.template.id,
      accepted: accepted.entry.id,
      gym: gym.template.id,
      skip: skip.id,
    };
  });
}

/** The current version of every versioned row a user owns, by id. */
async function versionsOf(userId: string): Promise<Versions> {
  return withUser(harness.db, { userId }, async (tx) => {
    const versions: Record<string, number> = {};
    for (const table of [
      'positions',
      'position_valuations',
      'income_entries',
      'expense_entries',
      'transfers',
      'recurring_templates',
      'recurring_template_terms',
    ]) {
      const result = await tx.execute(sql`SELECT id, version FROM ${sql.identifier(table)}`);
      for (const row of result.rows as { id: string; version: number }[]) versions[row.id] = row.version;
    }
    return versions;
  });
}

/**
 * Every row of every user-owned table, read as this user (RLS on), as
 * canonical JSON text, sorted. Two snapshots are equal exactly when nothing
 * this user can see was inserted, changed or removed.
 */
async function snapshotOf(userId: string): Promise<Record<string, string[]>> {
  return withUser(harness.db, { userId }, async (tx) => {
    const tables: Record<string, string[]> = {};
    for (const table of USER_OWNED_TABLES) {
      const result = await tx.execute(
        sql`SELECT to_jsonb(t)::text AS row FROM ${sql.identifier(table)} t`,
      );
      tables[table] = (result.rows as { row: string }[]).map((row) => row.row).sort();
    }
    return tables;
  });
}

async function snapshotBoth() {
  return { a: await snapshotOf(USER_A), b: await snapshotOf(USER_B) };
}

/* -------------------------------------------------------------------------- */
/* Outcomes                                                                    */
/* -------------------------------------------------------------------------- */

type Outcome =
  | { readonly kind: 'resolved'; readonly value: unknown }
  | {
      readonly kind: 'rejected';
      readonly error: {
        readonly name: string;
        readonly code: string | undefined;
        readonly message: string;
        readonly fieldErrors: unknown;
      };
    };

async function outcomeOf(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { kind: 'resolved', value: await run() };
  } catch (error) {
    if (error instanceof DomainError) {
      return {
        kind: 'rejected',
        error: {
          name: error.name,
          code: error.code,
          message: error.message,
          fieldErrors: error.fieldErrors ?? null,
        },
      };
    }
    const unknown = error as Error;
    return {
      kind: 'rejected',
      error: { name: unknown.name, code: undefined, message: unknown.message, fieldErrors: null },
    };
  }
}

/** The same keys as `ids`, each naming a record that exists nowhere. */
function stranger(ids: WorldIds): WorldIds {
  return Object.fromEntries(Object.keys(ids).map((key) => [key, randomUUID()])) as unknown as WorldIds;
}

/* -------------------------------------------------------------------------- */
/* The fixture                                                                 */
/* -------------------------------------------------------------------------- */

let A: WorldIds;
let B: WorldIds;
let versionsB: Versions;

/** A's period-keyed pages, read before and after B's records exist. */
let aBeforeB: Record<string, unknown>;
let aAfterB: Record<string, unknown>;

/**
 * Every read keyed by a period or by nothing, as A sees it today. The oracle
 * needs no knowledge of a page's shape: whatever A sees must not move when B's
 * records appear.
 */
const PERIOD_READS: readonly (readonly [string, () => Promise<unknown>])[] = [
  ['getMonthlyPage, completed month', () => getMonthlyPage(flows(), AS_A, SEPTEMBER)],
  ['getMonthlyPage, current month', () => getMonthlyPage(flows(), AS_A, OCTOBER)],
  ['getSpendingPage, last completed month', () => getSpendingPage(flows(), AS_A, {})],
  ['getSpendingPage, current month', () => getSpendingPage(flows(), AS_A, { month: '2026-10' })],
  ['getIncomePage', () => getIncomePage(flows(), AS_A, {})],
  ['getBulkHistoryPage', () => getBulkHistoryPage(reads(), AS_A, parseMonth('2026-08'))],
  ['getNetWorth', () => getNetWorth(positions(), AS_A)],
];

async function periodReads(): Promise<Record<string, unknown>> {
  const pages: Record<string, unknown> = {};
  for (const [label, read] of PERIOD_READS) pages[label] = await read();
  return pages;
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

  A = await buildWorld(USER_A, { unexplained: 0, review: false });
  aBeforeB = await periodReads();
  B = await buildWorld(USER_B, { unexplained: 500, review: true });
  aAfterB = await periodReads();
  versionsB = await versionsOf(USER_B);
}, 240_000);

afterAll(async () => {
  await harness?.close();
});

/* -------------------------------------------------------------------------- */
/* Every financial mutation                                                    */
/* -------------------------------------------------------------------------- */

interface Attempt {
  /** What of B's the attempt goes through. */
  readonly label: string;
  /** The call as A, given B's ids or ids that exist nowhere. */
  readonly run: (ids: WorldIds) => Promise<unknown>;
}

type MutationCase =
  | { readonly takes: 'id'; readonly attempts: readonly Attempt[] }
  | {
      readonly takes: 'nothing of another user';
      readonly reason: string;
      readonly run: () => Promise<unknown>;
      /** What it answers today. */
      readonly answers: (outcome: Outcome) => void;
    };

const version = (id: string): number => versionsB[id] as number;

/**
 * Historical Correction drafts, one per kind and per kind of record named,
 * each naming B's records — the operations a correction's Confirm (and its
 * Preview) resolve before anything else. Built on demand, because the ids and
 * versions exist only once the fixture does.
 */
type BulkOperation = Extract<CorrectionDraft, { kind: 'bulk_history' }>['operations'][number];
/** One grid cell. Its amounts are canonical (`'1'`), as the grid sends them. */
const bulk = (operation: BulkOperation): CorrectionDraft => ({
  kind: 'bulk_history',
  startMonth: '2026-08',
  operations: [operation],
});

const CORRECTION_DRAFTS: readonly (readonly [string, (ids: WorldIds) => CorrectionDraft])[] = [
  [
    'valuation_create: an account',
    (ids) => ({ kind: 'valuation_create', positionId: ids.checking, valuedOn: '2026-09-15', amount: '1.00', datePrecision: 'exact' }),
  ],
  [
    'valuation_update: the balance',
    (ids) => ({
      kind: 'valuation_update',
      valuationId: ids.septemberEnd,
      expectedVersion: version(B.septemberEnd),
      valuedOn: '2026-09-30',
      amount: '1.00',
      datePrecision: 'month_end',
    }),
  ],
  [
    'valuation_delete: the balance',
    (ids) => ({ kind: 'valuation_delete', valuationId: ids.septemberEnd, expectedVersion: version(B.septemberEnd) }),
  ],
  [
    'quick_update: an account',
    (ids) => ({ kind: 'quick_update', entries: [{ positionId: ids.checking, amount: '1.00' }] }),
  ],
  [
    'income_create: an account',
    (ids) => ({
      kind: 'income_create',
      incomeKind: 'other',
      receivedOn: '2026-09-15',
      netAmount: '1.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: ids.checking,
    }),
  ],
  [
    'income_update: the entry',
    (ids) => ({ kind: 'income_update', entryId: ids.income, expectedVersion: version(B.income), netAmount: '1.00' }),
  ],
  [
    'income_delete: the entry',
    (ids) => ({ kind: 'income_delete', entryId: ids.income, expectedVersion: version(B.income) }),
  ],
  [
    'expense_create: a category',
    (ids) => ({
      kind: 'expense_create',
      categoryId: ids.groceries,
      incurredOn: '2026-09-15',
      amount: '1.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: A.checking,
    }),
  ],
  [
    'expense_create: an account',
    (ids) => ({
      kind: 'expense_create',
      categoryId: A.groceries,
      incurredOn: '2026-09-15',
      amount: '1.00',
      currency: 'EUR',
      settlement: 'tracked_cash',
      cashPositionId: ids.checking,
    }),
  ],
  [
    'expense_update: the entry',
    (ids) => ({ kind: 'expense_update', entryId: ids.expense, expectedVersion: version(B.expense), amount: '1.00' }),
  ],
  [
    'expense_delete: the entry',
    (ids) => ({ kind: 'expense_delete', entryId: ids.expense, expectedVersion: version(B.expense) }),
  ],
  [
    'transfer_create: the source account',
    (ids) => ({
      kind: 'transfer_create',
      occurredOn: '2026-09-15',
      fromPositionId: ids.checking,
      toPositionId: A.checking,
      fromAmount: '1.00',
      toAmount: '1.00',
    }),
  ],
  [
    'transfer_create: the destination account',
    (ids) => ({
      kind: 'transfer_create',
      occurredOn: '2026-09-15',
      fromPositionId: A.checking,
      toPositionId: ids.checking,
      fromAmount: '1.00',
      toAmount: '1.00',
    }),
  ],
  [
    'transfer_update: the transfer',
    (ids) => ({
      kind: 'transfer_update',
      transferId: ids.transfer,
      expectedVersion: version(B.transfer),
      occurredOn: '2026-09-10',
      fromPositionId: ids.checking,
      toPositionId: ids.savings,
      fromAmount: '1.00',
      toAmount: '1.00',
      description: null,
      fee: null,
      expectedFee: { state: 'version', feeId: ids.fee, version: version(B.fee) },
    }),
  ],
  [
    'transfer_delete: the transfer',
    (ids) => ({
      kind: 'transfer_delete',
      transferId: ids.transfer,
      expectedVersion: version(B.transfer),
      expectedFees: [{ feeId: ids.fee, version: version(B.fee) }],
    }),
  ],
  [
    'accept_suggestion: a template',
    (ids) => ({ kind: 'accept_suggestion', templateId: ids.gym, occurrenceDate: '2026-10-05' }),
  ],
  [
    'confirm_unchanged: an account',
    (ids) => ({ kind: 'confirm_unchanged', positionId: ids.savings, month: '2026-09' }),
  ],
  [
    'confirm_unchanged_batch: an account',
    (ids) => ({ kind: 'confirm_unchanged_batch', month: '2026-09', positionIds: [ids.savings] }),
  ],
  [
    'cash_account_update: the account',
    (ids) => ({ kind: 'cash_account_update', positionId: ids.checking, expectedVersion: version(B.checking), name: 'Taken' }),
  ],
  [
    'bulk_history valuation_create: an account',
    (ids) => bulk({ kind: 'valuation_create', positionId: ids.checking, month: '2026-08', amount: '1' }),
  ],
  [
    'bulk_history valuation_update: the balance',
    (ids) =>
      bulk({
        kind: 'valuation_update',
        positionId: ids.checking,
        month: '2026-09',
        valuationId: ids.septemberEnd,
        expectedVersion: version(B.septemberEnd),
        amount: '1',
      }),
  ],
  [
    'bulk_history valuation_clear: the balance',
    (ids) =>
      bulk({
        kind: 'valuation_clear',
        positionId: ids.checking,
        month: '2026-09',
        valuationId: ids.septemberEnd,
        expectedVersion: version(B.septemberEnd),
      }),
  ],
  [
    'bulk_history income_create: a template',
    (ids) => bulk({ kind: 'income_create', templateId: ids.salary, occurrenceDate: '2026-09-25', netAmount: '1' }),
  ],
  [
    'bulk_history income_update: the entry',
    (ids) =>
      bulk({
        kind: 'income_update',
        templateId: ids.salary,
        occurrenceDate: '2026-09-25',
        entryId: ids.accepted,
        expectedVersion: version(B.accepted),
        netAmount: '1',
      }),
  ],
  [
    'bulk_history income_clear: the entry',
    (ids) =>
      bulk({
        kind: 'income_clear',
        templateId: ids.salary,
        occurrenceDate: '2026-09-25',
        entryId: ids.accepted,
        expectedVersion: version(B.accepted),
      }),
  ],
];

const MUTATION_CASES: Readonly<Record<string, MutationCase>> = {
  /* ------------------------------------------------- positions/service ---- */
  createCashAccount: {
    takes: 'nothing of another user',
    reason: 'a currency and the account’s own details only',
    run: () =>
      createCashAccount(positions(), AS_A, { name: 'Probe', currency: 'EUR', accountType: 'checking', openedOn: null }),
    answers: (outcome) => expect(outcome).toMatchObject({ kind: 'resolved', value: { userId: USER_A } }),
  },
  createOtherAsset: {
    takes: 'nothing of another user',
    reason: 'a currency and the asset’s own details only',
    run: () =>
      createOtherAsset(positions(), AS_A, {
        name: 'Probe',
        currency: 'EUR',
        assetType: 'collectible',
        includeInFinancialNetWorth: false,
      }),
    answers: (outcome) => expect(outcome).toMatchObject({ kind: 'resolved', value: { userId: USER_A } }),
  },
  updateCashAccount: {
    takes: 'id',
    attempts: [
      {
        label: 'the account',
        run: (ids) =>
          updateCashAccount(positions(), AS_A, {
            positionId: ids.checking,
            expectedVersion: version(B.checking),
            name: 'Taken',
          }),
      },
    ],
  },
  updateOtherAsset: {
    takes: 'id',
    attempts: [
      {
        label: 'the asset',
        run: (ids) =>
          updateOtherAsset(positions(), AS_A, {
            positionId: ids.car,
            expectedVersion: version(B.car),
            includeInFinancialNetWorth: true,
          }),
      },
    ],
  },
  closePosition: {
    takes: 'id',
    attempts: [
      {
        label: 'the account',
        run: (ids) =>
          closePosition(positions(), AS_A, { positionId: ids.spare, expectedVersion: version(B.spare), closedOn: TODAY }),
      },
    ],
  },
  removePosition: {
    takes: 'id',
    attempts: [{ label: 'the account', run: (ids) => removePosition(positions(), AS_A, ids.spare) }],
  },

  /* ---------------------------------------------- positions/valuations ---- */
  recordValuation: {
    takes: 'id',
    attempts: [
      {
        label: 'an account',
        run: (ids) =>
          recordValuation(positions(), AS_A, {
            positionId: ids.checking,
            valuedOn: TODAY,
            amount: '1.00',
            datePrecision: 'exact',
          }),
      },
    ],
  },
  correctValuation: {
    takes: 'id',
    attempts: [
      {
        label: 'the balance',
        run: (ids) =>
          correctValuation(positions(), AS_A, {
            valuationId: ids.latest,
            expectedVersion: version(B.latest),
            valuedOn: '2026-10-04',
            amount: '1.00',
            datePrecision: 'exact',
          }),
      },
    ],
  },
  removeValuation: {
    takes: 'id',
    attempts: [
      {
        label: 'the balance',
        run: (ids) => removeValuation(positions(), AS_A, { valuationId: ids.latest, expectedVersion: version(B.latest) }),
      },
    ],
  },
  confirmMonthEnd: {
    takes: 'id',
    attempts: [
      {
        label: 'the balance',
        run: (ids) =>
          confirmMonthEnd(positions(), AS_A, { valuationId: ids.carSnapshot, expectedVersion: version(B.carSnapshot) }),
      },
    ],
  },
  confirmUnchanged: {
    takes: 'id',
    attempts: [
      {
        label: 'the account',
        run: (ids) => confirmUnchanged(positions(), AS_A, { positionId: ids.savings, month: '2026-09' }),
      },
    ],
  },
  confirmUnchangedBatch: {
    takes: 'id',
    attempts: [
      {
        label: 'the account, alone',
        run: (ids) => confirmUnchangedBatch(positions(), AS_A, { month: '2026-09', positionIds: [ids.savings] }),
      },
      {
        label: 'the account, beside one of A’s own',
        run: (ids) =>
          confirmUnchangedBatch(positions(), AS_A, { month: '2026-09', positionIds: [A.savings, ids.savings] }),
      },
    ],
  },
  quickUpdate: {
    takes: 'id',
    attempts: [
      {
        label: 'an account, alone',
        run: (ids) => quickUpdate(positions(), AS_A, { entries: [{ positionId: ids.checking, amount: '1.00' }] }),
      },
      {
        label: 'an account, beside one of A’s own',
        run: (ids) =>
          quickUpdate(positions(), AS_A, {
            entries: [
              { positionId: A.checking, amount: '1.00' },
              { positionId: ids.checking, amount: '1.00' },
            ],
          }),
      },
    ],
  },

  /* ------------------------------------------------------ flows/income ---- */
  createIncomeEntry: {
    takes: 'id',
    attempts: [
      {
        label: 'an account',
        run: (ids) =>
          createIncomeEntry(flows(), AS_A, {
            kind: 'other',
            receivedOn: TODAY,
            netAmount: '1.00',
            currency: 'EUR',
            settlement: 'tracked_cash',
            cashPositionId: ids.checking,
          }),
      },
    ],
  },
  updateIncomeEntry: {
    takes: 'id',
    attempts: [
      {
        label: 'the entry',
        run: (ids) =>
          updateIncomeEntry(flows(), AS_A, { entryId: ids.income, expectedVersion: version(B.income), netAmount: '1.00' }),
      },
    ],
  },
  deleteIncomeEntry: {
    takes: 'id',
    attempts: [
      {
        label: 'the entry',
        run: (ids) => deleteIncomeEntry(flows(), AS_A, { entryId: ids.income, expectedVersion: version(B.income) }),
      },
    ],
  },

  /* ---------------------------------------------------- flows/expenses ---- */
  createExpenseEntry: {
    takes: 'id',
    attempts: [
      {
        label: 'an account',
        run: (ids) =>
          createExpenseEntry(flows(), AS_A, {
            categoryId: A.groceries,
            incurredOn: TODAY,
            amount: '1.00',
            currency: 'EUR',
            settlement: 'tracked_cash',
            cashPositionId: ids.checking,
          }),
      },
      {
        label: 'a category',
        run: (ids) =>
          createExpenseEntry(flows(), AS_A, {
            categoryId: ids.groceries,
            incurredOn: TODAY,
            amount: '1.00',
            currency: 'EUR',
            settlement: 'tracked_cash',
            cashPositionId: A.checking,
          }),
      },
    ],
  },
  updateExpenseEntry: {
    takes: 'id',
    attempts: [
      {
        label: 'the entry',
        run: (ids) =>
          updateExpenseEntry(flows(), AS_A, { entryId: ids.expense, expectedVersion: version(B.expense), amount: '1.00' }),
      },
    ],
  },
  deleteExpenseEntry: {
    takes: 'id',
    attempts: [
      {
        label: 'the entry',
        run: (ids) => deleteExpenseEntry(flows(), AS_A, { entryId: ids.expense, expectedVersion: version(B.expense) }),
      },
    ],
  },

  /* --------------------------------------------------- flows/transfers ---- */
  // A fee's payer must be one of its own transfer's accounts, so it is not a
  // separate case: either side of the transfer is.
  createCashTransfer: {
    takes: 'id',
    attempts: [
      {
        label: 'the source account',
        run: (ids) =>
          createCashTransfer(flows(), AS_A, {
            occurredOn: TODAY,
            fromPositionId: ids.checking,
            toPositionId: A.checking,
            fromAmount: '1.00',
            toAmount: '1.00',
          }),
      },
      {
        label: 'the destination account',
        run: (ids) =>
          createCashTransfer(flows(), AS_A, {
            occurredOn: TODAY,
            fromPositionId: A.checking,
            toPositionId: ids.checking,
            fromAmount: '1.00',
            toAmount: '1.00',
          }),
      },
    ],
  },
  updateCashTransfer: {
    takes: 'id',
    attempts: [
      {
        label: 'the transfer',
        run: (ids) =>
          updateCashTransfer(flows(), AS_A, {
            transferId: ids.transfer,
            expectedVersion: version(B.transfer),
            occurredOn: '2026-09-10',
            fromPositionId: ids.checking,
            toPositionId: ids.savings,
            fromAmount: '1.00',
            toAmount: '1.00',
            description: null,
            fee: null,
            expectedFee: { state: 'version', feeId: ids.fee, version: version(B.fee) },
          }),
      },
    ],
  },
  deleteCashTransfer: {
    takes: 'id',
    attempts: [
      {
        label: 'the transfer',
        run: (ids) =>
          deleteCashTransfer(flows(), AS_A, {
            transferId: ids.transfer,
            expectedVersion: version(B.transfer),
            expectedFees: [{ feeId: ids.fee, version: version(B.fee) }],
          }),
      },
    ],
  },

  /* -------------------------------------------------- flows/adjustments ---- */
  acceptUnexplainedInflowAsAdjustment: {
    takes: 'nothing of another user',
    reason: 'a month, a currency and the amount the page showed; the bucket is always the caller’s own',
    // B's own figures: B's September shows 500.00 unexplained, A's shows none.
    run: () =>
      acceptUnexplainedInflowAsAdjustment(flows(), AS_A, { month: SEPTEMBER, currency: 'EUR', expectedAmount: '500' }),
    answers: (outcome) =>
      expect(outcome).toMatchObject({ kind: 'rejected', error: { code: 'CONFLICT_VERSION' } }),
  },

  /* ------------------------------------------------ recurring/templates ---- */
  createTemplate: {
    takes: 'id',
    attempts: [
      {
        label: 'an account',
        run: (ids) =>
          createTemplate(flows(), AS_A, {
            kind: 'income',
            name: 'Probe',
            incomeKind: 'employment',
            currency: 'EUR',
            frequency: 'monthly',
            dayOfMonth: 1,
            startDate: '2026-10-01',
            cashPositionId: ids.checking,
            amount: '1.00',
          }),
      },
      {
        label: 'a category',
        run: (ids) =>
          createTemplate(flows(), AS_A, {
            kind: 'expense',
            name: 'Probe',
            categoryId: ids.groceries,
            currency: 'EUR',
            frequency: 'monthly',
            dayOfMonth: 1,
            startDate: '2026-10-01',
            cashPositionId: A.checking,
            amount: '1.00',
          }),
      },
    ],
  },
  updateTemplateDetails: {
    takes: 'id',
    attempts: [
      {
        label: 'the template',
        run: (ids) =>
          updateTemplateDetails(flows(), AS_A, {
            templateId: ids.salary,
            expectedVersion: version(B.salary),
            name: 'Taken',
          }),
      },
    ],
  },
  archiveTemplate: {
    takes: 'id',
    attempts: [
      {
        label: 'the template',
        run: (ids) => archiveTemplate(flows(), AS_A, { templateId: ids.salary, expectedVersion: version(B.salary) }),
      },
    ],
  },
  unarchiveTemplate: {
    takes: 'id',
    attempts: [
      {
        label: 'the template',
        run: (ids) => unarchiveTemplate(flows(), AS_A, { templateId: ids.salary, expectedVersion: version(B.salary) }),
      },
    ],
  },
  setTemplateTerm: {
    takes: 'id',
    attempts: [
      {
        label: 'a template, inserting a term',
        run: (ids) =>
          setTemplateTerm(flows(), AS_A, {
            templateId: ids.salary,
            effectiveFrom: '2026-11-25',
            amount: '1.00',
            expected: { state: 'absent' },
          }),
      },
      {
        label: 'a template, updating its opening term',
        run: (ids) =>
          setTemplateTerm(flows(), AS_A, {
            templateId: ids.salary,
            effectiveFrom: '2026-09-01',
            amount: '1.00',
            // The opening term's own version: it was never edited.
            expected: { state: 'version', version: 1 },
          }),
      },
    ],
  },

  /* ---------------------------------------------- recurring/suggestions ---- */
  acceptSuggestion: {
    takes: 'id',
    attempts: [
      {
        label: 'a template',
        run: (ids) => acceptSuggestion(flows(), AS_A, { templateId: ids.gym, occurrenceDate: '2026-10-05' }),
      },
    ],
  },
  skipSuggestion: {
    takes: 'id',
    attempts: [
      {
        label: 'a template',
        run: (ids) =>
          skipSuggestion(flows(), AS_A, { templateId: ids.gym, occurrenceDate: '2026-10-05', reason: 'skipped' }),
      },
    ],
  },
  unskipSuggestion: {
    takes: 'id',
    attempts: [{ label: 'the skip', run: (ids) => unskipSuggestion(flows(), AS_A, { skipId: ids.skip }) }],
  },

  /* --------------------------------------------------- settings/service ---- */
  setCountAdditionalSpending: {
    takes: 'nothing of another user',
    reason: 'a flag on the caller’s own settings, addressed by the session’s user',
    run: async () => {
      const settings = await readSettings(harness.db, USER_A);
      return setCountAdditionalSpending(
        harness.services.settings,
        USER_A,
        settings.version,
        !settings.countAdditionalSpending,
      );
    },
    answers: (outcome) => expect(outcome).toMatchObject({ kind: 'resolved', value: { userId: USER_A } }),
  },

  /* -------------------------------------------------- corrections/confirm -- */
  confirmHistoricalCorrection: {
    takes: 'id',
    attempts: CORRECTION_DRAFTS.map(([label, draft]) => ({
      label,
      run: (ids: WorldIds) =>
        confirmHistoricalCorrection(corrections(), AS_A, {
          draft: draft(ids),
          fingerprint: 'not-a-fingerprint',
        }),
    })),
  },
};

describe('every financial mutation, as user A with user B’s ids (21.4)', () => {
  it('has one case per registered mutation, and no other', () => {
    expect(Object.keys(MUTATION_CASES).sort()).toEqual([...REGISTERED_MUTATIONS].sort());
  });

  it('starts from two worlds that each hold their own records', async () => {
    const { a, b } = await snapshotBoth();
    for (const table of ['positions', 'position_valuations', 'income_entries', 'expense_entries', 'transfers',
      'recurring_templates', 'recurring_template_terms', 'recurring_template_skips']) {
      expect(a[table]?.length, `A's ${table}`).toBeGreaterThan(0);
      expect(b[table]?.length, `B's ${table}`).toEqual(a[table]?.length);
    }
    // Only B reviewed September, and its audit trail holds those two writes too.
    expect(b.month_reviews).toHaveLength(1);
    expect(a.month_reviews).toHaveLength(0);
    expect(b.audit_entries?.length).toBe((a.audit_entries?.length ?? 0) + 2);
  });

  const idCases = Object.entries(MUTATION_CASES).filter(
    (entry): entry is [string, Extract<MutationCase, { takes: 'id' }>] => entry[1].takes === 'id',
  );

  describe.each(idCases)('%s', (_name, mutation) => {
    it.each(mutation.attempts.map((attempt) => [attempt.label, attempt] as const))(
      'through %s: NOT_FOUND, answered as for an id that exists nowhere, and nothing changes',
      async (_label, attempt) => {
        const before = await snapshotBoth();

        const withB = await outcomeOf(() => attempt.run(B));
        const withNobody = await outcomeOf(() => attempt.run(stranger(B)));

        expect(withB).toMatchObject({ kind: 'rejected', error: { code: 'NOT_FOUND' } });
        expect(withB).toEqual(withNobody);
        expect(await snapshotBoth()).toEqual(before);
      },
    );
  });

  const noIdCases = Object.entries(MUTATION_CASES).filter(
    (entry): entry is [string, Extract<MutationCase, { takes: 'nothing of another user' }>] =>
      entry[1].takes === 'nothing of another user',
  );

  it.each(noIdCases)('%s takes no id of another user, and changes nothing of B’s', async (_name, mutation) => {
    expect(mutation.reason.length).toBeGreaterThan(0);
    const before = await snapshotOf(USER_B);
    mutation.answers(await outcomeOf(mutation.run));
    expect(await snapshotOf(USER_B)).toEqual(before);
  });
});

/* -------------------------------------------------------------------------- */
/* Month review writes                                                         */
/* -------------------------------------------------------------------------- */

describe('the month review writes, which take a month rather than an id', () => {
  it('leave B’s review of the same month exactly as it was', async () => {
    const theirs = await readMonthReview(reads(), on(TODAY, USER_B), SEPTEMBER);
    expect(theirs.reviewedAt).not.toBeNull();
    expect(theirs.dismissedIssueKeys).toEqual(['possible_missing_interest']);
    const before = await snapshotOf(USER_B);

    await markMonthReviewed(reads(), AS_A, SEPTEMBER);
    await dismissMonthAdvisory(reads(), AS_A, SEPTEMBER, 'large_unclassified');
    // The key B dismissed: A has nothing to restore, and B's stays dismissed.
    await restoreMonthAdvisory(reads(), AS_A, SEPTEMBER, 'possible_missing_interest');

    expect(await snapshotOf(USER_B)).toEqual(before);
    expect(await readMonthReview(reads(), on(TODAY, USER_B), SEPTEMBER)).toEqual(theirs);

    // A's writes landed on A's own row.
    const mine = await readMonthReview(reads(), AS_A, SEPTEMBER);
    expect(mine.reviewedAt).not.toBeNull();
    expect(mine.dismissedIssueKeys).toEqual(['large_unclassified']);
  });
});

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

describe('every read that takes an id, as user A with user B’s ids', () => {
  const ID_READS: readonly (readonly [string, (ids: WorldIds) => Promise<unknown>])[] = [
    ['getPositionDetail: a cash account', (ids) => getPositionDetail(positions(), AS_A, ids.checking)],
    ['getPositionDetail: an other asset', (ids) => getPositionDetail(positions(), AS_A, ids.car)],
    ['getIncomeSourcePage: a template', (ids) => getIncomeSourcePage(reads(), AS_A, { templateId: ids.salary })],
    ...CORRECTION_DRAFTS.map(
      ([label, draft]) =>
        [
          `previewHistoricalCorrection: ${label}`,
          (ids: WorldIds) => previewHistoricalCorrection(corrections(), AS_A, { draft: draft(ids) }),
        ] as const,
    ),
  ];

  it.each(ID_READS)('%s: NOT_FOUND, answered as for an id that exists nowhere', async (_label, read) => {
    const before = await snapshotBoth();
    const withB = await outcomeOf(() => read(B));
    const withNobody = await outcomeOf(() => read(stranger(B)));

    expect(withB).toMatchObject({ kind: 'rejected', error: { code: 'NOT_FOUND' } });
    expect(withB).toEqual(withNobody);
    expect(await snapshotBoth()).toEqual(before);
  });
});

describe('every read keyed by a period or by nothing', () => {
  it('reads A’s own records, so an unchanged page is evidence rather than an empty one', () => {
    const september = aBeforeB['getMonthlyPage, completed month'] as CompletedMonthlyPageDto;
    expect(september.reconciliation.status).toBe('reliable');
    expect(september.reconciliation.buckets[0]?.totals.trackedTotalSpending?.amount).toBe('302');
    expect(september.income.direct.length).toBeGreaterThan(0);
    const netWorth = aBeforeB.getNetWorth as NetWorthDto;
    expect(netWorth.positions.map((p) => p.name).sort()).toEqual(['Car', 'Checking', 'Savings', 'Spare']);
  });

  it.each(PERIOD_READS.map(([label]) => label))(
    '%s: what A sees is identical before and after B’s records exist',
    (label) => {
      expect(aBeforeB[label]).toBeDefined();
      expect(aAfterB[label]).toEqual(aBeforeB[label]);
    },
  );
});
