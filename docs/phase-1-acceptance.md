# Phase 1 acceptance record

Evidence for every acceptance criterion in blueprint §25 (Phase 1) and §26.
Recorded 2026-09-07 on branch `main`, on top of the Phase 0 checkpoint
(`9d2b151`). Phase 2 has not been started.

Phase 1 delivers: Better Auth 1.7.x with verified email, optional TOTP and
DB-backed sessions and rate limits; user settings; categories and tags; the
global FX architecture with a daily refresh and first-use backfill; onboarding
steps 1–3; and the auth and settings pages.

---

## §26 — the Phase 1 gate

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Verification-gated sign-in | **PASS** | `auth.test.ts` → *refuses to sign in before the address is verified* (no session cookie is issued), *creates the user, sends a verification email, and issues no session* (`autoSignIn: false`), *signs in once verified*. End to end: `auth.spec.ts` signs up, is redirected away from `/settings/profile`, is refused at sign-in, then verifies from the captured email and gets in. |
| 2 | Auth rate limits | **PASS** | `security.test.ts` → the sixth sign-in in a minute is `429`, the fourth sign-up in ten minutes is `429`, the fourth reset request in fifteen minutes is `429`; the counters are rows in `rate_limit`, so they survive a serverless cold start. The route-specific rules of 17.1 are asserted against the config. |
| 3 | TOTP | **PASS** | `auth.test.ts` → enable with the password, confirm with a generated code, a fresh sign-in stops at the second factor and issues no session, a wrong code is refused, the right one gets in, a backup code works **once**, and disabling requires the password. `auth.spec.ts` does the same through the interface with a real authenticator algorithm. |
| 4 | User settings persist | **PASS** | `settings.test.ts` → every field round-trips through the database, the version increments, a stale version is refused with `CONFLICT_VERSION`, and `updated_at` is maintained by trigger. `auth.spec.ts` sets time zone, locale, both currencies and the spending preference, signs out, signs back in, and finds them unchanged. |
| 5 | FX cron fills the whole supported set without reading a user table | **PASS** | `fx.test.ts` → *fills the whole supported fiat set*: the refresh asks for every currency in `currencies`, not the ones anyone happens to use. *Completes with no session and cannot see any user row while doing so*: a provisioned user's rows exist inside their own scope, and in the context the cron runs in `user_settings`, `categories` and `tags` all count **0** — not by choice, by RLS. |
| 6 | A weekend conversion uses the prior available reference rate and reports `exact = false` | **PASS** | `fx.test.ts` (unit) → *uses Friday's rate on Saturday and reports exact = false*, and the same on Sunday and the following Monday; *refuses the eleventh day rather than carrying a stale rate*. Against a real database: `fx.test.ts` (integration) → *reproduces the stored rate exactly and applies the on-or-before rule*. |
| 7 | BTC/ETH and other crypto are not offered as currencies | **PASS** | `settings.test.ts` → *offers no crypto at all* (BTC, ETH, XBT, USDT, SOL, ADA, DOGE are absent from the catalogue), and setting a crypto reporting currency is a `VALIDATION_ERROR`. `fx.test.ts` → `ensureHistory('BTC')` makes no provider call at all. `auth.spec.ts` reads the currency picker's options in the browser and asserts none of them is crypto. |
| 8 | Account deletion removes all user-owned rows | **PASS** | `auth.test.ts` → deletion needs the password; afterwards the `user` row is gone and `{ user_settings: 0, categories: 0, tags: 0 }`. `phase1-rls.test.ts` → the raw cascade from `"user"` empties every user-owned table for the deleted user and touches nothing of the other user's; the Better Auth tables cascade too, so no session, credential or TOTP secret outlives the account. |
| 9 | RLS/security tests for all Phase 1 user-owned tables pass | **PASS** | `phase1-rls.test.ts` runs all six of 17.4's cases against **each** of `user_settings`, `categories` and `tags`, as raw SQL under `app_user`: GUC missing → 0 rows, no error; GUC empty → 0 rows, no error; GUC = A → only A; GUC = B → only B; an insert forged for the other tenant fails `WITH CHECK`; the policy cannot be disabled. It also asserts that the set of tables with RLS is exactly the set of user-owned tables. |
| 10 | Phase 0 acceptance remains green | **PASS** | See "Phase 0 still holds" below. |

---

## Test results

Run locally on 2026-09-07 against PostgreSQL 18, with a database provisioned
from zero by the same scripts an operator runs (admin bootstrap → migrations as
`app_owner` → currency seed).

| Suite | Command | Result |
|---|---|---|
| Lint + money rule | `pnpm -r run lint` | **pass**, 6 packages |
| Module boundaries | `pnpm run lint:boundaries` | **pass** — no violations, 185 modules, 414 dependencies |
| Types | `pnpm -r run typecheck` | **pass**, 6 packages |
| Unit + property | `pnpm -r run test:unit` | **158 passed** — finance 110, application 19, validation 16, web 10, db 3 |
| Integration (db) | `pnpm --filter @vaultide/db run test:integration` | **61 passed** (6 files) |
| Integration (application) | `pnpm --filter @vaultide/application run test:integration` | **66 passed** (4 files) |
| Build | `pnpm run build` | **pass** — 16 routes |
| End to end | `pnpm test:e2e` | **36 passed** — 12 specs × chromium desktop, webkit desktop, chromium mobile |
| Finance coverage gate | `vitest run --coverage` | **pass** — statements 99.56 %, branches 97.88 %, functions 100 %, lines 99.74 %; §21's gate is ≥ 95 % lines and branches |
| Secret scan | `gitleaks --config .gitleaks.toml` | **pass** — no leaks |
| Currency reconciliation | `pnpm db:verify-currencies` | **pass** — 30 = 30, in sync |

New unit coverage in Phase 1 (`packages/finance/test/unit/fx.test.ts`, 37 cases):
exact-date lookup; latest-on-or-before across a weekend and a Monday; the
ten-day cutoff accepted at day 10 and refused at day 11; monthly average as the
arithmetic mean of stored daily rates; the current month's five-sample rule and
its dated fallback; a completed month with no rates being `Unavailable` rather
than a guess; day-weighted span averages and their unavailability over a gap;
the EUR identity with an empty table; cross rates through the pivot including an
exact A→B→A round trip; a cross rate being only as fresh as its stalest leg;
source preference, including an unlisted publisher ranking last; `approximate`
propagating through a cross rate and a span; and conversion reporting the rate,
its date, its publisher and whether it was the requested day's.

---

## Phase 0 still holds

Phase 1 changed the landing page (it now offers a way in) and moved the shell
into the route groups. Nothing that Phase 0's acceptance rests on was weakened:

| Phase 0 criterion | Still proven by |
|---|---|
| CI green | Same pipeline; every job runs the same commands, plus the two new integration suites. |
| Shell renders | `smoke.spec.ts` → *renders the application shell* (title, heading, skip link first in tab order, footer). Updated to the Phase 1 badge text and to assert the way in; the assertions themselves are unchanged in strength. |
| Exact formatting in three locales | `format.test.ts` untouched; `smoke.spec.ts` still asserts all nineteen digits in `en-US` and `de-DE` and the half-up rounding in `ja-JP`, in a real browser. |
| CLF round-trips input, storage, display | `smoke.spec.ts` → *round-trips a four-minor-unit currency through the money input*, untouched. Phase 1 adds `settings.test.ts` asserting CLF's `minor_units = 4`, JPY's 0 and KWD's 3 survive in the catalogue. |
| `0.1 + 0.2 = 0.3`; backends agree | `money.test.ts`, `numeric-backends.test.ts`, untouched. |
| Fresh database from scratch; role assertions | `fresh-database.test.ts`, `rls.test.ts`, `backup.test.ts`, `managed-postgres.test.ts` — untouched and still passing against a schema that now has ten more tables. Phase 1 adds `security.test.ts` proving `app_user` still cannot DDL, grant itself anything, `SET ROLE`, or disable RLS. |
| Verified backup dump as `app_backup` | `backup.test.ts` untouched; `phase1-rls.test.ts` additionally asserts `app_backup` reads every tenant's rows in each new table and can write to none of them. |

One Phase 0 test changed in substance, and it was wrong rather than weakened:
`smoke.spec.ts` asserted a placeholder reading *"Reporting currency (selectable
from Phase 1)"*. The selector is now real and belongs to a signed-in visitor, so
the test asserts that an anonymous visitor is offered sign-in and sign-up and
that **no** reporting-currency control is rendered for them.

---

## What was built

### Schema (migrations `0002`, `0003`)

`0002_phase1_auth_settings_fx.sql` creates ten tables.

**Better Auth** (17.1, T10) — `user`, `session`, `account`, `verification`,
`two_factor`, `rate_limit`. Two departures from the library's generated default,
both required by the blueprint: ids are `uuid` (17.1
`advanced.database.generateId`), so every `user_id` elsewhere is a real uuid
foreign key and the RLS predicate's `::uuid` cast compares like with like; and
timestamps are `timestamptz` (6.1). No RLS: these belong to no tenant in the RLS
sense, and a session must be readable before there is a user id to scope by.

**`fx_rates`** (6.2, global, append-only) — `EUR`-pivot rows with
`UNIQUE (base, quote, rate_date, source)`, `(quote, rate_date DESC)`,
`CHECK (rate > 0)` and `CHECK (base = 'EUR')`. No RLS. `app_user`'s `UPDATE`,
`DELETE` and `TRUNCATE` are revoked by migration `0003`, so immutability is a
privilege rather than a convention.

**`user_settings`**, **`categories`** (with the `category_kind` enum and the
seven system kinds), **`tags`** — each with `user_id … ON DELETE CASCADE`, RLS
enabled and one policy for `app_user`:
`user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid`, as
`USING` and `WITH CHECK` (17.4, D44). `categories` carries
`UNIQUE (id, user_id)` for the composite child references of Phase 3 and a
partial unique index on `(user_id, name) WHERE archived_at IS NULL`, so
archiving frees the name.

`0003_phase1_privileges_and_triggers.sql` adds the `set_updated_at` trigger
function and its three triggers (6.1: "trigger-maintained"), and applies the
`fx_rates` privilege exception.

The Phase 0 `currencies` table and its seed are preserved. One correction, which
Phase 1 was asked to make: see "Supported-currency reconciliation".

### Packages

| Package | Added |
|---|---|
| `finance` | `src/fx/` — `FxTable` (`rateOn`, `monthlyAverage`, `spanAverage`), `convert`, `crossRate`, the EUR pivot, the ten-day rule. Pure: no IO, no clock. |
| `validation` | `inputs/auth.ts` (email, password with the 12/128 bounds, TOTP and deletion confirmation), `inputs/settings.ts` (settings, onboarding steps, category and tag names), the `categoryKinds` enums. |
| `db` | `schema/{auth,fx-rates,user-settings,categories,tags,rls}.ts`; `repositories/{currencies,fx-rates,provisioning,user-settings,categories,users}.ts`; `src/testing/provision.ts` moved from `test/helpers` and exported as `@vaultide/db/testing`. |
| `application` | `auth/{config,session}.ts`, `mail/{mailer,templates,providers}.ts`, `fx/{provider,frankfurter,service}.ts`, `settings/{types,service}.ts`, `users/{provisioning,default-categories,categories,deletion}.ts`, `currencies/service.ts`, `services.ts` (the composition root). |
| `apps/web` | `(auth)/` sign-in, sign-up, verify, reset; `(app)/` settings (profile, security, currencies, categories, data) and `onboarding/[step]`; `api/auth/[...all]`, `api/cron/fx-refresh`, `api/test/mailbox`; the reporting-currency selector and user menu; the proxy's session gate. |

### Dependency changes

| Package | Change |
|---|---|
| `better-auth` | **added `1.7.2`** to `@vaultide/application` and `@vaultide/web`. Not 1.7.3 (published 2026-09-06): `minimumReleaseAge: 4320` — the three-day supply-chain hold of 17.3 — excludes it. |
| `otplib` | **added `13.5.0`** (dev) to `@vaultide/application` and `@vaultide/e2e`, to generate TOTP codes in tests. |
| `server-only` | **added `0.0.1`** to `@vaultide/web`. Next resolves the specifier itself; dependency-cruiser cannot, and an unresolvable import is a boundary error. |
| `zod` | **added `4.5.4`** to `@vaultide/web` (already in `validation` and `application`). |
| `pg`, `@types/pg` | **added `8.23.0` / `8.23.1`** (dev) to `@vaultide/application` for the integration harness. |
| Everything else | unchanged. Next.js stays on `16.3.4`, Drizzle on `0.45.2`, React on `19.2.8`. |

`drizzle-orm` was deliberately **not** added to `@vaultide/application`: a second
copy type-checks as an unrelated class and fails at the first `sql` template
crossing a package boundary. `@vaultide/db` re-exports the few helpers needed.

### Better Auth configuration actually implemented

Every row of 17.1, with the three API-level adaptations noted:

- `emailAndPassword`: `enabled`, `requireEmailVerification: true`,
  `minPasswordLength: 12`, `maxPasswordLength: 128`, `autoSignIn: false`,
  `resetPasswordTokenExpiresIn: 3600`, `revokeSessionsOnPasswordReset: true`,
  `sendResetPassword`, and `onExistingUserSignUp` — the enumeration wrapper of
  17.3, which emails the **existing owner** that somebody tried.
- `emailVerification`: `sendOnSignUp: true`, `expiresIn: 3600`,
  `autoSignInAfterVerification: true`, `sendVerificationEmail`.
- `session`: `expiresIn` 30 days, `updateAge` 1 day,
  `cookieCache { enabled: true, maxAge: 300 }`, `freshAge: 600`. DB-backed.
- `user.deleteUser`: enabled, with an `afterDelete` that verifies the cascade
  reached every table and sends the confirmation of 18.3. No
  `sendDeleteAccountVerification` — 18.3 wants re-authentication and a typed
  confirmation, not an email round trip.
- `rateLimit`: `storage: 'database'`, default 60 s / 30, with
  `/sign-in/email` 60 s / 5, `/sign-up/email` 600 s / 3,
  `/request-password-reset` 900 s / 3, `/two-factor/verify-totp` 300 s / 5.
- `trustedOrigins: [APP_URL]`, and — added deliberately —
  `advanced.disableOriginCheck: false` and `disableCSRFCheck: false`.
- `advanced.database.generateId`: UUID v4. `useSecureCookies` from the base
  URL's scheme; `httpOnly`, `sameSite: 'lax'`, `secure`, and the `__Secure-`
  prefix Better Auth adds with them.
- Plugins: `twoFactor({ issuer: 'Vaultide', accountLockout: { maxFailedAttempts: 5 }, backupCodeOptions: { storeBackupCodes: 'encrypted' } })`,
  `haveIBeenPwned()`, `nextCookies()` last.
- `Mailer`: an interface in `application`, a provider-agnostic HTTP adapter, and
  a capturing implementation used by the integration and E2E suites.

Three adaptations, all recorded in
[ADR 0002](adr/0002-phase-1-implementation-decisions.md): the reset route is
named `/request-password-reset` in 1.7 rather than `/forget-password`; the HIBP
check is the `haveIbeenPwned()` plugin rather than an `isPasswordCompromised`
option, with the same k-anonymity mechanism; and the TOTP lockout is
`accountLockout.maxFailedAttempts`. Behaviour is the blueprint's in each case.

### User provisioning

On user creation, one transaction inside `withUser` writes `user_settings`, the
starter consumption categories, one category for each of the seven system kinds,
and the initial tag list. Every write is `ON CONFLICT DO NOTHING`, so it is
idempotent; `requireSession` calls `ensureProvisioned` on every authenticated
request, so an account whose provisioning was interrupted repairs itself before
the user can act on it. Asserted three ways in `settings.test.ts`:
all-or-nothing, no duplicates on a second run, and repair after the settings row
is deleted out from under it.

### FX provider behaviour

Primary provider **Frankfurter v2** at `api.frankfurter.dev`, whose current API
is served under `/v1`. Rates are read from the response **text** with a reviver
that keeps each number's literal digits: `JSON.parse` would hand back a float64,
and `fx_rates.rate` is `NUMERIC(24,12)`.

- `refreshAll()` — one time-series call covering the last 14 days for every
  currency in `currencies` with `is_fx_supported`. It delivers the latest fixing
  and fills any business day a previous run missed, in the same request. Runs
  with no user context.
- `ensureHistory(currency, from)` — one call, once, globally, on first use of a
  currency; from `1999-01-04` or 31 days before the caller's earliest date.
  Skipped when the stored series already reaches back far enough.
- `loadTable(quotes, from, to, today)` — reads rows into the pure `FxTable`.
- Failure: a provider outage during `ensureHistory` is swallowed — it runs
  inside a user's request and must not undo what they did — and logged;
  conversions stay `Unavailable` until the next cron. An outage during the cron
  returns 503, logs, and checks in with the Sentry monitor as `error`. Nothing
  is fabricated and nothing already stored is touched.
- Idempotence is a constraint, not a check: `ON CONFLICT DO NOTHING` on
  `(base, quote, rate_date, source)`. A second refresh inserts zero rows.
- Implausible rates (≤ 0, or above 10⁶) are refused by the adapter and, as a
  last line, by the `CHECK` constraint.

### Supported-currency reconciliation

Phase 0 seeded 31 currencies as `is_fx_supported`, from the historical ECB list.
The provider publishes **30**. The difference is **BGN**: Bulgaria adopted the
euro on 2026-01-01 and the ECB stopped publishing a EUR/BGN reference rate.

BGN stays in the catalogue — historical amounts must still validate and format —
with `is_fx_supported = false`, so it can no longer be chosen as a base or
reporting currency. `settings.test.ts` asserts that choosing it is refused, and
`auth.spec.ts` asserts it is absent from the picker in the browser.

The assumption is now checked rather than carried:

```text
$ pnpm db:verify-currencies
provider (https://api.frankfurter.dev/v1): 30 currencies
seed (is_fx_supported):  30 currencies
In sync.
```

It runs weekly in `verify-environment.yml`, and
`FxService.reconcileSupportedCurrencies()` does the same at runtime. Both
**report**; neither repairs. Adding or removing a currency is a migration and a
decision, not a background job's side effect.

---

## Operational work

| Item | State |
|---|---|
| Vercel cron | `apps/web/vercel.json` schedules `/api/cron/fx-refresh` at `0 16 * * *` UTC, after the ECB fixing (10.4). Once per day, which is what the Hobby plan allows. |
| Cron authorization | Bearer `CRON_SECRET`, compared in constant time. Any other caller gets a **404** — not a 401, which would confirm the route exists. |
| Sentry cron monitor | The route checks in `in_progress` → `ok`/`error` at `SENTRY_CRON_FX_URL` (22.6). A monitoring failure never fails the refresh, and is logged as a warning rather than swallowed — the mistake the backup job made and fixed. |
| Production migrations | `deploy-production.yml` already runs `db:migrate` and `db:seed-currencies` as `app_owner` before the deploy hook. Migrations `0002` and `0003` need no workflow change. |
| Currency reconciliation | New job in `verify-environment.yml`, weekly and on demand. |
| Env var names | `.env.example` documents `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `EMAIL_API_KEY`, `EMAIL_FROM`, `EMAIL_API_URL`, `EMAIL_PROVIDER_ID`, `CRON_SECRET`, `FX_PROVIDER_URL`, `SENTRY_CRON_FX_URL`. Names only, as always. |
| Runbooks | `docs/ops/environment-setup.md` §5 covers auth secrets, the email decision and the cron, with the verification commands. `docs/ops/secrets.md` covers rotation. |
| Privileged credentials in Vercel | Still none. The runtime holds `DATABASE_URL` (`app_user`) only. |

### Verified locally against the real provider

The production build was run in a production-like configuration (a real
`CRON_SECRET`, mail configured, the test capabilities **off**) against a
database provisioned from zero, and driven with `curl`:

```text
GET /api/test/mailbox?to=…                              404   (test capabilities off)
GET /api/cron/fx-refresh            (no secret)         404
GET /api/cron/fx-refresh            (bearer secret)     {"status":"ok","currencies":29,
                                                         "rowsFetched":319,"rowsInserted":308,
                                                         "from":"2026-08-24","to":"2026-09-07"}
GET /api/cron/fx-refresh            (again)             rowsInserted: 0
```

29 currencies is the supported set of 30 minus the EUR pivot, which is 1 by
definition and never stored. The second run inserting nothing is idempotence
by constraint. Afterwards the database held **7,395 rows across 29 currencies,
1999-01-04 to 2026-09-07** — the range covers the whole ECB series because the
end-to-end run had already triggered a first-use history backfill.

Two spot checks against the live API: EUR→USD on 2026-09-04 is stored as
`1.162200000000`, digit for digit what Frankfurter published; and no weekend
row exists (the series steps 2026-08-28 → 2026-08-31), which is what makes the
`exact = false` weekend rule true against real data rather than only against a
fixture.

In the same connection, with no user context — the context the cron runs in —
`user_settings`, `categories` and `tags` all counted **0** while the E2E
accounts existed.

### Not done: the production deployment

**This is the external boundary, and it is a hard stop.** A Phase 1 deployment
needs three secrets this session cannot create, and deploying without them would
take the site down rather than degrade it: `createServices` refuses to start
without `BETTER_AUTH_SECRET`, and `createMailerFromEnv` refuses to start without
a mail provider — deliberately, because an installation that silently swallows
verification mail looks healthy while nobody can sign in.

What you need to do, in order:

1. **Choose an email provider.** Blueprint 18.3 asks for one with an EU region
   and 29.1 proposes Postmark or Resend. Checked on 2026-09-07: **neither has
   EU data residency.** Postmark (ActiveCampaign) is US-only with no plans for
   an EU region; Resend's `eu-west-1` is a *sending* region — account data,
   message metadata and logs stay in the US. Vaultide's adapter is
   provider-agnostic, so this is your decision, not a code change. What a
   provider sees is an email address and the fact that an account exists.
2. **Set four variables in the Vercel production environment:**
   `BETTER_AUTH_SECRET` (`openssl rand -hex 32`), `BETTER_AUTH_URL`
   (`https://<domain>/api/auth`), `APP_URL` (`https://<domain>`), and
   `CRON_SECRET` (`openssl rand -hex 32`).
3. **Set the email variables:** `EMAIL_API_KEY`, `EMAIL_FROM`
   (`Vaultide <no-reply@<domain>>`, with the domain verified at the provider),
   and `EMAIL_API_URL` if it is not Resend.
4. Optionally create a Sentry cron monitor for the FX job and set
   `SENTRY_CRON_FX_URL`.
5. Merge to `main`. CI runs, then `deploy-production.yml` applies migrations
   `0002` and `0003` as `app_owner` and triggers the deploy hook.

Then verify, in this order — each of these fails loudly if the step before it
was wrong:

```bash
curl -s https://<domain>/api/health
# {"status":"ok","database":"ok","version":"<the released commit>"}

curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/api/test/mailbox
# 404 — the capturing mailbox must not exist in production

curl -s -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/fx-refresh
# {"status":"ok","currencies":29,...}   then run it again: rowsInserted is 0

curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/api/cron/fx-refresh
# 404 — no secret, no answer
```

Finally, **sign up with a real address on the deployed site and click the
verification link.** Nothing in CI can prove a mail provider is configured
correctly, and this is the one path where a silent failure means nobody can use
the product at all.

Until that is done, the deployed site is still the Phase 0 build. The Phase 0
acceptance record's evidence for the live environment stands unchanged.

---

## Deviations from the blueprint, and why

1. **`/sign-in`, not `/auth/sign-in`.** 15.1 writes the routes as
   `/auth/(sign-in|sign-up|verify|reset)`; 19 shows the directory as
   `src/app/(auth)/sign-in|…`, and a parenthesised directory is a route group
   that does not appear in the URL. Section 19's file tree is followed exactly.
2. **The email provider has no EU region.** 18.3 and 29.1 assume one exists;
   neither candidate offers it. Implemented as a provider-agnostic adapter with
   the decision recorded rather than a residency claim that is not true.
3. **Three Better Auth API adaptations** (route name, HIBP plugin, lockout
   option name), each preserving the blueprint's behaviour.
4. **`VAULTIDE_TEST_ENDPOINTS`.** Section 21 gates the `TEST_CLOCK` override on
   `NODE_ENV === 'test'`, and 21.5 runs the E2E suite against the production
   build — but a Next standalone server assigns `NODE_ENV = 'production'` to
   itself before any application code runs, so that gate can never be true where
   the blueprint says to use it. The gate now also accepts an explicit
   `VAULTIDE_TEST_ENDPOINTS=enabled`, and refuses outright whenever
   `VERCEL_ENV=production`. The intent is unchanged: a header a user sends can
   never move the server's clock, and the mailbox — which hands out single-use
   tokens — cannot be reached in production. Asserted in
   `application.test.ts`.
5. **Cookie caching leaves a five-minute read window after revocation.** 17.1
   asks for both `cookieCache: { maxAge: 300 }` and
   `revokeSessionsOnPasswordReset`. Revocation deletes the session rows, and
   every endpoint that authorizes something re-reads the store — but an ordinary
   session read can still be answered from the signed cookie for up to five
   minutes. This is the blueprint's own configuration, implemented as written;
   it is recorded because both halves are true and the second is not obvious.

None of these changes the architecture, the accounting model, the schema
semantics or the roadmap.

---

## Defects found and fixed while implementing Phase 1

- **Better Auth's origin check was silently off under test.** It disables its
  origin and CSRF checks when `NODE_ENV === 'test'`. The first cross-origin
  test passed a sign-in it should have refused. Both flags are now set
  explicitly, so the behaviour is identical in every environment and the
  security suite can assert the refusal.
- **The deletion verification read without a user context.** `countUserRows`
  used `withoutUser`, so RLS returned zero for every table and an unfinished
  deletion would have looked complete. It now runs inside `withUser`, which is
  well defined for a deleted user's id.
- **A stray directory tree.** `packages/db/apps/web/…` was created by a shell
  whose working directory had moved, and dependency-cruiser reported it as `db`
  importing `application`. A real file, not a tool artifact; deleted.
- **BGN.** See "Supported-currency reconciliation".

---

## Open items (none blocks the Phase 1 checkpoint)

1. **The production deployment is not done.** See above — it is blocked on
   three secrets and one provider decision that are yours to make.
2. **Neon plan.** Free gives 6 hours of instant-restore history; 22.5 wants 7
   days before real balances exist. Phase 1 stores accounts and settings but no
   financial records, so this is due before Phase 2 ships, not before this
   checkpoint. Flagged in the Phase 0 record and still open.
3. **The Phase 0 credential-hygiene items are still open**:
   `~/.vaultide/age-backup-key.txt` and the `.secrets.local/` files should move
   into a password manager; Sentry's *Prevent Storing of IP Addresses* is still
   unset; the pre-existing R2 admin token still has write access to the backup
   bucket.
4. **Onboarding steps 4–11** (spec §90) belong to the phases that give them
   something to ask about. `/onboarding/[step]` returns a 404 for them today,
   which is honest.
5. **The `data` settings page has no export.** Export is a Phase 7 deliverable
   (18.3); the page says so and lists what is held instead.
