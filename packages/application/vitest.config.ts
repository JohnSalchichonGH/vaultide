import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
      {
        // The one suite that talks to the public rate service. Its own project
        // so it never runs as a side effect of the others, and serial so a
        // free API is asked one question at a time.
        test: {
          name: 'live',
          include: ['test/live/**/*.test.ts'],
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 240_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          // Each file provisions its own database; the role bootstrap is
          // cluster-wide, so files run one after another.
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 240_000,
        },
      },
    ],
  },
});
