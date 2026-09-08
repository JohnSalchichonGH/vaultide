import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  uuid,
} from 'drizzle-orm/pg-core';
import { otherAssetTypes } from '@vaultide/validation';
import { authUser } from './auth';
import { moneyNumeric, timestamps } from './columns';
import { positionKind, positions } from './positions';
import { userOwnedPolicy } from './rls';

/**
 * `other_assets` (blueprint 6.2, F21, M15, R18) — the other-asset subtype.
 *
 * This table carries **the only inclusion preference in the schema**.
 *
 * The specification offered a general "counts towards net worth" toggle; taken
 * literally that would let a user exclude a mortgage and call the result their
 * net worth (F21). The resolution is two defined metrics instead — total net
 * worth (everything tracked) and financial net worth (the headline) — with the
 * preference living here and nowhere else. A car excluded from the financial
 * metric is still in the total one: nothing a user can switch makes a tracked
 * asset disappear from total net worth.
 *
 * The flag is **not dated**. Toggling it recomputes the financial series
 * consistently across all history, and the change is audited (12.1).
 */

export const otherAssetType = pgEnum('other_asset_type', otherAssetTypes);

export const otherAssets = pgTable(
  'other_assets',
  {
    positionId: uuid('position_id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    kind: positionKind('kind').notNull().default('other_asset'),
    assetType: otherAssetType('asset_type').notNull(),
    acquisitionDate: date('acquisition_date'),
    /**
     * What it cost, if known — metadata and the start of a cost basis, never a
     * valuation. An asset's market value only ever comes from an explicit
     * valuation row, which is what keeps "unknown" distinct from "zero".
     */
    acquisitionValue: moneyNumeric('acquisition_value'),
    includeInFinancialNetWorth: boolean('include_in_financial_net_worth')
      .notNull()
      .default(false),
    ...timestamps,
  },
  (table) => [
    check('other_assets_kind_is_other_asset', sql`${table.kind} = 'other_asset'`),
    check(
      'other_assets_acquisition_value_non_negative',
      sql`${table.acquisitionValue} IS NULL OR ${table.acquisitionValue} >= 0`,
    ),
    foreignKey({
      name: 'other_assets_position_fk',
      columns: [table.positionId, table.userId, table.kind],
      foreignColumns: [positions.id, positions.userId, positions.kind],
    }),
    index('other_assets_user_idx').on(table.userId),
    userOwnedPolicy('other_assets_user_policy'),
  ],
);

export type OtherAssetRow = typeof otherAssets.$inferSelect;
export type NewOtherAssetRow = typeof otherAssets.$inferInsert;
