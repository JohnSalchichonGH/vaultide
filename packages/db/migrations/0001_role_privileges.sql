-- Runtime privilege exceptions (blueprint 6.1).
--
-- The bootstrap script's default privileges give `app_user` full DML on every
-- table migrations create. A few tables are deliberately narrower; this
-- migration applies those exceptions as they appear, phase by phase. Phase 0
-- has one: `currencies` is global reference data that only migrations write.
--
-- Later phases add here: `fx_rates` (SELECT, INSERT only), `audit_entries`
-- (INSERT, SELECT only) and `scenario_revisions` (no UPDATE).

DO $privileges$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    RAISE EXCEPTION
      'Role app_user does not exist. Run scripts/db/bootstrap-roles.sql as the platform admin before migrating (blueprint 22.2).';
  END IF;

  -- Reference data: read-only for the runtime role.
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE currencies FROM app_user;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_backup') THEN
    -- Backups must be complete even for tables created before the default
    -- privileges existed; writing stays impossible.
    GRANT SELECT ON TABLE currencies TO app_backup;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE currencies FROM app_backup;

    -- The migration bookkeeping schema is part of a restorable backup, so
    -- `pg_dump` as app_backup must be able to read it. Without this, the whole
    -- dump fails on "permission denied for schema drizzle".
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') THEN
      GRANT USAGE ON SCHEMA drizzle TO app_backup;
      GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO app_backup;
      GRANT SELECT ON ALL SEQUENCES IN SCHEMA drizzle TO app_backup;
      ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA drizzle
        GRANT SELECT ON TABLES TO app_backup;
      ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA drizzle
        GRANT SELECT ON SEQUENCES TO app_backup;
    END IF;
  END IF;
END
$privileges$;
