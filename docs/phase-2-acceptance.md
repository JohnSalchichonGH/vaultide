# Phase 2 acceptance record

Evidence for every acceptance criterion in blueprint §25 (Phase 2) and §26.
Recorded 2026-09-08, on branch `main`, on top of the Phase 1 checkpoint
(`a506e66`). Phase 3 has not been started.

**Phase 2 is deployed in production at <https://vaultide.app>**, with the
migrations applied, the environment and role checks re-run, a verified
encrypted backup of the expanded schema, and — since 2026-09-08 — **the
authenticated journey walked end to end on the production deployment itself**,
on a disposable account with synthetic values, which was then deleted through
the product and the cascade measured.

What that does and does not settle is worth stating plainly. The production walk
proves the **deployed** system: that this schema, these roles, this artifact and
these figures behave as recorded on the real deployment, over representative
end-to-end behaviour. It does not, and could not, independently discriminate
every edge case — some invariants can only be separated from their plausible
wrong implementations by constructing a state that is awkward or unsafe to
produce in production. **Those remain proven by focused automated regressions,
and this record says so at each point where it matters** — most explicitly for
the `confirmUnchanged` gap case in §1 below. See
"[The authenticated production journey](#the-authenticated-production-journey)".

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

## Post-implementation review items

Three points raised in review after the implementation was complete. Two were
already correct and needed proof; one was a defect and was fixed.

### 1. "Confirm unchanged for this month" carried across an unobserved month — **defect, fixed**

8.1 says this action writes a month-end valuation "equal to **the previous
month-end balance**". The implementation instead took the latest valuation on or
**before** the previous month end, of any precision. Those agree whenever the
previous month is closed, and diverge when it is not.

Reproduced against a real database before changing anything: an account with a
31 July statement balance of 8,000 and **nothing at all for August**, confirming
*September* unchanged on 1 October, produced

```
{"valuedOn":"2026-09-30","amount":"8000.00000000","precision":"month_end","source":"confirmed_unchanged"}
```

— a July figure written as September's **statement** balance, across an entirely
unobserved August. Reachable in one click: `monthsAwaitingStatement` listed every
unclosed completed month and offered the action on each without checking the one
before it.

The immediate damage is nil (September's own opening is still `carried`, so the
month stays unavailable), but **October** then becomes reconcilable against an
opening nobody confirmed, and any August movement is silently absorbed into
October's inferred spending — the exact failure C7, F1 and R5 exist to prevent.

**Fix.** `confirmUnchanged` now requires an explicit valuation dated `end(M−1)`
with `date_precision = 'month_end'`, and otherwise refuses with
`INCOMPLETE_DATA` naming the month: *"August 2026 has no month-end balance, so
there is nothing to carry forward. Close August 2026 first, or enter September
2026's statement balance instead."* Deliberately **not** widened to
`closed_zero`, `dormant_zero` or `opened_zero`: those are settled openings with
their own semantics, and a dormant account already carries automatically under
R22 — reading them as a "previous month-end balance" would be a wider definition
than the blueprint gives.

The interface disables the button when the previous month is unresolved, from a
new `canConfirmUnchanged` flag on the month DTO, so the reason is visible before
the click. The server-side invariant remains the authority.

**Proof** — `positions.test.ts`, `"confirm unchanged for this month" (R22, 8.1)`:

| Assertion | Test |
|---|---|
| July closed, August missing → September refused, and **nothing written** (July untouched, version 1) | *refuses September while August has no month-end balance* |
| An ordinary snapshot dated 31 August is not August's statement balance and does not qualify (8.8) | *refuses an unclosed month even when an ordinary snapshot sits on its last day* |
| Once August is closed: succeeds; the new row carries **August's exact native amount** (`8055.55000000`, byte-identical to August's), `source = confirmed_unchanged`, `date_precision = month_end`, version 1 | *succeeds once August is closed, carrying August's exact amount* |
| No earlier valuation mutated — every earlier row keeps its amount and version 1, and carries only its original `insert` audit entry | same test |
| Audit: one `insert` with `before` null and an `after` carrying the amount, source and precision | same test |
| The month then reports `open: month_end`, `close: month_end`, `included: true`, and leaves the awaiting-statement list | same test |
| Refused before September has ended | *refuses to confirm a month that has not ended* |
| Refused with nothing earlier at all | *refuses when there is nothing earlier to carry* |
| A second confirmation of the same month is `CONFLICT_DUPLICATE` (M1) | *refuses a second confirmation for the same month* |
| The DTO marks August eligible and September not, before the button is offered | *tells the interface which months are eligible before it offers the button* |

### 2. Quick Update same-day correction is audited and versioned — **verified**

The correction path goes through `updateValuationIn`, the same repository
function every other balance edit uses, so it takes the same `SELECT … FOR
UPDATE`, the same optimistic version check and the same before/after audit row.
The existing test proved the row count and untouched history; it did not prove
the trail.

**Proof** — `positions.test.ts` → *audits a same-day correction and moves its
version, like any other edit*: today's row is created at version 1; a second
quick update for the same position and date leaves **exactly one** row for that
date, same row id, at version 2; the August row is byte-identical at version 1
and carries only its original `insert`; and `audit_entries` holds
`['insert','update']` for the corrected row with `before.amount =
8120.00000000`, `after.amount = 8130.00000000` and `changed_fields` containing
`amount`. A stale `expectedVersion` aborting the whole submission is proven
separately by *aborts the whole batch on a version conflict rather than writing
half of it*.

### 3. Other-asset inclusion is a timeless classification — **verified**

Confirmed against the schema and the engine: `other_assets` has no effective-date
column, `inFinancialNetWorth` reads the current flag at **every** as-of date, and
`netWorthSeries` recomputes each point from the same records. Toggling therefore
never moves total net worth, moves the whole financial series together, creates
no driver and needs no dated field. Recorded as decision 6 in ADR 0004.

**Proof** — `networth.test.ts` → *reclassifies the whole history when the
inclusion flag is toggled*: across a thirteen-point series, total net worth is
byte-identical at every point; the **historical** 31 August financial point moves
13,055 → 33,055 exactly as the current point does; and 31 July — before the car
was on the balance sheet at all — is unchanged either way.

---

## Test results

Run locally on 2026-09-08 against PostgreSQL 18 (the version Neon runs) and a
production build of the web app.

| Suite | Command | Result |
|---|---|---|
| Lint + money rule | `pnpm -r run lint` | **pass**, 6 packages |
| Module boundaries | `pnpm run lint:boundaries` | **pass** — no violations, 232 modules, 666 dependencies |
| Types | `pnpm -r run typecheck` | **pass**, 6 packages |
| Unit + property | `pnpm -r run test:unit` | **254 passed** — finance 179, application 36, validation 16, web 20, db 3 |
| Integration (db) | `pnpm --filter @vaultide/db run test:integration` | **113 passed** (7 files) |
| Integration (application) | `pnpm --filter @vaultide/application run test:integration` | **123 passed** (5 files) |
| Finance coverage gate | `vitest run --coverage` | **pass** — statements 99.66 %, branches 98.26 %, functions 100 %, lines 99.80 %; §21's gate is ≥ 95 % lines and branches |
| Build | `pnpm run build` | **pass** — 21 routes |
| End to end | `pnpm test:e2e` | **54 passed** — 18 specs × chromium desktop, webkit desktop, chromium mobile, against the FX fixture and no public network. Four assertions were added after the production journey, in the matrix rather than in a unit test, because they are about layout and rendering |
| Real provider (separate, serial) | `pnpm test:live` | **6 passed** against the live Frankfurter v2 |
| Secret scan | `gitleaks --config .gitleaks.toml` | **pass** — 34 commits scanned, no leaks |
| Currency reconciliation | `pnpm db:verify-currencies` | **pass** — 150 = 150, in sync with the live approved chain (`ECB -> BDI`) |
| Fresh database from zero | `fresh-database.test.ts` (inside the db suite) | **pass** — admin bootstrap → migrations as `app_owner` → currency seed → role assertions, against a schema that now has five more tables |

Phase 2 adds 72 unit and property tests to `finance`, 52 raw-SQL database
tests, 41 application integration tests, 5 action-registry tests in `apps/web`
and 5 end-to-end scenarios (15 runs across the browser matrix): the full
journey in two currencies with an excluded asset, an unvalued asset shown as
unknown, the 30 September → 1 October month close, first-balance marking, and
the dormant flag.

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
| `validation` | `inputs/positions.ts` — account, asset, valuation, close and quick-update schemas, with the date rules built from `ctx.today`; the Phase 2 enums. |
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

**Dormant accounts** (R22, 6.2) are the one automatic carry there is: empty,
left open, carried at zero without a monthly confirmation, and excluded from the
quick update. The flag is refused unless the latest balance is exactly zero and
is cleared the moment a non-zero balance is recorded — clearing it does **not**
consume the position's optimistic version, because it is a consequence of a
balance write and must not invalidate an account form somebody has open.

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

## Deployed and verified in production

**Phase 2 is deployed at <https://vaultide.app>, and the deployed commit is
always the head of `main`.**

| Workflow | Run | Commit | Result |
|---|---|---|---|
| CI | `34222434497` | `e738b60` | success — lint/boundaries/types, unit and property, fresh database and roles, build and the browser matrix |
| Deploy production | `34222828114` | `e738b60` | success — **migrations `0004` and `0005` applied as `app_owner`** over the direct endpoint, currency seed, deploy hook |
| Verify environment | `34223083180` | `235bf42` | success — all five jobs |
| Nightly backup (post-Phase-2 schema) | `34223190343` | `235bf42` | success |
| CI | `34223063086` | `235bf42` | success |
| Deploy production | `34223479375` | `235bf42` | success |
| CI | `34224373651` | `0e6d818` | success |
| Deploy production | `34224860011` | `0e6d818` | success |
| CI | `34226911159` | `3371d71` | success — the "confirm unchanged" correction |
| Deploy production | `34227391287` | `3371d71` | success |
| CI | `34235655250` | `4145c5d` | success — the readable exchange rate |
| Deploy production | `34236267774` | `4145c5d` | success |
| Verify environment | `34247793949` | `aaa8a2e` | success — first run with the live financial invariants |
| Verify environment | `34249561967` | `aaa8a2e` | success — the post-deletion reading |
| Nightly backup (post-deletion) | `34249700070` | `aaa8a2e` | success |

The schema migrations landed with `34222828114`; the later runs are the docs,
the ops verifiers, the dormant control and the two corrections the production
journey turned up, each of which went through the same gate. Production has been
green at every step.

One red mark is worth naming rather than leaving to be discovered: run
`34249116215` shows `failure` for the single job "The FX adapter still speaks to
Frankfurter v2", which reached the public rate service and got `request failed`
after 26.8 seconds. That job is deliberately isolated in this workflow so an
upstream hiccup cannot redden a pull request; it passed twelve minutes earlier
in `34247793949` and again afterwards in `34249561967`. It is upstream weather,
not a Phase 2 defect.

### The released commit is the branch

`/api/health` reports the commit the running artifact was built from, so the
question "is production the branch?" has a one-line answer that does not depend
on anybody remembering to look:

```
$ curl -s https://vaultide.app/api/health
{"status":"ok","database":"ok","checkedAt":"2026-09-08T12:14:34.597Z","version":"0e6d818"}
```

That reading is from `0e6d818`; each deployment since has been verified the same
way, and the closing check for this record is stated in the freeze report rather
than here, because a document cannot quote the hash of the commit that contains
it. `deploy-production.yml` builds with `VAULTIDE_VERSION` set to the commit it
is deploying, so a stale artifact would report a different hash rather than
silently serve. The landing page also carries the Phase 2 badge and footer.

### Environment and RLS, against the production database

`verify-environment.yml` run `34223083180` — **all 22 checks passed** as
`app_owner`, and the backup-role job passed live:

- three roles, none a superuser, none able to create roles or databases;
- `app_user` and `app_owner` cannot bypass RLS; `app_backup` can;
- `app_owner` owns the public schema; **6 migrations applied**; 159 currencies
  seeded, CLF present with four minor units, no crypto codes;
- **16 tables**, up from 11;
- `app_user` cannot write reference data, and — new in Phase 2 — **holds only
  the narrowed privileges on `fx_rates` and `audit_entries`**, with a separate
  check that both tables exist, so a migration that had not run would fail here
  rather than pass silently;
- `app_backup` can read every table and write none.

### The invariants a constraint cannot express

Added after the production journey, and run against the live database as
`app_backup` by `verify-environment.yml` (`pnpm db:verify-invariants`). The
schema already enforces one balance per position per day, a month-end balance
that falls on a month end, and a closed position carrying a closing date. It
cannot enforce rules *about other rows*, and those are only true for as long as
the service is the sole writer:

- a closed position closed at **zero** — the latest balance on or before its
  closing date, which is the rule M6 states and no constraint can hold;
- every position and every balance left an **audit row** when it was written;
- every balance belongs to its **position's owner**, and every audit row to the
  same user as its subject;
- every position has a **subtype row of the right kind**;
- no balance is dated in the future, allowing a day for the user's timezone.

The script prints counts and the identifiers of failures — never an amount
belonging to anybody. A `--manifest <prefix>` flag dumps the stored state of
positions by name prefix, which is how the journey above was checked against
what the interface had claimed.

The same run also asserts, from the catalogs, **which tables carry row level
security and which deliberately do not**: the eight user-owned tables each
enable RLS with exactly one policy; the three Better Auth tables carry none,
because a session must be read before anyone knows whose request it is; and any
*other* table with a `user_id` and no policy fails the check, which is the
failure actually worth catching.

### The routes exist and are closed to anonymous callers

```
/dashboard                 307 → /sign-in?next=%2Fdashboard
/accounts                  307 → /sign-in?next=%2Faccounts
/accounts/<uuid>           307 → /sign-in?next=%2Faccounts%2F…
/onboarding/4              307 → /sign-in?next=%2Fonboarding%2F4
/api/test/mailbox          404
/api/test/fx-provider      404
/api/cron/fx-refresh       404   (no bearer secret, and no hint the route exists)
```

The security headers of 17.3 are unchanged and still present on every response:
CSP with a per-request nonce and `strict-dynamic`, HSTS with preload,
`frame-ancestors 'none'`, `X-Content-Type-Options`, `Referrer-Policy`,
`Permissions-Policy`, `Cross-Origin-Opener-Policy`.

### Backup, with the expanded schema

`nightly-backup.yml` run `34223190343`, taken after the migrations:

- `pg_dump -Fc` as `app_backup` over the direct endpoint;
- **row counts verified against the live database, table by table — all 16
  match**, including the five new ones (`positions`, `cash_accounts`,
  `other_assets`, `position_valuations`, `audit_entries`, each 0 = 0 at this
  point) alongside `currencies` 159, `fx_rates` 1,958, `categories` 42;
- 120,543 bytes of dump, encrypted with `age` to 120,759 bytes;
- uploaded to `s3://vaultide-backups-prod/2026/09/vaultide-production-2026-09-08T11-55-22-389Z.dump.age`
  and **read back out of the bucket**, digest
  `fc5b75c0a07edd48bada1a4b3b534a0bcfa7a6ca42a97c59b43bd0b13cdd1ddf` matching
  the one taken at encryption time;
- the Sentry cron monitor checked in `in_progress` then `ok`.

A dump in which every table is empty is refused by the verifier, so "all zeros
matched" could not have passed on its own.

### The authenticated production journey

Walked on <https://vaultide.app> on 2026-09-08, one step at a time, on a
**disposable account with synthetic values** (EUR 1,234.56, USD 2,345.67, other
asset EUR 4,567.89). The server's today was 2026-09-08; reporting currency EUR;
locale `es-ES`. Every figure below was predicted before the page was opened and
then compared, because a number read only after the fact is not a check.

| # | Step | Result |
|---|---|---|
| 1–2 | Sign up, receive the real Resend verification email, verify | from `no-reply@vaultide.app`, subject "Confirm your Vaultide email address", link host `vaultide.app`; not signed in before verifying (`autoSignIn: false`, 17.1), signed in after |
| 3 | Onboarding 1–4 | defaults, then Europe/Madrid, `es-ES`, favourites USD + JPY. **BTC is not offered** (R28). Reporting currency EUR; the empty total renders `0,00 €` and is `available`, not partial — nothing tracked is a complete zero |
| 4–5 | First EUR cash account, `1234,56` typed **with a comma** | native `1234,56 €`, as of 2026-09-08, "Up to date", amber "No month-end balance for 2026-08". Both metrics `1234,56 €`; "Since 2026-08-31: +1234,56 €" — a complete zero baseline, not `—` |
| 6 | Second cash account, **no balance** | Balance `—`, In EUR `—`, "No value recorded". Cash `1234,56 €` + **Partial**, naming the account. "Since 2026-08-31: `—`" — a delta against a partial figure is refused. All twelve month ends went `unavailable`, because an unvalued account is `missing` at every date |
| 7–8 | USD balance `2345,67` | native unchanged; reporting `2018,30 €`; rate `0.8604371020478403028738599208397866115987` USD→EUR on 2026-09-07 through the EUR pivot, "nearest earlier". Both metrics `3252,86 €`, Partial gone, the series refilled |
| 9–10 | Other asset `4567,89 €`, **excluded** | badge "Total only". Total `7820,75 €` = 3252,86 + 4567,89 **exactly**; financial **unmoved** at `3252,86 €`; excluded component `4567,89 €`; the metrics-differ note appeared |
| 11–12 | Turn inclusion **on** | badge flips; **value, date and history unchanged — one row, no dated event**. Total does **not** move; financial rises by exactly `4567,89` |
| 12b | The discriminating test | a second, **past** snapshot dated 2026-08-31 was added, then inclusion toggled off: the **closed month's** financial figure moved `4000,00 € → 0,00 €` while total today stayed put. A dated-event implementation would have left the past alone. See §3 above |
| 13–15 | Quick Update `1300,00` / `2400,00`, other asset **left blank** | "Saved **2** balances dated 2026-09-08" — blank means *keep the last snapshot*, not zero. Cash `3366,47 €`; the USD leg landed on the cent predicted in advance. One row per account, old values **corrected in place**, kind still Snapshot |
| 16 | A past balance, then a correction to it | `2026-07-31` recorded and corrected to `1100,00`. The present did not move; the past did — `2026-07-31 → 1100,00 €` and **`2026-08-31 → 5100,00 €`**. August has no balance of its own for that account, so that figure exists only because the engine carries the July one forward |
| 17 | Confirm the statement balance | kind `Snapshot → Statement balance`; July left the awaiting list; **not one figure moved** — confirming is a precision change, not an amount change |
| 18 | "Unchanged this month" for 2026-08 | new row `2026-08-31 / 1100,00 € / Statement balance · confirmed unchanged` — **July's statement balance**, not today's `1350,00` snapshot. Badge amber → green "2026-08 closed". 2026-09 absent, September not having ended; 2026-06 still disabled — no cascade |
| 19 | Close an account holding `2400,00 US$` | refused: *"This account still holds a balance. Record where the money went — a balance of zero on the closing date — and then close it."* The account stays active |
| 20 | Zero it, then close | **no figure moved**, which is what the zero-balance precondition exists to guarantee. Freshness became "Closed"; the chip fell to "1 of 1 accounts updated this month" |
| 21–23 | Sign out, sign back in | every figure survived the round trip |

Three guards against a second balance for one day were each seen to hold: the
unique `(position_id, valued_on)` constraint, Quick Update correcting in place,
and "Record a balance" refusing outright — *"There is already a balance for
2026-09-08. Edit it instead of adding another."*

The strict previous-`month_end` rule was confirmed in the interface as well as
in the service: every month whose predecessor had no statement balance offered a
**disabled** "Unchanged this month" carrying the tooltip *"Close the previous
month first — this carries its statement balance forward."*

**One thing this journey did not discriminate**, recorded so the evidence is not
read as stronger than it is: at step 18 July's row was simultaneously "the latest
valuation on or before 2026-08-31" and "July's `month_end`", so the pre-fix code
would have carried the same figure. The case that separates them — confirming a
month whose predecessor has no statement balance — is proven by the disabled
control above and by the nine regressions in `positions.test.ts`, which is where
that invariant is actually pinned.

#### FX behaviour observed during the journey

The ECB fixing for 2026-09-08 published **between** step 8 and step 12b. The USD
leg moved `2018,30 € → 2019,69 €` on its own, with the stored native amount
untouched, and the detail page went from `1 USD = 0,860437 EUR on 2026-09-07
(ecb, nearest earlier)` to `1 USD = 0,86103 EUR on 2026-09-08 (ecb)`. Nothing
converted is stored, so the same figures simply read differently once a newer
rate existed — 7.4 and 10.2, seen happening rather than asserted.

### The production database, read back as `app_backup`

`verify-environment.yml` run `34247793949`, job "Financial invariants, live" —
read-only, `SELECT`-only, `BYPASSRLS`. Stored state after the journey:

```
Synthetic EUR checking [cash/EUR] active v1 checking dormant=false
  2026-09-08  1350.00000000  exact      entered              v3
  2026-08-31  1100.00000000  month_end  confirmed_unchanged  v1
  2026-07-31  1100.00000000  month_end  entered              v3
  audit: position_valuations.insert=3 .update=4  positions.insert=1
Synthetic USD checking [cash/USD] closed closed=2026-09-08 v2
  2026-09-08     0.00000000  exact      entered              v3
  audit: position_valuations.insert=1 .update=2  positions.insert=1 .update=1
Synthetic other asset [other_asset/EUR] active v5 custom  include=true
  2026-09-08  4567.89000000  exact      entered              v1
  2026-08-31  4000.00000000  exact      entered              v1
  audit: position_valuations.insert=2  positions.insert=1 .update=4
```

The row versions are the evidence, and they settle two of the three review items
above from the storage side rather than the interface:

- the EUR row for 2026-09-08 is at **v3** from three writes to **one** row —
  entered `1234,56`, Quick Update to `1300,00`, inline edit to `1350,00`. A
  same-day Quick Update correction is an ordinary versioned edit with `update`
  audit rows (§2);
- the other asset carries **four** `positions.update` audit rows — the inclusion
  toggles — and exactly **two** valuation rows, the two balances recorded.
  Toggling inclusion wrote no valuation and no dated event (§3);
- the six `position_valuations.update` rows across both accounts are exactly the
  six corrections made by hand. Nothing wrote silently.

### Account deletion, measured

The disposable account was deleted through the product. A wrong password with
the correct confirmation phrase was refused — *"Invalid password"* — so deletion
re-authenticates rather than trusting the session cookie (18.3).

Production held only that one account with any financial rows, so a **second**
disposable account was created first, holding a single `999,99 €` balance, in
order to measure "another account is unaffected" rather than assume it:

| | before | after | |
|---|---|---|---|
| balances | 7 | **1** | −6, exactly the deleted account's six |
| positions | 4 | **1** | −3, exactly its three |
| owners | 2 | **1** | |
| audit rows | 22 | **2** | −20, exactly its twenty |

The keeper account's balance, version and both audit rows were untouched. All
ten live invariants still held afterwards, which is the check that the cascade
removed whole objects: no orphaned valuation, no subtype row without a parent,
no audit row pointing at a position that no longer exists. Audit rows cascade
from the `user` row by design — erasure means the record of what was erased goes
with it.

### Backup after the deletion

`nightly-backup.yml` run `34249700070`: dump 125,647 bytes as `app_backup`,
every table row count matched live, `age` encryption to 125,863 bytes, uploaded
to `s3://vaultide-backups-prod/2026/09/` despite the 30-day object lock, read
back out of the bucket, digest
`f2f730467afaad2a2a54e173ace86fabfea4467efb0acc88a6f10572a4967bcd` matching the
one taken at encryption time.

Manifest delta against run `34223190343`, taken before the journey:

| Table | before | after | Why |
|---|---|---|---|
| `user`, `account`, `user_settings` | 2 | 3 | +journey account, +keeper, −journey account. Two users predate the journey and hold no positions, which is why the earlier run showed `positions = 0` alongside two users |
| `categories` | 42 | 63 | 21 defaults per user; the deleted account's 21 cascaded away |
| `positions`, `position_valuations`, `cash_accounts` | 0 | 1 | the keeper's only |
| `other_assets` | 0 | 0 | the journey's other asset is gone |
| `audit_entries` | 0 | 2 | the keeper's only |
| `fx_rates` | 1,958 | 2,059 | the 2026-09-08 ECB fixing publishing mid-journey — the same event that moved the USD leg |
| `currencies` | 159 | 159 | reference data, untouched |

ADR 0003 §5 records that immutable backup objects may retain a deleted account
for up to the 30-day retention window. **For this account they retain nothing**:
backups ran at 10:28, 11:54 and 16:13, and the account walked through the journey
was created after 11:54 and deleted before 16:13, so no dump was ever taken while
it held anything. That is a statement about this account only — the keeper
outlived the 16:13 backup, and the final-cleanup section below records what that
archive does contain.

### Final cleanup: removing the keeper, and the state left behind

The keeper account above was created for one purpose — to make "another account
is unaffected" a measurement rather than an assumption — and it was left in place
only long enough to serve as that evidence. It has since been deleted through the
same production account-deletion flow, as have the two older disposable accounts
that predated the journey. The re-authentication guard was exercised and recorded
on the first deletion; the later ones went through the same flow without needing
it demonstrated again.

**No Phase 2 financial data of any kind remains.** `verify-environment.yml` run
`34252956103` on `a20a58d`, all six jobs green, the read-only invariants job
reporting:

```
all ten invariants hold
Checked 0 balance(s) across 0 position(s), 0 owner(s), 0 audit row(s).
Manifest for positions named like Synthetic%:  distinct owners: 0
```

**No synthetic disposable accounts remain either** — nor any account at all.
`nightly-backup.yml` run `34253377859`, taken after the last deletion, verified
every table against the live database:

| Table | Rows |
|---|---|
| `user`, `account`, `session`, `two_factor`, `verification` | 0 |
| `user_settings`, `categories`, `tags` | 0 |
| `positions`, `position_valuations`, `cash_accounts`, `other_assets` | 0 |
| `audit_entries` | 0 |
| `currencies` | 159 |
| `fx_rates` | 2,236 |
| `rate_limit` | 2 |

Reference data only. That run: dump 126,732 bytes as `app_backup`, **every table
row count matched the live database**, `age` encryption to 126,948 bytes,
uploaded to
`s3://vaultide-backups-prod/2026/09/vaultide-production-2026-09-08T16-49-41-831Z.dump.age`
despite the 30-day object lock, **read back out of the bucket**, digest
`32bd877bab60cd51136008d9ba21f978918b8ac9e20d5be4465002bcfb861f99` matching the
one taken at encryption time, and the Sentry cron monitor checking in
`in_progress` then `ok`.

**The retention caveat, stated accurately.** The earlier section records that no
retained backup object ever contained the *first* disposable account's financial
rows, because no dump was taken while it held anything. That is not true of the
keeper: run `34249700070` was taken while the keeper existed, so **that archive
does contain one synthetic position, one `999,99 €` balance and two audit rows**.
It expires under the 30-day retention and bucket lock recorded in ADR 0003 §5 —
the documented consequence of immutable backups, not a failed deletion. The live
database is clean now; that object ages out on its own schedule.

Production and `main` were equal throughout this cleanup, which changed no code:
`/api/health` reported `a20a58d` before and after, matching the head of `main`
with a clean working tree.

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

5. **Archiving was built, then removed.** §25 gives Phase 2
   "create/edit/close cash accounts". Archiving was implemented before that was
   checked and came out again, because there is no correct Phase 2 answer: an
   archived position that keeps counting makes the button meaningless, and one
   that stops counting at every date silently rewrites every past net-worth
   figure. 12.3's "removed from tracking" is the right answer and needs an
   archived-on date the schema does not carry, plus the decomposition Phase 7
   owns. Closing remains the supported, dated way to stop something counting.
   `position_status` keeps its `archived` value because the enum is 6.2's closed
   set. Reasoning in ADR 0004 §5.

6. **A narrow ESLint carve-out for chart coordinates.** 7.1.1 says charts
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

### Found in production, during the authenticated journey

None of these produced a wrong figure. All five are about what the page shows,
which is the half of the product a local test suite is worst at judging — and
four of them only became visible with real data in front of a real person.

- **The exchange rate was dumped, not read.** The account detail page printed
  the engine's derived cross rate at full precision —
  `0.8604371020478403028738599208397866115987` — with no direction and no
  explanation. It is a rate, so it must be *read*: `1 USD = 0,860437 EUR on
  2026-09-07 (ecb, nearest earlier)`, rounded for display at six decimals in the
  user's locale. Only the display rounds; the conversion still multiplies by the
  exact rate, which is why the reporting figure did not move by a cent when this
  landed. Regressions in `apps/web/test/format.test.ts`, including one asserting
  that it is the **rate** that is rounded and never a figure derived from it,
  plus a tightened browser assertion.

- **The chart's plotted points were ovals.** The line is drawn with
  `preserveAspectRatio="none"` so twelve months fill whatever width the card
  has, which scales x and y by different factors: fine for a path, wrong for
  anything with a shape of its own. An SVG `<circle>` came out an ellipse and the
  2px stroke came out thicker one way than the other. The stroke now opts out of
  scaling and the points are drawn over the top in the page's own coordinates.

- **The chart never said which metric it drew.** It plots *financial* net worth
  by design; the metric name lived in the `aria-label`, the `sr-only` caption
  and the table header, so a screen-reader user was told and a sighted user was
  not. Harmless while the two metrics agree, and misleading the moment they
  diverge — which is exactly when the headline above shows two numbers.

- **Total net worth had no change-since line.** The delta was computed and
  carried in the DTO and only the financial one was rendered, so a reader could
  see that total net worth was higher but not what it had *done*. Each metric
  moves for its own reasons; each now carries its own change.

- **The quick-update modal opened in the top-left corner.** A `<dialog>` opened
  with `showModal()` is laid out with `inset: 0` and fit-content sizing and
  centres itself through the user agent's `margin: auto` — which Tailwind v4's
  preflight resets to zero along with every other element's. One class puts it
  back.

The regressions for the last four are in the **browser matrix**, where a layout
fault can actually be observed: a plotted point is as wide as it is tall, the
chart names its metric, the two change lines differ while an asset is excluded
and agree once it is included, and the open dialog's centre is the viewport's.

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

2. **Onboarding steps 5–10** still return 404, which remains honest.

3. **First restore drill** is a Phase 7 acceptance criterion (§22.5) and stays
   scheduled. The backup side is proven end to end.

4. **The `data` settings page still has no export.** Export is a Phase 7
   deliverable (18.3).

5. **Running the integration suites invalidates a hand-made local end-to-end
   credential.** Database roles are cluster-wide, and `provisionDatabase` runs
   the real `bootstrap-roles.sql` with fresh random passwords for each suite —
   which is exactly what makes the fresh-database test meaningful. The
   consequence locally is that a `DATABASE_URL` assembled by hand for
   `pnpm test:e2e` stops authenticating after `pnpm run test:integration`; re-run
   `pnpm db:bootstrap` with the passwords you want before the browser suite. CI
   is unaffected: each job gets its own PostgreSQL service container.

6. **A chart with nothing to draw renders blank, with the reason only in the
   table alternative.** Observed at step 6 of the production journey: adding an
   account with no balance makes every historical point `unavailable`, because
   an unvalued account is `missing` at every date, and the picture goes empty.
   That is the honest consequence — it corrected itself the moment a balance was
   recorded — and no wrong figure is ever shown; the `aria-label` and the "View
   as table" fallback both say `unavailable` for each month, which is what 16.3
   requires. What is missing is an inline note in the picture itself, so a
   sighted user does not have to open the table to learn why it is empty. Left
   for Phase 8, which builds the real charting layer.

7. **Deleting a balance and closing an account are both one click, with no
   confirmation step.** Deleting is audited before and after, and closing
   refuses unless the balance is zero, so neither can lose money silently — but
   Phase 2 has no reopen action, which makes closing effectively one-way from
   the interface. Whether these want a confirmation is a product decision, not a
   defect, and it belongs with the wider destructive-action review rather than
   with a net-worth phase.
