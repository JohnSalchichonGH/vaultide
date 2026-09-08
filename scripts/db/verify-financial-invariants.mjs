#!/usr/bin/env node
/**
 * Read-only audit of the live financial state (blueprint 6.1, 8.1, 12.1, 18.1).
 *
 * Some financial rules are enforced by the database — one balance per position
 * per day, a month-end balance that falls on a month end, a closed position
 * that carries a closing date. Others cannot be, because they are rules about
 * *other rows*: a closed account's final balance must be zero, every position
 * must have left an audit trail, every balance must belong to its position's
 * owner. Those are service rules, and a service rule is only true until
 * something writes around it.
 *
 * This asks the real database whether they are still true, as `app_backup`:
 * SELECT-only, `BYPASSRLS`, so it sees every tenant and can change none of
 * them. It writes nothing, and prints no amount belonging to anybody — only
 * counts, and the identifiers of rows that fail.
 *
 *   DATABASE_URL_BACKUP=…  node scripts/db/verify-financial-invariants.mjs
 *
 * With `--manifest <prefix>` it also prints the full state of positions whose
 * name starts with `prefix`, for checking a synthetic acceptance account
 * against what the interface claimed. Never point that at real data.
 *
 * Exits non-zero if any invariant is violated.
 */
import pg from 'pg';

const connectionString = process.env.DATABASE_URL_BACKUP;
if (!connectionString) {
  console.error('DATABASE_URL_BACKUP is required (the SELECT-only backup credential).');
  process.exit(1);
}

const manifestIndex = process.argv.indexOf('--manifest');
const manifestPrefix =
  manifestIndex === -1
    ? // Also accepted through the environment, so a workflow can pass it
      // without interpolating an input into a shell command line.
      (process.env.MANIFEST_PREFIX ?? '') || null
    : (process.argv[manifestIndex + 1] ?? null);

/**
 * Each check selects the rows that BREAK it, so an empty result is a pass and
 * a failure names exactly what to look at.
 */
const CHECKS = [
  {
    name: 'one balance per position per day (M1)',
    sql: `SELECT position_id, valued_on, count(*) AS rows
            FROM position_valuations
           GROUP BY position_id, valued_on
          HAVING count(*) > 1`,
  },
  {
    name: 'every month-end balance falls on a month end (R15)',
    sql: `SELECT id, valued_on
            FROM position_valuations
           WHERE date_precision = 'month_end'
             AND valued_on <> (date_trunc('month', valued_on) + interval '1 month - 1 day')::date`,
  },
  {
    name: 'no balance is dated in the future (M1)',
    // A day of tolerance: "today" belongs to the user's timezone, not the
    // server's, so a balance dated tomorrow UTC can still be today for them.
    sql: `SELECT id, valued_on
            FROM position_valuations
           WHERE valued_on > (current_date + 1)`,
  },
  {
    name: 'a closed position carries a closing date (6.1)',
    sql: `SELECT id FROM positions WHERE status = 'closed' AND closed_on IS NULL`,
  },
  {
    name: 'a closed position closed at zero (M6)',
    // The service refuses to close a position that still holds something.
    // Nothing in the schema can express that, so it is asserted here against
    // every closed row: the latest balance on or before the closing date must
    // be exactly zero. A closed account that still shows a balance would have
    // dropped that money out of net worth with no record of where it went.
    sql: `SELECT p.id, v.valued_on
            FROM positions p
            LEFT JOIN LATERAL (
              SELECT amount, valued_on
                FROM position_valuations
               WHERE position_id = p.id AND valued_on <= p.closed_on
               ORDER BY valued_on DESC
               LIMIT 1
            ) v ON true
           WHERE p.status = 'closed'
             AND (v.amount IS NULL OR v.amount <> 0)`,
  },
  {
    name: 'every balance belongs to its position owner (M8)',
    sql: `SELECT v.id
            FROM position_valuations v
            JOIN positions p ON p.id = v.position_id
           WHERE p.user_id <> v.user_id`,
  },
  {
    name: 'every position has a subtype row of the right kind (6.2)',
    sql: `SELECT p.id, p.kind
            FROM positions p
            LEFT JOIN cash_accounts c ON c.position_id = p.id
            LEFT JOIN other_assets o ON o.position_id = p.id
           WHERE (p.kind = 'cash' AND c.position_id IS NULL)
              OR (p.kind = 'other_asset' AND o.position_id IS NULL)`,
  },
  {
    name: 'every position was audited when it was created (18.1)',
    sql: `SELECT p.id
            FROM positions p
           WHERE NOT EXISTS (
                   SELECT 1 FROM audit_entries a
                    WHERE a.entity_table = 'positions'
                      AND a.entity_id = p.id
                      AND a.action = 'insert')`,
  },
  {
    name: 'every balance was audited when it was written (18.1)',
    sql: `SELECT v.id
            FROM position_valuations v
           WHERE NOT EXISTS (
                   SELECT 1 FROM audit_entries a
                    WHERE a.entity_table = 'position_valuations'
                      AND a.entity_id = v.id
                      AND a.action = 'insert')`,
  },
  {
    name: 'every audit row is owned by the same user as its subject (17.4)',
    sql: `SELECT a.id
            FROM audit_entries a
            JOIN positions p ON p.id = a.entity_id
           WHERE a.entity_table = 'positions' AND a.user_id <> p.user_id`,
  },
];

const client = new pg.Client({ connectionString });
await client.connect();

let failed = 0;

console.log('Financial invariants, live\n');
for (const check of CHECKS) {
  const { rows } = await client.query(check.sql);
  if (rows.length === 0) {
    console.log(`  ok    ${check.name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${check.name} — ${String(rows.length)} row(s)`);
    for (const row of rows.slice(0, 10)) console.log(`          ${JSON.stringify(row)}`);
  }
}

const scale = await client.query(
  `SELECT (SELECT count(*) FROM positions) AS positions,
          (SELECT count(*) FROM position_valuations) AS valuations,
          (SELECT count(*) FROM audit_entries) AS audit_entries,
          (SELECT count(DISTINCT user_id) FROM positions) AS owners`,
);
const counted = scale.rows[0];
console.log(
  `\nChecked ${counted.valuations} balance(s) across ${counted.positions} position(s), ` +
    `${counted.owners} owner(s), ${counted.audit_entries} audit row(s).`,
);

if (manifestPrefix) {
  console.log(`\nManifest for positions named like ${manifestPrefix}%\n`);

  const owners = await client.query(
    `SELECT count(DISTINCT user_id) AS owners FROM positions WHERE name LIKE $1`,
    [`${manifestPrefix}%`],
  );
  console.log(`  distinct owners: ${owners.rows[0].owners}`);

  const positions = await client.query(
    `SELECT p.id, p.kind, p.name, p.currency, p.status, p.version,
            p.opened_on::text AS opened_on, p.closed_on::text AS closed_on,
            c.account_type, c.is_dormant, o.asset_type, o.include_in_financial_net_worth
       FROM positions p
       LEFT JOIN cash_accounts c ON c.position_id = p.id
       LEFT JOIN other_assets o ON o.position_id = p.id
      WHERE p.name LIKE $1
      ORDER BY p.kind, p.name`,
    [`${manifestPrefix}%`],
  );

  for (const position of positions.rows) {
    const extra =
      position.kind === 'cash'
        ? ` type=${position.account_type} dormant=${String(position.is_dormant)}`
        : position.kind === 'other_asset'
          ? ` type=${position.asset_type} include_in_financial_net_worth=${String(position.include_in_financial_net_worth)}`
          : '';
    console.log(
      `\n  ${position.name} [${position.kind}/${position.currency}] status=${position.status}` +
        ` opened=${position.opened_on ?? 'null'} closed=${position.closed_on ?? 'null'}` +
        ` v${String(position.version)}${extra}`,
    );

    const valuations = await client.query(
      // ::text because a DATE arrives as a JavaScript Date otherwise, and
      // printing one of those turns a financial date into a local timestamp.
      `SELECT valued_on::text AS valued_on, amount, source, date_precision, version
         FROM position_valuations WHERE position_id = $1 ORDER BY valued_on DESC`,
      [position.id],
    );
    for (const valuation of valuations.rows) {
      console.log(
        `      ${valuation.valued_on}  ${String(valuation.amount).padStart(16)}  ` +
          `${valuation.date_precision.padEnd(9)} ${valuation.source.padEnd(20)} v${String(valuation.version)}`,
      );
    }

    const audit = await client.query(
      `SELECT entity_table, action, count(*) AS rows
         FROM audit_entries
        WHERE entity_id = $1
           OR entity_id IN (SELECT id FROM position_valuations WHERE position_id = $1)
        GROUP BY entity_table, action
        ORDER BY entity_table, action`,
      [position.id],
    );
    const summary = audit.rows
      .map((row) => `${row.entity_table}.${row.action}=${row.rows}`)
      .join(' ');
    console.log(`      audit: ${summary === '' ? 'none' : summary}`);
  }
}

await client.end();

if (failed > 0) {
  console.error(`\n${String(failed)} invariant(s) violated.`);
  process.exit(1);
}
console.log('\nAll invariants hold.');
