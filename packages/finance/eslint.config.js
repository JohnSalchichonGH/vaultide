import { config } from '@vaultide/config/eslint';
import { boundaries } from '@vaultide/config/eslint';

export default config({
  tsconfigRootDir: import.meta.dirname,
  restrictedImports: boundaries.finance,
  money: true,
});
