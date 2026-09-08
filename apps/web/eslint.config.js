import { boundaries, config } from '@vaultide/config/eslint';

export default [
  ...config({
    tsconfigRootDir: import.meta.dirname,
    restrictedImports: boundaries.web,
    money: true,
  }),
  {
    // Blueprint 7.1.1 / R31: "Charts receive `Number(amount)` for coordinates
    // only. Tooltips and tables format from the exact string."
    //
    // The money rule is deliberately applied to the whole web app rather than
    // only to the format module, which is stricter than section 7.1.1 asks for
    // — so the one place the blueprint explicitly allows a coercion needs a
    // carve-out. It is scoped to the chart components and nowhere else: every
    // figure a person reads in these files still comes from `MoneyText` and the
    // exact decimal string, and only pixel geometry passes through a number.
    files: ['src/components/charts/**/*.tsx'],
    rules: { '@vaultide/money/no-number-coercion': 'off' },
  },
  { ignores: ['.next/**', 'next-env.d.ts'] },
];
