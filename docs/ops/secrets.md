# Secrets and rotation

Blueprint 17.3, 22.2. Every credential exists in exactly one place. Nothing is
shared between roles, and no secret is ever committed — `gitleaks` runs in CI.

## Who holds what

| Secret | Held by | Never in |
|---|---|---|
| `DATABASE_URL` (`app_user`, pooled) | Vercel runtime | CI, backups, laptops |
| `DATABASE_URL_DIRECT_OWNER` (`app_owner`) | GitHub environment `production` | Vercel |
| `DATABASE_URL_BACKUP` (`app_backup`) | GitHub environment `backup` | Vercel, CI default |
| `DATABASE_URL_ADMIN` (platform admin) | GitHub environment `bootstrap` | everywhere else |
| `BACKUP_AGE_PUBLIC_KEY` | GitHub environment `backup` | — (public by nature) |
| age **private** key | Offline, sealed | CI, Vercel, this repository |
| `BETTER_AUTH_SECRET` (Phase 1) | Vercel | CI |
| `CRON_SECRET` (Phase 1) | Vercel | CI |
| `SENTRY_AUTH_TOKEN` | GitHub build environment | runtime |

`BETTER_AUTH_SECRET` must be at least 32 random bytes.

## Rotating a database role password

1. Generate a new password (`openssl rand -base64 24`).
2. Update the secret in the owning GitHub environment (or Vercel, for
   `DATABASE_URL`).
3. Run **Bootstrap database roles** with `rotate_passwords = true`. The script
   only sets the passwords it is given, so unrelated roles are untouched.
4. Redeploy so the runtime picks up the new `DATABASE_URL`.
5. Confirm `/api/health` reports `"database": "ok"`.

Rotating `app_user` is zero-downtime in the other direction as well: the
password change takes effect on new connections, and the pool reconnects.

## Rotating the backup key

The age key pair protects data at rest. To rotate:

1. Generate a new pair offline (`age-keygen -o key-new.txt`).
2. Store the private key in the sealed store; publish only the recipient.
3. Update `BACKUP_AGE_PUBLIC_KEY` in the `backup` environment.
4. Keep the previous private key until every archive encrypted to it has aged
   out of retention (30 daily + 12 monthly), otherwise old archives become
   unreadable.

## If a secret leaks

1. Rotate it immediately (above).
2. For a database role: check `pg_stat_activity` and Neon's connection log for
   unexpected clients.
3. For the admin credential: rotate it, then re-run the bootstrap to re-assert
   role attributes and privileges, and diff the result against a known-good
   privilege snapshot (the integration suite prints one).
4. Record the incident and the timeline.
