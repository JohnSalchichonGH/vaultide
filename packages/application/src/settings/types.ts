import type { RequestContext } from '../context';

/**
 * The settings DTO (blueprint 6.2 `user_settings`, 4.2 "serializable DTOs").
 *
 * A plain object of strings, numbers and booleans: it crosses the server/client
 * boundary of a React Server Component, so it holds no Date, no Decimal and no
 * database row type.
 */
export interface UserSettings {
  readonly userId: string;
  /** What the user thinks in. Seeds new positions and the scenario reserve. */
  readonly baseCurrency: string;
  /** What totals are displayed in. A presentation choice; never persisted into a record (T8, M10). */
  readonly reportingCurrency: string;
  readonly timezone: string;
  readonly locale: string;
  readonly favoriteCurrencies: readonly string[];
  readonly staleInvestmentMonths: number;
  readonly stalePropertyMonths: number;
  /** 12.5, D40: whether self-paid untracked spending reduces the savings rate. */
  readonly countAdditionalSpending: boolean;
  /**
   * Whether the user has been through onboarding steps 1-3. UI state, so it
   * lives in `preferences` rather than in a column of its own (6.1).
   */
  readonly onboardingCompleted: boolean;
  /** Optimistic concurrency token (20.3). */
  readonly version: number;
}

/**
 * The context of an authenticated request (17.2).
 *
 * `today` is already computed in the user's timezone by the time this exists,
 * so no engine and no validator has to ask what day it is.
 */
export interface SessionContext extends RequestContext {
  readonly settings: UserSettings;
  readonly email: string;
  readonly name: string;
  readonly emailVerified: boolean;
  readonly twoFactorEnabled: boolean;
  /**
   * Whether the session is younger than `freshAge` (17.1). Sensitive screens
   * read this to decide whether to ask for the password again; Better Auth
   * enforces the same rule server-side on the endpoints themselves, so this is
   * for the interface, never the authority.
   */
  readonly sessionFresh: boolean;
}
