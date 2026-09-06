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

export async function checkHealth(
  db: Database,
  options: { version?: string } = {},
): Promise<HealthReport> {
  const checkedAt = new Date().toISOString();
  const version = options.version ?? process.env.VAULTIDE_VERSION ?? 'dev';

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
