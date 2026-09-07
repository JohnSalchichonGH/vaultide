-- Phase 1: runtime privilege exceptions and the updated_at trigger.
--
-- Two things drizzle-kit cannot generate from the schema, both required by the
-- blueprint:
--
--   1. 6.1: `updated_at` is trigger-maintained, so no application path can
--      forget it and no client can set it.
--   2. 6.1 / 6.2: the bootstrap script's default privileges give `app_user`
--      full DML on every table a migration creates. `fx_rates` is deliberately
--      narrower — SELECT and INSERT only — because its rows are immutable and
--      a conversion made last year must still reproduce next year.

-- ---------------------------------------------------------------------------
-- 1. updated_at
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;
--> statement-breakpoint

-- Application tables only. The Better Auth tables are excluded on purpose:
-- Better Auth writes `updatedAt` itself and compares it, so a trigger would be
-- overwriting a value the library considers its own.
DROP TRIGGER IF EXISTS user_settings_set_updated_at ON user_settings;
--> statement-breakpoint
CREATE TRIGGER user_settings_set_updated_at
  BEFORE UPDATE ON user_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

DROP TRIGGER IF EXISTS categories_set_updated_at ON categories;
--> statement-breakpoint
CREATE TRIGGER categories_set_updated_at
  BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

DROP TRIGGER IF EXISTS tags_set_updated_at ON tags;
--> statement-breakpoint
CREATE TRIGGER tags_set_updated_at
  BEFORE UPDATE ON tags
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Privileges
-- ---------------------------------------------------------------------------
DO $privileges$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    RAISE EXCEPTION
      'Role app_user does not exist. Run scripts/db/bootstrap-roles.sql as the platform admin before migrating (blueprint 22.2).';
  END IF;

  -- 6.2: `fx_rates` rows are never updated. An alternative rate for the same
  -- day is a new row with another source; readers apply a source preference.
  -- Removing UPDATE and DELETE makes that a property of the runtime role, not
  -- a convention the application layer has to keep.
  REVOKE UPDATE, DELETE, TRUNCATE ON TABLE fx_rates FROM app_user;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_backup') THEN
    -- The bootstrap's default privileges already cover tables created after it
    -- ran; these statements make a re-run on an existing database converge to
    -- the same state, and re-assert that the backup role can never write.
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_backup;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM app_backup;
  END IF;
END
$privileges$;
