#!/usr/bin/env node
/**
 * The real-provider verification (blueprint 10.1, 21.3).
 *
 *   pnpm test:live
 *
 * One serial run of `packages/application/test/live`, against the **live**
 * Frankfurter v2 service, with a database provisioned from zero like every
 * other integration suite. It is the only suite that touches the public API:
 * the browser matrix runs against a deterministic fixture and the integration
 * suite against a stub, so a transient upstream slowdown can never make
 * Vaultide's own suites flaky. What is left here is the question only the real
 * service can answer — does the adapter still speak to v2 correctly?
 *
 * It is not part of `pnpm test:integration` and is not run per browser or per
 * project. Run it before a release, and whenever the adapter changes.
 *
 * `FX_LIVE=1` is set here rather than in the script line: `VAR=x command` is
 * shell-specific and this repository is developed on Windows too.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(repoRoot, 'packages', 'application');
// pnpm hoists to the workspace root; the package's own tree is checked first
// so a future direct dependency keeps working.
const vitest = [
  path.join(packageRoot, 'node_modules', 'vitest', 'vitest.mjs'),
  path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'),
].find((candidate) => existsSync(candidate));

if (vitest === undefined) {
  console.error('vitest was not found. Run "pnpm install" first.');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [vitest, 'run', '--project', 'live'],
  {
    cwd: packageRoot,
    stdio: 'inherit',
    env: { ...process.env, FX_LIVE: '1' },
  },
);

process.exit(result.status ?? 1);
