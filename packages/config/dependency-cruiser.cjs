/**
 * Module boundaries of blueprint section 19, enforced in CI.
 *
 *  From \ To      finance  validation  db   application  apps/web
 *  finance          —          x        x        x           x
 *  validation       x          —        x        x           x
 *  db               x          v        —        x           x
 *  application      v          v        v        —           x
 *  apps/web         x(*)       v        x        v           —
 *
 *  (*) apps/web may import `@vaultide/finance/client` only (previews and formatting).
 */

const P = {
  finance: '^(packages/finance)',
  validation: '^(packages/validation)',
  db: '^(packages/db)',
  application: '^(packages/application)',
  web: '^(apps/web)',
};

/** @param {string[]} parts */
const anyOf = (parts) => `(${parts.join('|')})`;

module.exports = {
  forbidden: [
    {
      name: 'finance-is-pure',
      comment:
        'packages/finance is pure: it may depend only on decimal.js and its own files (section 4.1).',
      severity: 'error',
      from: { path: P.finance, pathNot: '\\.test\\.ts$|/test/' },
      to: { path: anyOf([P.validation, P.db, P.application, P.web]) },
    },
    {
      name: 'finance-no-framework',
      comment: 'packages/finance must not import framework or IO packages (section 4.1).',
      severity: 'error',
      from: { path: P.finance },
      to: {
        dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer'],
        pathNot: 'node_modules/(decimal\\.js|vitest|@vitest|fast-check|chai|tinyrainbow)',
      },
    },
    {
      name: 'validation-is-standalone',
      comment: 'packages/validation depends on zod only (section 19).',
      severity: 'error',
      from: { path: P.validation, pathNot: '\\.test\\.ts$|/test/' },
      to: { path: anyOf([P.finance, P.db, P.application, P.web]) },
    },
    {
      name: 'db-may-only-use-validation',
      comment: 'packages/db may import validation (enum literals) but nothing else (section 19).',
      severity: 'error',
      from: { path: P.db, pathNot: '\\.test\\.ts$|/test/' },
      to: { path: anyOf([P.finance, P.application, P.web]) },
    },
    {
      name: 'application-not-web',
      comment: 'packages/application must not depend on the web app (section 19).',
      severity: 'error',
      from: { path: P.application },
      to: { path: P.web },
    },
    {
      name: 'web-not-db',
      comment: 'apps/web must never reach the database directly (section 19).',
      severity: 'error',
      from: { path: P.web },
      to: { path: P.db },
    },
    {
      name: 'web-finance-client-only',
      comment:
        'apps/web may import @vaultide/finance only through its /client entry point (section 19).',
      severity: 'error',
      from: { path: P.web },
      to: {
        path: P.finance,
        pathNot: '^packages/finance/(src/client\\.ts|dist/client\\.(js|d\\.ts))$',
      },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: {
      path: '(^|/)(node_modules|dist|\\.next|coverage|test-results|playwright-report)(/|$)',
    },
    tsPreCompilationDeps: true,
    preserveSymlinks: false,
    combinedDependencies: true,
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
