-- Phase 2: runtime privilege exceptions and the updated_at triggers.
--
-- Two things drizzle-kit cannot generate from the schema, both required by the
-- blueprint:
--
--   1. 6.1: `updated_at` is trigger-maintained, so no application path can
--      forget it and no client can set it.
--   2. 6.1 / 18.1: the bootstrap script's default privileges give `app_user`
--      full DML on every table a migration creates. `audit_entries` is
--      deliberately narrower — INSERT and SELECT only — because an audit trail
--      the runtime can rewrite is not an audit trail.

-- ---------------------------------------------------------------------------
-- 1. updated_at
-- ---------------------------------------------------------------------------
-- `set_updated_at()` was created by migration 0003.

DROP TRIGGER IF EXISTS positions_set_updated_at ON positions;
--> statement-breakpoint
CREATE TRIGGER positions_set_updated_at
  BEFORE UPDATE ON positions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

DROP TRIGGER IF EXISTS cash_accounts_set_updated_at ON cash_accounts;
--> statement-breakpoint
CREATE TRIGGER cash_accounts_set_updated_at
  BEFORE UPDATE ON cash_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

DROP TRIGGER IF EXISTS other_assets_set_updated_at ON other_assets;
--> statement-breakpoint
CREATE TRIGGER other_assets_set_updated_at
  BEFORE UPDATE ON other_assets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

DROP TRIGGER IF EXISTS position_valuations_set_updated_at ON position_valuations;
--> statement-breakpoint
CREATE TRIGGER position_valuations_set_updated_at
  BEFORE UPDATE ON position_valuations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- `audit_entries` has no `updated_at`: an audit row is never edited (18.1).

-- ---------------------------------------------------------------------------
-- 2. Privileges
-- ---------------------------------------------------------------------------
DO $privileges$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    RAISE EXCEPTION
      'Role app_user does not exist. Run scripts/db/bootstrap-roles.sql as the platform admin before migrating (blueprint 22.2).';
  END IF;

  -- 6.1: `app_user` holds INSERT and SELECT on `audit_entries` and nothing
  -- more. The before-image of a deleted valuation is the only remaining record
  -- of it (R12, T7), so the role that performs the deletion must not be able to
  -- remove or alter the evidence of it afterwards.
  REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_entries FROM app_user;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_backup') THEN
    -- Backups must be complete; writing stays impossible (R27, T12).
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_backup;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM app_backup;
  END IF;
END
$privileges$;
