import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // Next compiles JSX itself, so the app's tsconfig preserves it. The unit tests
  // render a few presentational components to static markup, which needs Vite to
  // transform it instead — for the tests only; the build is untouched.
  oxc: { jsx: { runtime: 'automatic' } },
  test: { include: ['test/**/*.test.ts'] },
});
