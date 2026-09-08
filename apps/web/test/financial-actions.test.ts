import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every financial mutation goes through the authoritative session path
 * (ADR 0003, blueprint 17.1, 17.2).
 *
 * ADR 0003 makes this an architectural invariant: a state-changing financial
 * action must validate its session against the **session store**, never against
 * the five-minute signed cookie cache, so a revoked session loses the ability
 * to write a balance immediately rather than eventually.
 *
 * Convention is not enough for that. This test reads the action modules and
 * enumerates every exported action, so the rule fails a build rather than a
 * review: a new action is financial by default, and the only way to declare one
 * otherwise is to name it in `NON_FINANCIAL_ACTIONS` below — which is a visible,
 * reviewable line in a test, not an invisible omission in a feature branch.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const actionsDir = path.join(here, '..', 'src', 'server', 'actions');

/**
 * The actions that are deliberately **not** financial.
 *
 * Each is a Phase 1 preference: cheap, reversible and visible to the account
 * holder. Phase 1's production verification observed exactly the trade ADR 0003
 * describes — a revoked session completed one settings write inside the cookie
 * window — and accepted it for these and only these.
 */
const NON_FINANCIAL_ACTIONS = new Set([
  'updateSettingsAction',
  'setReportingCurrencyAction',
  'createCategoryAction',
  'archiveCategoryAction',
  'createTagAction',
  'deleteTagAction',
  'completeOnboardingStepAction',
]);

interface DeclaredAction {
  readonly file: string;
  readonly name: string;
  readonly wrapper: string;
}

/** Every `export const <name> = action({` / `financialAction({` in the tree. */
function declaredActions(): DeclaredAction[] {
  const files = readdirSync(actionsDir).filter((file) => file.endsWith('.ts'));
  const pattern = /export\s+const\s+(\w+)\s*=\s*(financialAction|action)\s*\(/gu;
  const found: DeclaredAction[] = [];

  for (const file of files) {
    const source = readFileSync(path.join(actionsDir, file), 'utf8');
    for (const match of source.matchAll(pattern)) {
      found.push({ file, name: match[1] as string, wrapper: match[2] as string });
    }
  }
  return found;
}

describe('financial server actions authorize against the session store', () => {
  const actions = declaredActions();

  it('finds the action modules at all', () => {
    // A refactor that moves or renames the directory must fail loudly here
    // rather than silently making this suite vacuous.
    expect(actions.length).toBeGreaterThan(10);
    expect(new Set(actions.map((item) => item.file))).toContain('positions.ts');
  });

  it('declares every action either financial or explicitly not', () => {
    const unexplained = actions.filter(
      (item) => item.wrapper === 'action' && !NON_FINANCIAL_ACTIONS.has(item.name),
    );

    expect(
      unexplained.map((item) => `${item.file}: ${item.name}`),
      'a new action defaults to financial; add it to NON_FINANCIAL_ACTIONS only with a reason',
    ).toEqual([]);
  });

  it('uses the financial wrapper for every position, valuation and quick-update mutation', () => {
    const financialModules = ['positions.ts'];
    const inFinancialModules = actions.filter((item) => financialModules.includes(item.file));

    expect(inFinancialModules.length).toBeGreaterThan(0);
    for (const item of inFinancialModules) {
      expect(item.wrapper, `${item.file}: ${item.name}`).toBe('financialAction');
    }
  });

  it('does not list an action that no longer exists', () => {
    // Keeps the allow-list honest: a removed action must leave the list too, or
    // the next action to reuse its name would be silently exempted.
    const names = new Set(actions.map((item) => item.name));
    for (const allowed of NON_FINANCIAL_ACTIONS) {
      expect(names.has(allowed), `${allowed} is on the non-financial list but does not exist`).toBe(
        true,
      );
    }
  });

  it('wires the financial wrapper to the authoritative session, and the ordinary one to the cached session', () => {
    const source = readFileSync(path.join(actionsDir, 'define.ts'), 'utf8');

    const financial = source.slice(source.indexOf('export function financialAction'));
    expect(financial).toContain('requireAuthoritativeSession');
    expect(financial).not.toContain('getContext: requireSession');

    const ordinary = source.slice(
      source.indexOf('export function action'),
      source.indexOf('export function financialAction'),
    );
    expect(ordinary).toContain('requireSession');
    expect(ordinary).not.toContain('requireAuthoritativeSession');

    // `requireFreshSession` asks a different question — "did they authenticate
    // recently?" — and would accept a session revoked one second after it was
    // created. It is not an authorization and must not appear here.
    expect(source).not.toContain('requireFreshSession');
  });
});
