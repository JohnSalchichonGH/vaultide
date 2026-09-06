/**
 * Next.js instrumentation hook (blueprint 22.1): initialise Sentry once per
 * runtime. Nothing is initialised when no DSN is configured, so local runs and
 * CI send nothing anywhere.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

export { captureRequestError as onRequestError } from '@sentry/nextjs';
