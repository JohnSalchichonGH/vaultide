-- Vaultide database role bootstrap (blueprint 22.2, 6.1, D45).
--
-- Run ONCE per environment, as the platform/admin role (Neon's project owner,
-- or the superuser of a local PostgreSQL), BEFORE the first migration. A
-- migration cannot create the role it runs as, which is why this is not
-- migration 0.
--
-- The script is idempotent: re-running it creates nothing twice, changes no
-- privilege and drops nothing. Passwords are optional on a re-run; supply them
-- only when creating the roles or rotating a credential.
--
-- Roles:
--   app_owner   owns the schema, runs migrations (DDL). CI only.
--   app_user    runtime role: DML under RLS, NOBYPASSRLS, no DDL. Vercel only.
--   app_backup  SELECT everywhere, BYPASSRLS so pg_dump is complete, no writes.
--               Backup workflow only.
--
-- Passwords are read from session settings so no credential is ever written
-- into this file or into a log:
--   SELECT set_config('vaultide.app_owner_password',  '…', false);
--   SELECT set_config('vaultide.app_user_password',   '…', false);
--   SELECT set_config('vaultide.app_backup_password', '…', false);
-- `pnpm db:bootstrap` and .github/workflows/bootstrap-database.yml do this.

BEGIN;

DO $bootstrap$
DECLARE
  target_database text := current_database();
  role_password   text;
  target_role     text;
BEGIN
  ----------------------------------------------------------------------------
  -- 1. Roles
  ----------------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_owner') THEN
    EXECUTE 'CREATE ROLE app_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS';
    RAISE NOTICE 'created role app_owner';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'CREATE ROLE app_user WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS';
    RAISE NOTICE 'created role app_user';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_backup') THEN
    EXECUTE 'CREATE ROLE app_backup WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS';
    RAISE NOTICE 'created role app_backup';
  END IF;

  -- Correct attribute drift, under two constraints that managed platforms
  -- impose and a local superuser hides:
  --
  --  * SUPERUSER and BYPASSRLS are never named here. PostgreSQL treats naming
  --    either attribute in ALTER ROLE as changing it and refuses unless the
  --    caller holds it, so on Neon or RDS an ALTER that merely restates
  --    NOSUPERUSER fails. Both are set once at CREATE and verified below.
  --  * The ALTER runs only when something actually differs. Since PostgreSQL 16
  --    a CREATEROLE administrator may alter only the roles it created, so an
  --    unconditional ALTER would turn a no-op re-run into a permission error
  --    wherever the roles were established by a different administrator.
  FOREACH target_role IN ARRAY ARRAY['app_owner', 'app_user', 'app_backup'] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_roles
       WHERE rolname = target_role
         AND (NOT rolcanlogin OR rolcreatedb OR rolcreaterole)
    ) THEN
      EXECUTE format('ALTER ROLE %I WITH LOGIN NOCREATEDB NOCREATEROLE', target_role);
      RAISE NOTICE 'corrected attributes on %', target_role;
    END IF;
  END LOOP;

  ----------------------------------------------------------------------------
  -- 1b. Verify the attributes that cannot be re-asserted here
  ----------------------------------------------------------------------------
  -- These are the security properties the whole role design rests on (R27,
  -- 17.4). If the platform refused BYPASSRLS at CREATE, or a role was granted
  -- superuser out of band, fail loudly now rather than discovering it when a
  -- backup silently comes back empty.
  IF EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname IN ('app_owner', 'app_user', 'app_backup') AND rolsuper
  ) THEN
    RAISE EXCEPTION
      'One of the application roles has SUPERUSER. Remove it: no application role may hold it.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname IN ('app_owner', 'app_user') AND rolbypassrls
  ) THEN
    RAISE EXCEPTION
      'app_owner or app_user can bypass row level security. The runtime role must never be able to (17.4).';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_backup' AND rolbypassrls) THEN
    RAISE EXCEPTION
      'app_backup lacks BYPASSRLS, so a dump would silently omit every tenant row (T12, R27). '
      'Grant it with an administrator that holds BYPASSRLS, or drop the role and re-run this script.';
  END IF;

  ----------------------------------------------------------------------------
  -- 2. Passwords (only when supplied)
  ----------------------------------------------------------------------------
  role_password := current_setting('vaultide.app_owner_password', true);
  IF role_password IS NOT NULL AND role_password <> '' THEN
    EXECUTE format('ALTER ROLE app_owner WITH PASSWORD %L', role_password);
  END IF;

  role_password := current_setting('vaultide.app_user_password', true);
  IF role_password IS NOT NULL AND role_password <> '' THEN
    EXECUTE format('ALTER ROLE app_user WITH PASSWORD %L', role_password);
  END IF;

  role_password := current_setting('vaultide.app_backup_password', true);
  IF role_password IS NOT NULL AND role_password <> '' THEN
    EXECUTE format('ALTER ROLE app_backup WITH PASSWORD %L', role_password);
  END IF;

  ----------------------------------------------------------------------------
  -- 3. Database and schema ownership
  ----------------------------------------------------------------------------
  -- app_owner needs CREATE to add the migration bookkeeping schema.
  EXECUTE format('GRANT CONNECT, TEMPORARY, CREATE ON DATABASE %I TO app_owner', target_database);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_user', target_database);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_backup', target_database);

  -- The admin needs membership in app_owner to change ownership on its behalf.
  IF NOT pg_has_role(current_user, 'app_owner', 'MEMBER') THEN
    EXECUTE format('GRANT app_owner TO %I', current_user);
  END IF;

  EXECUTE 'ALTER SCHEMA public OWNER TO app_owner';
  EXECUTE 'GRANT USAGE ON SCHEMA public TO app_user, app_backup';
  -- Only migrations create objects.
  EXECUTE 'REVOKE CREATE ON SCHEMA public FROM PUBLIC';
  EXECUTE 'REVOKE CREATE ON SCHEMA public FROM app_user, app_backup';

  ----------------------------------------------------------------------------
  -- 4. Default privileges for everything migrations will create later
  ----------------------------------------------------------------------------
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
             GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user';
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
             GRANT USAGE, SELECT ON SEQUENCES TO app_user';
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
             GRANT SELECT ON TABLES TO app_backup';
  -- pg_dump reads sequence state, so a complete backup needs SELECT on
  -- sequences too. It is still a read-only privilege.
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
             GRANT SELECT ON SEQUENCES TO app_backup';
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
             GRANT EXECUTE ON FUNCTIONS TO app_user';

  -- Anything that already exists (e.g. a re-run after migrations) is covered
  -- for the backup role too; the runtime role's per-table exceptions are
  -- applied by migrations and are never re-granted here.
  EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_backup';
  EXECUTE 'GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO app_backup';

  ----------------------------------------------------------------------------
  -- 5. The backup role must never write
  ----------------------------------------------------------------------------
  EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM app_backup';
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
             REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLES FROM app_backup';
END
$bootstrap$;

COMMIT;
