import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, withUser, withoutUser } from '@vaultide/db';
import { minorUnitsMessage } from '@vaultide/validation';
import { createHarness, type Harness } from '../helpers/harness';
import { testContext, type RequestContext } from '../../src/context';
import { ValidationError } from '../../src/errors';
import { provisionUser } from '../../src/users/provisioning';
import { listCategories } from '../../src/users/categories';
import {
  createCashAccount,
  createOtherAsset,
  updateOtherAsset,
} from '../../src/positions/service';
import { correctValuation, quickUpdate, recordValuation } from '../../src/positions/valuations';
import { createIncomeEntry, updateIncomeEntry } from '../../src/flows/income';
import { createExpenseEntry, updateExpenseEntry } from '../../src/flows/expenses';
import { createCashTransfer, updateCashTransfer } from '../../src/flows/transfers';
import { createTemplate, setTemplateTerm } from '../../src/recurring/templates';
import { acceptSuggestion } from '../../src/recurring/suggestions';
import {
  confirmHistoricalCorrection,
  previewHistoricalCorrection,
  type BulkHistoryOperation,
  type CorrectionDraft,
} from '../../src/corrections/index';

/**
 * Input scale on every write that takes an amount from the request (blueprint
 * 7.2 "Input scale").
 *
 * The server's input schemas hold an amount only to the storage scale of 8, so
 * each of these writes is sent an amount its currency does not allow and must
 * refuse it in the domain — keyed to the field, or to the cell in Bulk History,
 * in the browser's own words — having written no row and no audit entry.
 *
 * The currencies are ones the product lets an account carry: EUR (2 decimals),
 * JPY (0) and KWD (3), all on the approved FX chain. CLF (4) is not — it has no
 * approved rate source — so the four-decimal case is covered by the unit suite.
 *
 * `today` is 5 October 2026: September has closed.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';

let harness: Harness;
let eur: string;
let eurSavings: string;
let yen: string;
let dinar: string;
let groceries: string;

const OCT_5: RequestContext = testContext({
  today: '2026-10-05',
  userId: USER_A,
  reportingCurrency: 'EUR',
});

const EUR = minorUnitsMessage(2);
const JPY = minorUnitsMessage(0);
const KWD = minorUnitsMessage(3);

const positions = () => harness.services.positions;
const flows = () => harness.services.flows;
const corrections = () => harness.services.corrections;

const FINANCIAL_TABLES = [
  'positions',
  'cash_accounts',
  'other_assets',
  'position_valuations',
  'income_entries',
  'expense_entries',
  'transfers',
  'recurring_templates',
  'recurring_template_terms',
  'recurring_template_skips',
  'audit_entries',
] as const;

async function createAuthUser(id: string, email: string): Promise<void> {
  await withoutUser(harness.db, async (tx) => {
    await tx.execute(
      sql`INSERT INTO "user" (id, name, email, email_verified)
          VALUES (${id}, ${email}, ${email}, true)
          ON CONFLICT (id) DO NOTHING`,
    );
  });
}

/** Every financial table's row count, and the newest version on each row-versioned one. */
async function footprint(): Promise<Record<string, string>> {
  return withUser(harness.db, { userId: USER_A }, async (tx) => {
    const out: Record<string, string> = {};
    for (const table of FINANCIAL_TABLES) {
      const result = await tx.execute(
        sql`SELECT count(*)::text AS n FROM ${sql.identifier(table)}`,
      );
      out[table] = (result.rows[0] as { n: string }).n;
    }
    for (const table of ['income_entries', 'expense_entries', 'transfers', 'position_valuations']) {
      const result = await tx.execute(
        sql`SELECT coalesce(sum(version), 0)::text AS v FROM ${sql.identifier(table)}`,
      );
      out[`${table}.versions`] = (result.rows[0] as { v: string }).v;
    }
    return out;
  });
}

/**
 * Run a write that must be refused for its scale: a `ValidationError` with
 * exactly these field errors, and nothing written.
 */
async function expectScaleRefusal(
  run: () => Promise<unknown>,
  fieldErrors: Record<string, string[]>,
): Promise<void> {
  const before = await footprint();
  const outcome = await run().then(
    () => new Error('the write was expected to be refused, and it was saved'),
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(ValidationError);
  expect((outcome as ValidationError).fieldErrors).toEqual(fieldErrors);
  // The message is the first refusal's, in the order the write judges its
  // amounts — for a batch, its canonical cell order.
  expect(Object.values(fieldErrors).flat()).toContain((outcome as ValidationError).message);
  expect(await footprint()).toEqual(before);
}

/** The same draft, refused the same way by Preview and by Confirm. */
async function expectCorrectionRefusal(
  draft: CorrectionDraft,
  fieldErrors: Record<string, string[]>,
): Promise<void> {
  await expectScaleRefusal(
    () => previewHistoricalCorrection(corrections(), OCT_5, { draft }),
    fieldErrors,
  );
  // Confirm resolves the draft before it compares fingerprints, so a
  // well-formed one is enough to reach the rule.
  await expectScaleRefusal(
    () =>
      confirmHistoricalCorrection(corrections(), OCT_5, {
        draft,
        fingerprint: `hc-v1:${'0'.repeat(64)}`,
      }),
    fieldErrors,
  );
}

const account = async (name: string, currency: string): Promise<string> =>
  (
    await createCashAccount(positions(), OCT_5, {
      name,
      currency,
      accountType: 'checking',
      openedOn: null,
    })
  ).id;

const income = (overrides: Record<string, unknown> = {}) =>
  createIncomeEntry(flows(), OCT_5, {
    kind: 'employment',
    receivedOn: '2026-10-02',
    netAmount: '1000.00',
    currency: 'EUR',
    settlement: 'tracked_cash',
    cashPositionId: eur,
    ...overrides,
  });

const expense = (overrides: Record<string, unknown> = {}) =>
  createExpenseEntry(flows(), OCT_5, {
    categoryId: groceries,
    incurredOn: '2026-10-02',
    amount: '40.00',
    currency: 'EUR',
    settlement: 'tracked_cash',
    cashPositionId: eur,
    ...overrides,
  });

const transfer = (overrides: Record<string, unknown> = {}) =>
  createCashTransfer(flows(), OCT_5, {
    occurredOn: '2026-10-02',
    fromPositionId: eur,
    toPositionId: eurSavings,
    fromAmount: '100.00',
    toAmount: '100.00',
    ...overrides,
  });

async function salaryTemplate(currency = 'EUR', cashPositionId = eur): Promise<string> {
  const { template } = await createTemplate(flows(), OCT_5, {
    kind: 'income',
    name: `Salary ${currency}`,
    incomeKind: 'employment',
    currency,
    frequency: 'monthly',
    dayOfMonth: 1,
    startDate: '2026-01-01',
    cashPositionId,
    amount: '2100',
  });
  return template.id;
}

beforeAll(async () => {
  harness = await createHarness();
  await createAuthUser(USER_A, 'a@example.test');
  await provisionUser(harness.db, { userId: USER_A });
  const categories = await listCategories(harness.db, USER_A);
  groceries = categories.find((row) => row.kind === 'food')?.id as string;
}, 240_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  for (const table of [
    'expense_entries',
    'transfers',
    'income_entries',
    'recurring_template_skips',
    'recurring_template_terms',
    'recurring_templates',
    'month_reviews',
    'audit_entries',
    'position_valuations',
    'cash_accounts',
    'other_assets',
    'positions',
  ]) {
    await harness.asOwner(`DELETE FROM ${table}`);
  }

  eur = await account('BBVA', 'EUR');
  eurSavings = await account('Savings', 'EUR');
  yen = await account('Tokyo', 'JPY');
  dinar = await account('Kuwait', 'KWD');
});

/* -------------------------------------------------------------------------- */
/* Phase 3                                                                     */
/* -------------------------------------------------------------------------- */

describe('income entries', () => {
  it('refuses a net or a gross past EUR’s two decimals, on creation', async () => {
    await expectScaleRefusal(() => income({ netAmount: '10.123' }), { netAmount: [EUR] });
    await expectScaleRefusal(() => income({ grossAmount: '10.123' }), { grossAmount: [EUR] });
  });

  it('refuses them on a correction, in the stored entry’s currency', async () => {
    const entry = await income();
    const update = (patch: Record<string, unknown>) =>
      updateIncomeEntry(flows(), OCT_5, {
        entryId: entry.id,
        expectedVersion: entry.version,
        ...patch,
      });
    await expectScaleRefusal(() => update({ netAmount: '10.123' }), { netAmount: [EUR] });
    await expectScaleRefusal(() => update({ grossAmount: '10.123' }), { grossAmount: [EUR] });
  });

  it('holds a no-decimal currency to whole amounts, and keeps one', async () => {
    const yenIncome = (netAmount: string) =>
      income({ currency: 'JPY', cashPositionId: yen, netAmount });
    await expectScaleRefusal(() => yenIncome('1.5'), { netAmount: [JPY] });
    expect((await yenIncome('2')).netAmount).toBe('2.00000000');
  });

  it('keeps a three-decimal currency at its limit and refuses one decimal past it', async () => {
    const dinarIncome = (netAmount: string) =>
      income({ currency: 'KWD', cashPositionId: dinar, netAmount });
    expect((await dinarIncome('1.234')).netAmount).toBe('1.23400000');
    await expectScaleRefusal(() => dinarIncome('1.2345'), { netAmount: [KWD] });
  });
});

describe('expense entries', () => {
  it('refuses an amount past EUR’s two decimals, on creation and on a correction', async () => {
    await expectScaleRefusal(() => expense({ amount: '10.123' }), { amount: [EUR] });

    const entry = await expense();
    await expectScaleRefusal(
      () =>
        updateExpenseEntry(flows(), OCT_5, {
          entryId: entry.id,
          expectedVersion: entry.version,
          amount: '10.123',
        }),
      { amount: [EUR] },
    );
  });
});

describe('transfers', () => {
  it('judges each leg in its own account’s currency', async () => {
    await expectScaleRefusal(
      () => transfer({ toPositionId: yen, fromAmount: '10.123', toAmount: '1500' }),
      { fromAmount: [EUR] },
    );
    await expectScaleRefusal(
      () =>
        transfer({ fromPositionId: yen, toPositionId: eur, fromAmount: '1500', toAmount: '10.123' }),
      { toAmount: [EUR] },
    );
    await expectScaleRefusal(
      () => transfer({ toPositionId: yen, fromAmount: '10.12', toAmount: '1500.5' }),
      { toAmount: [JPY] },
    );
  });

  it('judges the fee in its payer’s currency', async () => {
    await expectScaleRefusal(
      () => transfer({ fee: { amount: '0.123', cashPositionId: eur, incurredOn: '2026-10-02' } }),
      { 'fee.amount': [EUR] },
    );
  });

  it('refuses the same on a correction of the whole aggregate', async () => {
    const saved = await transfer();
    await expectScaleRefusal(
      () =>
        updateCashTransfer(flows(), OCT_5, {
          transferId: saved.transfer.id,
          expectedVersion: saved.transfer.version,
          occurredOn: '2026-10-02',
          fromPositionId: eur,
          toPositionId: eurSavings,
          fromAmount: '100.005',
          toAmount: '100.005',
          description: null,
          fee: null,
          expectedFee: { state: 'absent' },
        }),
      { fromAmount: [EUR], toAmount: [EUR] },
    );
  });
});

describe('recurring sources', () => {
  it('refuses a template’s opening amount or gross past its currency', async () => {
    const create = (amounts: { amount: string; grossAmount?: string }) =>
      createTemplate(flows(), OCT_5, {
        kind: 'income',
        name: 'Salary',
        incomeKind: 'employment',
        currency: 'EUR',
        frequency: 'monthly',
        dayOfMonth: 1,
        startDate: '2026-01-01',
        ...amounts,
      });
    await expectScaleRefusal(() => create({ amount: '2100.001' }), { amount: [EUR] });
    await expectScaleRefusal(() => create({ amount: '2100', grossAmount: '3000.001' }), {
      grossAmount: [EUR],
    });
  });

  it('refuses a term in its template’s currency', async () => {
    const templateId = await salaryTemplate('JPY', yen);
    const term = (amounts: { amount: string; grossAmount?: string }) =>
      setTemplateTerm(flows(), OCT_5, {
        templateId,
        effectiveFrom: '2026-11-01',
        expected: { state: 'absent' },
        ...amounts,
      });
    await expectScaleRefusal(() => term({ amount: '2100.5' }), { amount: [JPY] });
    await expectScaleRefusal(() => term({ amount: '2100', grossAmount: '3000.5' }), {
      grossAmount: [JPY],
    });
  });

  it('refuses an occurrence accepted with its own amounts past the currency', async () => {
    const templateId = await salaryTemplate();
    const accept = (amounts: { amount?: string; grossAmount?: string }) =>
      acceptSuggestion(flows(), OCT_5, { templateId, occurrenceDate: '2026-10-01', ...amounts });
    await expectScaleRefusal(() => accept({ amount: '2100.001' }), { amount: [EUR] });
    await expectScaleRefusal(() => accept({ grossAmount: '3000.001' }), { grossAmount: [EUR] });
  });

  it('judges only what the request states: a stored term is carried as it stands', async () => {
    // A term stored before the rule existed, past its currency's scale. Accepting
    // at the term's amount copies a stored figure the user did not type here, so
    // it is not refused; stating an amount is.
    const templateId = await salaryTemplate();
    await harness.asOwner(
      `UPDATE recurring_template_terms SET amount = '2100.005' WHERE template_id = $1`,
      [templateId],
    );
    const accepted = await acceptSuggestion(flows(), OCT_5, {
      templateId,
      occurrenceDate: '2026-10-01',
    });
    expect(accepted.kind === 'income' ? accepted.entry.netAmount : null).toBe('2100.00500000');
  });
});

describe('Historical Correction drafts', () => {
  it('refuse in Preview and in Confirm exactly what the ordinary write refuses', async () => {
    const september = await income({ receivedOn: '2026-09-10' });
    const fee = await expense({ incurredOn: '2026-09-10' });
    const moved = await transfer({ occurredOn: '2026-09-10' });
    const templateId = await salaryTemplate();

    const cases: [CorrectionDraft, Record<string, string[]>][] = [
      [
        {
          kind: 'income_create',
          incomeKind: 'employment',
          receivedOn: '2026-09-11',
          netAmount: '10.123',
          currency: 'EUR',
          settlement: 'tracked_cash',
          cashPositionId: eur,
        },
        { netAmount: [EUR] },
      ],
      [
        {
          kind: 'income_update',
          entryId: september.id,
          expectedVersion: september.version,
          netAmount: '10.123',
        },
        { netAmount: [EUR] },
      ],
      [
        {
          kind: 'expense_create',
          categoryId: groceries,
          incurredOn: '2026-09-11',
          amount: '10.123',
          currency: 'EUR',
          settlement: 'tracked_cash',
          cashPositionId: eur,
        },
        { amount: [EUR] },
      ],
      [
        { kind: 'expense_update', entryId: fee.id, expectedVersion: fee.version, amount: '10.123' },
        { amount: [EUR] },
      ],
      [
        {
          kind: 'transfer_create',
          occurredOn: '2026-09-11',
          fromPositionId: eur,
          toPositionId: yen,
          fromAmount: '10.123',
          toAmount: '1500',
        },
        { fromAmount: [EUR] },
      ],
      [
        {
          kind: 'transfer_update',
          transferId: moved.transfer.id,
          expectedVersion: moved.transfer.version,
          occurredOn: '2026-09-10',
          fromPositionId: eur,
          toPositionId: eurSavings,
          fromAmount: '100.001',
          toAmount: '100.001',
          description: null,
          fee: null,
          expectedFee: { state: 'absent' },
        },
        { fromAmount: [EUR], toAmount: [EUR] },
      ],
      [
        {
          kind: 'accept_suggestion',
          templateId,
          occurrenceDate: '2026-09-01',
          amount: '2100.001',
        },
        { amount: [EUR] },
      ],
    ];

    for (const [draft, fieldErrors] of cases) {
      await expectCorrectionRefusal(draft, fieldErrors);
    }

    // And the ordinary writes refuse the same amounts with the same errors.
    await expectScaleRefusal(
      () =>
        updateIncomeEntry(flows(), OCT_5, {
          entryId: september.id,
          expectedVersion: september.version,
          netAmount: '10.123',
        }),
      { netAmount: [EUR] },
    );
    await expectScaleRefusal(
      () =>
        acceptSuggestion(flows(), OCT_5, {
          templateId,
          occurrenceDate: '2026-09-01',
          amount: '2100.001',
        }),
      { amount: [EUR] },
    );
  });
});

describe('the Bulk History batch', () => {
  const save = (operations: BulkHistoryOperation[]) => {
    const draft: CorrectionDraft = { kind: 'bulk_history', startMonth: '2026-01', operations };
    return {
      draft,
      preview: () => previewHistoricalCorrection(corrections(), OCT_5, { draft }),
    };
  };

  it('refuses the batch, naming each cell past its column’s currency, and writes nothing', async () => {
    const salary = await salaryTemplate();
    await recordValuation(positions(), OCT_5, {
      positionId: eur,
      valuedOn: '2026-07-31',
      amount: '500',
      datePrecision: 'month_end',
    });

    const { draft } = save([
      { kind: 'valuation_create', positionId: eur, month: '2026-08', amount: '1200.555' },
      { kind: 'valuation_create', positionId: eurSavings, month: '2026-08', amount: '300' },
      { kind: 'income_create', templateId: salary, occurrenceDate: '2026-08-01', netAmount: '2100.001' },
    ]);
    await expectCorrectionRefusal(draft, {
      [`${eur}#2026-08-31`]: [EUR],
      [`${salary}#2026-08-01`]: [EUR],
    });
  });

  it('holds a no-decimal column to whole amounts and a three-decimal one to three', async () => {
    const yenSalary = await salaryTemplate('JPY', yen);
    const refused = save([
      { kind: 'valuation_create', positionId: yen, month: '2026-08', amount: '1.5' },
      { kind: 'valuation_create', positionId: dinar, month: '2026-08', amount: '1.2345' },
      { kind: 'income_create', templateId: yenSalary, occurrenceDate: '2026-08-01', netAmount: '2100.5' },
    ]);
    await expectCorrectionRefusal(refused.draft, {
      [`${yen}#2026-08-31`]: [JPY],
      [`${dinar}#2026-08-31`]: [KWD],
      [`${yenSalary}#2026-08-01`]: [JPY],
    });

    const kept = save([
      { kind: 'valuation_create', positionId: yen, month: '2026-08', amount: '2' },
      { kind: 'valuation_create', positionId: dinar, month: '2026-08', amount: '1.234' },
      { kind: 'income_create', templateId: yenSalary, occurrenceDate: '2026-08-01', netAmount: '2100' },
    ]);
    const prepared = await kept.preview();
    if (prepared.status !== 'review_required') throw new Error('a Bulk History save is always reviewed');
    const result = await confirmHistoricalCorrection(corrections(), OCT_5, {
      draft: kept.draft,
      fingerprint: prepared.preview.fingerprint,
    });
    expect(result.status).toBe('committed');

    const stored = await withUser(harness.db, { userId: USER_A }, async (tx) =>
      tx.execute(
        sql`SELECT position_id, amount::text AS amount FROM position_valuations
             WHERE valued_on = '2026-08-31' ORDER BY amount`,
      ),
    );
    expect(stored.rows).toEqual([
      { position_id: dinar, amount: '1.23400000' },
      { position_id: yen, amount: '2.00000000' },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Phase 2                                                                     */
/* -------------------------------------------------------------------------- */

const balance = (positionId: string, amount: string, valuedOn = '2026-10-02') =>
  recordValuation(positions(), OCT_5, { positionId, valuedOn, amount, datePrecision: 'exact' });

describe('balances', () => {
  it('refuses a recorded balance past its position’s currency', async () => {
    await expectScaleRefusal(() => balance(eur, '1200.005'), { amount: [EUR] });
    await expectScaleRefusal(() => balance(eur, '-1200.005'), { amount: [EUR] });
  });

  it('holds a no-decimal account to whole amounts, and keeps one', async () => {
    await expectScaleRefusal(() => balance(yen, '1.5'), { amount: [JPY] });
    expect((await balance(yen, '2')).amount).toBe('2.00000000');
  });

  it('keeps a three-decimal account at its limit and refuses one decimal past it', async () => {
    expect((await balance(dinar, '1.234')).amount).toBe('1.23400000');
    await expectScaleRefusal(() => balance(dinar, '1.2345', '2026-10-03'), { amount: [KWD] });
  });

  it('refuses a corrected balance past its position’s currency', async () => {
    const stored = await balance(eur, '1200');
    await expectScaleRefusal(
      () =>
        correctValuation(positions(), OCT_5, {
          valuationId: stored.id,
          expectedVersion: stored.version,
          valuedOn: '2026-10-02',
          amount: '1200.005',
          datePrecision: 'exact',
        }),
      { amount: [EUR] },
    );
  });

  it('refuses a quick update as a whole, naming the entry past its own account’s currency', async () => {
    await expectScaleRefusal(
      () =>
        quickUpdate(positions(), OCT_5, {
          entries: [
            { positionId: yen, amount: '15000' },
            { positionId: eur, amount: '1200.005' },
          ],
        }),
      { 'entries.1.amount': [EUR] },
    );
  });
});

describe('accounts and assets', () => {
  it('refuses a cash account’s opening balance past its currency', async () => {
    await expectScaleRefusal(
      () =>
        createCashAccount(positions(), OCT_5, {
          name: 'New',
          currency: 'EUR',
          accountType: 'savings',
          openedOn: null,
          openingBalance: '10.123',
          openingBalanceOn: '2026-10-01',
        }),
      { openingBalance: [EUR] },
    );
  });

  it('refuses an asset’s acquisition or current value past its currency, on creation', async () => {
    const create = (values: Record<string, string>) =>
      createOtherAsset(positions(), OCT_5, {
        name: 'Car',
        currency: 'EUR',
        assetType: 'vehicle',
        includeInFinancialNetWorth: false,
        ...values,
      });
    await expectScaleRefusal(() => create({ acquisitionValue: '9000.001' }), {
      acquisitionValue: [EUR],
    });
    await expectScaleRefusal(
      () => create({ currentValue: '8000.001', currentValueOn: '2026-10-01' }),
      { currentValue: [EUR] },
    );
  });

  it('refuses an asset’s acquisition value past its own currency, on an edit', async () => {
    const car = await createOtherAsset(positions(), OCT_5, {
      name: 'Car',
      currency: 'JPY',
      assetType: 'vehicle',
      includeInFinancialNetWorth: false,
    });
    await expectScaleRefusal(
      () =>
        updateOtherAsset(positions(), OCT_5, {
          positionId: car.id,
          expectedVersion: car.version,
          acquisitionValue: '1500000.5',
        }),
      { acquisitionValue: [JPY] },
    );
  });
});

describe('Historical Correction drafts of a balance', () => {
  it('refuse in Preview and in Confirm exactly what the ordinary write refuses', async () => {
    const august = await recordValuation(positions(), OCT_5, {
      positionId: eur,
      valuedOn: '2026-08-31',
      amount: '1000',
      datePrecision: 'month_end',
    });

    await expectCorrectionRefusal(
      {
        kind: 'valuation_create',
        positionId: eur,
        valuedOn: '2026-09-30',
        amount: '1200.005',
        datePrecision: 'month_end',
      },
      { amount: [EUR] },
    );
    await expectCorrectionRefusal(
      {
        kind: 'valuation_update',
        valuationId: august.id,
        expectedVersion: august.version,
        valuedOn: '2026-08-31',
        amount: '1000.005',
        datePrecision: 'month_end',
      },
      { amount: [EUR] },
    );
    await expectCorrectionRefusal(
      { kind: 'quick_update', entries: [{ positionId: yen, amount: '1.5' }] },
      { 'entries.0.amount': [JPY] },
    );

    await expectScaleRefusal(
      () =>
        correctValuation(positions(), OCT_5, {
          valuationId: august.id,
          expectedVersion: august.version,
          valuedOn: '2026-08-31',
          amount: '1000.005',
          datePrecision: 'month_end',
        }),
      { amount: [EUR] },
    );
  });
});
