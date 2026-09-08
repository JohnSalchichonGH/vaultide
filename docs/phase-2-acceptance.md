# Phase 2 acceptance record

Evidence for every acceptance criterion in blueprint §25 (Phase 2) and §26.
Recorded 2026-09-08, on branch `main`, on top of the Phase 1 checkpoint
(`a506e66`). Phase 3 has not been started.

Phase 2 delivers the first real financial state in Vaultide: the unified
`positions` supertype with cash accounts and other assets, the unified
`position_valuations` table, the audit trail, the freshness and net-worth
engines, and the pages that make them usable — accounts, account detail with
its balance history, quick update, onboarding step 4 and a dashboard v0.

The two things Phase 2 exists to get right are stated once here and are what
most of the evidence below is about:

- **A missing value is missing, never zero.** A tracked asset nobody has valued
  makes every total containing it `partial`, and the total says which position
  is not inside it and why. A conversion with no rate does the same. Nothing
  anywhere substitutes a zero for an unknown.
- **A statement month-end balance exists only once its month has ended** — not
  on the month's last day — and no actual record may be dated after the user's
  local today. Both are enforced in the application and the domain, never by a
  database constraint, because neither is a timeless property of a row.

---

## §26 — the Phase 2 gate

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | No future-dated balances | **PASS** | `positions.test.ts` → *refuses a balance dated tomorrow, even though the database would take it* and *refuses a future-dated balance*: the service is called directly, with no schema and no browser in the way, and refuses with `VALIDATION_ERROR`. `phase2-rls.test.ts` → *does allow a valuation dated in the future, because the database is not the authority* records the deliberate division of labour. In the browser, `accounts.spec.ts` asserts the date control carries `max=<today>`. |
| 2 | Month-end balances only once the month has ended (not on its last day), server-enforced | **PASS** | `positions.test.ts` → *refuses a September month-end balance on 30 September — even server-side* (the call **is** the bypass: no client, straight into `recordValuation`), and *accepts it on 1 October*. Unit: `positions.test.ts` → *refuses to call September closable on any day of September*, including the 30th. End to end: `accounts.spec.ts` → *offers no statement balance on 30 September, and offers one on 1 October*, driven by the `TEST_CLOCK` header across the boundary. |
| 3 | Last-day snapshots confirmable as statement balances afterwards | **PASS** | `positions.test.ts` → the 30 September snapshot is confirmed on 1 October, its `date_precision` becomes `month_end`, **the amount is untouched**, and the audit row's `changed_fields` contains `datePrecision`. `accounts.spec.ts` clicks the confirmation in the browser and asserts the history row becomes "Statement balance" and the month leaves the awaiting-statement list. |
| 4 | First-balance marking | **PASS** | Unit: `positions.test.ts` → *marks a pre-existing account first tracked this month as first_balance*, with `included = false`. Service: `positions.test.ts` → the DTO carries `firstBalance: true` for the month and `false` for the next, ordinary month. Browser: `accounts.spec.ts` → *a pre-existing account's first balance is marked as such* — the note on the detail page and the chip in the accounts table. |
| 5 | Multi-currency cash total with partial markers | **PASS** | Golden `multi-currency` with the hand computation in its README: EUR 8,055.00 + USD 3,000.00 ÷ 1.1596 = 10,642.10 at 31 August, and Friday's rate on a Sunday with `exact = false`. With no rates at all the total is **`partial`**, its value is exactly EUR 8,055.00, and `missing` names the US account with reason `fx_missing` **and its native USD 3,000.00**. `positions.test.ts` reproduces both against a real database and a stubbed outage, and asserts the native data is untouched by the failure. |
| 6 | Other-asset inclusion affects only financial net worth | **PASS** | Golden `complex-user`: total 33,055.00, financial 13,055.00, difference exactly the excluded car. Turning the flag on leaves **total unchanged** and makes financial equal it. Property test 20 asserts `financial = total − excluded` for random balance sheets. `positions.test.ts` proves the same through the services; `accounts.spec.ts` proves it in the browser. Structurally, the flag exists on `other_assets` and on no other table (M15). |
| 7 | Audit on valuation edit | **PASS** | `positions.test.ts` → *updates in place, with a before-image and a version check*: the audit row carries `before.amount = 8000.00000000`, `after.amount = 8055.00000000` and `changed_fields` containing `amount`. Deletion keeps the full before-image with `after` null. `phase2-rls.test.ts` → `app_user` may INSERT and SELECT `audit_entries` and is refused UPDATE and DELETE by privilege, so the role that deletes a balance cannot erase the record of it. |
| 8 | Closing rules | **PASS** | `positions.test.ts` → closing an account that still holds a balance is refused with `IMPOSSIBLE_OPERATION` and a message naming what to do instead; closing after a final zero balance succeeds and the position then contributes nothing. Deleting a position with history is refused; deleting one without history succeeds (and the database refuses it independently — `phase2-rls.test.ts` → *is refused while it has valuations, and allowed once it has none*). |
| 9 | Cross-user access returns not found | **PASS** | `positions.test.ts` → *answers NOT_FOUND for every read and every write with the other user's id*: detail, history, record, correct, delete, remove and update, each with user B's session and user A's ids. A's records are then asserted unchanged, and B's own view is empty. |
| 10 | RLS denies on missing and empty GUC without errors | **PASS** | `phase2-rls.test.ts` runs all six cases of 17.4 against **each** of `positions`, `cash_accounts`, `other_assets`, `position_valuations` and `audit_entries`, as raw SQL under `app_user`: GUC missing → 0 rows, no error; GUC empty → 0 rows, no error; GUC = A → only A; GUC = B → only B; a forged insert fails `WITH CHECK`; the policy cannot be disabled. `phase1-rls.test.ts` additionally asserts the set of tables with RLS is **exactly** the set of user-owned tables, so a new table cannot ship without one. |

### The §25 acceptance bullet, item by item

| Statement | Evidence |
|---|---|
| a balance cannot be dated tomorrow | §26 item 1 |
| neither on 6 Sep nor on 30 Sep does the current month offer a month-end column | `positions.test.ts` → *offers no month-end surface for a month that has not ended*: `monthsAwaitingStatement` excludes September on the 30th. `accounts.spec.ts` asserts the section is absent in the browser. |
| on 1 Oct it does, and the 30 Sep snapshot can be confirmed as the statement balance | §26 items 2 and 3 |
| a bypassed request with `month_end` precision on 30 Sep is rejected by the server | §26 item 2 — the integration test calls the service directly |
| a pre-existing account's first balance is marked "first balance" | §26 item 4 |
| two accounts in EUR and USD total correctly, with a partial marker if USD rates are missing | §26 item 5 |
| a car excluded from financial net worth changes total but not financial net worth | §26 item 6 |
| editing a past balance produces an audit row | §26 item 7 |
| closing an account with a non-zero balance is refused with guidance | §26 item 8 |

---

## Test results

Run locally on 2026-09-08 against PostgreSQL 18 (the version Neon runs) and a
production build of the web app.

| Suite | Command | Result |
|---|---|---|
| Lint + money rule | `pnpm -r run lint` | **pass**, 6 packages |
| Module boundaries | `pnpm run lint:boundaries` | **pass** — no violations, 232 modules, 665 dependencies |
| Types | `pnpm -r run typecheck` | **pass**, 6 packages |
| Unit + property | `pnpm -r run test:unit` | **247 passed** — finance 177, application 36, validation 16, web 15, db 3 |
| Integration (db) | `pnpm --filter @vaultide/db run test:integration` | **113 passed** (7 files) |
| Integration (application) | `pnpm --filter @vaultide/application run test:integration` | **119 passed** (5 files) |
| Finance coverage gate | `vitest run --coverage` | **pass** — statements 99.66 %, branches 98.26 %, functions 100 %, lines 99.80 %; §21's gate is ≥ 95 % lines and branches |
| Build | `pnpm run build` | **pass** — 21 routes |
| End to end | `pnpm test:e2e` | **51 passed** — 17 specs × chromium desktop, webkit desktop, chromium mobile, against the FX fixture and no public network |
| Real provider (separate, serial) | `pnpm test:live` | **6 passed** against the live Frankfurter v2 |
| Secret scan | `gitleaks --config .gitleaks.toml` | **pass** — 34 commits scanned, no leaks |
| Currency reconciliation | `pnpm db:verify-currencies` | **pass** — 150 = 150, in sync with the live approved chain (`ECB -> BDI`) |
| Fresh database from zero | `fresh-database.test.ts` (inside the db suite) | **pass** — admin bootstrap → migrations as `app_owner` → currency seed → role assertions, against a schema that now has five more tables |

Phase 2 adds 70 unit and property tests to `finance`, 52 raw-SQL database
tests, 37 application integration tests, 5 action-registry tests in `apps/web`
and 4 end-to-end scenarios (12 runs across the browser matrix).

---

## What was built

### Schema (migrations `0004`, `0005`)

| Table | Notes |
|---|---|
| `positions` | The supertype (D1). `UNIQUE (id, user_id)` and `UNIQUE (id, user_id, kind)` — the targets of the composite and **typed** foreign keys of 6.1. Static CHECKs only: closing date not before opening, a closed position has a closing date. Index `(user_id, kind, status)`. **No inclusion flag** (M15). |
| `cash_accounts` | `position_id` primary key; constant `kind` pinned to `'cash'` by CHECK; composite FK `(position_id, user_id, kind) → positions`. `is_dormant`. |
| `other_assets` | Same pattern on kind `other_asset`. Carries **`include_in_financial_net_worth`** — the only inclusion preference in the whole schema. |
| `position_valuations` | `UNIQUE (position_id, valued_on)` (M1); composite FK `(position_id, user_id) → positions` with `NO ACTION`; the **timeless** month-end date-shape CHECK; indexes `(position_id, valued_on DESC)` and `(user_id, valued_on)`. No currency column: a valuation inherits its position's (R4). |
| `audit_entries` | 6.2 as written. Insert-only for the runtime by privilege, not by convention. |

Seven new PostgreSQL enums: `position_kind` (all five values — the shared
structural piece later phases extend), `position_status`, `cash_account_type`,
`other_asset_type`, `valuation_source`, `date_precision`, `audit_action`.

Migration `0005` adds the `updated_at` triggers for the four mutable tables and
revokes `UPDATE`, `DELETE` and `TRUNCATE` on `audit_entries` from `app_user`.

`USER_OWNED_TABLES` now lists eight tables. The Phase 1 deletion test compares
that list against the live schema, so a table added without being listed fails
the suite rather than quietly surviving an account deletion; the Phase 1 auth
test's deletion assertion was rewritten to be driven by the same list rather
than by three hard-coded names.

### Packages

| Package | Added |
|---|---|
| `finance` | `positions/{types,valuation,cash-state}.ts` — position values with their freshness states and the seven cash month states of 8.1; `networth/{types,engine,series}.ts` — total and financial net worth in one pass, aggregates carrying availability and what is missing, and the month-end series with its provisional point. Golden fixtures `simple-user`, `multi-currency`, `complex-user`, each with a README containing the hand computation. |
| `validation` | `inputs/positions.ts` — account, asset, valuation, close, archive and quick-update schemas, with the date rules built from `ctx.today`; the Phase 2 enums. |
| `db` | `schema/{positions,cash-accounts,other-assets,position-valuations,audit}.ts`; `repositories/{audited,positions,valuations}.ts`; `loadFinancialWindow`. |
| `application` | `positions/{types,mapping,queries,service,valuations}.ts` — the DTOs, the row↔engine boundary, the read services and every Phase 2 mutation. `defineAction` now accepts a schema **factory** so a financial action's schema can be built from the request's `today`. |
| `apps/web` | `(app)/dashboard`, `(app)/accounts` (with the other-assets tab) and `(app)/accounts/[id]`; `components/finance/{freshness-badge,aggregate-figure}.tsx`; `components/charts/net-worth-chart.tsx`; `features/accounts/{account-forms,valuation-editor,quick-update}.tsx`; `server/actions/positions.ts`; onboarding step 4. |

No dependency was added or changed in Phase 2.

### Financial semantics actually implemented

**Position value at a date** (12.1). The latest valuation on or before the
date, never flow-adjusted, with an explicit state:

| State | Meaning |
|---|---|
| `exact` | A valuation dated exactly that day. |
| `carried` | An older valuation, carried forward, with its age and its date. |
| `opened_zero` | The account opened empty on a known date and nothing has been recorded since. Zero because the user said so at creation. |
| `closed` | Closed on or before the date; contributes nothing after. |
| `not_yet_tracked` | Not on the balance sheet yet (12.3 `t_start`). Left out of totals entirely rather than counted as missing — which is what keeps a historical series from being "partial" for every month before an account was added. |
| `missing` | Tracked, and no value on record at all. **Never zero.** |

**Freshness thresholds were not invented.** 12.6 and 8.5 define staleness
thresholds only for investments (`stale_investment_months`) and properties
(`stale_property_months`), which arrive in Phases 4 and 6. Phase 2 exposes the
age of every value, the state above, and the month states below — and no
threshold of its own.

**Cash month states** (8.1), built and tested here, consumed by Phase 3:
`month_end`, `closed_zero`, `dormant_zero`, `carried`, `missing` for a close;
plus `opened_zero` and `first_balance` for an opening. Only a `month_end`
valuation closes a month; an ordinary snapshot dated the last day does not
(8.8).

**Net worth** (12.1, R18, R25). Every position signed by `netWorthSign` — no
branch anywhere says "if it is a debt, subtract" — converted at the **as-of
date's** rate (10.3), and summed twice from the same pass: over everything
(total) and over everything except excluded other assets (financial). An
aggregate is `available`, `partial` or `unavailable`, and carries the list of
what is not inside it with each reason and native amount.

**Quick update** (15.3) writes ordinary `exact` valuations dated **today** —
there is no date field and none can be supplied — through the same repository
as every other balance. A position that already has today's balance is
corrected rather than duplicated (M1), which touches today's row and no other.
The submission is one transaction: 20.3 has a bulk save abort entirely on any
conflict, and a half-applied balance sheet is exactly the state that would make
a net-worth figure quietly wrong.

**Nothing is derived into a column.** There is no current-balance field, no
running total and no cached net worth. Correcting a six-month-old balance
simply changes what every later figure reads.

### RLS and role evidence

`phase2-rls.test.ts`, raw SQL as `app_user` with no ORM in the way:

- the six cases of 17.4 on each of the five new tables;
- a valuation pointing at the other user's position is refused by the composite
  foreign key — the database, not RLS, saying no;
- a subtype attached to a position of the wrong kind is refused by the typed
  foreign key;
- one valuation per position per date, and a month-end balance dated anything
  but the month's last day is refused;
- every required column rejects a NULL and every enum column rejects an unknown
  value;
- deleting a position with valuations is refused (`NO ACTION`), and allowed once
  it has none;
- `DELETE FROM "user"` empties all five tables for that user and touches
  nothing of the other's;
- `app_backup` reads every tenant's rows in each table and can write to none;
- `app_user` still cannot create a table, alter one, or grant itself
  `BYPASSRLS`.

And one assertion about the schema as a whole: **no CHECK constraint anywhere
references `now()`, `current_date` or any other moving clock** (6.1, M5). A
constraint that changed its verdict on a row that never changed would also make
a restored backup unrestorable.

### Authoritative-session evidence (ADR 0003)

Every Phase 2 mutation is declared with `financialAction`, whose context comes
from `requireAuthoritativeSession` — the session store, not the five-minute
signed cookie cache.

Three independent proofs, because convention is not one:

1. **Enumeration.** `apps/web/test/financial-actions.test.ts` reads the action
   modules and lists every exported action. An action declared with the
   ordinary `action` wrapper fails the suite unless it is named in
   `NON_FINANCIAL_ACTIONS` — a visible, reviewable line in a test rather than an
   invisible omission in a branch. It also asserts that `financialAction` wires
   `requireAuthoritativeSession`, that `action` does not, and that
   `requireFreshSession` appears in neither (it answers a different question and
   would accept a session revoked one second after it was created).
2. **The primitive.** `security.test.ts` (Phase 1) → a revoked session is
   refused by `requireAuthoritativeSession` immediately, while Better Auth's own
   authoritative read returns `null` for the same cookie.
3. **The wrapper, writing.** `security.test.ts` (Phase 2) → *refuses the
   financial wrapper the moment the session row is gone, while the ordinary one
   still answers*: two `defineAction`s over the same handler, wired exactly as
   `define.ts` wires them, one financial and one ordinary. After the session
   rows are deleted from another context, the financial one returns
   `AUTH_REQUIRED` and **no account is created**, while the ordinary one still
   completes from the cookie cache — the documented trade for a preference, and
   exactly why a balance may not use it.

---

## Deviations from the blueprint, and why

None changes the architecture, the accounting model, the schema semantics or
the roadmap.

1. **`audit_entries` lands in Phase 2, not Phase 1.** §25 lists "audit helpers"
   under Phase 1's backend bullet and 6.2 defines the table; Phase 1 shipped
   without either, and §26's Phase 2 gate requires "audit on valuation edit". It
   is built here exactly as 6.2 defines it. Not a change to the blueprint — work
   that moved one phase later than the roadmap's prose implied.

2. **The dashboard's twelve-month chart is inline SVG, not Recharts.** 16.3
   specifies Recharts wrapped in `components/charts/*` with a table alternative
   under every chart. Phase 2 needs "a 12-month chart" (§25) and Phase 8 is
   where the charting layer is actually built, so this is a self-contained SVG:
   no dependency to pin now, nothing to migrate later, and the accessibility
   contract 16.3 asks for is already met — `role="img"` with a summary sentence,
   plus the "View as table" alternative carrying every figure exactly. Partial
   and provisional points are drawn hollow (16.2, 15.4). Phase 8 replaces it
   with the Recharts wrapper.

3. **Quick Update is atomic.** 15.3 describes the modal but not what happens
   when one entry conflicts. 20.3 says a bulk save "aborts entirely on any
   conflict"; quick update is the same shape of write, so the same rule applies.
   Chosen deliberately rather than inventing silent partial writes.

4. **Onboarding step 4 is the first cash account.** §25 assigns no onboarding
   step to Phase 2 explicitly, and 15.2 says the wizard has "steps 1–10 of spec
   §90, skippable". Phase 1's own record left steps 4 onwards "to the phases
   that give them something to ask about", and Phase 2 is the phase that gives
   this one something to ask about. The wizard is still marked complete by step
   3, so step 4 is skippable exactly like the others, and balances entered there
   are dated today with `exact` precision (15.2).

5. **A narrow ESLint carve-out for chart coordinates.** 7.1.1 says charts
   "receive `Number(amount)` for coordinates only" and scopes the money lint
   rule to `finance`, `application`, `db` and the format module. This repository
   applies the rule to the whole web app, which is stricter than the blueprint
   asks — so the one coercion the blueprint explicitly allows needs an exception,
   scoped to `src/components/charts/**` and nowhere else. Every figure a person
   reads in those files still comes from `MoneyText` and the exact decimal
   string; only pixel geometry passes through a number.

### Corrections made to Phase 0/1 material

None weakens an assertion.

- **`0003_snapshot.json` had the same `id` as `0002_snapshot.json`.** Migration
  `0003` was hand-written and its meta snapshot was copied wholesale, so
  drizzle-kit refused to generate any further migration ("pointing to a parent
  snapshot … which is a collision"). Given a fresh id and the correct `prevId`;
  the journal, which is what the migrator reads, was already correct and is
  unchanged.
- **The Phase 1 account-deletion assertion listed three tables by name.** It now
  derives the expectation from `USER_OWNED_TABLES`, so it grows with the schema
  instead of going stale. Strictly stronger.
- **The smoke suite's phase badge** and **the Phase 1 onboarding walk** were
  updated for text and a step that genuinely changed. The onboarding scenario
  now walks step 4 and skips it; the sign-in landing assertion moved from
  `/settings/profile` to `/dashboard`, because Phase 2 gives the application a
  home page. Both remain exactly as specific as they were — the defect they
  were tightened for in Phase 1 (a sign-in that always went to the wizard) would
  still fail them.

---

## Defects found and fixed while implementing Phase 2

- **Summing converted amounts was order-dependent in the fortieth digit.** A
  property test comparing a net worth computed from positions in two different
  orders failed on an exact string comparison. The cause is real and is not a
  bug in the test: `USD 3,000 / 1.1596` does not terminate, so it is held to 40
  significant digits, and decimal addition stops being associative once a value
  has been rounded to any precision at all. Fixed by construction rather than by
  loosening the assertion — contributions are now summed in a canonical order
  (by position id), so the same balance sheet produces the same number whatever
  order the rows came back from the database in.

  The related invariant, `financial = total − excluded`, is asserted **exactly**
  where no division is involved, and to 10⁻²⁵ of a unit where a rate is — which
  is twenty-three orders of magnitude below the smallest amount the database can
  store. Asserting exact string equality there would have been asserting
  something arithmetic cannot deliver.

- **The "first balance" chip hid the month-closed state.** The badge rendered
  either "First balance" or "September closed", so a pre-existing account whose
  first statement balance had just been entered showed only the former — and the
  user could not see that the month was closed. Both facts are true and both
  matter; they are now rendered side by side. Found by the end-to-end month-close
  scenario, which asserted the closed state and got the first-balance chip.

---

## Open items (none blocks the Phase 2 checkpoint)

1. **`loadFinancialWindow` has no lower date bound.** It loads every valuation
   dated on or before the as-of date, deliberately: a position's value is its
   *latest valuation on or before* a date, so a window starting at `from` would
   turn a balance carried from before the window into "missing" — the one thing
   this engine must never do. At the scale of 23.1 (≈ 10k valuations over thirty
   years) this is a single indexed scan. When a lower bound becomes worth having
   it has to arrive together with a per-position "latest before `from`" query,
   not without one.

2. **Onboarding steps 5–11** still return 404, which remains honest.

3. **First restore drill** is a Phase 7 acceptance criterion (§22.5) and stays
   scheduled. The backup side is proven end to end.

4. **The `data` settings page still has no export.** Export is a Phase 7
   deliverable (18.3).
