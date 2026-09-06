# ADR 0001 — Phase 0 implementation decisions

**Status:** accepted · **Date:** 2026-09-06 · **Phase:** 0

The blueprint (`docs/implementation-blueprint.md`, frozen v2.1.2) is the
authoritative specification. This record covers only the implementation-level
choices Phase 0 had to make that the blueprint left open (section 29.2), and the
two places where the framework forced a small deviation from the literal text.
Nothing here changes the architecture, the accounting model, the schema
semantics or the roadmap.

## Decisions inside the space 29.2 leaves open

### 1. No Turborepo yet

Section 19 lists a `turbo.json`, and 29.2 explicitly leaves "`turbo` usage" to
implementation. With five workspace packages and a build measured in seconds,
`pnpm -r` is enough and one fewer moving part. Revisit when a full CI run
exceeds a few minutes.

### 2. Workspace packages are consumed as TypeScript source

`@vaultide/*` packages export `./src/*.ts` and `apps/web` lists them in
`transpilePackages`. There is no per-package `dist`, so there is no stale build
to reason about, and the type-checker sees the real source. The Next build and
`tsc --noEmit` per package are the compile gates.

Consequence: relative imports inside packages are extensionless. Turbopack does
not map a `.js` specifier onto a `.ts` file, and the packages are consumed by
bundlers (Next, Vitest) rather than by bare Node.

### 3. The exact formatter lives in `finance/client`, re-exported by the app

Section 7.1.1 places `formatMoney` in `apps/web/src/lib/format.ts` and says it is
"shared with `finance` explanations". `finance` may not import the web app
(section 19), so the implementation lives in `@vaultide/finance/client` — the one
finance entry point the app may import — and `apps/web/src/lib/format.ts` is the
app-facing module that re-exports it and runs the startup self-test. Both the
UI and future engine explanations format through the same code.

### 4. `PartialValue<T>` rather than `Partial<Money>`

Section 7.6 names the partial-aggregate type `Partial<Money>`. `Partial` is a
TypeScript built-in, so shadowing it would be a trap. The type is
`PartialValue<T>`; the semantics are unchanged.

### 5. `allocate` takes the currency's minor units explicitly

Section 7.6 writes `allocate(m, weights[])`. A largest-remainder split needs the
quantum it is splitting into, and `finance` has no currency table (minor units
live in the `currencies` row). The signature is
`allocate(money, weights, minorUnits)`; callers pass the value they already read
from `currencies`.

### 6. Local PostgreSQL without Docker

Section 22.2 offers "Docker Postgres 16 or a personal Neon branch" for local
work. `pnpm db:local start` adds a third option: a throwaway PostgreSQL 16
cluster under `.vaultide-pg/`, loopback-only, scram-authenticated, so the
integration, role and backup suites run on a machine with neither Docker nor a
Neon branch. CI still uses a `postgres:16` service container.

### 7. `age` encryption through its JavaScript implementation

Section 22.5 specifies `age`. The backup script uses the `age-encryption`
package rather than the `age` binary, so the job is identical on a developer
machine and on a runner with no extra installation. The output is a standard age
archive, decryptable by the `age` CLI — the restore runbook uses the CLI.

### 8. Currency seed and `is_fx_supported`

Section 6.2 seeds "the fiat/official currencies published by the FX provider".
Phase 0 has no FX client yet, so the seed is a committed list: the ECB set the
provider publishes (`is_fx_supported = true`) plus further official currencies
whose minor units the formatter and validators need — CLF and UYW (4), the Gulf
dinars (3), JPY and ISK (0) — marked `is_fx_supported = false`. Phase 1
reconciles the flag with the provider's own list at refresh time. No crypto
codes, per R28.

## Forced by the framework

### 9. `proxy.ts` lives in `apps/web/src/`

Section 19 shows `apps/web/proxy.ts`. Next.js resolves the proxy next to the
`app` directory, and this app uses `src/app`, so the file is
`apps/web/src/proxy.ts`. Same file, same role, the location the framework
requires.

### 10. The landing page is rendered per request

Two reasons, both substantive: a statically prerendered page would bake "today"
in at build time, and it could not carry the per-request CSP nonce the proxy
issues (without which `strict-dynamic` blocks Next's own scripts and the page
never hydrates). `export const dynamic = 'force-dynamic'` — consistent with
23.4, which rules out static/ISR rendering of financial pages.

## Defects found and fixed while implementing Phase 0

- The bootstrap script granted the backup role nothing on the `drizzle`
  migration schema, and no `SELECT` on sequences. `pg_dump` as `app_backup`
  failed outright. Fixed in the bootstrap script (sequences) and migration
  `0001` (the migration schema); the backup test would have caught a regression
  either way.
- The proxy set the CSP only on the response. Next reads the policy from the
  **request** headers to stamp its own scripts with the nonce, so the page never
  hydrated under a strict policy. Fixed; an E2E test asserts hydration by
  driving the theme toggle and the inputs.
- `next start` is incompatible with `output: 'standalone'`; the E2E suite and
  any non-Vercel host run `.next/standalone/apps/web/server.js`, and
  `scripts/prepare-standalone.mjs` copies the static assets in so that artifact
  is complete.
