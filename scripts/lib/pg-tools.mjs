/**
 * Locating the PostgreSQL client tools the operational scripts need.
 * Order: $PGBIN, the local development cache, then PATH.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function pgBinDir() {
  if (process.env.PGBIN) return process.env.PGBIN;
  const cached = path.join(os.homedir(), '.vaultide', 'pgsql', 'bin');
  if (fs.existsSync(cached)) return cached;
  return '';
}

export function pgTool(name) {
  const dir = pgBinDir();
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  return dir ? path.join(dir, exe) : exe;
}

/** Run a PostgreSQL tool, returning stdout. Throws with stderr on failure. */
export function runPgTool(name, args, options = {}) {
  const result = spawnSync(pgTool(name), args, {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    ...options,
  });
  if (result.error) {
    throw new Error(
      `Could not run ${name}: ${result.error.message}. Set PGBIN to a PostgreSQL 16 bin directory.`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`${name} failed (exit ${result.status}):\n${result.stderr ?? ''}`);
  }
  return result.stdout ?? '';
}
