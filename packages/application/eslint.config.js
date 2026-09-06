import { boundaries, config } from '@vaultide/config/eslint';

export default config({
  tsconfigRootDir: import.meta.dirname,
  restrictedImports: boundaries.application,
  money: true,
});
