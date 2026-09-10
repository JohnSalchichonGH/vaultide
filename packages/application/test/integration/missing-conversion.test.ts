import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql, withoutUser } from '@vaultide/db';
import { createHarness, type Harness } from '../helpers/harness';
import { testContext, type RequestContext } from '../../src/context';
import { provisionUser } from '../../src/users/provisioning';
import { createCashAccount } from '../../src/positions/service';
import { recordValuation } from '../../src/positions/valuations';
import { createCashTransfer } from '../../src/flows/transfers';
import { createTemplate } from '../../src/recurring/templates';
import { createFxService } from '../../src/fx/service';
import {
  getMonthReconciliation,
  parseMonth,
  type ReconciliationDependencies,
} from '../../src/reconciliation/service';
import type {
  MonthReconciliationDto,
  ReconciliationBucketDto,
  ReconciliationIssueDto,
} from '../../src/reconciliation/types';

/**
 * `possible_missing_conversion` against a real database (8.5, 30.15 items
 * 6–9, 30.17 item 7).
 *
 * November 2026 throughout, read on 1 December. Every month is built from
 * month-end statements alone, so a bucket's residual is exactly the balance it
 * gained or lost, and the missing transfer's signature is two statements: euros
 * that arrived with nothing recorded, dollars that left the same way.
 */

const USER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

let harness: Harness;

const on = (today: string): RequestContext =>
  testContext({ today, userId: USER, reportingCurrency: 'EUR' });

const DEC_1 = on('2026-12-01');
const NOVEMBER = parseMonth('2026-11');

const readDeps = (): ReconciliationDependencies => ({ db: harness.db, fx: harness.services.fx });
type ReadDeps = ReconciliationDependencies;

async function makeAccount(name: string, currency = 'EUR', openedOn: string | null = null): Promise<string> {
  const created = await createCashAccount(harness.services.positions, DEC_1, {
    name,
    currency,
    accountType: 'checking',
    openedOn,
  });
  return created.id;
}

const statement = (positionId: string, valuedOn: string, amount: string): Promise<unknown> =>
  recordValuation(harness.services.positions, DEC_1, {
    positionId,
    valuedOn,
    amount,
    datePrecision: 'month_end',
  });

/** Correct one month-end balance: the statement is replaced, not appended. */
async function restate(positionId: string, valuedOn: string, amount: string): Promise<void> {
  await harness.asOwner('DELETE FROM position_valuations WHERE position_id = $1 AND valued_on = $2', [positionId, valuedOn]);
  await statement(positionId, valuedOn, amount);
}

/** Month ends from April 2026 to November 2026, in order. */
const ENDS = {
  apr: '2026-04-30', may: '2026-05-31', jun: '2026-06-30', jul: '2026-07-31',
  aug: '2026-08-31', sep: '2026-09-30', oct: '2026-10-31', nov: '2026-11-30',
} as const;

/** Exact decimal-string subtraction at two decimals. */
function subtract(a: string, b: string): string {
  const cents = (s: string): number => Math.round(Number(s) * 100);
  return ((cents(a) - cents(b)) / 100).toFixed(2);
}

/**
 * Forget every stored rate.
 *
 * Creating a foreign account, recording its balance or moving money into it
 * calls `ensureHistory` (10.4), so writing a fixture warms the cache with the
 * stub publisher's series. A test that wants to own November's evidence
 * therefore clears the table after its writes and stores its own rows — and
 * that ordering is itself the proof that the reconciliation read fetches
 * nothing.
 */
const forgetRates = (): Promise<unknown> => harness.asOwner('DELETE FROM fx_rates');

/** Store an `EUR -> quote` rate, the only orientation 10.1 persists. */
async function rate(quote: string, rateDate: string, value: string): Promise<void> {
  await withoutUser(harness.db, async (tx) => {
    await tx.execute(
      sql`INSERT INTO fx_rates (base, quote, rate_date, rate, source, fetched_at)
          VALUES ('EUR', ${quote}, ${rateDate}, ${value}, 'ECB', now())
          ON CONFLICT DO NOTHING`,
    );
  });
}

/** `EUR -> USD` 1.08 on the 10th and 1.10 on the 20th: November's average is 1.09. */
async function novemberRates(extra: readonly [string, string, string][] = []): Promise<void> {
  await forgetRates();
  await rate('USD', '2026-11-10', '1.08');
  await rate('USD', '2026-11-20', '1.10');
  for (const [quote, day, value] of extra) await rate(quote, day, value);
}

/**
 * A missing USD -> EUR transfer's signature: euros gained 1000 nobody
 * recorded, dollars lost `sourceDrop`. At 1.09 the inflow is worth 1090 USD,
 * so the band is [1090, 1144.5]. Rates are written last.
 */
async function signature(sourceDrop = '1100.00'): Promise<{ eur: string; usd: string }> {
  const eur = await makeAccount('BBVA');
  const usd = await makeAccount('Dollars', 'USD');
  await statement(eur, ENDS.oct, '1000.00');
  await statement(eur, ENDS.nov, '2000.00');
  await statement(usd, ENDS.oct, '10000.00');
  await statement(usd, ENDS.nov, subtract('10000.00', sourceDrop));
  await novemberRates();
  return { eur, usd };
}

const bucketOf = (result: MonthReconciliationDto, currency: string): ReconciliationBucketDto => {
  const bucket = result.buckets.find((b) => b.currency === currency);
  if (bucket === undefined) throw new Error(`no ${currency} bucket`);
  return bucket;
};

const advisoryOf = (bucket: ReconciliationBucketDto): ReconciliationIssueDto[] =>
  bucket.issues.filter((issue) => issue.key === 'possible_missing_conversion');

const keysOf = (bucket: ReconciliationBucketDto): string[] => bucket.issues.map((issue) => issue.key);

const november = (): Promise<MonthReconciliationDto> => getMonthReconciliation(readDeps(), DEC_1, NOVEMBER);

/**
 * Round trips and rate reads of one run. The FX service is built over the
 * counting database so its query is a round trip like any other, and its
 * `loadTable` is wrapped so a read that was skipped can be told from one that
 * happened to be free.
 */
async function countReads<T>(run: (deps: ReadDeps) => Promise<T>): Promise<[number, number, T]> {
  let transactions = 0;
  let rateReads = 0;
  const counting = new Proxy(harness.db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property !== 'transaction' || typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        transactions += 1;
        return (value as (...rest: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const fx = createFxService({ db: counting, provider: harness.fxProvider });
  const result = await run({
    db: counting,
    fx: {
      loadTable(...args) {
        rateReads += 1;
        return fx.loadTable(...args);
      },
    },
  });
  return [transactions, rateReads, result];
}

beforeAll(async () => {
  harness = await createHarness();
  await withoutUser(harness.db, async (tx) => {
    await tx.execute(
      sql`INSERT INTO "user" (id, name, email, email_verified)
          VALUES (${USER}, ${'conversion@example.test'}, ${'conversion@example.test'}, true)
          ON CONFLICT (id) DO NOTHING`,
    );
  });
  await provisionUser(harness.db, { userId: USER });
}, 240_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.asOwner('DELETE FROM expense_entries');
  await harness.asOwner('DELETE FROM transfers');
  await harness.asOwner('DELETE FROM income_entries');
  await harness.asOwner('DELETE FROM recurring_template_terms');
  await harness.asOwner('DELETE FROM recurring_templates');
  await harness.asOwner('DELETE FROM audit_entries');
  await harness.asOwner('DELETE FROM position_valuations');
  await harness.asOwner('DELETE FROM cash_accounts');
  await harness.asOwner('DELETE FROM positions');
  await harness.asOwner('DELETE FROM fx_rates');
});

/* -------------------------------------------------------------------------- */
/* A / B — the signature, and its exact edges                                 */
/* -------------------------------------------------------------------------- */

describe('a month with a missing conversion’s signature', () => {
  it('A — carries one advisory on the destination, with the figures a transfer needs', async () => {
    await signature();
    const result = await november();
    const eur = bucketOf(result, 'EUR');
    const usd = bucketOf(result, 'USD');

    // The engine's own verdict, untouched: euros unresolved, dollars reliable.
    expect(result.status).toBe('unresolved');
    expect(eur.status).toBe('unresolved');
    expect(usd.status).toBe('reliable');
    expect(eur.totals.unclassified?.amount).toBe('-1000');
    expect(usd.totals.unclassified?.amount).toBe('1100');

    expect(keysOf(eur)).toEqual(['unexplained_inflow', 'possible_missing_conversion']);
    const [inflow, advisory] = eur.issues;
    expect(advisory).toEqual({
      key: 'possible_missing_conversion',
      class: 'advisory',
      currency: 'EUR',
      positionId: null,
      positionName: null,
      amount: { amount: '1000', currency: 'EUR' },
      variant: null,
      templateId: null,
      templateName: null,
      occurrenceDate: null,
      expectedAmount: null,
      candidates: [
        {
          sourceCurrency: 'USD',
          destinationCurrency: 'EUR',
          sourceAmount: { amount: '1100', currency: 'USD' },
          destinationAmount: { amount: '1000', currency: 'EUR' },
          comparisonAmount: { amount: '1090', currency: 'USD' },
          rate: '1.09',
          rateDate: '2026-11-30',
          rateSource: 'ECB',
        },
      ],
    });
    // `X` is the unexplained inflow itself.
    expect(advisory?.amount).toEqual(inflow?.amount);
    // The source bucket carries nothing: the advisory belongs to the bucket
    // that gained the cash.
    expect(usd.issues).toEqual([]);
    // No other issue grew a candidate list.
    expect(inflow).not.toHaveProperty('candidates');
  });

  it('B — admits U2 at exactly X2 and 1.05 × X2, and refuses one cent outside', async () => {
    const { usd } = await signature();
    const sourceOf = async (drop: string): Promise<ReconciliationIssueDto[]> => {
      await restate(usd, ENDS.nov, subtract('10000.00', drop));
      // Restating a foreign balance warmed the cache again (10.4).
      await novemberRates();
      return advisoryOf(bucketOf(await november(), 'EUR'));
    };

    expect(await sourceOf('1090.00')).toHaveLength(1);
    expect(await sourceOf('1089.99')).toEqual([]);
    expect(await sourceOf('1144.50')).toHaveLength(1);
    expect(await sourceOf('1144.51')).toEqual([]);
    // The floor is a floor: a source 5 % below X2 is not "close enough".
    expect(await sourceOf('1035.50')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* C / D — several sources, and an estimated one                              */
/* -------------------------------------------------------------------------- */

describe('sources', () => {
  it('C — lists every qualifying source once, ascending by currency code', async () => {
    await signature();
    // Pounds, created after the dollars: 1000 -> 140, a spike of 860 against
    // an inflow worth 850 GBP at 0.85.
    const gbp = await makeAccount('Pounds', 'GBP');
    await statement(gbp, ENDS.oct, '1000.00');
    await statement(gbp, ENDS.nov, '140.00');
    await novemberRates([['GBP', '2026-11-16', '0.85']]);

    const result = await november();
    const [advisory] = advisoryOf(bucketOf(result, 'EUR'));
    expect(advisory?.candidates?.map((candidate) => candidate.sourceCurrency)).toEqual(['GBP', 'USD']);
    expect(advisory?.candidates?.[0]).toEqual({
      sourceCurrency: 'GBP',
      destinationCurrency: 'EUR',
      sourceAmount: { amount: '860', currency: 'GBP' },
      destinationAmount: { amount: '1000', currency: 'EUR' },
      comparisonAmount: { amount: '850', currency: 'GBP' },
      rate: '0.85',
      rateDate: '2026-11-30',
      rateSource: 'ECB',
    });
    expect(advisoryOf(bucketOf(result, 'GBP'))).toEqual([]);
    expect(advisoryOf(bucketOf(result, 'USD'))).toEqual([]);
  });

  it('D — admits an estimated source bucket, and leaves it estimated', async () => {
    await signature();
    // A second dollar account opened in October whose first balance lands in
    // November: excluded there, and the USD bucket is estimated (8.1, 8.8).
    const late = await makeAccount('Late dollars', 'USD', '2026-10-15');
    await statement(late, ENDS.nov, '50.00');
    await novemberRates();

    const result = await november();
    const usd = bucketOf(result, 'USD');
    expect(usd.status).toBe('estimated');
    expect(keysOf(usd)).toEqual(['first_balance']);
    expect(usd.totals.unclassified?.amount).toBe('1100');
    const [advisory] = advisoryOf(bucketOf(result, 'EUR'));
    expect(advisory?.candidates?.map((candidate) => candidate.sourceCurrency)).toEqual(['USD']);
  });
});

/* -------------------------------------------------------------------------- */
/* E — the month's own rate evidence, and nothing else                         */
/* -------------------------------------------------------------------------- */

describe('rate evidence', () => {
  it('E1 — averages a single observation inside the month', async () => {
    await signature();
    await forgetRates();
    await rate('USD', '2026-11-03', '1.09');

    const [advisory] = advisoryOf(bucketOf(await november(), 'EUR'));
    expect(advisory?.candidates?.[0]).toEqual(
      expect.objectContaining({ rate: '1.09', rateDate: '2026-11-30', comparisonAmount: { amount: '1090', currency: 'USD' } }),
    );
  });

  it('E2 — lets no rate from outside the month stand in, and fetches none', async () => {
    await signature();
    await forgetRates();
    // The day before and the day after, at a rate that would qualify.
    await rate('USD', '2026-10-31', '1.09');
    await rate('USD', '2026-12-01', '1.09');

    const before = harness.fxProvider.calls.length;
    const result = await november();
    expect(harness.fxProvider.calls.length).toBe(before);

    const eur = bucketOf(result, 'EUR');
    expect(keysOf(eur)).toEqual(['unexplained_inflow']);
    // The month is exactly what it was: the advisory is the only thing missing.
    expect(eur.status).toBe('unresolved');
    expect(eur.totals.unclassified?.amount).toBe('-1000');
    expect(bucketOf(result, 'USD').totals.unclassified?.amount).toBe('1100');
  });

  it('E3 — says nothing with no stored rate at all, and fetches none', async () => {
    await signature();
    await forgetRates();

    const before = harness.fxProvider.calls.length;
    expect(keysOf(bucketOf(await november(), 'EUR'))).toEqual(['unexplained_inflow']);
    expect(harness.fxProvider.calls.length).toBe(before);
  });
});

/* -------------------------------------------------------------------------- */
/* F / G — no candidate, and the current month                                */
/* -------------------------------------------------------------------------- */

describe('when nothing qualifies', () => {
  it('F — raises no advisory when the spike is outside the band, and changes nothing else', async () => {
    await signature('2000.00');
    const result = await november();
    const eur = bucketOf(result, 'EUR');
    expect(keysOf(eur)).toEqual(['unexplained_inflow']);
    expect(eur.issues[0]).not.toHaveProperty('candidates');
    expect(bucketOf(result, 'USD').totals.unclassified?.amount).toBe('2000');
    expect(result.status).toBe('unresolved');
  });

  it('G — is refused for the current month by the completed-month guard', async () => {
    await signature();
    await expect(getMonthReconciliation(readDeps(), DEC_1, parseMonth('2026-12'))).rejects.toThrow('not over yet');
  });
});

/* -------------------------------------------------------------------------- */
/* H — the transfer the advisory prefills                                     */
/* -------------------------------------------------------------------------- */

describe('recording what the advisory suggests', () => {
  it('H — closes both residuals with the two native amounts, and the advisory goes with them', async () => {
    const { eur, usd } = await signature();
    const [advisory] = advisoryOf(bucketOf(await november(), 'EUR'));
    const [candidate] = advisory?.candidates ?? [];
    if (candidate === undefined) throw new Error('expected a candidate');

    // 30.15 item 9: the prefill is `U2` out of the source and `X` into the
    // destination — never `X2`.
    await createCashTransfer(harness.services.flows, DEC_1, {
      occurredOn: '2026-11-15',
      fromPositionId: usd,
      toPositionId: eur,
      fromAmount: candidate.sourceAmount.amount,
      toAmount: candidate.destinationAmount.amount,
    });
    // The cross-currency write warmed the cache again (10.4).
    await novemberRates();

    const result = await november();
    expect(result.status).toBe('reliable');
    for (const currency of ['EUR', 'USD']) {
      const bucket = bucketOf(result, currency);
      expect(bucket.status).toBe('reliable');
      expect(bucket.totals.unclassified?.amount).toBe('0');
      expect(bucket.issues).toEqual([]);
    }
    expect(bucketOf(result, 'EUR').totals.nonIncomeInflows.amount).toBe('1000');
    expect(bucketOf(result, 'USD').totals.nonExpenseOutflows.amount).toBe('1100');
  });
});

/* -------------------------------------------------------------------------- */
/* I — beside the other advisory                                              */
/* -------------------------------------------------------------------------- */

describe('with large_unclassified on the source bucket', () => {
  it('I — each bucket carries its own advisory, and neither disturbs the other', async () => {
    // Dollars: April anchor, six baseline drops of 10,20,30,10,20,30 (median
    // 20), then November's 1100 — far above twice the median. Euros: the
    // unexplained 1000.
    const eur = await makeAccount('BBVA');
    const usd = await makeAccount('Dollars', 'USD');
    await statement(eur, ENDS.oct, '1000.00');
    await statement(eur, ENDS.nov, '2000.00');
    let running = '10000.00';
    await statement(usd, ENDS.apr, running);
    for (const [index, drop] of ['10', '20', '30', '10', '20', '30', '1100'].entries()) {
      running = subtract(running, drop);
      await statement(usd, Object.values(ENDS)[index + 1] as string, running);
    }
    await novemberRates();

    const result = await november();
    const usdBucket = bucketOf(result, 'USD');
    expect(keysOf(usdBucket)).toEqual(['large_unclassified']);
    expect(usdBucket.issues[0]?.amount).toEqual({ amount: '1100', currency: 'USD' });
    const eurBucket = bucketOf(result, 'EUR');
    expect(keysOf(eurBucket)).toEqual(['unexplained_inflow', 'possible_missing_conversion']);
    expect(advisoryOf(eurBucket)[0]?.candidates?.map((candidate) => candidate.sourceCurrency)).toEqual(['USD']);
  });
});

/* -------------------------------------------------------------------------- */
/* J — read counts                                                            */
/* -------------------------------------------------------------------------- */

describe('the read count', () => {
  it('J — is the range load alone until the month shows the signature, then one rate read more', async () => {
    const eur = await makeAccount('BBVA');
    await statement(eur, ENDS.oct, '1000.00');
    await statement(eur, ENDS.nov, '900.00');
    const [simple, simpleRates] = await countReads((d) => getMonthReconciliation(d, DEC_1, NOVEMBER));
    // The range's seven parallel reads; no template, so no terms query; no
    // foreign bucket, so no rate read.
    expect(simple).toBe(7);
    expect(simpleRates).toBe(0);

    // A second currency whose bucket reconciles: still nothing to convert.
    const usd = await makeAccount('Dollars', 'USD');
    await statement(usd, ENDS.oct, '10000.00');
    await statement(usd, ENDS.nov, '9900.00');
    await novemberRates();
    const [multi, multiRates] = await countReads((d) => getMonthReconciliation(d, DEC_1, NOVEMBER));
    expect(multi).toBe(simple);
    expect(multiRates).toBe(0);

    // Euros gain 1000 unexplained: a destination and a source coexist, and
    // the month's rates are read once — whether or not the band then matches.
    await restate(eur, ENDS.nov, '2000.00');
    const [signed, signedRates, result] = await countReads((d) => getMonthReconciliation(d, DEC_1, NOVEMBER));
    expect(signed).toBe(simple + 1);
    expect(signedRates).toBe(1);
    expect(advisoryOf(bucketOf(result, 'EUR'))).toEqual([]);

    for (const name of ['Salary A', 'Salary B', 'Salary C']) {
      await createTemplate(harness.services.flows, DEC_1, {
        kind: 'income',
        name,
        incomeKind: 'employment',
        currency: 'EUR',
        frequency: 'monthly',
        dayOfMonth: 25,
        startDate: '2026-01-25',
        amount: '100.00',
      });
    }
    const [expanded, expandedRates] = await countReads((d) => getMonthReconciliation(d, DEC_1, NOVEMBER));
    // One batched terms read once templates exist, one rate read: never one
    // per template, per bucket, per candidate or per currency.
    expect(expanded).toBe(simple + 2);
    expect(expandedRates).toBe(1);
  });

  it('performs no provider request', async () => {
    await signature();
    const before = harness.fxProvider.calls.length;
    await november();
    expect(harness.fxProvider.calls.length).toBe(before);
  });
});
