import * as Sentry from '@sentry/nextjs';
import { scrubEvent } from '@vaultide/application/observability';

/** Sentry, edge runtime (proxy.ts). Same redaction rule as the server (18.2). */
Sentry.init({
  dsn: process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN),
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development',
  release: process.env.VAULTIDE_VERSION,
  sendDefaultPii: false,
  tracesSampleRate: 0.1,
  beforeSend: (event) => scrubEvent(event),
});
