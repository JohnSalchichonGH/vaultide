import type { Database } from '@vaultide/db';
import { createAuth, type Auth } from './auth/config';
import { areTestEndpointsEnabled } from './context';
import { getDatabase } from './database';
import { createFxService, type FxService } from './fx/service';
import { createFrankfurterProvider } from './fx/frankfurter';
import type { FxProvider } from './fx/provider';
import { createLogger, type Logger } from './logging';
import { createMailerFromEnv } from './mail/providers';
import type { Mailer } from './mail/mailer';
import type { SettingsDependencies } from './settings/service';

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

  const fxProvider =
    overrides.fxProvider ??
    createFrankfurterProvider({
      ...(env['FX_PROVIDER_URL'] === undefined ? {} : { baseUrl: env['FX_PROVIDER_URL'] }),
      onRejected: (reason) => {
        // The reason names a currency and a date, never a rate (18.2).
        logger.warn({ route: '/api/cron/fx-refresh', reason }, 'fx_row_rejected');
      },
    });

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
      ensureCurrencyHistory: async (currencies) => {
        // First use of a currency backfills its history once, globally (10.4).
        // Sequential rather than parallel: this is a courtesy to a free public
        // provider, and the user's action does not wait on the result being
        // complete — `ensureHistory` already swallows provider failure.
        for (const currency of currencies) await fx.ensureHistory(currency);
      },
    },
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
