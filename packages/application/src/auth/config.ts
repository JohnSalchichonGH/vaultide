import { randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { haveIBeenPwned } from 'better-auth/plugins/haveibeenpwned';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { betterAuthSchema, type Database } from '@vaultide/db';
import { authInput } from '@vaultide/validation';
import type { Mailer } from '../mail/mailer';
import {
  accountDeletedEmail,
  existingAccountSignUpEmail,
  resetPasswordEmail,
  verificationEmail,
} from '../mail/templates';
import { purgeUserData } from '../users/deletion';
import { provisionUser } from '../users/provisioning';
import type { Logger } from '../logging';

/**
 * Better Auth configuration (blueprint 17.1, D16).
 *
 * Every row of the 17.1 table is expressed below. Where Better Auth 1.7's API
 * differs from the blueprint's wording the behaviour is preserved and the
 * difference is noted at the line that carries it; the two that exist are the
 * reset-request route's name and the TOTP lockout's option name.
 */

/** 17.1: sessions last 30 days and refresh at most once a day. */
export const SESSION_EXPIRES_IN = 60 * 60 * 24 * 30;
export const SESSION_UPDATE_AGE = 60 * 60 * 24;
/** 17.1: the signed session cookie caches for five minutes. */
export const SESSION_COOKIE_CACHE_MAX_AGE = 300;
/**
 * 17.1 `freshAge: 600` — password change, 2FA changes, account deletion and
 * data export need a session younger than ten minutes, or re-authentication.
 */
export const SESSION_FRESH_AGE = 600;
/** 17.1: verification and reset tokens live one hour and are single-use. */
export const TOKEN_EXPIRES_IN = 60 * 60;
/** 17.1: the TOTP challenge locks the account after five wrong codes. */
export const TOTP_MAX_FAILED_ATTEMPTS = 5;

export interface AuthDependencies {
  readonly db: Database;
  readonly mailer: Mailer;
  /** `BETTER_AUTH_SECRET`, at least 32 random bytes (17.3). */
  readonly secret: string;
  /** `BETTER_AUTH_URL` — where the auth routes are mounted. */
  readonly baseURL: string;
  /** `APP_URL` — the only origin allowed to drive the auth endpoints (17.1). */
  readonly appUrl: string;
  /**
   * Rate limiting is on by default only in production. Tests and the security
   * suite turn it on explicitly so the limits are exercised where they can be
   * asserted rather than only where they cannot.
   */
  readonly rateLimitEnabled?: boolean;
  /** Operational logging only; message bodies and payloads never reach it (18.2). */
  readonly logger?: Logger;
}

/**
 * Route-specific rate limits (17.1).
 *
 * The blueprint names the reset-request route `/forget-password`; Better Auth
 * 1.7 calls the same endpoint `/request-password-reset`. The limit — three
 * attempts per fifteen minutes — is unchanged.
 */
export const AUTH_RATE_LIMITS = {
  '/sign-in/email': { window: 60, max: 5 },
  '/sign-up/email': { window: 600, max: 3 },
  '/request-password-reset': { window: 900, max: 3 },
  '/two-factor/verify-totp': { window: 300, max: 5 },
} as const;

export const AUTH_RATE_LIMIT_DEFAULT = { window: 60, max: 30 } as const;

export function createAuth(deps: AuthDependencies) {
  const { db, mailer } = deps;
  const isHttps = deps.baseURL.startsWith('https://');

  return betterAuth({
    appName: 'Vaultide',
    secret: deps.secret,
    baseURL: deps.baseURL,

    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: betterAuthSchema,
      // Better Auth writes a user and its credential account together; without
      // this they would be two independent commits.
      transaction: true,
    }),

    // 17.1 "Origins": only the application's own origin may drive these
    // endpoints. Better Auth checks it on every state-changing request, in
    // addition to Next.js's own Origin/Host check on server actions (17.3).
    trustedOrigins: [deps.appUrl],

    emailAndPassword: {
      enabled: true,
      // A session is never issued before the address is proven (Phase 1
      // acceptance: "verification-gated sign-in").
      requireEmailVerification: true,
      minPasswordLength: authInput.MIN_PASSWORD_LENGTH,
      maxPasswordLength: authInput.MAX_PASSWORD_LENGTH,
      // Signing up must not sign you in: the verification gate would be
      // pointless if the sign-up response carried a session.
      autoSignIn: false,
      resetPasswordTokenExpiresIn: TOKEN_EXPIRES_IN,
      // 17.1: a reset invalidates every existing session, on every device.
      revokeSessionsOnPasswordReset: true,

      async sendResetPassword({ user, url }) {
        await mailer.send(resetPasswordEmail({ to: user.email, name: user.name, url }));
      },

      /**
       * 17.3 "Enumeration": the person signing up is told the same thing
       * whether or not the address is already registered, and the **existing
       * owner** is told that somebody tried. Better Auth calls this only when
       * verification is required or auto-sign-in is off — both hold here.
       */
      async onExistingUserSignUp({ user }) {
        await mailer.send(
          existingAccountSignUpEmail({
            to: user.email,
            name: user.name,
            signInUrl: `${deps.appUrl}/sign-in`,
            resetUrl: `${deps.appUrl}/reset`,
          }),
        );
      },
    },

    emailVerification: {
      sendOnSignUp: true,
      expiresIn: TOKEN_EXPIRES_IN,
      // Verifying is itself proof of control of the address, so the user lands
      // signed in rather than being asked for their password a second time.
      autoSignInAfterVerification: true,
      async sendVerificationEmail({ user, url }) {
        await mailer.send(verificationEmail({ to: user.email, name: user.name, url }));
      },
    },

    session: {
      expiresIn: SESSION_EXPIRES_IN,
      updateAge: SESSION_UPDATE_AGE,
      cookieCache: { enabled: true, maxAge: SESSION_COOKIE_CACHE_MAX_AGE },
      freshAge: SESSION_FRESH_AGE,
    },

    user: {
      deleteUser: {
        enabled: true,
        /**
         * No `sendDeleteAccountVerification`: configuring it would turn
         * deletion into an email round-trip. 18.3 wants re-authentication and a
         * typed confirmation instead, both of which the delete-account action
         * enforces before it calls this, and Better Auth verifies the password
         * it is given.
         */
        async afterDelete(user) {
          // The FK cascade from `user` should already have removed everything
          // (6.1). This verifies it and sweeps anything that survived, so a
          // half-deleted account cannot be reported as deleted (18.3).
          await purgeUserData(db, user.id, deps.logger);
          await mailer.send(accountDeletedEmail({ to: user.email, name: user.name }));
        },
      },
    },

    /**
     * 17.1: DB-backed limits with route-specific rules. The store is the
     * database, not process memory: on a serverless host an in-memory counter
     * resets with every cold start and enforces nothing.
     */
    rateLimit: {
      enabled: deps.rateLimitEnabled ?? undefined,
      storage: 'database',
      window: AUTH_RATE_LIMIT_DEFAULT.window,
      max: AUTH_RATE_LIMIT_DEFAULT.max,
      customRules: { ...AUTH_RATE_LIMITS },
    },

    advanced: {
      /**
       * 17.3 "CSRF": stated explicitly rather than left to the default.
       *
       * Better Auth turns its origin and CSRF checks **off** when
       * `NODE_ENV === 'test'`. That is convenient for a library's own suite and
       * wrong for ours: a control that switches itself off under the conditions
       * it is tested in has not been tested. Setting both flags makes the
       * behaviour identical in every environment, and the security suite can
       * assert that a cross-origin request is refused.
       */
      disableOriginCheck: false,
      disableCSRFCheck: false,
      // 17.1: `httpOnly`, `secure` in production, `SameSite=Lax`, and the
      // `__Secure-` prefix, which Better Auth adds whenever cookies are secure.
      useSecureCookies: isHttps,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure: isHttps },
      database: {
        // 17.1 "IDs": UUID v4, so the auth tables use `uuid` columns and every
        // `user_id` elsewhere is a real uuid foreign key (6.1).
        generateId: () => randomUUID(),
      },
    },

    databaseHooks: {
      user: {
        create: {
          /**
           * Provisioning (Phase 1): settings, the default categories including
           * all seven system kinds, and the initial tags — in one transaction.
           * `provisionUser` is idempotent, and `requireSession` re-runs it if
           * this ever fails, so an account can never be left unusable.
           */
          after: async (user) => {
            await provisionUser(db, { userId: user.id });
          },
        },
      },
    },

    plugins: [
      twoFactor({
        // The string authenticator apps display next to the code.
        issuer: 'Vaultide',
        // 17.1: "lockout after 5 wrong codes". Better Auth 1.7 expresses this
        // as an account-level lockout across challenges and factors, which is
        // the same rule stated more precisely; the default is 10.
        accountLockout: { enabled: true, maxFailedAttempts: TOTP_MAX_FAILED_ATTEMPTS },
        backupCodeOptions: { storeBackupCodes: 'encrypted' },
      }),
      /**
       * 17.1: passwords are checked against Have I Been Pwned by k-anonymity at
       * sign-up, change and reset. In Better Auth 1.7 the `isPasswordCompromised`
       * option of the blueprint is this plugin; the behaviour — a compromised
       * password is refused, and only a five-character hash prefix ever leaves
       * the process — is unchanged.
       */
      haveIBeenPwned({
        customPasswordCompromisedMessage:
          'This password has appeared in a public data breach. Choose a different one.',
      }),
      // Must be last: it writes Better Auth's cookies through Next's cookie API.
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
