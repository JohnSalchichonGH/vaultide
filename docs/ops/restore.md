# Restore runbook

Blueprint 22.5. Two layers protect the data: Neon instant restore (7 days on
Launch) and the nightly encrypted `pg_dump` in the EU object store (30 daily +
12 monthly). This runbook covers the second, which is also the quarterly drill.

**Drill cadence:** quarterly, logged in [`restore-log.md`](./restore-log.md).
The first drill is a Phase 7 acceptance criterion.

## 0. Decide the layer

| Situation | Use |
|---|---|
| Accidental data change in the last 7 days | Neon instant restore / a branch at a timestamp |
| Corruption discovered later, or Neon itself is unavailable | The encrypted dump |
| Drill | The encrypted dump, always |

## 1. Fetch the archive

```bash
aws s3 ls "s3://${BACKUP_BUCKET_NAME}/$(date -u +%Y/%m)/" \
  ${BACKUP_BUCKET_ENDPOINT:+--endpoint-url "$BACKUP_BUCKET_ENDPOINT"}
aws s3 cp "s3://${BACKUP_BUCKET_NAME}/2026/09/vaultide-production-<stamp>.dump.age" . \
  ${BACKUP_BUCKET_ENDPOINT:+--endpoint-url "$BACKUP_BUCKET_ENDPOINT"}
```

Each archive is accompanied by `<name>.age.json` (size, SHA-256, recipient) and
`<name>.manifest.json` (per-table row counts verified at backup time). Check the
digest before going further:

```bash
sha256sum vaultide-production-<stamp>.dump.age
```

## 2. Decrypt

The private key is **offline**; it is never in CI, Vercel or this repository.
Retrieve it from the sealed store, then:

```bash
age --decrypt --identity key.txt \
  --output vaultide.dump vaultide-production-<stamp>.dump.age
head -c 5 vaultide.dump   # must print PGDMP
```

## 3. Restore into a new database

Never restore over a live database. Create a fresh Neon branch (or a scratch
project), then bootstrap the roles **before** restoring, because the dump
contains objects owned by `app_owner`:

```bash
DATABASE_URL_ADMIN=... APP_OWNER_PASSWORD=... APP_USER_PASSWORD=... APP_BACKUP_PASSWORD=... \
  pnpm db:bootstrap

pg_restore --no-owner --role=app_owner --clean --if-exists \
  --dbname "$DATABASE_URL_DIRECT_OWNER" vaultide.dump
```

## 4. Verify

1. **Row counts** match the archive's manifest:
   ```bash
   DATABASE_URL_BACKUP=<restored, app_backup> pnpm db:verify-dump vaultide.dump
   ```
2. **Roles and RLS** behave on the restored database:
   ```bash
   TEST_DATABASE_URL_ADMIN=<restored admin URL> pnpm run test:integration
   ```
3. **Financial identities** hold on the restored data — from Phase 3 the golden
   reconciliation fixtures run against it, so a restore that loses rows fails
   loudly rather than quietly.
4. Point a preview deployment at the restored database and walk one month end
   to end.

## 5. Sign off

Record the drill in [`restore-log.md`](./restore-log.md): date, archive, time to
restore, verification results, and anything that slowed the recovery down.

## Notes

- Backups retain deleted data until they expire; this is stated in the privacy
  notice, and there is no selective purge from backups (18.3).
- A dump taken with an RLS-subject role is rejected at backup time (T12), so an
  archive that exists has already proved it contains every tenant's rows.
