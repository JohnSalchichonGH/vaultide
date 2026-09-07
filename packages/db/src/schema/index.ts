/**
 * Drizzle schema (blueprint section 6). Phase 0 defined the global
 * `currencies` reference table; Phase 1 adds identity (Better Auth), the global
 * `fx_rates` cache and the first user-owned tables — `user_settings`,
 * `categories` and `tags`, each with RLS. The remaining user tables arrive with
 * the phases that use them.
 */
export * from './columns';
export * from './rls';
export * from './currencies';
export * from './auth';
export * from './fx-rates';
export * from './user-settings';
export * from './categories';
export * from './tags';
