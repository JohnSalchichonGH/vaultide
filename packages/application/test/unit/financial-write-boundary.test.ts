import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FINANCIAL_MUTATION_REGISTRY,
  NON_MUTATING_APPLICATION_CALLS,
  POST_COMMIT_ALLOWLIST,
  REGISTERED_MUTATIONS,
  actionModuleFiles,
  analyzeModule,
  crossCheckRegistryCoverage,
  discoverFinancialActions,
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

/** The registry itself lives beside the checker, so the coverage cross-check
 * below and the boundary rules above read exactly one definition. */
const REGISTRY = FINANCIAL_MUTATION_REGISTRY;

/** The web app's action modules, read from disk rather than imported: the
 * boundary between the packages is a module boundary, and this is source text
 * (blueprint 19; enforced by dependency-cruiser, which sees no edge here). */
const actionsDir = path.join(here, '..', '..', '..', '..', 'apps', 'web', 'src', 'server', 'actions');

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
    expect(REGISTERED_COUNT).toBe(33);
  });

  it('keeps the post-commit allow-list small and explicit', () => {
    // "Warm support data" is the whole of what may happen after the commit. If
    // this list grows, something is deciding whether a write should have
    // happened after it already did (ADR 0010 §16 item 6).
    expect([...POST_COMMIT_ALLOWLIST]).toEqual([
      'deps.fx.ensureHistory',
      'warmRates',
      'warmHistory',
      'warmCorrectionSupport',
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

/* -------------------------------------------------------------------------- */
/* Registry coverage: the exposed surface, discovered independently            */
/* -------------------------------------------------------------------------- */

/**
 * The registry above is manual, and a manual list can be forgotten.
 *
 * These cases close that: they derive the **exposed** financial surface from
 * the web app's own `financialAction` declarations, without consulting the
 * registry to find them, and then cross-check. Adding a financial action that
 * calls a new mutation nobody registered fails here — which is the whole point,
 * because the boundary rules above would otherwise never analyze it.
 */

/**
 * The action modules, **enumerated from disk** rather than listed.
 *
 * A hand-written list was the last way a financial action could escape this
 * check: a new module — Phase 4's `investments.ts`, say — would simply never be
 * read, so its actions would never be cross-checked and its mutations never
 * analyzed, while the authorization suite (which does enumerate) stayed green.
 * `financial-actions.test.ts` has always read the directory; so does this now.
 */
const ACTION_MODULES = actionModuleFiles(readdirSync(actionsDir, { encoding: 'utf8', recursive: true }));

const actionSource = (file: string): string =>
  readFileSync(path.join(actionsDir, file), 'utf8');

function exposedFinancialActions() {
  return ACTION_MODULES.flatMap((file) => discoverFinancialActions(file, actionSource(file)));
}

describe('the registry covers the exposed financial surface (ADR 0010 §16)', () => {
  const actions = exposedFinancialActions();

  it('reads every action module the directory actually holds', () => {
    // Computed inline, independently of `ACTION_MODULES`, so replacing that
    // constant with a hand-written array fails here rather than silently
    // narrowing what gets analyzed.
    const onDisk = readdirSync(actionsDir, { encoding: 'utf8', recursive: true })
      .map((entry) => String(entry).split('\\').join('/'))
      .filter((entry) => entry.endsWith('.ts'))
      .sort();

    expect([...ACTION_MODULES]).toEqual(onDisk);
    // Today that includes the wrapper definition itself, which declares no
    // action and so contributes none — naturally harmless, not excluded.
    expect(onDisk).toContain('define.ts');
    expect(discoverFinancialActions('define.ts', actionSource('define.ts'))).toEqual([]);

    for (const known of [
      'define.ts',
      'flows.ts',
      'monthly.ts',
      'positions.ts',
      'recurring.ts',
      'settings.ts',
    ]) {
      expect(onDisk).toContain(known);
    }
  });

  it('finds a plausible number of financial actions, in modules it enumerated', () => {
    // Non-vacuity, without freezing the future set: a fourth module that
    // starts declaring financial actions is covered automatically, and only
    // its mutations need registering.
    expect(actions.length).toBeGreaterThanOrEqual(30);
    for (const file of new Set(actions.map((action) => action.file))) {
      expect(ACTION_MODULES).toContain(file);
    }

    const names = actions.map((action) => action.actionName);
    for (const expected of [
      'flows.createIncomeEntry',
      'flows.acceptAdjustment',
      'positions.createCashAccount',
      'valuations.quickUpdate',
      'recurring.acceptSuggestion',
      'settings.setCountAdditionalSpending',
      'onboarding.firstAccount',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('resolves every exposed financial action to a registered mutation', () => {
    const violations = crossCheckRegistryCoverage(actions);
    expect(
      violations.map(
        (item) =>
          `${item.file}:${String(item.line)} ${item.actionName} [${item.rule}] ${item.detail}`,
      ),
    ).toEqual([]);
  });

  it('accepts the onboarding delegation for the right reason', () => {
    // It owns no mutation of its own: it reaches `createCashAccount`, which is
    // registered and therefore analyzed by the boundary rules above, and
    // `markOnboardingCompleted`, which writes UI state (6.1).
    const onboarding = actions.find((action) => action.actionName === 'onboarding.firstAccount');
    expect(onboarding?.applicationCalls).toEqual([
      'createCashAccount',
      'getServices',
      'markOnboardingCompleted',
    ]);
    expect(REGISTERED_MUTATIONS.has('createCashAccount')).toBe(true);
    expect(REGISTERED_MUTATIONS.has('markOnboardingCompleted')).toBe(false);
  });

  it('classifies no ordinary action as a financial mutation', () => {
    // `settings.ts` and `monthly.ts` hold category, tag, preference and
    // month-review actions. They are declared with `action`, not
    // `financialAction`, so discovery must return nothing for them — reading a
    // preference write or a presentation write as a financial mutation would be
    // a different mistake, and `financial-actions.test.ts` is what holds those
    // to the authorization rule.
    for (const file of ['settings.ts', 'monthly.ts']) {
      expect(discoverFinancialActions(file, actionSource(file))).toEqual([]);
    }
  });

  it('keeps the non-mutating allow-list small and explicit', () => {
    expect([...NON_MUTATING_APPLICATION_CALLS]).toEqual([
      'getServices',
      'parseMonth',
      'markOnboardingCompleted',
    ]);
  });
});

const ACTION_PREAMBLE = [
  "import { createIncomeEntry, getServices, recordFxAdjustment } from '@vaultide/application';",
  "import { financialAction } from './define';",
].join('\n');

const discover = (body: string) =>
  discoverFinancialActions('fixture.ts', `${ACTION_PREAMBLE}\n${body}`);

describe('the coverage cross-check itself (ADR 0010 §16)', () => {
  it('accepts an exposed action that calls a registered mutation', () => {
    const actions = discover(`
      export const createIncomeEntryAction = financialAction({
        name: 'flows.createIncomeEntry',
        input: flowInput.createIncomeEntryInput,
        async handler({ input, ctx }) {
          const created = await createIncomeEntry(getServices().flows, ctx, input);
          return { id: created.id };
        },
      });
    `);

    expect(actions).toHaveLength(1);
    expect(actions[0]?.applicationCalls).toEqual(['createIncomeEntry', 'getServices']);
    expect(crossCheckRegistryCoverage(actions)).toEqual([]);
  });

  it('rejects an exposed action that calls a mutation nobody registered', () => {
    // The omission this exists for: the new mutation may well be missing the
    // mutex entirely, and the boundary rules never look at it because the
    // registry never mentions it.
    const actions = discover(`
      export const recordFxAdjustmentAction = financialAction({
        name: 'flows.recordFxAdjustment',
        input: flowInput.recordFxAdjustmentInput,
        async handler({ input, ctx }) {
          const created = await recordFxAdjustment(getServices().flows, ctx, input);
          return { id: created.id };
        },
      });
    `);

    const violations = crossCheckRegistryCoverage(actions);
    expect(violations.map((item) => item.rule)).toContain('action-calls-unregistered-mutation');
    expect(violations.map((item) => item.detail)).toContain('recordFxAdjustment');
    expect(violations[0]?.actionName).toBe('flows.recordFxAdjustment');
    expect(violations[0]?.line).toBeGreaterThan(0);
  });

  it('rejects an exposed action that reaches no registered mutation at all', () => {
    // An action that stopped going through the mutation layer — an inlined
    // write, say — must not pass by calling nothing the registry recognises.
    const actions = discover(`
      export const somethingAction = financialAction({
        name: 'flows.something',
        input: flowInput.somethingInput,
        async handler({ ctx }) {
          return { userId: ctx.userId };
        },
      });
    `);

    expect(crossCheckRegistryCoverage(actions).map((item) => item.rule)).toContain(
      'action-reaches-no-registered-mutation',
    );
  });

  it('does not discover ordinary actions, only financial ones', () => {
    const actions = discoverFinancialActions(
      'fixture.ts',
      [
        "import { listCategories } from '@vaultide/application';",
        "import { action } from './define';",
        '',
        'export const listCategoriesAction = action({',
        "  name: 'categories.list',",
        '  input: z.object({}),',
        '  async handler({ ctx }) {',
        '    return listCategories(getServices().db, ctx.userId);',
        '  },',
        '});',
      ].join('\n'),
    );
    expect(actions).toEqual([]);
  });

  it('ignores an application export that is only imported as a type', () => {
    const actions = discoverFinancialActions(
      'fixture.ts',
      [
        "import { createIncomeEntry, getServices, type UserSettings } from '@vaultide/application';",
        "import { financialAction } from './define';",
        '',
        'export const createIncomeEntryAction = financialAction({',
        "  name: 'flows.createIncomeEntry',",
        '  input: flowInput.createIncomeEntryInput,',
        '  async handler({ input, ctx }): Promise<UserSettings> {',
        '    return createIncomeEntry(getServices().flows, ctx, input);',
        '  },',
        '});',
      ].join('\n'),
    );
    expect(actions[0]?.applicationCalls).toEqual(['createIncomeEntry', 'getServices']);
  });

  it('discovers from the action declarations, never from the registry', () => {
    // Handed an empty registry, the same real actions all fail. The discovery
    // therefore cannot be reading the registry to decide what to look at.
    const violations = crossCheckRegistryCoverage(exposedFinancialActions(), {
      registered: new Set<string>(),
    });
    expect(violations.length).toBeGreaterThanOrEqual(30);
    expect([...new Set(violations.map((item) => item.rule))]).toContain(
      'action-reaches-no-registered-mutation',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The file-discovery layer: a brand-new action module                         */
/* -------------------------------------------------------------------------- */

/**
 * The layer above the fixtures: **which files reach the checker at all**.
 *
 * The cross-check discovers actions independently of the registry, but it used
 * to be handed a hand-written list of modules. A Phase 4 `investments.ts` whose
 * author forgot both that list and the registry would then have passed
 * everything: the authorization suite enumerates the directory and would have
 * seen a correct `financialAction`, while nothing here ever read the file.
 */

const NEW_MODULE = [
  "import { createContribution, getServices } from '@vaultide/application';",
  "import { financialAction } from './define';",
  '',
  'export const createContributionAction = financialAction({',
  "  name: 'investments.createContribution',",
  '  input: investmentInput.createContributionInput,',
  '  async handler({ input, ctx }) {',
  '    const created = await createContribution(getServices().investments, ctx, input);',
  '    return { id: created.id };',
  '  },',
  '});',
].join('\n');

const KNOWN_MODULE = [
  "import { createIncomeEntry, getServices } from '@vaultide/application';",
  "import { financialAction } from './define';",
  '',
  'export const createIncomeEntryAction = financialAction({',
  "  name: 'flows.createIncomeEntry',",
  '  input: flowInput.createIncomeEntryInput,',
  '  async handler({ input, ctx }) {',
  '    return createIncomeEntry(getServices().flows, ctx, input);',
  '  },',
  '});',
].join('\n');

describe('a brand-new server-action module (ADR 0010 §16)', () => {
  it('enumerates every TypeScript module, nested ones included, and nothing else', () => {
    // The pure rule, checked on its own: the widest statable one. Naming a file
    // to skip is what reopens the hole, so nothing is skipped — a module that
    // declares no action simply yields none.
    expect(
      actionModuleFiles([
        'define.ts',
        'flows.ts',
        'investments.ts',
        'README.md',
        'notes.txt',
        'nested',
        'nested\\contributions.ts',
        'legacy.d.ts',
        'helpers.test.ts',
      ]),
    ).toEqual([
      'define.ts',
      'flows.ts',
      'helpers.test.ts',
      'investments.ts',
      'legacy.d.ts',
      'nested/contributions.ts',
    ]);
  });

  it('carries a new module through enumeration, discovery and the cross-check', () => {
    // End to end over a real directory, because the defect lived between the
    // directory and the checker rather than inside either.
    const directory = mkdtempSync(path.join(tmpdir(), 'vaultide-actions-'));
    try {
      writeFileSync(path.join(directory, 'define.ts'), 'export function financialAction() {}\n');
      writeFileSync(path.join(directory, 'flows.ts'), KNOWN_MODULE);
      writeFileSync(path.join(directory, 'investments.ts'), NEW_MODULE);
      writeFileSync(path.join(directory, 'README.md'), '# not a module\n');

      const files = actionModuleFiles(readdirSync(directory, { encoding: 'utf8', recursive: true }));
      // The new module is read without anybody adding it to a list.
      expect(files).toEqual(['define.ts', 'flows.ts', 'investments.ts']);

      const discovered = files.flatMap((file) =>
        discoverFinancialActions(file, readFileSync(path.join(directory, file), 'utf8')),
      );
      expect(discovered.map((action) => action.actionName).sort()).toEqual([
        'flows.createIncomeEntry',
        'investments.createContribution',
      ]);

      const violations = crossCheckRegistryCoverage(discovered);
      expect(
        violations.map((item) => `${item.file} ${item.actionName} [${item.rule}] ${item.detail}`),
      ).toEqual([
        'investments.ts investments.createContribution [action-calls-unregistered-mutation] createContribution',
        'investments.ts investments.createContribution [action-reaches-no-registered-mutation] createContribution, getServices',
      ]);
      // The registered neighbour in the same directory stays clean, so the
      // failure is about the new mutation and not about the sweep being noisy.
      expect(violations.every((item) => item.file === 'investments.ts')).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
