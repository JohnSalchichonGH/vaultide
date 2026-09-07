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
   - Vercel builds Next with its own adapter, so `next.config.ts` omits
     `output: 'standalone'` when `VERCEL=1`; leaving it on fails the build with
     a missing `.next/next-server.js.nft.json`.
   - Install command: `pnpm install --frozen-lockfile`
   - Build command: `pnpm run build` (the repo default is fine)
4. Environment variables (Production, and Preview if you want previews):
   - `DATABASE_URL` — copy from `.secrets.local/vercel-env.txt`, then delete
     that file. This is the pooled `app_user` endpoint: the runtime role that
     cannot bypass RLS and cannot run DDL.
   - `NEXT_PUBLIC_SENTRY_DSN` and `SENTRY_DSN` — after section 3.
   - `VAULTIDE_VERSION` — optional; Vercel's `VERCEL_GIT_COMMIT_SHA` works too.
5. **Turn off automatic production deploys.** The committed
   `apps/web/vercel.json` sets `git.deploymentEnabled.main = false`. Migrations
   must run before the code that needs them (22.3), and that ordering is what
   `deploy-production.yml` exists for. Verified on this project: a deploy hook
   still fires while that setting is `false` (it responded `201`), so the two
   are compatible — the deprecated `github.enabled: false` is the setting that
   blocks hooks, and it is not used.
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

5. Turn off IP storage: Settings → **Security & Privacy** → *Prevent Storing
   of IP Addresses*. `scrubEvent` removes the `ip_address` we send, but Sentry
   also derives a location from the connecting address at ingest, which no
   client-side rule can reach. For a personal-finance app that would mean
   storing roughly where each user was sitting.
6. Cron monitor for the backup: Sentry → **Monitors** → New Monitor → **Cron**
   → **Manually Create a Monitor**. Do not take the "Auto-Instrument with
   Next.js" path: it derives monitors from *Vercel* cron jobs, and this backup
   runs in GitHub Actions against the database, not in the web app (it also
   requires Webpack, and we build with Turbopack).

   - Name `vaultide-nightly-backup` — it becomes the slug in the check-in URL
   - Crontab `30 2 * * *`, timezone UTC — matching `nightly-backup.yml`
   - Grace period **30 min**. The default of 1 is far too tight: the runner must
     boot, install, dump, verify and encrypt before its first check-in.
   - Max runtime 30 min, failure tolerance 1, recovery tolerance 1. A missed
     backup should be visible on the first miss.

   Store the bare check-in URL — the workflow appends `?status=…` itself, so a
   URL that already carries a query string breaks the check-in:

   ```bash
   gh secret set SENTRY_CRON_BACKUP_URL --env backup
   ```

The scrubbing rules (`packages/application/src/observability.ts`) drop request
bodies, query strings, breadcrumbs and PII before anything is sent. They are
unit-tested, and `scripts/ops/verify-sentry.mjs` proves them against the live
project: it builds an event carrying balances, a token, cookies, an email and an
IP, runs the real `scrubEvent`, refuses to send if any of it survived, and posts
what remains to EU ingest. The `verify-sentry` job in `verify-environment.yml`
runs it weekly.

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
   live database, encrypts with age, uploads, then downloads the object back and
   checks its sha256 against the digest taken at encryption time. A dump an RLS
   policy filtered cannot pass the row-count comparison, and a truncated upload
   cannot pass the digest check — so a green run means the archive is complete
   *and* the bucket holds exactly those bytes.

---

## 5. Authentication, email and the FX cron (Phase 1)

Three things a Phase 1 deployment needs that Phase 0 did not. All three are
Vercel **runtime** environment variables, set on the production environment.

### 5.1 `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`

```bash
openssl rand -hex 32          # 32 bytes, per blueprint 17.3
```

Set in Vercel:

- `BETTER_AUTH_SECRET` — the value above. The app refuses to start without at
  least 32 characters.
- `BETTER_AUTH_URL` — `https://<your-domain>/api/auth`
- `APP_URL` — `https://<your-domain>` — the only origin allowed to drive the
  auth endpoints (17.1 `trustedOrigins`). Sign-in from anywhere else is refused.

Rotating the secret signs everybody out. See [`secrets.md`](./secrets.md).

### 5.2 Transactional email

**Decide this before launching to anybody but yourself.** Blueprint 18.3 asks
for a provider with an EU region and 29.1 proposes Postmark or Resend. Checked
on 2026-09-07: **neither offers EU data residency.** Postmark (ActiveCampaign)
is US-only and has said it has no plans for an EU region; Resend's `eu-west-1`
is a *sending* region — account data, message metadata and logs stay in the US.

Vaultide therefore ships a provider-agnostic adapter. What it sends is narrow —
a verification link, a reset link, an "someone tried to sign up with your
address" notice and a deletion confirmation — so what a provider sees is an
email address and the fact that an account exists. That is a real disclosure,
and choosing where it goes is yours.

Whichever you pick, set:

- `EMAIL_API_KEY` — the provider's API key
- `EMAIL_FROM` — `Vaultide <no-reply@your-domain>`; the domain must be verified
  with the provider
- `EMAIL_API_URL` — the provider's send endpoint. Defaults to
  `https://api.resend.com/emails`. For a provider with a different JSON shape,
  `createHttpMailer` takes a `body` builder — one function, in
  `packages/application/src/mail/providers.ts`.
- `EMAIL_PROVIDER_ID` — optional; names the provider in operational logs only.

**Without a key the deployment refuses to start**, rather than silently
capturing verification mail and looking healthy while nobody can sign in.

Send yourself a real verification email from the deployed site before
announcing it. Nothing in CI can prove a provider is configured correctly.

### 5.3 The FX cron

```bash
openssl rand -hex 32
```

- `CRON_SECRET` — the value above, in Vercel. `apps/web/vercel.json` schedules
  `/api/cron/fx-refresh` at `0 16 * * *` UTC, after the ECB fixing (10.4).
  Vercel sends the secret as a bearer token; any other caller gets a 404.
- `SENTRY_CRON_FX_URL` — optional; a Sentry cron monitor check-in URL. The route
  reports `in_progress`, then `ok` or `error` (22.6). A monitoring failure never
  fails the refresh, but it is logged as a warning rather than swallowed.

Verify after the first deployment:

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" https://<your-domain>/api/cron/fx-refresh
# {"status":"ok","currencies":149,"rowsFetched":...,"rowsInserted":...}
# 149 quote currencies: the 150 the approved ECB -> BDI chain supports, minus
# the EUR pivot, which is 1 by definition and never stored against itself.

curl -s -o /dev/null -w '%{http_code}
' https://<your-domain>/api/cron/fx-refresh
# 404 — no secret, no answer, and no hint that the route exists
```

The refresh is idempotent: a second call inserts nothing. It also runs with no
user context at all, which is what makes it structurally unable to read across
tenants (R26, T11) — asserted in
`packages/application/test/integration/fx.test.ts`.

### 5.4 The supported-currency set

The catalogue must match what the rate provider actually publishes; a currency
flagged supported without rates would be offered as a reporting currency and
then be unconvertible.

```bash
pnpm db:verify-currencies
```

It compares the committed seed with the provider's own list and exits non-zero
on any divergence. It runs weekly in `verify-environment.yml`. It reports only:
adding or removing a currency is a migration and a decision.

---

## What lives where, afterwards

| Credential | Only in |
|---|---|
| Neon admin (`neondb_owner`) | GitHub environment `bootstrap` |
| `app_owner` URL | GitHub environment `production` |
| `app_user` URL | Vercel project env |
| `BETTER_AUTH_SECRET` | Vercel project env |
| `EMAIL_API_KEY` | Vercel project env |
| `CRON_SECRET` | Vercel project env |
| `app_backup` URL | GitHub environment `backup` |
| age private key | Offline / password manager |
| age recipient | GitHub environment `backup` |
| R2 API token | GitHub environment `backup` |
| Sentry auth token | GitHub environment `production` |

No credential appears in two places, and none is in the repository.
