import { checkHealth, getDatabase, isDatabaseConfigured } from '@vaultide/application';

/**
 * `/api/health` (blueprint 4.2, 22.6).
 *
 * Polled by an external uptime monitor every five minutes, so it proves the
 * database connection rather than merely that the process is alive. It needs no
 * session, returns no user data, and is never cached.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(): Promise<Response> {
  if (!isDatabaseConfigured()) {
    // A build or preview without DATABASE_URL is honest about it rather than
    // reporting a healthy database it never contacted.
    return Response.json(
      {
        status: 'degraded',
        database: 'unreachable',
        checkedAt: new Date().toISOString(),
        version: process.env.VAULTIDE_VERSION ?? 'dev',
        detail: 'DATABASE_URL is not configured',
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const report = await checkHealth(getDatabase());

  return Response.json(report, {
    status: report.status === 'ok' ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
