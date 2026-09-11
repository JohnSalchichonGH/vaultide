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
 * The first seven are Phase 1 preferences: cheap, reversible and visible to the
 * account holder. Phase 1's production verification observed exactly the trade
 * ADR 0003 describes — a revoked session completed one settings write inside the
 * cookie window — and accepted it for those.
 *
 * The three month-review actions are the same kind of state (5.1, 6.2, 20.3).
 * A review mark records that somebody looked at a completed month; a dismissal
 * hides an advisory key from the month's presentation and is restored with one
 * click. Neither changes a financial record, a figure, a status, an issue or a
 * completeness result, so the cookie window can at most hide an advisory or mark
 * a month as looked at — both visible to the account holder.
 */
const MONTH_REVIEW_ACTIONS = [
  'markMonthReviewedAction',
  'dismissMonthAdvisoryAction',
  'restoreMonthAdvisoryAction',
] as const;

const NON_FINANCIAL_ACTIONS = new Set<string>([
  'updateSettingsAction',
  'setReportingCurrencyAction',
  'createCategoryAction',
  'archiveCategoryAction',
  'createTagAction',
  'deleteTagAction',
  'completeOnboardingStepAction',
  ...MONTH_REVIEW_ACTIONS,
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
    const files = new Set(actions.map((item) => item.file));
    expect(files).toContain('positions.ts');
    // Phase 3's flow and recurring mutations live in their own modules; a
    // rename that emptied one of them would otherwise make this suite vacuous.
    expect(files).toContain('flows.ts');
    expect(files).toContain('recurring.ts');
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
    const financialModules = ['positions.ts', 'flows.ts', 'recurring.ts'];
    const inFinancialModules = actions.filter((item) => financialModules.includes(item.file));

    expect(inFinancialModules.length).toBeGreaterThan(0);
    for (const item of inFinancialModules) {
      expect(item.wrapper, `${item.file}: ${item.name}`).toBe('financialAction');
    }
  });

  it('keeps every Phase 3 flow, recurring and savings-preference mutation financial', () => {
    // The savings-rate preference lives on `user_settings` and used to ride
    // along with locale and currencies on the cached-session action. It is a
    // financial input — flipping it re-interprets every past month's personal
    // savings (12.5) — so it moved to its own action here, and this asserts it
    // did not drift back onto the cheap path (v2.1.6 §30.9).
    const expected = [
      'flows.createIncomeEntry',
      'flows.updateIncomeEntry',
      'flows.deleteIncomeEntry',
      'flows.createExpenseEntry',
      'flows.updateExpenseEntry',
      'flows.deleteExpenseEntry',
      'flows.createTransfer',
      'flows.updateTransfer',
      'flows.deleteTransfer',
      'recurring.createTemplate',
      'recurring.updateTemplate',
      'recurring.archiveTemplate',
      'recurring.unarchiveTemplate',
      'recurring.setTemplateTerm',
      'recurring.acceptSuggestion',
      'recurring.skipSuggestion',
      'recurring.unskipSuggestion',
      'settings.setCountAdditionalSpending',
    ];

    const declared = new Set<string>();
    for (const file of ['flows.ts', 'recurring.ts']) {
      const source = readFileSync(path.join(actionsDir, file), 'utf8');
      for (const match of source.matchAll(/name:\s*'([^']+)'/gu)) declared.add(match[1] as string);
    }

    for (const name of expected) expect(declared, name).toContain(name);
    // Everything outside positions.ts is financial unless it is named on the
    // explicit list above — a name, not a whole file, so a financial action
    // added beside a non-financial one is still held to the rule.
    for (const item of actions.filter((entry) => entry.file !== 'positions.ts')) {
      if (NON_FINANCIAL_ACTIONS.has(item.name)) continue;
      expect(item.wrapper, `${item.file}: ${item.name}`).toBe('financialAction');
    }
  });

  it('keeps the month-review actions on the ordinary path, and only those in monthly.ts', () => {
    const monthly = actions.filter((item) => item.file === 'monthly.ts');
    expect(monthly.map((item) => item.name).sort()).toEqual([...MONTH_REVIEW_ACTIONS].sort());
    for (const item of monthly) expect(item.wrapper, item.name).toBe('action');

    // Review state is written through the review service alone: the module
    // imports no flow, valuation, template or skip mutation.
    const source = readFileSync(path.join(actionsDir, 'monthly.ts'), 'utf8');
    for (const forbidden of ['skipSuggestion', 'acceptSuggestion', 'recordValuation', 'createIncomeEntry']) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('no longer lets the ordinary settings action write the savings-rate preference', () => {
    // Removing it from the schema is what actually enforces this; the check is
    // here because the schema lives in another package and a re-added field
    // would be invisible in this app's diff.
    const source = readFileSync(path.join(actionsDir, 'settings.ts'), 'utf8');
    expect(source).not.toContain('countAdditionalSpending');
  });

  it('exposes no recurring-template hard delete', () => {
    // 6.3 permits deleting an unreferenced template, but its terms and skips
    // cascade and a skip can carry an occupancy fact whose removal has to be
    // audited. Retirement is archiving until a phase defines that behaviour.
    const source = readFileSync(path.join(actionsDir, 'recurring.ts'), 'utf8');
    expect(source).not.toMatch(/deleteTemplate/u);
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
