import { boundaries, config } from '@vaultide/config/eslint';

export default [
  ...config({
    tsconfigRootDir: import.meta.dirname,
    restrictedImports: boundaries.web,
    money: true,
  }),
  { ignores: ['.next/**', 'next-env.d.ts'] },
];
