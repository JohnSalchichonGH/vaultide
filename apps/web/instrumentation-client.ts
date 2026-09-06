import * as Sentry from '@sentry/nextjs';
import { scrubEvent } from '@vaultide/application/observability';

/**
 * Sentry, browser (blueprint 18.2): no Session Replay, no PII, no network or
 * console breadcrumbs — a finance UI's breadcrumbs would carry balances.
 */
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? 'development',
  sendDefaultPii: false,
  tracesSampleRate: 0.1,
  integrations: (defaults) =>
    defaults.filter(
      (integration) => !['Replay', 'BrowserSession', 'Breadcrumbs'].includes(integration.name),
    ),
  beforeSend: (event) => scrubEvent(event),
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
