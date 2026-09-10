# Vaultide

A monthly, snapshot-driven personal finance platform. You enter balances and the
flows you know; Vaultide infers spending by cash reconciliation, keeps records in
their native currency with historical FX, separates capital flows from investment
performance, explains what changed your net worth, and projects it forward.

**Phases 0–2 are frozen and production-verified; Phase 3 is in progress.** What
you can use today is Phase 2: create an account, verify your email address, sign
in (optionally with a second factor), and choose your base and reporting
currencies, timezone and locale. Then: cash accounts and other assets in any
supported currency, balances dated to the day and never into the future,
statement month-end balances once a month has ended, quick update, and both
net-worth metrics — total (everything you track) and financial (the headline). A
value nobody has recorded is shown as unknown, never as zero, and a total that
could not include something says so and says what.

**Phase 3 server-side implementation has reached slice 10b.** Income, expenses
and transfers with their linked fee; recurring sources with their occurrences,
terms, acceptances and skips, and how complete a past month's recurring record
is; completed-month reconciliation with its issues and per-account residuals —
the engine that infers what a finished month spent from its own statement
balances and records, per native currency, and says when it cannot; the current
month so far, measured to the one date every account has evidence for;
multi-month spans, which reconcile a stretch whose interior month ends are
missing and report it once for the interval rather than spreading it back over
the months inside; and, in each native currency, what that spending was for —
consumption against fees, transaction costs and money sent outside — together
with what was saved from income, personal savings and the savings rate, plus
the spending paid from outside tracked accounts and the spending someone else
paid, which are reported beside the rest and never inside it.

The same month is now also said in the currency you think in. Every known flow
converts at its own financial date and the inferred remainder at its interval's
average rate — the calendar month for a finished month, and only the evidence up
to the shared date `D` for the month so far, so a rate published after `D`
cannot move a figure labelled as running to it. Each figure carries its own
availability, so a rate missing for one memo does not blank out the savings
rate: available, partial, or unavailable with the reason and the currency it
came from — a missing month-end statement, an unusable opening, an unresolved
month or an absent rate each named as itself. A month with no shared date has no
tracked interval at all and says so, rather than reporting zeros it never
measured. A currency in which you only recorded spending you settled yourself or
somebody else paid needs no account and gets no reconciliation bucket, and its
rows still reach the figures they belong to. Completed months can be read as a
series, one result each, and the rolling three-, six- and twelve-month averages
of tracked spending are built from it: exact calendar windows ending at each
completed month, counting a month only when it is reliable and its
reporting-currency tracked spending is complete — an ineligible month keeps its
calendar slot rather than being replaced by an older one — averaging whatever
survived, saying how many months that was, and never averaging a span or the
month in progress.

None of it has an interface yet. There is no monthly editor, no spending page,
no income page and no bulk-history editor; the large-unclassified and
possible-missing-conversion advisories, the month's completeness report and the
remaining read models and actions are still unwritten; the rest of the Phase 3
end-to-end journeys are not yet covered; and no Phase 3 journey has been
accepted end to end. Phase 3 is in progress, and is neither accepted nor
frozen.

The authoritative specification is
[`docs/implementation-blueprint.md`](docs/implementation-blueprint.md) (frozen,
v2.1.13). Implementation-level choices are recorded in [`docs/adr/`](docs/adr/):
[Phase 0](docs/adr/0001-phase-0-implementation-decisions.md),
[Phase 1](docs/adr/0002-phase-1-implementation-decisions.md),
[pre-Phase-2 gates](docs/adr/0003-pre-phase-2-security-and-cost-gates.md),
[Phase 2](docs/adr/0004-phase-2-implementation-decisions.md),
[Phase 3](docs/adr/0005-phase-3-implementation-decisions.md) (written against
v2.1.6, and deliberately left at that baseline). Each accepted phase's evidence
is in `docs/phase-N-acceptance.md`.

## Layout

```text
apps/web            Next.js App Router: auth pages, settings, onboarding, shell,
                    dashboard, accounts and account detail,
                    /api/auth, /api/cron/fx-refresh, /api/health
packages/finance    pure engines — money, dates, FX lookup and conversion,
                    Unavailable/Partial, sign, numeric backends, position values
                    and freshness, total and financial net worth, flow roles,
                    recurring occurrences and terms, completed-month,
                    month-to-date and multi-month-span reconciliation, native
                    spending decomposition and savings, reporting-currency cash
                    flow and savings, rolling tracked-spending averages
packages/validation Zod primitives and inputs shared by client, server, database
packages/db         Drizzle schema, migrations, RLS policies, repositories, seed
packages/application use cases: Better Auth, sessions, mailer, settings, FX service,
                    positions, valuations, quick update, net-worth queries,
                    income, expenses, transfers, recurring templates and
                    suggestions, completed-month, month-to-date and span
                    reconciliation reads, native savings reads,
                    reporting-currency cash-flow and rolling tracked-spending reads
packages/config     tsconfig, ESLint (incl. the money-coercion rule), boundaries
e2e                 Playwright: smoke, the auth and settings flow, and the
                    accounts, balances and net-worth journey
scripts/db          role bootstrap, local PostgreSQL, currency reconciliation,
                    live environment and financial-invariant checks
scripts/backup      dump → verify → encrypt
```

Module boundaries (blueprint section 19) are enforced by `dependency-cruiser` in
CI: `finance` is pure, `apps/web` never reaches the database, and only
`application` sees `db`, `finance` and `validation` together.

## Getting started

```bash
corepack enable
pnpm install
```

### Run the app

```bash
pnpm dev            # http://localhost:3000
```

Authentication needs a database and a secret. Without a mail provider the
verification and reset messages are captured rather than sent, and readable at
`/api/test/mailbox`:

```bash
export BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
export BETTER_AUTH_URL=http://localhost:3000/api/auth
export APP_URL=http://localhost:3000
export DATABASE_URL=postgres://app_user:...@127.0.0.1:5432/vaultide
pnpm dev
```

### A local database

No Docker required. `PGBIN` may point at any PostgreSQL 16 `bin` directory;
otherwise the script looks in `~/.vaultide/pgsql/bin`.

```bash
pnpm db:local start                 # throwaway cluster under .vaultide-pg/
DATABASE_URL_ADMIN="$(pnpm -s db:local url)" \
  APP_OWNER_PASSWORD=... APP_USER_PASSWORD=... APP_BACKUP_PASSWORD=... \
  pnpm db:bootstrap                 # create app_owner / app_user / app_backup
DATABASE_URL_DIRECT_OWNER=... pnpm db:migrate
DATABASE_URL_DIRECT_OWNER=... pnpm db:seed-currencies
```

Roles, and the credential each one belongs to, are described in
[`docs/ops/secrets.md`](docs/ops/secrets.md).

### Checks

```bash
pnpm lint                # ESLint + module boundaries
pnpm typecheck
pnpm test:unit           # finance, validation, application, web
pnpm test:integration    # provisions fresh databases: roles, RLS, seed, backup
pnpm build
pnpm test:e2e            # Playwright, desktop + mobile
```

`pnpm test:integration` needs a PostgreSQL admin URL: either
`TEST_DATABASE_URL_ADMIN`, or the local cluster above. It provisions a fresh
database per suite through the same scripts an operator runs, so what it proves
about roles, RLS and privileges is what production has.

`pnpm test:e2e` needs `DATABASE_URL` for a migrated database; the suite starts
the production build itself.

```bash
pnpm db:verify-currencies   # does the seed still match the approved ECB -> BDI chain?
```

### Backups

```bash
DATABASE_URL_BACKUP=... BACKUP_AGE_PUBLIC_KEY=age1... pnpm db:backup
```

Dumps as `app_backup` (`SELECT` only, `BYPASSRLS`), verifies every table's row
count against the live database, then encrypts with `age`. A dump that an RLS
policy filtered can never pass verification. Restoring is documented in
[`docs/ops/restore.md`](docs/ops/restore.md).

## Principles this codebase holds to

- **Money is exact.** `NUMERIC(24,8)` in PostgreSQL, `Decimal` at 40 digits in
  the domain, decimal strings across the wire, and display formatted from those
  strings. Authoritative financial arithmetic and displayed money never pass
  through a JavaScript `number`, and a lint rule fails the build if they try.
  Numeric coercion is permitted in one place only — chart geometry, where the
  rule is switched off for `components/charts/` because a pixel is not a
  figure; every number a person reads there still comes from the exact string.
- **Time is injected.** No engine reads the clock. "Today" is computed once per
  request in the user's timezone, so month boundaries are testable and no record
  can be dated in the future.
- **Unknown is a value.** A figure that cannot be computed is `Unavailable` with
  a reason, never `0`; an aggregate missing a part says so.
- **Financial writes re-check the session.** Every state-changing financial
  action revalidates the session against the authoritative store before it
  writes. The signed cookie cache is enough to render a page; it is not enough
  to authorize a mutation, so a session revoked moments ago cannot spend its
  remaining cache window changing money.
- **The database fails closed.** Row-level security denies when no user context
  is set, the runtime role cannot bypass it or run DDL, and only the backup role
  — used by one workflow — can read across tenants.
- **Jobs cannot see tenants.** The daily exchange-rate refresh runs with no user
  context at all, so every user-owned table returns nothing to it. It maintains
  the whole supported currency set from a global table rather than discovering
  currencies from anybody's data.
- **Crypto is not a currency.** The catalogue holds fiat and official currencies
  the rate provider publishes, and nothing else. A crypto holding will be an
  investment priced in the currency its broker reports.
