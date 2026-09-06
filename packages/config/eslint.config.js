import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import money from './eslint-money.js';

/** Files that are never linted. */
export const ignores = [
  '**/dist/**',
  '**/.next/**',
  '**/coverage/**',
  '**/node_modules/**',
  '**/*.d.ts',
  '**/playwright-report/**',
  '**/test-results/**',
];

/**
 * Import boundaries of blueprint section 19, expressed as ESLint
 * `no-restricted-imports` patterns. dependency-cruiser enforces the same table
 * in CI; this gives the same feedback in the editor.
 */
export const boundaries = {
  finance: ['@vaultide/validation', '@vaultide/db', '@vaultide/application', '@vaultide/web'],
  validation: ['@vaultide/finance', '@vaultide/db', '@vaultide/application', '@vaultide/web'],
  db: ['@vaultide/finance', '@vaultide/application', '@vaultide/web'],
  application: ['@vaultide/web'],
  web: ['@vaultide/db'],
};

/**
 * @param {object} options
 * @param {string} options.tsconfigRootDir absolute path of the package root
 * @param {string[]} [options.restrictedImports] package names this package may not import
 * @param {boolean} [options.money] enable the money-coercion rule (finance/db/application/format)
 * @returns {import('eslint').Linter.Config[]}
 */
export function config({ tsconfigRootDir, restrictedImports = [], money: enableMoney = false }) {
  return [
    { ignores },
    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    {
      languageOptions: {
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      plugins: { '@vaultide/money': money },
      rules: {
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
        '@typescript-eslint/consistent-type-imports': 'error',
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/no-misused-promises': 'error',
        'no-restricted-syntax': [
          'error',
          {
            selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
            message: 'dangerouslySetInnerHTML is banned (blueprint 17.3).',
          },
          {
            selector: 'MemberExpression[object.name="sql"][property.name="raw"]',
            message: 'sql.raw is allowed only in migrations (blueprint 17.3).',
          },
        ],
        ...(restrictedImports.length
          ? {
              'no-restricted-imports': [
                'error',
                {
                  patterns: restrictedImports.map((name) => ({
                    group: [name, `${name}/*`],
                    message: `Module boundary violation: this package may not import ${name} (blueprint section 19).`,
                  })),
                },
              ],
            }
          : {}),
        ...(enableMoney ? { '@vaultide/money/no-number-coercion': 'error' } : {}),
      },
    },
    {
      // Config files and operational scripts are plain JavaScript and are not
      // part of any tsconfig project, so they are linted without type
      // information rather than failing to parse.
      files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
      ...tseslint.configs.disableTypeChecked,
      languageOptions: {
        globals: { ...globals.node },
        parserOptions: { projectService: false, project: false },
      },
    },
    {
      files: ['**/*.test.ts', '**/*.test.tsx', '**/test/**/*.ts'],
      rules: {
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-unsafe-argument': 'off',
      },
    },
  ];
}

export default config;
