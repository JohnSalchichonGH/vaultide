import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Better Auth tables (blueprint 17.1, T10, D16).
 *
 * Better Auth owns identity; the application owns `user_settings` and
 * everything else keyed by `user_id`. The shape below is exactly what Better
 * Auth 1.7's Drizzle adapter expects — the TypeScript property names are the
 * adapter's field names and must stay camelCase, while the columns follow the
 * project's snake_case convention.
 *
 * Two deliberate departures from the generated default:
 *
 *  - ids are `uuid`, not `text` (17.1: `advanced.database.generateId` returns a
 *    UUID v4), so every `user_id` in the application schema is a real `uuid`
 *    foreign key and the RLS predicate's `::uuid` cast compares like with like;
 *  - timestamps are `timestamptz` (6.1: system times are UTC `timestamptz`).
 *
 * These tables carry **no** RLS (17.4): they belong to no tenant in the RLS
 * sense, and Better Auth queries them without a user context — a session must
 * be readable before there is a user id to scope by. Ownership is enforced by
 * Better Auth itself, which only ever looks a session up by its own token.
 */

export const authUser = pgTable('user', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  /** Added by the twoFactor plugin. */
  twoFactorEnabled: boolean('two_factor_enabled').default(false),
});

export const authSession = pgTable(
  'session',
  {
    id: uuid('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
  },
  (table) => [index('session_user_id_idx').on(table.userId)],
);

export const authAccount = pgTable(
  'account',
  {
    id: uuid('id').primaryKey(),
    issuer: text('issuer').notNull(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    /** The scrypt hash of the user's password. Never leaves the database. */
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('account_issuer_account_id_uidx').on(table.issuer, table.accountId),
    index('account_user_id_idx').on(table.userId),
  ],
);

/** Verification, reset-password and delete-account tokens. Single-use, expiring. */
export const authVerification = pgTable(
  'verification',
  {
    id: uuid('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
);

/** TOTP secret and backup codes (17.1). One row per user with 2FA enabled. */
export const authTwoFactor = pgTable(
  'two_factor',
  {
    id: uuid('id').primaryKey(),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    verified: boolean('verified').default(true),
    failedVerificationCount: integer('failed_verification_count').default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
  },
  (table) => [
    index('two_factor_secret_idx').on(table.secret),
    index('two_factor_user_id_idx').on(table.userId),
  ],
);

/**
 * Database-backed auth rate limiting (17.1, 17.3 "Brute force").
 *
 * Storage is the database rather than process memory so a limit survives a
 * serverless cold start and applies across every instance — an in-memory
 * counter on Vercel would reset on each new lambda and enforce nothing.
 */
export const authRateLimit = pgTable('rate_limit', {
  id: uuid('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
});

export type AuthUserRow = typeof authUser.$inferSelect;
export type AuthSessionRow = typeof authSession.$inferSelect;

/**
 * The schema object handed to `drizzleAdapter`. Its keys are Better Auth model
 * names, which is how the adapter finds each table.
 */
export const betterAuthSchema = {
  user: authUser,
  session: authSession,
  account: authAccount,
  verification: authVerification,
  twoFactor: authTwoFactor,
  rateLimit: authRateLimit,
};
