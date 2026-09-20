import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  POST_COMMIT_ALLOWLIST,
  analyzeModule,
  type WriteBoundaryViolation,
} from '../helpers/write-boundary';

/**
 * Every financial mutation is one atomic transaction that locks before it reads
 * (blueprint 20.3, 30.22; ADR 0010 §3, §16).
 *
 * This is the mechanical half of the write-coordination invariant. The other
 * half — that every state-changing financial *action* authorizes against the
 * session store — is `apps/web/test/financial-actions.test.ts`, and the two are
 * deliberately separate because they answer different questions:
 *
 *   authorization      -> financialAction    (ADR 0003)
 *   write coordination -> withUserWrite      (ADR 0010)
 *
 * The registry below is explicit rather than discovered, so removing an entry
 * is a visible line in a diff instead of an absence nobody notices. The
 * non-vacuity cases underneath make a rename fail here rather than quietly
 * stopping the check.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', '..', 'src');

/**
 * Every externally callable mutation of Vaultide's mutable financial evidence
 * (30.22 item 6), by the module that owns it.
 *
 * `onboarding.firstAccount` is not listed: it is a server action that calls
 * `createCashAccount`, and inherits the mutex through it.
 */
const REGISTRY: Readonly<Record<string, readonly string[]>> = {
  'positions/service.ts': [
    'createCashAccount',
    'createOtherAsset',
    'updateCashAccount',
    'updateOtherAsset',
    'closePosition',
    'removePosition',
  ],
  'positions/valuations.ts': [
    'recordValuation',
    'correctValuation',
    'removeValuation',
    'confirmMonthEnd',
    'confirmUnchanged',
    'confirmUnchangedBatch',
    'quickUpdate',
  ],
  'flows/income.ts': ['createIncomeEntry', 'updateIncomeEntry', 'deleteIncomeEntry'],
  'flows/expenses.ts': ['createExpenseEntry', 'updateExpenseEntry', 'deleteExpenseEntry'],
  'flows/transfers.ts': ['createCashTransfer', 'updateCashTransfer', 'deleteCashTransfer'],
  'flows/adjustments.ts': ['acceptUnexplainedInflowAsAdjustment'],
  'recurring/templates.ts': [
    'createTemplate',
    'updateTemplateDetails',
    'archiveTemplate',
    'unarchiveTemplate',
    'setTemplateTerm',
  ],
  'recurring/suggestions.ts': ['acceptSuggestion', 'skipSuggestion', 'unskipSuggestion'],
  'settings/service.ts': ['setCountAdditionalSpending'],
};

const REGISTERED_COUNT = Object.values(REGISTRY).reduce((n, names) => n + names.length, 0);

function analyze(relative: string) {
  const file = path.join(srcDir, relative);
  return analyzeModule({
    file: relative,
    source: readFileSync(file, 'utf8'),
    entryPoints: REGISTRY[relative] as readonly string[],
  });
}

function describeViolations(violations: readonly WriteBoundaryViolation[]): string[] {
  return violations.map(
    (item) => `${item.file}:${String(item.line)} ${item.fn} [${item.rule}] ${item.detail}`,
  );
}

describe('the financial write boundary (30.22 item 5, ADR 0010 §16)', () => {
  it.each(Object.keys(REGISTRY))('%s locks before it reads', (relative) => {
    const { violations, found } = analyze(relative);

    expect(describeViolations(violations)).toEqual([]);
    // Non-vacuity, per module: a renamed or removed export fails here rather
    // than silently dropping out of the invariant.
    expect(found).toEqual(REGISTRY[relative]);
  });

  it('covers every mutation the registry claims, and counts them', () => {
    const found = Object.keys(REGISTRY).flatMap((relative) => analyze(relative).found);
    expect(found).toHaveLength(REGISTERED_COUNT);
    // A deliberate number: adding a financial mutation without registering it
    // leaves this untouched, so the count is asserted beside the names.
    expect(REGISTERED_COUNT).toBe(32);
  });

  it('keeps the post-commit allow-list small and explicit', () => {
    // "Warm support data" is the whole of what may happen after the commit. If
    // this list grows, something is deciding whether a write should have
    // happened after it already did (ADR 0010 §16 item 6).
    expect([...POST_COMMIT_ALLOWLIST]).toEqual([
      'deps.fx.ensureHistory',
      'warmRates',
      'warmHistory',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* The checker's own tests                                                     */
/* -------------------------------------------------------------------------- */

const PREAMBLE = `
import { withUserWrite } from '../coordination';
`;

function check(body: string, entryPoint = 'updateExpenseEntry') {
  return analyzeModule({
    file: 'fixture.ts',
    source: `${PREAMBLE}\n${body}`,
    entryPoints: [entryPoint],
  });
}

const rules = (result: ReturnType<typeof check>): string[] =>
  result.violations.map((item) => item.rule);

describe('the checker itself (ADR 0010 §16)', () => {
  it('accepts the shape the invariant describes', () => {
    const result = check(`
      export async function updateExpenseEntry(deps: FlowDependencies, ctx: RequestContext, args: Args) {
        assertNotFuture(ctx, args.incurredOn, 'incurredOn');

        const updated = await withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
          updateExpenseEntryIn(tx, ctx, args),
        );

        await deps.fx.ensureHistory(args.currency, args.incurredOn);
        return updated;
      }
    `);

    expect(describeViolations(result.violations)).toEqual([]);
    expect(result.found).toEqual(['updateExpenseEntry']);
  });

  it('rejects the authoritative read that happens before the mutex', () => {
    // The case the design review named. It contains a mutex and is still
    // wrong, and a search for `withUserWrite(` would pass it.
    const result = check(`
      export async function updateExpenseEntry(deps: FlowDependencies, ctx: RequestContext, args: Args) {
        const existing = await findExpenseEntry(deps.db, ctx.userId, args.entryId);

        return withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
          updateExpenseEntryIn(tx, ctx, existing, args),
        );
      }
    `);

    expect(rules(result)).toContain('await-before-boundary');
    expect(rules(result)).toContain('database-before-boundary');
    expect(result.violations[0]?.fn).toBe('updateExpenseEntry');
    expect(result.violations[0]?.line).toBeGreaterThan(0);
    expect(result.violations[0]?.detail).toContain('findExpenseEntry');
  });

  it('rejects a category requirement resolved before the mutex', () => {
    const result = check(`
      export async function updateExpenseEntry(deps: FlowDependencies, ctx: RequestContext, args: Args) {
        await requireCategory(deps.db, ctx, args.categoryId);

        return withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
          updateExpenseEntryIn(tx, ctx, args),
        );
      }
    `);
    expect(rules(result)).toContain('await-before-boundary');
  });

  it('rejects a cash-leg resolution before the mutex', () => {
    const result = check(`
      export async function updateExpenseEntry(deps: FlowDependencies, ctx: RequestContext, args: Args) {
        await resolveTrackedCashLeg(deps, ctx, { cashPositionId: args.cashPositionId });

        return withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
          updateExpenseEntryIn(tx, ctx, args),
        );
      }
    `);
    expect(rules(result)).toContain('await-before-boundary');
  });

  it('rejects a database handle merely passed around before the mutex', () => {
    // Not awaited, so an await-only rule would miss it: the read is deferred
    // and its result is still decided from a state the mutex never covered.
    const result = check(`
      export async function updateExpenseEntry(deps: FlowDependencies, ctx: RequestContext, args: Args) {
        const pending = findExpenseEntry(deps.db, ctx.userId, args.entryId);

        return withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
          updateExpenseEntryIn(tx, ctx, await pending, args),
        );
      }
    `);
    expect(rules(result)).toContain('database-before-boundary');
  });

  it('rejects a mutation with no boundary at all', () => {
    const result = check(`
      export async function updateExpenseEntry(deps: FlowDependencies, ctx: RequestContext, args: Args) {
        return updateExpenseEntryRow(deps.db, ctx, args);
      }
    `);
    expect(rules(result)).toEqual(['boundary-missing']);
  });

  it('rejects two boundaries in one mutation', () => {
    const result = check(`
      export async function updateExpenseEntry(deps: FlowDependencies, ctx: RequestContext, args: Args) {
        const row = await withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
          updateExpenseEntryIn(tx, ctx, args),
        );
        await withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
          clearDormancyForFlowIn(tx, ctx, [row.cashPositionId]),
        );
        return row;
      }
    `);
    expect(rules(result)).toContain('boundary-not-unique');
  });

  it('rejects a dependency bundle handed to the transaction-internal call', () => {
    const result = check(`
      export async function updateExpenseEntry(deps: FlowDependencies, ctx: RequestContext, args: Args) {
        return withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
          updateExpenseEntryIn(tx, deps, ctx, args),
        );
      }
    `);
    expect(rules(result)).toContain('capability-into-transaction');
  });

  it('rejects an authoritative read after the commit', () => {
    const result = check(`
      export async function updateExpenseEntry(deps: FlowDependencies, ctx: RequestContext, args: Args) {
        const updated = await withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
          updateExpenseEntryIn(tx, ctx, args),
        );
        // Deciding after the fact whether the write should have happened.
        const month = await reconcileMonth(deps, ctx, args.month);
        return month.ok ? updated : undefined;
      }
    `);
    expect(rules(result)).toContain('post-commit-not-allowed');
    expect(result.violations.map((item) => item.detail)).toContain('reconcileMonth');
  });

  it('rejects an ambient service or database escape hatch', () => {
    const result = check(`
      export async function updateExpenseEntry(ctx: RequestContext, args: Args) {
        const deps = getServices().flows;
        return withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
          updateExpenseEntryIn(tx, ctx, args),
        );
      }
    `);
    expect(rules(result)).toContain('ambient-escape');
  });

  it('rejects a nested or alternative transaction boundary', () => {
    const result = check(`
      export async function updateExpenseEntry(deps: FlowDependencies, ctx: RequestContext, args: Args) {
        return withUser(deps.db, { userId: ctx.userId }, async (tx) =>
          updateExpenseEntryIn(tx, ctx, args),
        );
      }
    `);
    expect(rules(result)).toContain('nested-boundary');
    expect(rules(result)).toContain('boundary-missing');
  });

  it('rejects `withUserWrite` imported from the db package', () => {
    const result = analyzeModule({
      file: 'fixture.ts',
      source: `
        import { withUserWrite } from '@vaultide/db';
        export async function updateExpenseEntry(deps: FlowDependencies, ctx: RequestContext, args: Args) {
          return withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
            updateExpenseEntryIn(tx, ctx, args),
          );
        }
      `,
      entryPoints: ['updateExpenseEntry'],
    });
    // It would work, and it would surface a database error nobody maps to
    // `WRITE_BUSY` (ADR 0010 §7).
    expect(rules(result)).toContain('boundary-import-source');
  });

  it('rejects a transaction-internal implementation that takes a Database', () => {
    const result = check(`
      async function updateExpenseEntryIn(db: Database, ctx: RequestContext, args: Args) {
        return updateExpenseEntryRow(db, ctx, args);
      }
      export async function updateExpenseEntry(deps: FlowDependencies, ctx: RequestContext, args: Args) {
        return withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
          updateExpenseEntryIn(tx, ctx, args),
        );
      }
    `);
    expect(rules(result)).toContain('inner-takes-database');
  });

  it('is not vacuous: an entry point it cannot find is reported as not found', () => {
    const result = check(
      `
      export async function somethingElse(deps: FlowDependencies, ctx: RequestContext) {
        return withUserWrite(deps.db, { userId: ctx.userId }, async (tx) => somethingElseIn(tx, ctx));
      }
    `,
      'updateExpenseEntry',
    );
    expect(result.found).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  it('names the file, the function and the line of every finding', () => {
    const result = check(`
      export async function updateExpenseEntry(deps: FlowDependencies, ctx: RequestContext, args: Args) {
        const existing = await findExpenseEntry(deps.db, ctx.userId, args.entryId);
        return withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
          updateExpenseEntryIn(tx, ctx, existing, args),
        );
      }
    `);
    for (const violation of result.violations) {
      expect(violation.file).toBe('fixture.ts');
      expect(violation.fn).toBe('updateExpenseEntry');
      expect(violation.line).toBeGreaterThan(0);
      expect(violation.detail.length).toBeGreaterThan(0);
    }
  });
});
