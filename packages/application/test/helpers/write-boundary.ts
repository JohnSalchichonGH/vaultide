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
