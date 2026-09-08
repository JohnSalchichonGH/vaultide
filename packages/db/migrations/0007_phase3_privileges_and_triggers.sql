-- Phase 3: the updated_at triggers for the flow tables, and the backup grant
-- extended over them.
--
-- Two things drizzle-kit cannot generate from the schema, exactly as in
-- migration 0005:
--
--   1. 6.1: `updated_at` is trigger-maintained, so no application path can
--      forget it and no client can set it.
--   2. 6.1 / R27: `app_backup` must be able to read every table a migration
--      creates. `ALTER DEFAULT PRIVILEGES` covers objects created after the
--      bootstrap, but the grant is re-stated here so a backup taken the day
--      this migration lands is provably complete rather than probably complete.

-- ---------------------------------------------------------------------------
-- 1. updated_at
-- ---------------------------------------------------------------------------
-- `set_updated_at()` was created by migration 0003.

DROP TRIGGER IF EXISTS recurring_templates_set_updated_at ON recurring_templates;
--> statement-breakpoint
CREATE TRIGGER recurring_templates_set_updated_at
  BEFORE UPDATE ON recurring_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

DROP TRIGGER IF EXISTS recurring_template_terms_set_updated_at ON recurring_template_terms;
--> statement-breakpoint
CREATE TRIGGER recurring_template_terms_set_updated_at
  BEFORE UPDATE ON recurring_template_terms
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

DROP TRIGGER IF EXISTS recurring_template_skips_set_updated_at ON recurring_template_skips;
--> statement-breakpoint
CREATE TRIGGER recurring_template_skips_set_updated_at
  BEFORE UPDATE ON recurring_template_skips
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

DROP TRIGGER IF EXISTS income_entries_set_updated_at ON income_entries;
--> statement-breakpoint
CREATE TRIGGER income_entries_set_updated_at
  BEFORE UPDATE ON income_entries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

DROP TRIGGER IF EXISTS transfers_set_updated_at ON transfers;
--> statement-breakpoint
CREATE TRIGGER transfers_set_updated_at
  BEFORE UPDATE ON transfers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

DROP TRIGGER IF EXISTS expense_entries_set_updated_at ON expense_entries;
--> statement-breakpoint
CREATE TRIGGER expense_entries_set_updated_at
  BEFORE UPDATE ON expense_entries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

DROP TRIGGER IF EXISTS month_reviews_set_updated_at ON month_reviews;
--> statement-breakpoint
CREATE TRIGGER month_reviews_set_updated_at
  BEFORE UPDATE ON month_reviews
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

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_backup') THEN
    -- Backups must be complete; writing stays impossible (R27, T12).
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_backup;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM app_backup;
  END IF;
END
$privileges$;
