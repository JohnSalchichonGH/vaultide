# Environment setup

One-time provisioning of the four external services Phase 0 depends on
(blueprint 22.1, 22.2). Everything here is done once per environment; the
per-credential rules are in [`secrets.md`](./secrets.md).

Order matters: Neon first (everything else needs the database), then Vercel,
then Sentry, then the backup bucket.

Throughout: **no credential should ever be pasted into a chat, a commit or a
terminal history.** The helper scripts read values from the environment and
write them straight into GitHub; the one value a human must move by hand (the
runtime `DATABASE_URL`, into Vercel) is written to a gitignored file.

---

## 0. Prerequisites

```bash
gh auth status        # must show the account that owns the repository
node --version        # 22.x
```

The GitHub environments `production`, `backup` and `bootstrap` already exist.
They are where each credential lives, and nowhere else.

---

## 1. Neon — PostgreSQL in Frankfurt

1. Sign up at <https://console.neon.tech> (GitHub sign-in is fine).
2. **Create project**:
   - Name: `vaultide`
   - Postgres version: 17 (16 is equally fine — the schema targets 16+)
   - Cloud: **AWS**
   - Region: **Europe (Frankfurt) — `aws-eu-central-1`** ← data residency, 18.3
3. Neon shows a connection string for the project's owner role
   (`neondb_owner`). That is the **admin** credential: it is only ever used by
   the manual bootstrap workflow.
4. Load every database credential into GitHub in one step. The script generates
   the three role passwords, derives the direct and pooled endpoints, and writes
   the secrets through `gh secret set` on stdin — nothing is printed:

   ```bash
   export DATABASE_URL_ADMIN='postgresql://neondb_owner:…@ep-….eu-central-1.aws.neon.tech/neondb?sslmode=require'
   export BACKUP_AGE_PUBLIC_KEY='age1…'      # from step 4 of section 4
   node scripts/ops/setup-github-secrets.mjs
   unset DATABASE_URL_ADMIN
   ```

5. Create the roles by running the bootstrap workflow — the same one an operator
   would use for any environment:

   ```bash
   gh workflow run bootstrap-database.yml -f environment=production -f rotate_passwords=true
   gh run watch "$(gh run list --workflow=bootstrap-database.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
   ```

6. Apply the schema and seed the currencies:

   ```bash
   gh workflow run deploy-production.yml
   ```

**Plan note.** Neon Free is enough through Phase 2. Move to Launch once real
balances exist: it raises instant-restore history from 6 h to 7 days, which is
the first backup layer (22.5).

---

## 2. Vercel — hosting in `fra1`

1. Sign up at <https://vercel.com> with the same GitHub account.
2. **Add New → Project → Import** `JohnSalchichonGH/vaultide`.
3. Configure before the first deploy:
   - Framework preset: **Next.js**
   - Root directory: **`apps/web`**
   - Install command: `pnpm install --frozen-lockfile`
   - Build command: `pnpm run build` (the repo default is fine)
4. Environment variables (Production, and Preview if you want previews):
   - `DATABASE_URL` — copy from `.secrets.local/vercel-env.txt`, then delete
     that file. This is the pooled `app_user` endpoint: the runtime role that
     cannot bypass RLS and cannot run DDL.
   - `NEXT_PUBLIC_SENTRY_DSN` and `SENTRY_DSN` — after section 3.
   - `VAULTIDE_VERSION` — optional; Vercel's `VERCEL_GIT_COMMIT_SHA` works too.
5. **Turn off automatic production deploys.** Settings → Git → *Ignored Build
   Step*, or the committed `apps/web/vercel.json`, which already sets
   `git.deploymentEnabled.main = false`. Migrations must run before the code
   that needs them (22.3), and that ordering is what
   `deploy-production.yml` exists for.
6. Create the deploy hook: Settings → Git → **Deploy Hooks** → name `production`,
   branch `main`. Copy the URL and store it where the deploy workflow reads it:

   ```bash
   gh secret set VERCEL_DEPLOY_HOOK_URL --env production   # paste, then Ctrl-D
   gh variable set APP_URL --body 'https://<your-project>.vercel.app'
   ```

   `APP_URL` lets the deploy workflow poll `/api/health` and fail if the new
   deployment is not healthy.

---

## 3. Sentry — EU region

1. Sign up at <https://sentry.io>. **Choose the EU data region during signup** —
   it cannot be changed afterwards, and 18.3 requires EU residency.
2. Create project: platform **Next.js**, name `vaultide-web`.
3. Copy the DSN (it looks like `https://…@o…ingest.de.sentry.io/…`; the `.de.`
   confirms the EU region).
4. Set it where each side needs it:

   ```bash
   # Vercel → Settings → Environment Variables
   NEXT_PUBLIC_SENTRY_DSN=https://…ingest.de.sentry.io/…
   SENTRY_DSN=https://…ingest.de.sentry.io/…
   ```

   The DSN is not a secret — it ships in the browser bundle — but the auth
   token used for source maps is:

   ```bash
   gh secret set SENTRY_AUTH_TOKEN --env production   # Settings → Auth Tokens
   ```

5. Cron monitor for the backup: Sentry → **Crons** → Add Monitor, name
   `vaultide-nightly-backup`, schedule `30 2 * * *`, timezone UTC, then copy its
   check-in URL:

   ```bash
   gh secret set SENTRY_CRON_BACKUP_URL --env backup
   ```

The scrubbing rules (`packages/application/src/observability.ts`) already drop
request bodies, query strings, breadcrumbs and PII before anything is sent, and
they are unit-tested.

---

## 4. Cloudflare R2 — encrypted backup destination

1. Sign up at <https://dash.cloudflare.com> → **R2**. (R2 asks for a card even
   on the free tier; 10 GB of storage and no egress fees are free.)
2. **Create bucket**: name `vaultide-backups-prod`, location **EU** — this pins
   the data to European jurisdiction.
3. Add a lifecycle rule so retention matches 22.5: keep 30 daily objects, expire
   the rest. (R2 → bucket → Settings → Object lifecycle rules.)
4. Generate the encryption key pair, if you have not already:

   ```bash
   node scripts/backup/generate-age-key.mjs
   ```

   Move the private key to your password manager and delete the file. Only the
   printed recipient goes to CI. **Losing the private key makes every archive
   permanently unreadable; leaking it makes every archive readable.**
5. Create an R2 API token: R2 → **Manage API Tokens** → Create, permission
   *Object Read & Write*, scoped to the bucket. Note the Access Key ID, Secret
   Access Key, and your account ID.
6. Load them:

   ```bash
   gh secret set BACKUP_BUCKET_ACCESS_KEY_ID --env backup
   gh secret set BACKUP_BUCKET_SECRET_ACCESS_KEY --env backup
   gh variable set BACKUP_BUCKET_NAME --env backup --body 'vaultide-backups-prod'
   gh variable set BACKUP_BUCKET_REGION --env backup --body 'auto'
   gh variable set BACKUP_BUCKET_ENDPOINT --env backup --body 'https://<account-id>.r2.cloudflarestorage.com'
   ```

7. Take one real backup and verify it end to end:

   ```bash
   gh workflow run nightly-backup.yml
   gh run watch "$(gh run list --workflow=nightly-backup.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
   ```

   The job dumps as `app_backup`, compares every table's row count against the
   live database, encrypts with age and uploads. A dump an RLS policy filtered
   cannot pass that comparison, so a green run means the archive is complete.

---

## What lives where, afterwards

| Credential | Only in |
|---|---|
| Neon admin (`neondb_owner`) | GitHub environment `bootstrap` |
| `app_owner` URL | GitHub environment `production` |
| `app_user` URL | Vercel project env |
| `app_backup` URL | GitHub environment `backup` |
| age private key | Offline / password manager |
| age recipient | GitHub environment `backup` |
| R2 API token | GitHub environment `backup` |
| Sentry auth token | GitHub environment `production` |

No credential appears in two places, and none is in the repository.
