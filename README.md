# Vaultide

A monthly, snapshot-driven personal finance platform. You enter balances and the
flows you know; Vaultide infers spending by cash reconciliation, keeps records in
their native currency with historical FX, separates capital flows from investment
performance, explains what changed your net worth, and projects it forward.

**Current state: Phase 0 — Foundations.** No authentication, no financial data
models, no FX. What exists is the ground the rest is built on: exact decimal
money, injected time, database roles with row-level security that fails closed,
CI, and a verified encrypted backup.

The authoritative specification is
[`docs/implementation-blueprint.md`](docs/implementation-blueprint.md) (frozen,
v2.1.2). Implementation-level choices are recorded in
[`docs/adr/`](docs/adr/0001-phase-0-implementation-decisions.md).

## Layout

```text
apps/web            Next.js App Router: shell, /api/health, exact formatting, inputs
packages/finance    pure engines — money, dates, Unavailable/Partial, sign, backends
packages/validation Zod primitives shared by client, server and database
packages/db         Drizzle schema, migrations, RLS primitives, currency seed
packages/application use cases: request context, actions, errors, logging, health
packages/config     tsconfig, ESLint (incl. the money-coercion rule), boundaries
e2e                 Playwright smoke suite (desktop + mobile)
scripts/db          role bootstrap, local PostgreSQL helper
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
`TEST_DATABASE_URL_ADMIN`, or the local cluster above.

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
