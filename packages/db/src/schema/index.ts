/**
 * Drizzle schema (blueprint section 6). Phase 0 defined the global
 * `currencies` reference table; Phase 1 added identity (Better Auth), the
 * global `fx_rates` cache and the first user-owned tables — `user_settings`,
 * `categories` and `tags`. Phase 2 adds the financial core: the unified
 * `positions` supertype with its cash and other-asset subtypes, the unified
 * `position_valuations` table, and `audit_entries`. The remaining user tables
 * arrive with the phases that use them.
 */
export * from './columns';
export * from './rls';
export * from './currencies';
export * from './auth';
export * from './fx-rates';
export * from './user-settings';
export * from './categories';
export * from './tags';
export * from './positions';
export * from './cash-accounts';
export * from './other-assets';
export * from './position-valuations';
export * from './audit';
