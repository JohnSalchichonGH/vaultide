#!/usr/bin/env node
/**
 * A throwaway local PostgreSQL 16 cluster for development and for running the
 * integration suite without Docker (blueprint 22.2 "local: Docker Postgres 16
 * or a personal Neon branch" — this is the third, dependency-free option).
 *
 *   pnpm db:local start | stop | status | url
 *
 * The cluster listens on loopback only, uses scram-sha-256 like production, and
 * stores its generated superuser password under .vaultide-pg/ (gitignored).
 * PostgreSQL binaries are located, in order: $PGBIN, ~/.vaultide/pgsql/bin,
 * or whatever `pg_ctl` is already on PATH.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const stateDir = path.join(repoRoot, '.vaultide-pg');
const dataDir = path.join(stateDir, 'data');
const logFile = path.join(stateDir, 'postgres.log');
const connectionFile = path.join(stateDir, 'connection.json');
const DEFAULT_PORT = Number(process.env.VAULTIDE_PG_PORT ?? 55432);
const SUPERUSER = 'vaultide_admin';

function binDir() {
  if (process.env.PGBIN) return process.env.PGBIN;
  const cached = path.join(os.homedir(), '.vaultide', 'pgsql', 'bin');
  if (fs.existsSync(cached)) return cached;
  return '';
}

function tool(name) {
  const dir = binDir();
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  return dir ? path.join(dir, exe) : exe;
}

function run(name, args, options = {}) {
  const result = spawnSync(tool(name), args, { encoding: 'utf8', ...options });
  if (result.error) {
    throw new Error(
      `Could not run ${name}: ${result.error.message}\n` +
        'Set PGBIN to a PostgreSQL 16 bin directory, or install PostgreSQL 16.',
    );
  }
  return result;
}

function readConnection() {
  if (!fs.existsSync(connectionFile)) return null;
  return JSON.parse(fs.readFileSync(connectionFile, 'utf8'));
}

function isRunning() {
  if (!fs.existsSync(dataDir)) return false;
  return run('pg_ctl', ['-D', dataDir, 'status']).status === 0;
}

function initCluster() {
  fs.mkdirSync(stateDir, { recursive: true });
  const password = randomBytes(18).toString('base64url');
  const pwFile = path.join(stateDir, 'superuser.pw');
  fs.writeFileSync(pwFile, password, { mode: 0o600 });

  const result = run('initdb', [
    '-D', dataDir,
    '-U', SUPERUSER,
    '--auth-host=scram-sha-256',
    '--auth-local=trust',
    `--pwfile=${pwFile}`,
    '--encoding=UTF8',
    '--locale=C',
  ]);
  if (result.status !== 0) {
    throw new Error(`initdb failed:\n${result.stdout}\n${result.stderr}`);
  }

  fs.appendFileSync(
    path.join(dataDir, 'postgresql.conf'),
    `\n# Vaultide local development cluster\nlisten_addresses = '127.0.0.1'\nport = ${DEFAULT_PORT}\nfsync = off\nsynchronous_commit = off\nfull_page_writes = off\n`,
  );

  const url = `postgres://${SUPERUSER}:${encodeURIComponent(password)}@127.0.0.1:${DEFAULT_PORT}/postgres`;
  fs.writeFileSync(
    connectionFile,
    `${JSON.stringify({ port: DEFAULT_PORT, superuser: SUPERUSER, password, url }, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(`Initialized a local PostgreSQL cluster in ${dataDir}`);
}

function start() {
  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) initCluster();
  if (isRunning()) {
    console.log('Local PostgreSQL is already running.');
    return;
  }
  // Detached, with no inherited handles, so the server outlives this process
  // and never holds the calling shell open.
  const child = spawn(tool('pg_ctl'), ['-D', dataDir, '-l', logFile, 'start'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  const ready = () => run('pg_isready', ['-h', '127.0.0.1', '-p', String(DEFAULT_PORT)]).status === 0;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !ready()) {
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 250)']);
  }
  if (!ready()) throw new Error(`PostgreSQL did not become ready; see ${logFile}`);

  const connection = readConnection();
  console.log(`Local PostgreSQL running on port ${connection.port}.`);
  console.log('Admin URL is in .vaultide-pg/connection.json (gitignored).');
}

function stop() {
  if (!isRunning()) {
    console.log('Local PostgreSQL is not running.');
    return;
  }
  const result = run('pg_ctl', ['-D', dataDir, '-m', 'fast', '-w', 'stop']);
  if (result.status !== 0) {
    throw new Error(`pg_ctl stop failed:\n${result.stdout}\n${result.stderr}`);
  }
  console.log('Local PostgreSQL stopped.');
}

const command = process.argv[2] ?? 'status';
switch (command) {
  case 'start':
    start();
    break;
  case 'stop':
    stop();
    break;
  case 'url': {
    const connection = readConnection();
    if (!connection) {
      console.error('No local cluster yet. Run: pnpm db:local start');
      process.exit(1);
    }
    console.log(connection.url);
    break;
  }
  case 'status':
    console.log(isRunning() ? 'running' : 'stopped');
    break;
  default:
    console.error(`Unknown command "${command}". Use start, stop, status or url.`);
    process.exit(1);
}
