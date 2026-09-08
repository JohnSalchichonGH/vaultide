#!/usr/bin/env node
/**
 * Asserts that a live environment matches the role and privilege model
 * (blueprint 6.1, 17.4, 22.2). CI proves the behaviour on a throwaway database;
 * this proves the state of a real one — Neon, or any other deployment.
 *
 *   DATABASE_URL_DIRECT_OWNER=…  (required: reads the catalogs as app_owner)
 *   DATABASE_URL_BACKUP=…        (optional: also exercises the backup role)
 *
 * Read-only apart from one deliberate write attempt as app_backup, which must
 * fail. Prints a check list and exits non-zero on the first violation.
 */
import pg from 'pg';

// Either credential can read the catalogs; whichever is present is used for
// the state checks. The backup credential additionally proves it cannot write.
const backupUrl = process.env.DATABASE_URL_BACKUP;
const ownerUrl = process.env.DATABASE_URL_DIRECT_OWNER ?? backupUrl;
if (!ownerUrl) {
  console.error('Set DATABASE_URL_DIRECT_OWNER or DATABASE_URL_BACKUP.');
  process.exit(1);
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const owner = new pg.Client({ connectionString: ownerUrl });
await owner.connect();

try {
  const version = await owner.query('SHOW server_version');
  console.log(`PostgreSQL ${version.rows[0].server_version}`);
  console.log('');

  console.log('Roles');
  const roles = await owner.query(
    `SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin
       FROM pg_roles WHERE rolname IN ('app_owner','app_user','app_backup') ORDER BY rolname`,
  );
  const byName = Object.fromEntries(roles.rows.map((row) => [row.rolname, row]));

  check('all three application roles exist', roles.rows.length === 3, `found ${roles.rows.length}`);
  for (const role of ['app_owner', 'app_user', 'app_backup']) {
    check(`${role} is not a superuser`, byName[role]?.rolsuper === false);
    check(`${role} cannot create roles or databases`,
      byName[role]?.rolcreaterole === false && byName[role]?.rolcreatedb === false);
  }
  // The property the whole tenant-isolation model rests on (17.4, R27).
  check('app_user cannot bypass row level security', byName['app_user']?.rolbypassrls === false);
  check('app_owner cannot bypass row level security', byName['app_owner']?.rolbypassrls === false);
  check('app_backup can bypass row level security', byName['app_backup']?.rolbypassrls === true);

  console.log('');
  console.log('Schema and migrations');
  const schema = await owner.query(
    `SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'public'`,
  );
  check('app_owner owns the public schema', schema.rows[0]?.owner === 'app_owner',
    `owner is ${schema.rows[0]?.owner}`);

  const applied = await owner.query(`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`);
  check('migrations have been applied', applied.rows[0].count >= 2, `${applied.rows[0].count} applied`);

  const currencies = await owner.query(`SELECT count(*)::int AS count FROM currencies`);
  check('currencies are seeded', currencies.rows[0].count > 50, `${currencies.rows[0].count} rows`);

  const clf = await owner.query(`SELECT minor_units FROM currencies WHERE code = 'CLF'`);
  check('a four-minor-unit currency is present', clf.rows[0]?.minor_units === 4);

  const crypto = await owner.query(
    `SELECT count(*)::int AS count FROM currencies WHERE code IN ('BTC','ETH','USDT')`,
  );
  check('no crypto codes were seeded', crypto.rows[0].count === 0);

  console.log('');
  console.log('Privileges');
  // `has_table_privilege` reports the *effective* privilege of any role and can
  // be asked by any caller, unlike information_schema.role_table_grants, which
  // only shows grants involving roles the caller belongs to.
  const tables = await owner.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  check('the schema has tables to check', tables.rows.length > 0, `${tables.rows.length} tables`);

  // Which tables carry row level security is a decision, not a default, and it
  // cuts both ways (17.4). The financial tables must have it: the runtime role
  // may only ever see the rows of whoever the current request belongs to.
  // Better Auth's tables must NOT: a session has to be read *before* anyone
  // knows which user the request is for, so a policy keyed on that user would
  // make signing in impossible. Both halves are asserted, because either one
  // silently flipping is a serious failure — one leaks, the other locks out.
  //
  // Kept in step with `USER_OWNED_TABLES` in packages/db/src/repositories/
  // users.ts by the `every user-owned table is listed here` check further
  // down: this script had its own copy through Phase 2, and a copy that drifts
  // is worse than no copy, because it reports a pass for tables it never
  // looked at.
  const USER_OWNED_TABLES = [
    'audit_entries',
    'cash_accounts',
    'categories',
    'expense_entries',
    'income_entries',
    'month_reviews',
    'other_assets',
    'position_valuations',
    'positions',
    'recurring_template_skips',
    'recurring_template_terms',
    'recurring_templates',
    'tags',
    'transfers',
    'user_settings',
  ];
  const AUTH_TABLES = ['account', 'session', 'two_factor'];

  const security = await owner.query(
    `SELECT c.relname,
            c.relrowsecurity AS enabled,
            (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
            EXISTS (SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attname = 'user_id' AND a.attnum > 0
                       AND NOT a.attisdropped) AS has_user_id
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`,
  );
  const securityByTable = Object.fromEntries(security.rows.map((row) => [row.relname, row]));

  const unsecured = USER_OWNED_TABLES.filter(
    (table) => securityByTable[table]?.enabled !== true || Number(securityByTable[table].policies) !== 1,
  );
  check(
    'every user-owned table enables row level security, with one policy',
    unsecured.length === 0,
    unsecured.length === 0
      ? `${String(USER_OWNED_TABLES.length)} tables`
      : unsecured.join(', '),
  );

  const overSecured = AUTH_TABLES.filter((table) => securityByTable[table]?.enabled === true);
  check(
    'the authentication tables stay outside row level security',
    overSecured.length === 0,
    overSecured.length === 0 ? `${String(AUTH_TABLES.length)} tables` : overSecured.join(', '),
  );

  // The failure this is really watching for: a new table that carries a
  // `user_id`, and which nobody gave a policy to, would be readable by every
  // tenant. Anything genuinely outside RLS has to be named above to pass.
  const unlisted = security.rows
    .filter((row) => row.has_user_id === true && row.enabled !== true)
    .map((row) => row.relname)
    .filter((name) => !AUTH_TABLES.includes(name));

  // Every table that carries a `user_id` must be in the list above, or the RLS
  // assertion silently skips it. This is the check that would have caught this
  // script falling a phase behind the schema.
  const owned = security.rows
    .filter((row) => row.has_user_id === true)
    .map((row) => row.relname)
    .filter((name) => !AUTH_TABLES.includes(name));
  const unlistedOwned = owned.filter((name) => !USER_OWNED_TABLES.includes(name));
  check(
    'every user-owned table is listed here',
    unlistedOwned.length === 0,
    unlistedOwned.length === 0 ? `${String(owned.length)} tables` : unlistedOwned.join(', '),
  );

  // 6.1: every closed set is a PostgreSQL enum type, never text + CHECK. The
  // tables above cannot exist without them, but naming them here turns that
  // from an inference into an assertion — and names what a later phase must
  // extend rather than replace.
  const enums = await owner.query(
    `SELECT t.typname FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public' AND t.typtype = 'e'`,
  );
  const enumNames = new Set(enums.rows.map((row) => row.typname));
  const EXPECTED_ENUMS = [
    'audit_action', 'cash_account_type', 'category_kind', 'date_precision',
    'expense_settlement', 'income_kind', 'income_settlement', 'other_asset_type',
    'position_kind', 'position_status', 'recurrence_frequency', 'skip_reason',
    'template_kind', 'transfer_kind', 'valuation_source',
  ];
  const missingEnums = EXPECTED_ENUMS.filter((name) => !enumNames.has(name));
  check(
    'every closed set exists as an enum type',
    missingEnums.length === 0,
    missingEnums.length === 0 ? `${String(EXPECTED_ENUMS.length)} types` : missingEnums.join(', '),
  );

  console.log('');
  console.log('Schema invariants no constraint can express');

  // 6.1: `updated_at` is trigger-maintained, so no application path can forget
  // it and no client can set it.
  const triggers = await owner.query(
    `SELECT c.relname
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal
        AND t.tgname = c.relname || '_set_updated_at'`,
  );
  const withTrigger = new Set(triggers.rows.map((row) => row.relname));
  const hasUpdatedAt = await owner.query(
    `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND a.attname = 'updated_at' AND a.attnum > 0 AND NOT a.attisdropped`,
  );
  // Scoped to the tables this project's migrations create. Better Auth owns
  // `user`, `session`, `account` and `verification` and maintains their
  // timestamps itself (17.1); installing a trigger on them would be this
  // project reaching into somebody else's schema.
  const missingTrigger = hasUpdatedAt.rows
    .map((row) => row.relname)
    .filter((name) => USER_OWNED_TABLES.includes(name))
    .filter((name) => !withTrigger.has(name));
  check(
    'every table with updated_at maintains it by trigger',
    missingTrigger.length === 0,
    missingTrigger.length === 0 ? `${String(withTrigger.size)} triggers` : missingTrigger.join(', '),
  );

  // 6.1: a CHECK that reads the moving present would change its verdict on a
  // row that never changed, and would make a restored backup unrestorable.
  const moving = await owner.query(
    `SELECT c.conname, t.relname
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) ~* 'now\\(\\)|current_date|current_timestamp|localtimestamp|statement_timestamp|clock_timestamp'`,
  );
  check(
    'no CHECK constraint reads the clock',
    moving.rows.length === 0,
    moving.rows.map((row) => `${row.relname}.${row.conname}`).join(', '),
  );

  // v2.1.6 30.9: one accepted flow per scheduled occurrence, enforced by a
  // partial unique index on each of the three materialized-flow tables.
  const occurrenceIndexes = await owner.query(
    `SELECT tablename, indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexname LIKE '%_occurrence_uidx'
      ORDER BY tablename`,
  );
  const OCCURRENCE_TABLES = ['expense_entries', 'income_entries', 'transfers'];
  const indexed = occurrenceIndexes.rows.map((row) => row.tablename).sort();
  check(
    'every materialized-flow table has its occurrence unique index',
    OCCURRENCE_TABLES.every((table) => indexed.includes(table)),
    indexed.join(', '),
  );

  // 30.9 item 4: accepted history keeps its template identity, so these are
  // NO ACTION — `a` in pg_constraint's confdeltype. A `n` here would be
  // SET NULL, which cannot even be expressed against the non-null tenant
  // column without erasing the link.
  const templateFks = await owner.query(
    `SELECT c.conname, t.relname, c.confdeltype
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_class f ON f.oid = c.confrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND c.contype = 'f'
        AND f.relname = 'recurring_templates'
        AND t.relname IN ('income_entries','expense_entries','transfers')`,
  );
  const wrongAction = templateFks.rows.filter((row) => row.confdeltype !== 'a');
  check(
    'materialized flows keep their template on delete (NO ACTION)',
    templateFks.rows.length === 3 && wrongAction.length === 0,
    `${String(templateFks.rows.length)} keys` +
      (wrongAction.length === 0 ? '' : `; wrong: ${wrongAction.map((r) => r.conname).join(', ')}`),
  );

  // The composite ownership pattern of 6.1: a child references
  // `(parent_id, user_id)`, never the parent id alone.
  const composite = await owner.query(
    `SELECT c.conname, t.relname, array_length(c.conkey, 1) AS columns
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND c.contype = 'f'
        AND c.conname IN ('income_entries_template_fk','expense_entries_template_fk',
                          'transfers_template_fk','expense_entries_transfer_fk',
                          'expense_entries_category_fk','recurring_template_terms_template_fk',
                          'recurring_template_skips_template_fk')`,
  );
  const notComposite = composite.rows.filter((row) => Number(row.columns) < 2);
  check(
    'Phase 3 foreign keys carry the tenant column',
    composite.rows.length === 7 && notComposite.length === 0,
    `${String(composite.rows.length)} keys`,
  );
  check(
    'no table carrying user_id was added without a policy',
    unlisted.length === 0,
    unlisted.length === 0 ? 'none unaccounted for' : unlisted.join(', '),
  );

  const WRITES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'];

  /**
   * Tables the runtime role holds narrower privileges on than the bootstrap's
   * default grants would give (blueprint 6.1). Each entry lists the writes
   * `app_user` must **not** have; they are removed by a migration, so this is
   * also how a deployment proves that migration actually ran.
   *
   *   fx_rates       rows are immutable — a conversion made last year must
   *                  still reproduce next year (6.2, Phase 1).
   *   audit_entries  insert-only — the role that deletes a valuation must not
   *                  be able to erase the record of it (18.1, Phase 2).
   */
  const RUNTIME_WRITE_EXCEPTIONS = {
    fx_rates: ['UPDATE', 'DELETE', 'TRUNCATE'],
    audit_entries: ['UPDATE', 'DELETE', 'TRUNCATE'],
  };

  const violations = { userWrite: [], backupWrite: [], backupRead: [], narrowed: [] };
  const seenNarrowed = new Set();

  for (const { tablename } of tables.rows) {
    const qualified = `public.${tablename}`;
    const privileges = await owner.query(
      `SELECT
         has_table_privilege('app_user', $1, 'SELECT')   AS user_select,
         has_table_privilege('app_backup', $1, 'SELECT') AS backup_select,
         ${WRITES.map((p) => `has_table_privilege('app_user', $1, '${p}') AS user_${p.toLowerCase()}`).join(', ')},
         ${WRITES.map((p) => `has_table_privilege('app_backup', $1, '${p}') AS backup_${p.toLowerCase()}`).join(', ')}`,
      [qualified],
    );
    const row = privileges.rows[0];

    // Reference data is read-only for the runtime role (6.1); user tables are
    // writable by it and arrive with their phases.
    if (tablename === 'currencies') {
      check('app_user can read reference data', row.user_select === true);
      for (const privilege of WRITES) {
        if (row[`user_${privilege.toLowerCase()}`]) violations.userWrite.push(`${tablename}.${privilege}`);
      }
    }

    const forbidden = RUNTIME_WRITE_EXCEPTIONS[tablename];
    if (forbidden !== undefined) {
      seenNarrowed.add(tablename);
      if (!row.user_select) violations.narrowed.push(`${tablename}.SELECT missing`);
      for (const privilege of forbidden) {
        if (row[`user_${privilege.toLowerCase()}`]) {
          violations.narrowed.push(`${tablename}.${privilege}`);
        }
      }
    }

    // A backup must be able to read everything and change nothing (R27, T12).
    if (!row.backup_select) violations.backupRead.push(tablename);
    for (const privilege of WRITES) {
      if (row[`backup_${privilege.toLowerCase()}`]) {
        violations.backupWrite.push(`${tablename}.${privilege}`);
      }
    }
  }

  check('app_user cannot write reference data', violations.userWrite.length === 0,
    violations.userWrite.join(', '));
  check(
    'app_user holds only the narrowed privileges on immutable tables',
    violations.narrowed.length === 0,
    violations.narrowed.join(', '),
  );
  // A missing table here means a migration has not run, which the privilege
  // check above could not have noticed on its own.
  const missingNarrowed = Object.keys(RUNTIME_WRITE_EXCEPTIONS).filter(
    (table) => !seenNarrowed.has(table),
  );
  check('every table with narrowed privileges exists', missingNarrowed.length === 0,
    missingNarrowed.join(', '));
  check('app_backup can read every table', violations.backupRead.length === 0,
    violations.backupRead.join(', '));
  check('app_backup can write no table', violations.backupWrite.length === 0,
    violations.backupWrite.join(', '));

  if (backupUrl) {
    console.log('');
    console.log('Backup role, live');
    const backup = new pg.Client({ connectionString: backupUrl });
    await backup.connect();
    try {
      const readable = await backup.query('SELECT count(*)::int AS count FROM currencies');
      check('app_backup can read', readable.rows[0].count > 50);

      let refused = false;
      try {
        await backup.query(`INSERT INTO currencies (code, name, minor_units) VALUES ('ZZZ','probe',2)`);
      } catch (error) {
        refused = error.code === '42501';
      }
      check('app_backup cannot write', refused);
    } finally {
      await backup.end();
    }
  }
} finally {
  await owner.end();
}

const failed = results.filter((row) => !row.ok);
console.log('');
if (failed.length > 0) {
  console.error(`${failed.length} of ${results.length} checks failed.`);
  process.exit(1);
}
console.log(`All ${results.length} checks passed.`);
