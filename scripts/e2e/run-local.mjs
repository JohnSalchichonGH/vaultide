#!/usr/bin/env node
/**
 * The browser suite against a database provisioned for this run (blueprint
 * 21.5, 21.7).
 *
 *   pnpm test:e2e:local
 *   node --import tsx scripts/e2e/run-local.mjs [playwright arguments]
 *
 * It provisions a fresh database the way every integration suite does —
 * bootstrap, migrations and the currency seed, through
 * `@vaultide/db/testing` — runs Playwright against the standalone build with
 * that database, and drops the database afterwards, whatever the outcome. The
 * connection string goes to Playwright through the environment and is never
 * printed.
 *
 * Before it starts it refuses three things that would make a run meaningless:
 *
 *  - an external target (`E2E_BASE_URL`), where this database would be unused;
 *  - no standalone build: the suite runs the production artifact, so run
 *    `pnpm build` first, after the change being verified;
 *  - something already listening on the suite's port. Outside CI Playwright
 *    reuses a server it finds there, so a stale one would be tested instead
 *    of the build, and a stale green is worse than no result.
 *
 * Two things it cannot check:
 *
 *  - the local cluster must be running (`pnpm db:local start`);
 *  - provisioning resets the cluster-wide passwords of the application roles,
 *    so do not run it alongside the integration suites.
 *
 * Unless the arguments choose a reporter, it adds the list and JSON reporters
 * and ends with one summary line — total, passed first time, flaky, failed and
 * skipped — and names every test that did not pass on its first attempt.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const e2eRoot = path.join(repoRoot, 'e2e');
const port = Number(process.env.E2E_PORT ?? 3100);

function refuse(message) {
  console.error(`run-local: ${message}`);
  process.exit(1);
}

function listening(onPort) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: onPort });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** Total, first-attempt passes, flaky, failed and skipped, from Playwright's JSON report. */
function summarize(reportFile) {
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  const counts = { total: 0, firstPass: 0, flaky: 0, failed: 0, skipped: 0 };
  const notFirstPass = [];
  const walk = (suite) => {
    for (const child of suite.suites ?? []) walk(child);
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        counts.total += 1;
        const attempts = (test.results ?? []).map((result) => result.status);
        if (test.status === 'skipped') counts.skipped += 1;
        else if (test.status === 'flaky') counts.flaky += 1;
        else if (test.status === 'unexpected') counts.failed += 1;
        if (attempts.length === 1 && attempts[0] === 'passed') counts.firstPass += 1;
        else if (test.status !== 'skipped') {
          notFirstPass.push(`  [${test.projectName}] ${spec.file}:${spec.line} ${spec.title} (${attempts.join(', ')})`);
        }
      }
    }
  };
  for (const suite of report.suites ?? []) walk(suite);
  console.log(
    `e2e summary: total=${counts.total} first-pass=${counts.firstPass} flaky=${counts.flaky} failed=${counts.failed} skipped=${counts.skipped}`,
  );
  for (const line of notFirstPass) console.log(line);
  console.log(`e2e report: ${reportFile}`);
}

if (process.env.E2E_BASE_URL) {
  refuse('E2E_BASE_URL points at an external server, which would not use this database. Run Playwright directly.');
}

const serverEntry = path.join(repoRoot, 'apps', 'web', '.next', 'standalone', 'apps', 'web', 'server.js');
if (!existsSync(serverEntry)) refuse('No standalone build. Run "pnpm build" first.');

const playwrightCli = path.join(e2eRoot, 'node_modules', '@playwright', 'test', 'cli.js');
if (!existsSync(playwrightCli)) refuse('Playwright is not installed. Run "pnpm install" first.');

if (await listening(port)) {
  refuse(`Something is already listening on port ${String(port)}. Stop it first: Playwright would reuse it instead of the build.`);
}

const args = process.argv.slice(2);
const env = { ...process.env };
let reportFile = null;
if (!args.some((arg) => arg.startsWith('--reporter'))) {
  reportFile = env.PLAYWRIGHT_JSON_OUTPUT_NAME || path.join(os.tmpdir(), `vaultide-e2e-${String(Date.now())}.json`);
  env.PLAYWRIGHT_JSON_OUTPUT_NAME = reportFile;
  args.push('--reporter=list,json');
}

const provision = await import(
  pathToFileURL(path.join(repoRoot, 'packages', 'db', 'src', 'testing', 'provision.ts')).href
);

let database;
try {
  database = await provision.provisionDatabase();
} catch (error) {
  const hint = String(error).includes('ECONNREFUSED') ? ' Is the local cluster running? "pnpm db:local start".' : '';
  refuse(`Could not provision a database: ${error instanceof Error ? error.message : String(error)}.${hint}`);
}

const built = statSync(serverEntry).mtime;
console.log(`run-local: database ${database.databaseName}, build from ${built.toISOString()}, port ${String(port)}`);

// The terminal delivers Ctrl+C to Playwright as well; staying alive until it
// exits is what lets the database be dropped.
process.on('SIGINT', () => {});

let code = 1;
try {
  code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [playwrightCli, 'test', ...args], {
      cwd: e2eRoot,
      stdio: 'inherit',
      env: { ...env, DATABASE_URL: database.userUrl },
    });
    child.on('exit', (exitCode) => resolve(exitCode ?? 1));
  });
} finally {
  await provision.dropDatabase(provision.adminUrl(), database.databaseName);
}

if (reportFile !== null && existsSync(reportFile)) summarize(reportFile);
process.exit(code);
