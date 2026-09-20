import ts from 'typescript';

/**
 * The financial-write boundary, checked over the TypeScript AST
 * (blueprint 20.3, 30.22; ADR 0010 §16).
 *
 * The invariant this exists to enforce cannot be checked by searching for text.
 * This is a mutex and is still wrong, because the authoritative read happened
 * first:
 *
 * ```ts
 * const existing = await findExpenseEntry(deps.db, ctx.userId, args.entryId);
 * return withUserWrite(deps.db, { userId: ctx.userId }, async (tx) =>
 *   updateExpenseEntryIn(tx, ctx, existing, args),
 * );
 * ```
 *
 * A grep for `withUserWrite(` passes it. Only the **order** of the nodes tells
 * the two apart, so the checker reads the syntax tree and compares positions.
 *
 * It is a pure function of source text on purpose: the suite runs it over the
 * real modules *and* over fixtures that are deliberately wrong, so a parser
 * change that silently stopped finding anything fails rather than passing
 * everything.
 */

/** The application module `withUserWrite` must come from (ADR 0010 §7). */
const COORDINATION_MODULE = /(^|\/)coordination$/u;

/**
 * Every externally callable mutation of Vaultide's mutable financial evidence
 * (blueprint 30.22 item 6), by the module that owns it.
 *
 * Written out rather than discovered, so removing an entry is a visible line in
 * a diff. It is **not** the only thing keeping the invariant honest:
 * `discoverFinancialActions` below derives the exposed surface from the web
 * app's own action declarations, independently of this list, and the suite
 * fails when the two disagree. Forgetting a line here is therefore a CI
 * failure rather than a silent escape.
 *
 * `onboarding.firstAccount` is not listed: it is a server action that calls
 * `createCashAccount`, and inherits the mutex through it.
 */
export const FINANCIAL_MUTATION_REGISTRY: Readonly<Record<string, readonly string[]>> = {
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

/** Every registered mutation entry point, flattened. */
export const REGISTERED_MUTATIONS: ReadonlySet<string> = new Set(
  Object.values(FINANCIAL_MUTATION_REGISTRY).flat(),
);

/**
 * The `@vaultide/application` exports a financial action may call **without**
 * being a mutation of financial evidence.
 *
 * Deliberately tiny, and each entry is a claim somebody can check:
 *
 *  - `getServices` is the composition root accessor (4.1, 19). It builds
 *    dependency bundles and writes nothing.
 *  - `parseMonth` parses a `YYYY-MM` string. Pure.
 *  - `markOnboardingCompleted` writes `user_settings.preferences`, which 6.1
 *    reserves for UI state and which is deliberately unversioned. It is not
 *    financial evidence (30.22 item 6), so it does not take the mutex.
 *
 * Anything else a financial action reaches into must be a registered mutation.
 * That is what makes forgetting a registry line fail rather than pass.
 */
export const NON_MUTATING_APPLICATION_CALLS = [
  'getServices',
  'parseMonth',
  'markOnboardingCompleted',
] as const;

/** What may still be awaited **after** the boundary has committed. */
export const POST_COMMIT_ALLOWLIST = [
  'deps.fx.ensureHistory',
  'warmRates',
  'warmHistory',
] as const;

/** Names that would let a mutation reach a connection out of thin air. */
const AMBIENT_ESCAPES = ['getServices', 'getDatabase'] as const;

/** Transaction boundaries a financial mutation may not open for itself. */
const FORBIDDEN_BOUNDARIES = ['withUser', 'withUserRead', 'withoutUser'] as const;

/** Type names a transaction-internal implementation may not receive. */
const FORBIDDEN_INNER_PARAMETER_TYPES = [
  'Database',
  'FlowDependencies',
  'PositionDependencies',
  'SettingsDependencies',
  'MonthDataDependencies',
] as const;

export type WriteBoundaryRule =
  | 'boundary-missing'
  | 'boundary-not-unique'
  | 'await-before-boundary'
  | 'database-before-boundary'
  | 'capability-into-transaction'
  | 'post-commit-not-allowed'
  | 'ambient-escape'
  | 'nested-boundary'
  | 'boundary-import-source'
  | 'inner-takes-database';

export interface WriteBoundaryViolation {
  readonly file: string;
  /** The mutation entry point, or the module itself for a module-wide rule. */
  readonly fn: string;
  readonly line: number;
  readonly rule: WriteBoundaryRule;
  /** The offending source text, trimmed to something a person can search for. */
  readonly detail: string;
}

export interface ModuleAnalysis {
  readonly violations: readonly WriteBoundaryViolation[];
  /** Which of the requested entry points were actually found in the module. */
  readonly found: readonly string[];
}

function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => {
    walk(child, visit);
  });
}

function collect(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  walk(root, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
}

/** `deps.fx.ensureHistory(...)` → `deps.fx.ensureHistory`. */
function calleeText(call: ts.CallExpression, file: ts.SourceFile): string {
  return call.expression.getText(file);
}

function lineOf(node: ts.Node, file: ts.SourceFile): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

function snippet(node: ts.Node, file: ts.SourceFile): string {
  const text = node.getText(file).replace(/\s+/gu, ' ');
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

/** Every exported or local function declaration in the module, by name. */
function functionsByName(file: ts.SourceFile): Map<string, ts.FunctionDeclaration> {
  const byName = new Map<string, ts.FunctionDeclaration>();
  walk(file, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      byName.set(node.name.text, node);
    }
  });
  return byName;
}

function isCallOf(node: ts.Node, name: string): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name;
}

/** The `withUserWrite(...)` calls a function makes, in source order. */
function boundariesIn(fn: ts.FunctionDeclaration, file: ts.SourceFile): ts.CallExpression[] {
  return collect(fn, (node) => isCallOf(node, 'withUserWrite'))
    .map((node) => node as ts.CallExpression)
    .sort((a, b) => a.getStart(file) - b.getStart(file));
}

/** Unwrap parentheses, so `await (withUserWrite(…))` reads like the plain form. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/** Does this node reference a database handle — `db`, `deps.db`, `.db`? */
function isDatabaseReference(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'db') return true;
  if (
    ts.isIdentifier(node) &&
    node.text === 'db' &&
    !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
  ) {
    return true;
  }
  return false;
}

/** Does this node reference the dependency bundle itself? */
function isDependencyBundleReference(node: ts.Node): boolean {
  return (
    ts.isIdentifier(node) &&
    node.text === 'deps' &&
    !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
  );
}

export interface AnalyzeInput {
  readonly file: string;
  readonly source: string;
  /** The externally callable financial mutations this module is expected to own. */
  readonly entryPoints: readonly string[];
  readonly postCommitAllowlist?: readonly string[];
}

export function analyzeModule(input: AnalyzeInput): ModuleAnalysis {
  const file = parse(input.file, input.source);
  const allowlist = input.postCommitAllowlist ?? POST_COMMIT_ALLOWLIST;
  const violations: WriteBoundaryViolation[] = [];
  const found: string[] = [];

  const report = (
    fn: string,
    node: ts.Node,
    rule: WriteBoundaryRule,
    detail = snippet(node, file),
  ): void => {
    violations.push({ file: input.file, fn, line: lineOf(node, file), rule, detail });
  };

  /* ------------------------------------------------------- module-wide ---- */

  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause?.namedBindings;
    if (clause === undefined || !ts.isNamedImports(clause)) continue;

    const importsBoundary = clause.elements.some(
      (element) => (element.propertyName ?? element.name).text === 'withUserWrite',
    );
    if (!importsBoundary) continue;

    const from = (statement.moduleSpecifier as ts.StringLiteral).text;
    if (!COORDINATION_MODULE.test(from)) {
      // The `@vaultide/db` primitive works and surfaces a database error nobody
      // maps to `WRITE_BUSY`. The application wrapper is the only legal door.
      report('<module>', statement, 'boundary-import-source', from);
    }
  }

  walk(file, (node) => {
    if (!ts.isCallExpression(node)) return;

    for (const name of AMBIENT_ESCAPES) {
      if (isCallOf(node, name)) report('<module>', node, 'ambient-escape');
    }
    for (const name of FORBIDDEN_BOUNDARIES) {
      if (isCallOf(node, name)) report('<module>', node, 'nested-boundary');
    }
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'transaction'
    ) {
      report('<module>', node, 'nested-boundary');
    }
  });

  const declared = functionsByName(file);

  // A transaction-internal implementation takes the transaction, never a way to
  // open one of its own (ADR 0010 §16 item 4).
  for (const [name, fn] of declared) {
    if (!name.endsWith('In')) continue;
    for (const parameter of fn.parameters) {
      const typeText = parameter.type?.getText(file) ?? '';
      if (FORBIDDEN_INNER_PARAMETER_TYPES.some((forbidden) => typeText.includes(forbidden))) {
        report(name, parameter, 'inner-takes-database', `${parameter.getText(file)}`);
      }
    }
  }

  /* ----------------------------------------------------- per entry point -- */

  for (const entryPoint of input.entryPoints) {
    const fn = declared.get(entryPoint);
    if (fn === undefined) continue;
    found.push(entryPoint);

    const boundaries = boundariesIn(fn, file);
    const boundary = boundaries[0];
    if (boundary === undefined) {
      report(entryPoint, fn.name ?? fn, 'boundary-missing');
      continue;
    }
    if (boundaries.length > 1) {
      report(entryPoint, boundaries[1] as ts.Node, 'boundary-not-unique');
    }

    const boundaryStart = boundary.getStart(file);
    const boundaryEnd = boundary.getEnd();

    // 1. Nothing is awaited before the mutex is held — except the boundary.
    for (const node of collect(fn, ts.isAwaitExpression)) {
      const await_ = node as ts.AwaitExpression;
      if (unwrap(await_.expression) === boundary) continue;
      if (await_.getStart(file) < boundaryStart) {
        report(entryPoint, await_, 'await-before-boundary');
      }
    }

    // 2. No database capability is touched before it either. This is what
    //    catches a read whose result is merely stored, not awaited in place.
    for (const node of collect(fn, isDatabaseReference)) {
      if (node.getStart(file) < boundaryStart) {
        report(entryPoint, node, 'database-before-boundary');
      }
    }

    // 3. The transaction-internal call receives `tx`, never `deps` or `db`.
    const callback = boundary.arguments[2];
    if (callback !== undefined) {
      for (const node of collect(callback, (n) => isDatabaseReference(n) || isDependencyBundleReference(n))) {
        report(entryPoint, node, 'capability-into-transaction');
      }
    }

    // 4. After the commit, only the explicit allow-list.
    for (const node of collect(fn, ts.isAwaitExpression)) {
      const await_ = node as ts.AwaitExpression;
      if (await_.getStart(file) < boundaryEnd) continue;
      const called = unwrap(await_.expression);
      const name = ts.isCallExpression(called) ? calleeText(called, file) : snippet(called, file);
      if (!allowlist.includes(name)) {
        report(entryPoint, await_, 'post-commit-not-allowed', name);
      }
    }
  }

  return { violations, found };
}

/* -------------------------------------------------------------------------- */
/* The exposed financial-action surface                                        */
/* -------------------------------------------------------------------------- */

/**
 * One server action declared with `financialAction` (ADR 0003), and the
 * `@vaultide/application` exports its handler actually calls.
 *
 * This is the **independent** half of the coverage invariant. It starts from
 * the web app's own action declarations and knows nothing about the registry
 * above, so an action that reaches a mutation nobody registered is discovered
 * here and reported rather than quietly skipped.
 */
export interface ExposedFinancialAction {
  readonly file: string;
  /** The exported binding, e.g. `createIncomeEntryAction`. */
  readonly actionExport: string;
  /** The declared action name, e.g. `flows.createIncomeEntry`. */
  readonly actionName: string;
  readonly line: number;
  /** Identifiers imported from `@vaultide/application` that the handler calls. */
  readonly applicationCalls: readonly string[];
}

const APPLICATION_PACKAGE = '@vaultide/application';

/** The value names this module imports from `@vaultide/application`. */
function applicationImports(file: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if ((statement.moduleSpecifier as ts.StringLiteral).text !== APPLICATION_PACKAGE) continue;
    // `import type { … }` brings in no callable value.
    if (statement.importClause?.isTypeOnly === true) continue;

    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      names.add(element.name.text);
    }
  }
  return names;
}

/** The string literal of an object property, when it has one. */
function literalProperty(object: ts.ObjectLiteralExpression, key: string): string | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (property.name.getText() !== key) continue;
    if (ts.isStringLiteralLike(property.initializer)) return property.initializer.text;
  }
  return undefined;
}

/** The `handler` property of an action definition, however it is written. */
function handlerOf(object: ts.ObjectLiteralExpression): ts.Node | undefined {
  for (const property of object.properties) {
    const name = ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)
      ? property.name.getText()
      : undefined;
    if (name !== 'handler') continue;
    return ts.isPropertyAssignment(property) ? property.initializer : property;
  }
  return undefined;
}

/**
 * Every `export const … = financialAction({ … })` in one action module, with
 * the application exports its handler calls.
 *
 * Only `financialAction` is looked at. An ordinary `action({ … })` is a
 * non-financial write or a read: `financial-actions.test.ts` is what holds
 * *those* to the authorization rule, and misclassifying one as a financial
 * mutation here would be a different mistake.
 */
export function discoverFinancialActions(
  filePath: string,
  source: string,
): ExposedFinancialAction[] {
  const file = parse(filePath, source);
  const imported = applicationImports(file);
  const discovered: ExposedFinancialAction[] = [];

  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const exported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (exported !== true) continue;

    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      if (initializer === undefined || !isCallOf(initializer, 'financialAction')) continue;

      const definition = initializer.arguments[0];
      if (definition === undefined || !ts.isObjectLiteralExpression(definition)) continue;

      const handler = handlerOf(definition);
      const calls = new Set<string>();
      if (handler !== undefined) {
        for (const node of collect(handler, ts.isCallExpression)) {
          const call = node as ts.CallExpression;
          if (!ts.isIdentifier(call.expression)) continue;
          if (imported.has(call.expression.text)) calls.add(call.expression.text);
        }
      }

      discovered.push({
        file: filePath,
        actionExport: declaration.name.getText(file),
        actionName: literalProperty(definition, 'name') ?? '<unnamed>',
        line: lineOf(declaration, file),
        applicationCalls: [...calls].sort(),
      });
    }
  }

  return discovered;
}

export type CoverageRule =
  | 'action-calls-unregistered-mutation'
  | 'action-reaches-no-registered-mutation';

export interface CoverageViolation {
  readonly file: string;
  readonly actionName: string;
  readonly line: number;
  readonly rule: CoverageRule;
  readonly detail: string;
}

/**
 * Cross-check the discovered surface against the registry (ADR 0010 §16).
 *
 * Default-deny in both directions:
 *
 *  1. every `@vaultide/application` export a financial action's handler calls
 *     is either a **registered** mutation or on the small documented
 *     non-mutating list — so a brand-new mutation nobody registered fails;
 *  2. every financial action reaches **at least one** registered mutation — so
 *     an action that quietly stopped going through the mutation layer fails
 *     too, rather than passing by calling nothing recognised.
 */
export function crossCheckRegistryCoverage(
  actions: readonly ExposedFinancialAction[],
  options: {
    readonly registered?: ReadonlySet<string>;
    readonly nonMutating?: readonly string[];
  } = {},
): CoverageViolation[] {
  const registered = options.registered ?? REGISTERED_MUTATIONS;
  const nonMutating = new Set(options.nonMutating ?? NON_MUTATING_APPLICATION_CALLS);
  const violations: CoverageViolation[] = [];

  for (const action of actions) {
    for (const called of action.applicationCalls) {
      if (registered.has(called) || nonMutating.has(called)) continue;
      violations.push({
        file: action.file,
        actionName: action.actionName,
        line: action.line,
        rule: 'action-calls-unregistered-mutation',
        detail: called,
      });
    }

    if (!action.applicationCalls.some((called) => registered.has(called))) {
      violations.push({
        file: action.file,
        actionName: action.actionName,
        line: action.line,
        rule: 'action-reaches-no-registered-mutation',
        detail: action.applicationCalls.join(', ') || '<no application call at all>',
      });
    }
  }

  return violations;
}
