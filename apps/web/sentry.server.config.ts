import * as Sentry from '@sentry/nextjs';
import { scrubEvent } from '@vaultide/application/observability';

/**
 * Sentry, server runtime (blueprint 18.2, 22.1).
 *
 * EU region, no PII, no request payloads, no server-action arguments. The
 * scrubbing rule lives in @vaultide/application so the server, the edge and the
 * browser all apply exactly the same one, and it is unit-tested.
 */
Sentry.init({
  dsn: process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN),
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development',
  release: process.env.VAULTIDE_VERSION,
  sendDefaultPii: false,
  tracesSampleRate: 0.1,
  beforeSend: (event) => scrubEvent(event),
  beforeSendTransaction: (event) => scrubEvent(event),
});
