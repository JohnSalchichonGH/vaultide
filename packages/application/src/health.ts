import { ping, type Database } from '@vaultide/db';

/**
 * Health check behind `/api/health` (blueprint 4.2, 22.6): an external monitor
 * polls it every five minutes, so it proves the database connection rather than
 * merely that the process is up. It reports no user data and needs no session.
 */
export interface HealthReport {
  readonly status: 'ok' | 'degraded';
  readonly database: 'ok' | 'unreachable';
  readonly checkedAt: string;
  readonly version: string;
}

/**
 * Which build is answering. Explicit when CI sets it, otherwise the commit the
 * host deployed, so a running deployment can always be tied back to a commit
 * without anyone remembering to configure a variable.
 */
export function deployedVersion(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['VAULTIDE_VERSION'];
  if (explicit !== undefined && explicit !== '') return explicit;

  const commit = env['VERCEL_GIT_COMMIT_SHA'];
  if (commit !== undefined && commit !== '') return commit.slice(0, 7);

  return 'dev';
}

export async function checkHealth(
  db: Database,
  options: { version?: string } = {},
): Promise<HealthReport> {
  const checkedAt = new Date().toISOString();
  const version = options.version ?? deployedVersion();

  try {
    const alive = await ping(db);
    return {
      status: alive ? 'ok' : 'degraded',
      database: alive ? 'ok' : 'unreachable',
      checkedAt,
      version,
    };
  } catch {
    // The reason never reaches the response body: it would describe internals.
    return { status: 'degraded', database: 'unreachable', checkedAt, version };
  }
}
