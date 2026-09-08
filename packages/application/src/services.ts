import type { Database } from '@vaultide/db';
import { createAuth, type Auth } from './auth/config';
import { areTestEndpointsEnabled } from './context';
import { getDatabase } from './database';
import { createFxService, type FxService } from './fx/service';
import { createFixtureFxProvider } from './fx/fixture';
import { createFrankfurterProvider } from './fx/frankfurter';
import type { FxProvider } from './fx/provider';
import { createLogger, type Logger } from './logging';
import { createMailerFromEnv } from './mail/providers';
import type { Mailer } from './mail/mailer';
import type { SettingsDependencies } from './settings/service';
import type { FlowDependencies } from './flows/shared';
import type { PositionDependencies } from './positions/service';

/**
 * The composition root (blueprint 4.1, 19).
 *
 * `apps/web` never constructs a database handle, a mailer or an auth instance:
 * it asks for the services. That is what keeps the boundary of section 19 real
 * rather than aspirational — the web app cannot reach `@vaultide/db` because it
 * never needs to.
 *
 * One instance per process, built lazily so importing this module has no side
 * effect (a Next.js build imports server modules without any environment).
 */

export interface Services {
  readonly db: Database;
  readonly logger: Logger;
  readonly mailer: Mailer;
  readonly auth: Auth;
  readonly fx: FxService;
  readonly fxProvider: FxProvider;
  /** Ready-made dependency bundle for the settings use cases. */
  readonly settings: SettingsDependencies;
  /**
   * The Phase 2 financial use cases: positions, valuations, quick update and
   * the net-worth queries. They need the database and the rate service, and
   * nothing else — the engines they call are pure.
   */
  readonly positions: PositionDependencies;
  /**
   * The Phase 3 flow use cases: income, expenses, transfers, templates and the
   * accept/skip services. The same two dependencies as `positions` — the
   * engines they call are pure — but named separately so a reader can see which
   * services a change touches.
   */
  readonly flows: FlowDependencies;
}

export interface ServiceOverrides {
  readonly db?: Database;
  readonly logger?: Logger;
  readonly mailer?: Mailer;
  readonly fxProvider?: FxProvider;
  readonly env?: NodeJS.ProcessEnv;
  readonly rateLimitEnabled?: boolean;
}

/**
 * Whether the auth rate limits are on (17.1).
 *
 * `undefined` leaves Better Auth's own rule, which is "on in production" — and
 * a Next standalone server is always production, so a real deployment always
 * has them.
 *
 * The end-to-end suite needs them off: it signs up several accounts in one run,
 * which is exactly what a limit of three per ten minutes exists to stop, and
 * the limits themselves are asserted properly in the integration suite where a
 * 429 can be provoked deliberately. Turning them off is therefore allowed only
 * where the test capabilities are — never on a production deployment.
 */
function rateLimitFromEnv(env: NodeJS.ProcessEnv): boolean | undefined {
  if (env['VAULTIDE_AUTH_RATE_LIMIT'] !== 'disabled') return undefined;
  return areTestEndpointsEnabled(env) ? false : undefined;
}

/**
 * The rate publisher (10.1).
 *
 * Normally the Frankfurter v2 adapter over the approved `ECB -> BDI` chain.
 * `FX_PROVIDER=fixture` swaps in the deterministic fixture instead, so the
 * browser matrix does not depend on a free public service being fast — but
 * only where the test capabilities are enabled, which is refused outright on a
 * production deployment (21.5). Asking for it anywhere else is ignored and
 * logged, rather than silently honoured.
 */
function fxProviderFromEnv(env: NodeJS.ProcessEnv, logger: Logger): FxProvider {
  if (env['FX_PROVIDER'] === 'fixture') {
    if (areTestEndpointsEnabled(env)) return createFixtureFxProvider();
    logger.warn(
      { fx_provider: 'fixture' },
      'fx_fixture_provider_refused',
    );
  }

  return createFrankfurterProvider({
    ...(env['FX_PROVIDER_URL'] === undefined ? {} : { baseUrl: env['FX_PROVIDER_URL'] }),
    onRejected: (reason) => {
      // The reason names a currency and a date, never a rate (18.2).
      logger.warn({ route: '/api/cron/fx-refresh', reason }, 'fx_row_rejected');
    },
  });
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set. See .env.example and docs/ops/secrets.md.`);
  }
  return value;
}

/** 17.3: "`BETTER_AUTH_SECRET` >= 32 random bytes". Checked, not assumed. */
const MIN_SECRET_LENGTH = 32;

export function createServices(overrides: ServiceOverrides = {}): Services {
  const env = overrides.env ?? process.env;
  const db = overrides.db ?? getDatabase();
  const logger = overrides.logger ?? createLogger();
  const mailer = overrides.mailer ?? createMailerFromEnv(env);

  const secret = requireEnv(env, 'BETTER_AUTH_SECRET');
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `BETTER_AUTH_SECRET must be at least ${String(MIN_SECRET_LENGTH)} characters of random data (17.3).`,
    );
  }

  // `BETTER_AUTH_URL` is where the auth routes live; `APP_URL` is the origin
  // allowed to drive them. They are the same host in every deployment so far,
  // but they are different facts and are configured separately (22.2).
  const baseURL = requireEnv(env, 'BETTER_AUTH_URL');
  const appUrl = env['APP_URL'] ?? baseURL;

  const fxProvider = overrides.fxProvider ?? fxProviderFromEnv(env, logger);

  const fx = createFxService({ db, provider: fxProvider, logger });

  const rateLimitEnabled = overrides.rateLimitEnabled ?? rateLimitFromEnv(env);

  const auth = createAuth({
    db,
    mailer,
    secret,
    baseURL,
    appUrl,
    logger,
    ...(rateLimitEnabled === undefined ? {} : { rateLimitEnabled }),
  });

  return {
    db,
    logger,
    mailer,
    auth,
    fx,
    fxProvider,
    settings: {
      db,
      ensureCurrentRates: async (currencies) => {
        // Choosing a currency makes it convertible now; it asks for nothing
        // dated, so no history is fetched here (10.4, ADR 0002 decision 17).
        // Sequential rather than parallel: a courtesy to a free public
        // provider, and `ensureHistory` already swallows provider failure, so
        // the settings write the caller just made cannot be undone by it.
        for (const currency of currencies) await fx.ensureHistory(currency);
      },
    },
    positions: { db, fx },
    flows: { db, fx },
  };
}

let services: Services | undefined;

export function getServices(): Services {
  services ??= createServices();
  return services;
}

/** Test seam: forget the cached instance (used when a suite swaps databases). */
export function resetServices(): void {
  services = undefined;
}
