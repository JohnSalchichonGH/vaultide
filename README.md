# Vaultide

A monthly, snapshot-driven personal finance platform. You record balances and
the flows you know; Vaultide infers the rest by cash reconciliation, keeps every
record in its native currency with historical exchange rates, separates capital
movements from spending and from investment performance, explains what changed
your net worth, and — in later phases — projects it forward. It covers cash,
investments, other assets and liabilities, in as many currencies as you hold.

The exact financial semantics live in
[`docs/implementation-blueprint.md`](docs/implementation-blueprint.md) (frozen,
v2.1.15). This README describes the product, its current status and how to
work on the repository; it does not restate the blueprint's rules.

## Status

### User-facing production

Phases 0–2 are accepted, frozen and production-verified. Phase 3 is still in
progress, but its first Monthly experience is live. What is usable today:

- account creation, email verification, sign-in, and an optional second factor;
- settings: base and reporting currencies, timezone and locale;
- cash accounts and other assets in any supported currency;
- balances dated to the day, never into the future, and statement month-end
  balances once a month has ended;
- quick update;
- total net worth (everything tracked) and financial net worth (the headline),
  valued across currencies with historical rates — a value nobody recorded is
  shown as unknown, never as zero, and a total that could not include something
  says so;
- Monthly, for a completed month or the current one: an overview of its income,
  spending and savings in the reporting currency, its reconciliation in each
  native currency, and, for a completed month, how complete its records are;
- marking a completed month reviewed, and hiding an advisory for that month or
  showing it again. Hiding changes only what the page shows; it resolves
  nothing.

### Phase 3 implementation

Implemented behind the application layer:

- income, expenses and transfers, with a transfer's linked fee;
- recurring templates with their terms, generated occurrences, acceptances and
  skips, and how complete a past month's recurring record is;
- completed-month reconciliation per native currency: the inferred spending of a
  finished month, its status, issues and per-account residuals;
- month-to-date reconciliation, measured to the one date every account has
  evidence for;
- multi-month spans, reconciling a stretch whose interior month ends are missing
  and reporting it once for the interval;
- the native spending and savings decomposition: consumption against fees,
  transaction costs and money sent outside, savings from income, personal
  savings and the savings rate;
- the same figures in the reporting currency, each carrying its own
  availability and the reason for anything it could not include;
- rolling three-, six- and twelve-month averages of tracked spending over
  completed months;
- completed-month completeness: whether a finished month holds the evidence its
  cash accounts and scheduled recurring occurrences require, judged separately
  from reconciliation, whose figures it does not change;
- the large-unclassified advisory: a finished month is flagged when it has far
  more unexplained spending than its own recent history;
- the possible-missing-conversion advisory: when one currency gained cash
  nobody recorded and another lost about as much in the same month, the month
  suggests the cross-currency transfer that would explain both.

Both advisories sit beside the figures and change none of them. Monthly can hide
an advisory for that month and show it again; that is presentation and review
state only, and changes neither the reconciliation nor any financial record.
There are no corrective actions on an issue yet.

In production, the Monthly foundation consumes part of this through one
composite read: a month's reconciliation, reporting-currency figures and
completeness. The rest, such as recording flows and recurring templates, has no
user interface yet.

### Remaining Phase 3

Phase 3 is **in progress**, and is neither accepted nor frozen. Still to do:

- Monthly Income, Known expenses and Accounts editing, with the existing
  financial actions those sections need;
- the Spending and Income pages;
- bulk history entry and correction;
- the remaining end-to-end journeys and hardening;
- Phase 3 acceptance, deployment and freeze.

## How Vaultide works

- **Monthly snapshots, not transaction bookkeeping.** You enter balances and the
  flows you know about — income, expenses, transfers, contributions. Vaultide
  does not import or categorise bank transactions.
- **Reconciliation infers the rest.** For a finished month, the change in cash
  balances minus the known flows is the spending nobody recorded. It is shown as
  unclassified, with a status that says how much to trust it, rather than being
  hidden or spread over categories.
- **Native currency is authoritative.** Every record keeps the currency it
  happened in. Reporting-currency figures are derived with historical rates and
  say which rate they used; they never replace the native record.
- **Capital movements are not spending.** Transfers between your own accounts,
  investment contributions, loan principal and capital improvements are
  allocations of money, not consumption, and are kept out of the spending
  figures.
- **Unknown is never zero.** A balance nobody entered, a rate nobody stored or a
  month that cannot be reconciled is reported as unavailable with its reason,
  and any total built on it says what is missing.
- **Arithmetic is exact.** Money is decimal end to end; rounding happens only
  when a value is stored or displayed.

The blueprint defines each of these precisely: statuses, issue keys,
reconciliation identities, rate selection and every edge case.

## Architecture

```text
apps/web             Next.js App Router: auth pages, onboarding, settings, shell,
                     dashboard, accounts and account detail, Monthly overview
                     and reconciliation; /api/auth, /api/cron/fx-refresh,
                     /api/health
packages/finance     pure engines — money, dates, FX, Unavailable/Partial,
                     positions and net worth, flow roles, recurrence,
                     completed-month, month-to-date and span reconciliation,
                     savings, reporting-currency figures, rolling averages,
                     the two reconciliation advisories, completed-month
                     completeness
packages/validation  Zod primitives and inputs shared by client, server, database
packages/db          Drizzle schema, migrations, RLS policies, repositories, seed
packages/application use cases: auth and sessions, mailer, settings, FX service,
                     positions and valuations, quick update, net-worth reads,
                     flows, recurring templates and suggestions, every
                     reconciliation, completeness, savings, reporting and
                     rolling read, and the Monthly composite read with its
                     review state
packages/config      tsconfig, ESLint (incl. the money-coercion rule), boundaries
e2e                  Playwright: smoke, the auth and settings flow, the
                     accounts, balances and net-worth journey, and the Monthly
                     journey
scripts/db           role bootstrap, local PostgreSQL, currency reconciliation,
                     live environment and financial-invariant checks
scripts/backup       dump → verify → encrypt
```

Module boundaries (blueprint section 19) are enforced by `dependency-cruiser` in
CI: `finance` is pure and performs no IO, `apps/web` never reaches the database,
and only `application` sees `db`, `finance` and `validation` together.

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
[`docs/ops/secrets.md`](docs/ops/secrets.md); the full environment is in
[`docs/ops/environment-setup.md`](docs/ops/environment-setup.md).

## Verification

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

## Backups

```bash
DATABASE_URL_BACKUP=... BACKUP_AGE_PUBLIC_KEY=age1... pnpm db:backup
```

Dumps as `app_backup` (`SELECT` only, `BYPASSRLS`), verifies every table's row
count against the live database, then encrypts with `age`. A dump that an RLS
policy filtered can never pass verification. Restoring is documented in
[`docs/ops/restore.md`](docs/ops/restore.md).

## Design and engineering docs

- **Semantic authority:** [`docs/implementation-blueprint.md`](docs/implementation-blueprint.md)
  (frozen, v2.1.15). When the code and the blueprint disagree, the blueprint is
  corrected or the code is — never silently either.
- **Implementation decisions:** [`docs/adr/`](docs/adr/) —
  [Phase 0](docs/adr/0001-phase-0-implementation-decisions.md),
  [Phase 1](docs/adr/0002-phase-1-implementation-decisions.md),
  [pre-Phase-2 gates](docs/adr/0003-pre-phase-2-security-and-cost-gates.md),
  [Phase 2](docs/adr/0004-phase-2-implementation-decisions.md),
  [Phase 3](docs/adr/0005-phase-3-implementation-decisions.md) (written against
  blueprint v2.1.6 and deliberately left at that baseline).
- **Evidence for frozen phases:**
  [`docs/phase-0-acceptance.md`](docs/phase-0-acceptance.md),
  [`docs/phase-1-acceptance.md`](docs/phase-1-acceptance.md),
  [`docs/phase-2-acceptance.md`](docs/phase-2-acceptance.md).
- **Operations:** [`docs/ops/`](docs/ops/) — environment setup, secrets and
  roles, restore procedure and restore log.

## Engineering invariants

- **Money is exact.** `NUMERIC(24,8)` in PostgreSQL, `Decimal` at 40 digits in
  the domain, decimal strings across the wire, display formatted from those
  strings. Financial arithmetic and displayed money never pass through a
  JavaScript `number`; a lint rule fails the build if they try. The one
  exception is chart geometry under `components/charts/`, where a pixel is not
  a figure and every number a person reads still comes from the exact string.
- **Time is injected.** No engine reads the clock. "Today" is computed once per
  request in the user's timezone, so month boundaries are testable and no record
  can be dated in the future.
- **Unknown is a value.** A figure that cannot be computed is `Unavailable` with
  a reason, never `0`; an aggregate missing a part says so.
- **Financial writes re-check the session.** Every state-changing financial
  action revalidates the session against the authoritative store before it
  writes. The signed cookie cache can render a page; it cannot authorize a
  mutation, so a session revoked moments ago cannot spend its remaining cache
  window changing money.
- **The database fails closed.** Row-level security denies when no user context
  is set, the runtime role cannot bypass it or run DDL, and only the backup role
  — used by one workflow — can read across tenants.
- **Jobs cannot see tenants.** The daily exchange-rate refresh runs with no user
  context, so every user-owned table returns nothing to it; it maintains the
  supported currency set from a global table rather than from anybody's data.
- **Crypto is not a currency.** The catalogue holds fiat and official currencies
  the rate provider publishes, and nothing else. A crypto holding will be an
  investment priced in the currency its broker reports.
