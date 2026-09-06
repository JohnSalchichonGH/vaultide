import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/client.ts'],
      thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
      reporter: ['text-summary', 'lcov'],
    },
  },
});
