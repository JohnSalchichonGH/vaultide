# Vaultide

A monthly, snapshot-driven personal finance platform. You enter balances and the
flows you know; Vaultide infers spending by cash reconciliation, keeps records in
their native currency with historical FX, separates capital flows from investment
performance, explains what changed your net worth, and projects it forward.

**Current state: Phase 2 — accounts, balances and net worth.** You can create
an account, confirm your address, sign in (optionally with a second factor), and
set what you think in and what totals are shown in. Then: cash accounts and
other assets in any supported currency, balances dated to the day and never into
the future, statement month-end balances once a month has ended, quick update,
and both net-worth metrics — total (everything you track) and financial (the
headline). A value nobody has recorded is shown as unknown, never as zero, and a
total that could not include something says so and says what. No spending,
income or transfers yet — those arrive with Phase 3.

The authoritative specification is
[`docs/implementation-blueprint.md`](docs/implementation-blueprint.md) (frozen,
v2.1.2). Implementation-level choices are recorded in [`docs/adr/`](docs/adr/):
[Phase 0](docs/adr/0001-phase-0-implementation-decisions.md),
[Phase 1](docs/adr/0002-phase-1-implementation-decisions.md),
[pre-Phase-2 gates](docs/adr/0003-pre-phase-2-security-and-cost-gates.md),
[Phase 2](docs/adr/0004-phase-2-implementation-decisions.md). Each phase's
evidence is in `docs/phase-N-acceptance.md`.

## Layout

```text
apps/web            Next.js App Router: auth pages, settings, onboarding, shell,
                    dashboard, accounts and account detail,
                    /api/auth, /api/cron/fx-refresh, /api/health
packages/finance    pure engines — money, dates, FX lookup and conversion,
                    Unavailable/Partial, sign, numeric backends, position values
                    and freshness, total and financial net worth
packages/validation Zod primitives and inputs shared by client, server, database
packages/db         Drizzle schema, migrations, RLS policies, repositories, seed
packages/application use cases: Better Auth, sessions, mailer, settings, FX service,
                    positions, valuations, quick update, net-worth queries
packages/config     tsconfig, ESLint (incl. the money-coercion rule), boundaries
e2e                 Playwright: smoke, the auth and settings flow, and the
                    accounts, balances and net-worth journey
scripts/db          role bootstrap, local PostgreSQL, currency reconciliation
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
pnpm db:verify-currencies   # does the seed still match what the ECB publishes?
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
  strings. Money never passes through a JavaScript `number` — a lint rule fails
  the build if it tries.
- **Time is injected.** No engine reads the clock. "Today" is computed once per
  request in the user's timezone, so month boundaries are testable and no record
  can be dated in the future.
- **Unknown is a value.** A figure that cannot be computed is `Unavailable` with
  a reason, never `0`; an aggregate missing a part says so.
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
