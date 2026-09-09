# Vaultide — Personal Finance Platform Implementation Blueprint (frozen, v2.1.10)

**Status:** Planning deliverable (no code written). Produced 2026-09-06 against the supplied product specification; revised after an adversarial model review, a product-owner review (v2), a targeted consistency pass (v2.1), a defect-fix freeze pass (v2.1.1), four final corrections (v2.1.2) and two narrow post-Phase-2 consistency corrections (v2.1.3, the onboarding step allocation; v2.1.4, one arithmetic slip in the Phase 3 savings golden — neither changed product behaviour, schema, accounting or security semantics), and a pre-Phase-3 clarification pass (v2.1.5, which settles the recurring-occurrence, template-deletion, month-to-date, dormancy, savings-availability and bulk-history questions Phase 3 raised before a line of Phase 3 code was written; it changes the Phase 3 schema and scope and no phase already delivered), extended once more before migration 0006 (v2.1.6, which settles how a recurring template materializes settlement, tightens the occurrence invariant to both-or-neither, and bounds occurrence generation by the template’s own dates), clarified once more before that migration was deployed (v2.1.7, which bounds early materialization to the next unresolved occurrence and separates a template’s schedule from its archive state), corrected once more when the completed-month engine proved one issue predicate impossible (v2.1.8, which reselects the two `unexplained_inflow` variants on the sign of `TrackedTotalSpending`), corrected again where the same engine had to invent a meaning the result shape demanded (v2.1.9, which makes `cashDelta` absent rather than partial when the complete included-account change cannot be computed), and clarified once more before the month-to-date engine was written (v2.1.10, which settles the MTD evidence date, status precedence and result shape that 8.4/8.5/8.6 stated three different ways). None changed an identity, the schema, or a phase already delivered. This version supersedes every earlier version in full; v2.1.2 was the frozen input to Phase 0, and Phases 0–2 were built and frozen against it.
**Audience:** The Claude Code session(s) that will implement the application phase by phase, and the product owner.
**Product name:** **Vaultide**. The repository root is `vaultide/`, workspace packages are published under the `@vaultide/*` namespace, and "Vaultide" is the product-facing name in app metadata, authentication and email branding, and hosting/monitoring project names. Historical local prototype paths quoted in Section 1.3 keep their real on-disk names.

---

## Context

The product specification describes a monthly, snapshot-driven personal-finance platform: users enter balances and known flows, the system infers spending by cash reconciliation, keeps native-currency records with historical FX, separates capital flows from investment performance, splits mortgage payments into interest and principal, explains net-worth changes, and simulates whole-net-worth scenarios. It must be multi-tenant from day one.

This document is the reviewed, corrected blueprint for building it. It audits the specification (Section 2), fixes the points where a literal implementation would produce wrong accounting or a weak architecture (Section 3), then specifies the domain model, schema, algorithms, UX, security, operations, tests and a phased roadmap in enough detail that implementation can proceed without redesign.

**Repository state:** the session workspace is empty. There is no existing code, schema or configuration to preserve. Two older folders exist on this machine (`C:\Projects\Patrimonio`, `C:\Projects\financial-simulator`); their contents are summarized in Section 1.3 and treated only as conceptual input, never as code to reuse.

**Stack (verified major lines on 2026-09-06; at implementation time use the latest compatible patched stable version of each, and pin exact versions only in the lockfile):** Next.js 16.x (the 16 LTS line: App Router, `proxy.ts`, Turbopack, React 19), TypeScript 5, Tailwind CSS 4, shadcn/ui (Base UI primitives are the default since July 2026; Radix remains supported), Drizzle ORM + drizzle-kit (latest stable; `pgTable.withRLS()`, `pgPolicy`, `pgRole`; `numeric` columns return strings by default), Zod 4, Better Auth 1.7.x with `@better-auth/drizzle-adapter`, decimal.js 10, Vitest 5, Playwright 1.6x, pnpm 10, PostgreSQL 16+. Hosting facts used: Vercel cron is once-per-day on Hobby and per-minute on Pro; Neon instant-restore history is 6 h on Free, 7 days on Launch, 30 days on Scale; Sentry offers an EU (Germany) region; Frankfurter v2 exposes ECB reference rates back to 1999 and a broad set of official currencies from other central banks, with no API key.

---

## 1. Executive summary

1. **Architecture.** A pnpm-workspace modular monolith: `apps/web` (Next.js App Router, server actions for mutations, RSC for reads) over four packages: `finance` (pure decimal arithmetic engines, zero IO), `db` (Drizzle schema, migrations, RLS policies, repositories), `validation` (Zod schemas and DTO types shared by client and server) and `application` (use-case services: authorization context, transactions, audit, orchestration). No `packages/ui` initially.
2. **Domain model.** Cash accounts, investments, properties, other assets and liabilities are subtypes of one **`positions`** supertype with one **`position_valuations`** table. Flows are four typed tables: `income_entries`, `expense_entries`, `transfers` (endpoint-typed: contribution, withdrawal, loan proceeds, asset purchase/sale, cash transfer), `liability_payments` (interest/principal/fee split). Dividends, fees, property costs, acquisition costs and **capital improvements** are income/expense entries with a settlement field and a kind-typed category, not separate tables.
3. **Time discipline.** No actual financial record is ever dated after today in the user's timezone. A month's closing balance is the balance **as of the last day of the month**, and it can be written only once the month has ended (from the next local day); a snapshot taken on the last day is an ordinary snapshot until it is confirmed as the statement-end value. Completed months reconcile on month-end balances; the current month shows **month-to-date, provisional** figures through the latest date on which every cash account has a snapshot.
4. **Arithmetic.** PostgreSQL `NUMERIC(24,8)` for amounts, `NUMERIC(24,12)` for FX rates, `NUMERIC(12,8)` for rates as fractions. decimal.js at 40 significant digits in the domain layer; no intermediate rounding; rounding only at persistence of computed schedules and at display, half-up to the currency's minor units. Display formatting never routes money through a JavaScript `number`: decimal strings are formatted exactly. Net-worth mathematics uses an explicit sign per position (assets +1, liabilities −1).
5. **Inferred spending** is the per-currency cash residual for a calendar month: opening month-end cash + inflows − non-expense outflows − closing month-end cash = tracked total spending; minus known tracked expenses = unclassified. A month is `reliable` only with month-end balances at both ends for every participating cash account; a missing month-end makes that month `unavailable`, and a later month-end lets the engine expose a **multi-month reconciliation span** ("combined unclassified spending 1 Sep – 31 Oct") that is never attributed to a single month or averaged. Non-zero accounts are never assumed unchanged; the user confirms unchanged per month with one click; only dormant zero-balance accounts carry automatically. Expenses the user paid from outside tracked accounts are **additional spending**, kept apart from tracked spending; expenses paid by someone else are informational and never enter totals or projection baselines. Savings are defined once (income minus consumption, property costs, interest & fees and transaction costs) so no cost is ever counted twice; the personal savings rate also counts spending the user paid from outside tracked accounts (a default-on preference), so "Total spending" and "Savings rate" stay consistent.
6. **Net worth** comes in two defined metrics: **Total net worth** = all assets and liabilities the user tracks; **Financial net worth** (the headline) = cash + investments + real estate − all liabilities + only those other assets the user includes. Liabilities can never be excluded. Both have exact wealth-change decompositions; buying an excluded other asset is shown as a "purchase of non-financial asset" in the financial decomposition, so the transfer-neutrality invariant is stated for total net worth and the difference is explicit.
7. **Investments.** Native performance `V1 − V0 − C + W + D_paid_out` (gross of external fees); external fees are a separate cost bucket; reinvested distributions are neither income to cash nor performance adjustments. Investments may carry an **opening net invested basis** (capital invested net of withdrawals before tracking began) so gain and return metrics do not treat the first valuation as contributed capital when the basis is known; nothing is ever labelled "lifetime contributions". FX contribution is `V0(r1−r0) + Σ flow(r1−r_flow)`. XIRR only with ≥ 12 months of tracked, dated history and a sign change.
8. **Property.** Capital improvements are capital expenditure: cash leaves, cost basis rises, **market value does not move** until an explicit valuation (or an explicitly entered value-add estimate, labelled as such). Investments remain flow-adjusted while carried; properties are not.
9. **FX.** EUR-pivot daily rates from the ECB via Frankfurter, refreshed daily for the **whole supported fiat set** (no cross-tenant discovery at runtime), cached in `fx_rates` with source and effective date; latest-on-or-before lookup for weekends; monthly arithmetic mean for undated inferred spending; conversions return `unavailable` rather than a guess. Crypto is an investment asset class, not a currency, until a pricing provider exists.
10. **Mortgages.** Versioned `liability_terms`; nominal annual rate / 12; payment suggested from the schedule each month and materialized only on acceptance; balance between confirmations is derived from recorded payments; confirmed actual balances re-anchor the schedule and the difference is a visible "debt adjustment". One `amortizeMonth` implementation serves actuals and projections.
11. **Scenario engine.** A deterministic month loop with a fixed, documented order, per-currency cash buckets with explicit funding rules (obligations in currency X are funded from X cash; simulated conversions only when auto-funding is enabled, at the FX path plus a configured spread; otherwise a currency-specific deficit is reported), one reserve target in the base currency measured over eligible cash without moving any currency, written against a small numeric-backend interface so the same code runs on decimal.js for deterministic runs and float64 for Monte Carlo. Monte Carlo uses a factor model: correlated asset-class factors (explicit positive-semidefinite matrix with a documented illustrative default) plus an idiosyncratic component per investment, so same-class investments co-move strongly but never perfectly. Scenarios are immutable revisions with a frozen starting state; results are disposable cached JSONB.
12. **Security and operations.** Better Auth (email/password, verification, reset, TOTP), sessions in Postgres, origin-checked mutations, per-request `set_config('app.current_user_id', …, true)` inside a transaction with RLS on every user-data table keyed on `NULLIF(current_setting('app.current_user_id', true), '')::uuid`, composite `(id, user_id)` FKs, three database roles created once by a platform-admin bootstrap script (`app_owner` for migrations in CI only, `app_user` for runtime with RLS and no bypass, `app_backup` SELECT-only with `BYPASSRLS` used only by the isolated backup workflow). Vercel (Frankfurt) + Neon (Frankfurt) + Sentry EU; CI-run migrations before deploy; nightly encrypted dumps; quarterly restore drill.
13. **Roadmap.** Thirteen phases (0–12), each a usable vertical slice with explicit acceptance criteria. Cash, income and reconciliation land before investments; liabilities before real estate; the full monthly workflow and historical editing before dashboard/analytics; goals before projections; deterministic projections before comparison; Monte Carlo last.

### 1.1 What the plan changes relative to the specification

Only where a literal reading would produce wrong money or a fragile system (detail in Sections 2–3):

- Principal repayment and investment contributions are **composition changes**, not net-worth drivers (drivers view sums to ΔNW; allocation view shows where savings went).
- External investment fees are counted **once**, in a costs bucket; performance in the decomposition is gross of them.
- A month's spending is **unavailable** without month-end balances at both ends; nothing is assumed unchanged for a non-zero account without an explicit per-month confirmation; multi-month gaps produce a separately reported span.
- No record is ever future-dated; the current month is provisional month-to-date.
- Two net-worth metrics (total and financial); only other assets can be excluded from the financial one.
- Capital improvements raise cost basis, not market value.
- An investment's known pre-tracking net invested capital is an explicit opening basis, not silently equated with the first valuation, and never presented as lifetime contributions.
- Cross-currency transfers have **one reporting-currency value** (from the source leg); the achieved-vs-market spread lands in the FX bucket.
- Snapshots do not store a currency; the position does. One valuation per position per date.

### 1.2 What is explicitly not built yet

Time-weighted returns, benchmarks, imports beyond a full JSON/CSV export, passkeys/social login, stochastic FX/inflation/property, crypto-denominated positions with market pricing, notifications, a public API, household sharing. See Section 29.

### 1.3 Existing local material

Two earlier prototypes exist on this machine. Neither is reused as code; both inform the plan.

- `C:\Projects\Patrimonio\finanzas-personales` (Vite + React, April 2025): a single-file CSV viewer whose 37-column monthly contract is effectively the "existing spreadsheet" the spec refers to. Column groups: date (MM/YYYY); direct income (salary, rent, other, total); passive income / monthly evolution (funds, stocks, crypto, other, total); expenses (fixed, variable, occasional, taxes, other, total); assets (liquid, funds, stocks, crypto, properties, other, total); liabilities (debts, mortgage, loans, other, total); monthly saving & investment (liquid, funds, stocks, crypto, other); metrics (savings rate, liquid, investments, net worth). Totals are stored, not derived, and the app has no persistence. **Consequence:** the deferred spreadsheet importer (Section 29) maps one legacy row per month onto month-end valuations of aggregate positions (one cash position, one investment per legacy asset class, one property, one mortgage), monthly contributions from the "saving & investment" columns, and a salary income entry; legacy expense totals become known expense entries only if the user opts in; the import sets each investment's opening net invested basis (legacy contributions net of legacy withdrawals) when the import starts after the first legacy month, and can later populate separate gross-history fields once those exist (9.3). No data files exist on disk, so nothing is migrated during the phases below.
- `C:\Projects\financial-simulator` (Create React App, February 2025): a deterministic projection prototype (French amortization, salary raise every 12th month, investments compounding monthly with savings added before growth, house appreciation, net worth = investments + house − mortgage). Its weaknesses (inflation applied only to salary, savings as a fixed percentage, mortgage term tied to horizon, contributions earning a full month's return, single currency) are all addressed by the engine in Section 13.

---

## 2. Specification audit

Findings are numbered for cross-reference from the decision log. Severity: **High** = would produce wrong financial results or a security/data-integrity hole; **Medium** = wrong analytics, avoidable rework, or a schema decision that is expensive to change later; **Low** = clarity or polish.

### 2.1 Contradictions

| # | Finding | Severity | Resolution |
|---|---|---|---|
| C1 | §36 says the €235 principal repayment "increases net worth by reducing a liability". At the moment of payment cash also falls by €235, so net worth is unchanged (Invariant 7). Net worth rose earlier, when the €235 was earned and not consumed. Implemented literally, a decomposition would count the same saving twice. | High | Principal repayment is a **composition change** (cash → equity). The net-worth drivers decomposition contains income, spending, interest/fees, revaluations, FX and adjustments; principal and contributions appear only in the "where the savings went" allocation view (R1). |
| C2 | §44 lists "investment contributions" and "mortgage principal reduction" among contributors that must "reconcile to total change". They net to zero against the cash they came from. | Medium | Same as C1: two views (Section 12). |
| C3 | §25 subtracts "external fees" inside investment performance; §17 counts fees "paid from cash" as known expense outflows; §44 then has both an investment-return bucket (already reduced by the fee) and a spending bucket (containing the fee). | High | Single-assignment rule (R2): performance in the decomposition is gross of external fees; external fees form "Interest & fees". |
| C4 | §41 says buying a tracked asset "changes asset composition rather than creating spending" and that acquisition costs "may be" expenses; §29 lists "acquisition costs" and "initial equity/down payment" as property data. | Medium | Acquisition costs are expense entries of kind `acquisition_cost`: reduce net worth when paid, excluded from consumption, included in cost basis. "Initial equity" is derived (R3). |
| C5 | §9 requires each snapshot to store a currency; a snapshot's currency must always equal its account's currency. | Low | Valuations do not carry a currency; the position does. Flow legs carry their own currency (R4). |
| C6 | §61 puts Settings under "System"; §115 under "Planning". | Low | System. |
| C7 | §2.3 permits carrying forward a last-known value "when appropriate"; §20 says a carried-forward unconfirmed cash balance must not count as confirmed; §45 says a stale cash balance "cannot normally" support inference. | High | Defined precisely (R5, Section 8): a non-zero cash account with no month-end balance makes the month `unavailable`; the only automatic carry is for dormant zero-balance accounts; "confirm unchanged" is an explicit per-month action. |
| C8 | §57 says bulk snapshots "may default to the final calendar day of the month", and §50/§58 imply balances can be typed at any time; together they would allow a "30 September" balance to be recorded on 6 September as fact. | High | No actual record may be dated after today (R17). Month-end balances are entered only once the month has ended; through the last day of the month the current month is month-to-date and provisional. |

### 2.2 Financial ambiguities

| # | Finding | Severity | Resolution |
|---|---|---|---|
| F1 | What inferred spending means when a cash balance is missing, stale, or dated mid-month is the largest correctness risk. Treating a stale closing as "unchanged" while income was recorded would report spending equal to income; reconciling a month's flows against a balance taken on the 3rd would report the salary as spending. | High | Month-end balances are the only closing balances; flows are taken by calendar month; a month without month-end balances at both ends is `unavailable`; multi-month spans are reported separately (Section 8, R5, R21). |
| F2 | Negative unclassified spending (cash grew more than explained). | High | Status `unresolved`; total spending shown as "at least the known amount"; issue "unexplained inflow of X" with per-account residual diagnostics. One-click actions create explicit records; nothing is auto-created (R6). |
| F3 | A contribution "may omit its source account" (§38); reconciliation is per currency. | Medium | Every flow leg has a currency even when its position is null; a null leg requires a participating cash account of that currency. |
| F4 | §18: a currency exchange is a transfer, fees are expenses; the bank's achieved rate differs from the ECB mid rate. | Medium | A transfer has one reporting value, from the **source** leg at its dated rate; the spread appears in the destination currency's FX bucket (R7, 12.2). |
| F5 | Dividends: paid to a tracked bank account, to broker cash, or reinvested. | Medium | One `income_entries` row with `settlement ∈ {tracked_cash, reinvested, external}` (R8). `reinvested` is valid only for dividend/interest linked to an investment (schema CHECK + domain rule). `external` on ordinary income means "received outside the tracked balance sheet" (informational only); `external` on a distribution keeps the investment-performance credit and pairs it with an equal external outflow (7.4). Broker cash is a cash account of type `brokerage_cash`. |
| F6 | Investment fees deducted inside the quoted value vs paid from a bank account. | Medium | `expense_entries` of kind `investment_fee` with `settlement ∈ {tracked_cash, deducted_from_asset}` (R8). |
| F7 | Gross vs net salary (§12). | Low | Withholding is never an expense; only net affects cash; gross is analytics metadata; an explicit tax payment from cash is an expense of kind `tax`. |
| F8 | Mortgage balance between confirmations. | Medium | Derived from recorded payments; the schedule only suggests; "accept expected balance" writes a valuation flagged `accepted_expected` (R9). |
| F9 | Recording an investment withdrawal without a new valuation leaves the carried value overstated. | Medium | Investment carried values are flow-adjusted (R10). Properties are **not** (F20). |
| F10 | When a property is revalued after several stale months, in which month is appreciation recognized? | Low | In the month of the new valuation, labelled with the span; annualized appreciation over the span. Stale months show "no valuation", never 0 %. |
| F11 | Month boundaries when snapshot dates are arbitrary (§4, §24). | Medium | For net worth and charts, the value at any date is the latest valuation ≤ that date. For reconciliation, only a valuation dated exactly at month end closes a month (R15). A valuation dated d includes flows dated ≤ d. |
| F12 | "Real / today's money" (§76) needs a base. | Low | Inflation index = 1.0 at the scenario start month, compounding monthly by `(1+π)^(1/12)`. |
| F13 | Annual rates in a monthly engine. | Low | Growth rates convert geometrically; loan interest uses nominal `r/12` (R11). |
| F14 | When is XIRR "sufficient history" (§27)? | Low | ≥ 365 days of tracked, dated history, a sign change, and convergence; otherwise "return since tracking began" (9.5). |
| F15 | Monthly average FX rate (§7.6) is undefined. | Low | Arithmetic mean of stored daily rates in the calendar month; fallback to the latest rate ≤ month end, marked approximate. |
| F16 | "Savings rate" (§68) is undefined, and a naive "income − tracked total spending − interest" would count interest twice because the reconciliation total already contains it. | Medium | One savings concept (12.5): `TrackedSavingsFromIncome = ExternalIncome − Consumption − PropertyOperatingCosts − InterestAndFees − TransactionCosts`, each flow counted once; `PersonalSavings = TrackedSavingsFromIncome − AdditionalSpending` when the user counts spending paid from outside tracked accounts (`count_additional_spending`, default on); `SavingsRate = PersonalSavings / ExternalIncome`; `ExternalIncome` = employment, freelance, bonus, rental, other, dividends and interest received in tracked cash, excluding `external_inflow` and `adjustment`. Contributions, principal, asset purchases and capital improvements are allocations of savings; withdrawals and loan proceeds are not income; third-party-paid expenses never count. |
| F17 | "Passive income" goal (§88) is undefined. | Low | Trailing-12-month rental + dividend + interest income in the reporting currency. |
| F18 | "Occupancy history where available" (§13). A month without a rent entry may mean vacancy, non-payment, payment outside tracked accounts, or a data gap. | Medium | **Never inferred.** A month with no rent entry shows "No rent recorded". Occupancy is known only from explicit facts: rent received, or the rent suggestion skipped with a reason (`vacant`, `non_payment`, `other`), recorded as a `recurring_template_skips` row (6.2, 11.2). Occupancy-rate analytics beyond these explicit facts are deferred. Scenario `vacancyPct` is an explicit assumption and stays. |
| F19 | §16/§17 define spending through tracked cash, but §125 allows expenses that were not paid from tracked cash, and "not from tracked cash" covers two different things: the user paid from an untracked account, or someone else paid. | Medium | Settlement `tracked_cash` / `untracked_self` / `third_party` / `deducted_from_asset` (R24). **Tracked spending** is inferred through tracked cash; **additional spending** is `untracked_self`; **total spending** = tracked + additional; `third_party` expenses are informational only. Neither untracked kind enters reconciliation; `untracked_self` counts in total spending, and in the personal savings rate and the projection baseline per the user's `count_additional_spending` setting (default on); `third_party` never enters totals, savings or baselines. |
| F20 | §29 lists property "maintenance/repairs" costs and "major one-off costs" but says nothing about improvements. A flow-adjusted property value would treat a €20,000 renovation as a €20,000 value increase. | High | Capital improvements are capital expenditure: cash out, cost basis up, market value unchanged until an explicit valuation or an explicitly entered value-add estimate (R19). |
| F21 | §32 gives *other assets* an option to participate in the headline net worth; nothing else has one, and liabilities obviously cannot be excluded. A generic toggle would let a user "exclude" a mortgage. | High | Two metrics — total and financial net worth — with the inclusion preference only on other assets (R18, Section 12). |
| F22 | §27 says lifetime XIRR must not be pretended when historical contributed capital is unknown; §125 says an investment may exist without it. Neither says what to do when it **is** known (a common onboarding case: value €41,870, net invested €33,359). | Medium | Explicit **opening net invested basis** on the investment (R20, 9.3): gain and return use it; because it is net of historical withdrawals it is never labelled "lifetime contributions"; XIRR remains "since tracking began" because pre-tracking flows are undated. |

### 2.3 Technical ambiguities

| # | Finding | Severity | Resolution |
|---|---|---|---|
| T1 | "Financial calendar dates are interpreted in the user's timezone" could be read as storing timestamps. | Low | Financial dates are `DATE` columns. Timezone determines "today" (future-date validation, current month, default dates). Changing the timezone never changes stored dates. |
| T2 | Scenario starting state: relational copy or frozen document? | Medium | A frozen JSONB engine-input document with a schema version (D12). |
| T3 | Bulk editor month-end dating (§57). | Low | `date_precision ∈ {exact, month_end}`; `month_end` means "the balance at the end of that month, as read from a statement", and can only be written once the month has ended (`today > end(M)`). The financial date stays the last day of the month; the row's creation timestamp records when it was entered (a statement imported on 4 October legitimately carries a 30 September month-end balance). |
| T4 | "Latest sufficiently complete/reviewed month" (§71). | Medium | The latest completed month whose completeness is `sufficient` **or** which the user marked reviewed; if none, the latest completed month with any month-end valuation, with a warning banner in the scenario. |
| T5 | Default categories: global rows or per-user rows? | Low | Copied per user at signup. |
| T6 | Tags storage. | Low | `text[]` with a GIN index plus a `tags` table for the managed list. |
| T7 | Soft delete vs hard delete. | Medium | Definitional entities are archived/closed; financial rows are hard-deleted with a full before-image in `audit_entries` (R12). |
| T8 | Where reporting-currency conversion happens. | Low | At read time; never persisted into source tables. |
| T9 | Recurring templates: when do suggestions become records? | Low | Only on explicit acceptance, and only for dates ≤ today; future-dated suggestions are "upcoming". |
| T10 | Better Auth's user table vs app settings. | Low | Better Auth owns the auth tables; the app owns `user_settings` (1:1) and everything keyed by `user_id`. |
| T11 | §110/§111 imply a scheduled FX job. A job that discovers currencies by reading every user's positions needs a runtime role that can see all tenants' data. | High | The refresh job maintains the **whole supported fiat set** from global tables only; runtime roles never bypass RLS (R26). |
| T12 | §99 requires backups, §96 requires RLS. A backup taken with an RLS-subject role and no user context is silently empty. | High | Dedicated `app_backup` role: SELECT-only, `BYPASSRLS`, credential only in the backup workflow (R27). |
| T13 | §5/§23 list crypto as an asset class; a currency table seeded with BTC/ETH would need trustworthy current and historical crypto prices, which the FX design does not provide. | Medium | Currencies are fiat/official only; crypto is an investment asset class held in a fiat-reported position (R28). |
| T14 | §107/§108 require exact arithmetic and correct formatting; formatting via `Number` can lose precision for large values. | Low | Exact display path: decimal strings formatted by `Intl.NumberFormat` string support (no `Number`), with an exact fallback assembler (R31). |

### 2.4 Unnecessary complexity (postponed or simplified)

| # | Item | Decision |
|---|---|---|
| U1 | Occupancy history model (§13) | Only explicit rent-skip reasons are recorded, as `recurring_template_skips` rows (F18); occupancy-rate analytics deferred. |
| U2 | Category icons, colors, groups (§6) | Columns from Phase 3; UI in Phase 8. |
| U3 | "Other property income" (§29) | Income kind `other` linked to a property. |
| U4 | Restore-from-audit UI (§93) | Before-images from Phase 3; UI in Phase 7. |
| U5 | Combinable contribution strategies (§78) | A fixed, ordered pipeline of optional stages (13.3). |
| U6 | Property vacancy assumption (§80) | A single percentage haircut on projected rent. |
| U7 | Per-account spending attribution | Diagnostics in reconciliation issues only. |
| U8 | Property/equity IRR (§31) | After the XIRR engine exists (Phase 8). |
| U9 | Per-account reconciliation spans and bucket windows (v1 of this plan) | **Removed.** The month-end rule plus multi-month spans (R15, R21) covers every case without per-account time partitioning. |
| U10 | Persistent "assume unchanged" account policy (v1 of this plan) | **Removed.** Replaced by explicit per-month confirmation and a dormant flag for zero-balance accounts (R22). |
| U11 | Passkeys, social login, TWR, benchmarks, imports | Deferred (spec agrees). |

### 2.5 Missing invariants (added)

| # | Invariant | Enforcement |
|---|---|---|
| M1 | One valuation per position per date. | `UNIQUE (position_id, valued_on)`. |
| M2 | A transfer's two endpoints are distinct, owned by the same user, and form an allowed kind pair. | Composite FKs on `(position_id, user_id)`; `CHECK from_position_id IS DISTINCT FROM to_position_id`; kind-pair validation in the domain layer. |
| M3 | Liability payment parts sum to the total; all parts ≥ 0. | `CHECK`. |
| M4 | No valuation or flow dated before a position's `opened_on` or after its `closed_on`. | Domain validation + DB trigger in Phase 7 hardening. |
| M5 | **No actual record is dated after today in the user's timezone, and a month-end balance (`date_precision = 'month_end'`) for month M may be written only when `today > end(M)`.** | Enforced authoritatively in application/domain validation using the user's local `today` (request context → Zod → domain rules). No database time constraint: "not in the future" is time-dependent, not a row invariant. Tests prove that requests bypassing the client are rejected at the server boundary. |
| M6 | Closing a position requires a final valuation of 0 (cash), a withdrawal plus 0 valuation (investment), a sale transfer plus 0 valuation (property/other asset), or a payoff payment plus 0 balance (liability). | Guided "Close" flow; domain validation. |
| M7 | Gross income ≥ net income. | Warning only. |
| M8 | Every child row carries `user_id` and references its parent through `(id, user_id)`. | Schema convention; lint check on migrations. |
| M9 | Scenario revisions are immutable; a run is fully determined by (revision, engine version, mode, seed, params). | Append-only tables; unique key on runs. |
| M10 | Reporting-currency values are never written to source tables. | Schema has no such columns; review rule. |
| M11 | The per-bucket reconciliation identity holds exactly in native currency for every reliable month and every span. | Property test. |
| M12 | An amortization schedule's principal sums to the opening balance and the final payment clears it exactly. | Unit + property test. |
| M13 | A same-currency transfer has equal leg amounts. | `CHECK`. |
| M14 | Every fact has exactly one representation (a transfer fee is one expense row; a dividend is one income row). | Schema (no duplicate columns) + service design. |
| M15 | Liabilities always participate in both net-worth metrics; only other assets carry an inclusion preference. | Schema (flag lives on `other_assets` only). |
| M16 | Internal transfers are neutral for **total** net worth in every reporting currency; for financial net worth the only exceptions are purchases/sales of excluded other assets, which are shown explicitly. | Property test. |
| M17 | A capital improvement never changes a market valuation. | Schema (improvements are expense rows) + tests. |
| M18 | A scenario never moves value between currency buckets without an explicit simulated conversion record. | Engine design + property test. |
| M19 | A scenario's current revision, and every revision's parent revision, belong to that same scenario and user. | Composite FKs `(current_revision_id, id, user_id) → scenario_revisions (id, scenario_id, user_id)` and `(parent_revision_id, scenario_id, user_id) → scenario_revisions (id, scenario_id, user_id)`; integration test. |

### 2.6 Edge cases and their handling

| Area | Case | Handling |
|---|---|---|
| Missing data | First month of tracking | No month-end opening → spending `unavailable`; net worth shown from first valuation; the first valuations appear as "newly tracked" in the decomposition. |
| Missing data | Income recorded but no month-end balances | Spending `unavailable`; issue "missing month-end balance for N accounts". |
| Missing data | September month-end missing, October present | September and October each `unavailable`; a **span** "1 Sep – 31 Oct" reports the combined residual, excluded from monthly averages. |
| Current month | All cash accounts updated on the 6th; one of them again on the 8th | Month-to-date, provisional spending through the 6th — the latest date every account shares; the 8th snapshot shows only as a newer individual balance, with "update all accounts to move the MTD date forward". Only if no date in the month is shared by every account (one updated only on the 3rd, another only on the 6th) is MTD spending unavailable ("update all cash accounts to the same date"); balances still display individually. September becomes reconcilable on 1 October with month-end balances. |
| Stale balances | Investment not valued for 3 months | Net worth uses the carried (flow-adjusted) value with "last valued <date>"; monthly performance `unavailable`; the next valuation's month shows performance "since <date>". |
| Stale balances | Property carried 18 months | Same, plus a "consider revaluing" hint after a user-configurable age (default 12 months). |
| Foreign currency | USD account, EUR reporting | Reconciliation in USD; USD unclassified spending converted at the USD monthly average; FX bucket absorbs revaluation. |
| Foreign currency | Rate missing for a date | Latest rate on or before, up to 10 calendar days back; beyond that the conversion is `unavailable` and totals show "partial". |
| Transfers | EUR → USD conversion with bank spread | 12.2 rule; spread in FX bucket; an explicit fee is a linked `transfer_fee` expense entry. |
| Transfers | Transfer to an untracked account (spouse, old bank) | Not a transfer: an expense entry of kind `external_outflow` (non-consumption), or income of kind `external_inflow` on the way back. |
| Investment withdrawals | Withdrawal larger than contributed capital | Allowed (gains). Larger than current value → validation error. |
| Investment withdrawals | Full liquidation | "Close investment" flow: withdrawal for the full value, valuation 0, status closed. |
| Investments | Onboarded with known net invested capital | Opening net invested basis recorded; gain vs the basis and gain since tracking shown; XIRR since tracking began. |
| Dividends | Reinvested | No cash effect, no performance term, shown as "reinvested distributions". |
| Fees | Deducted inside fund value | Informational only; never subtracted again. |
| Mortgage principal | Payment recorded but balance not confirmed | Balance `derived`; when confirmed, the difference is a "debt adjustment". |
| Debt | Variable-rate change mid-term | New `liability_terms` row effective from date; the schedule recomputes from the balance at that date. |
| Debt | Payment made by a third party | `liability_payments.settlement = untracked`: liability falls, no cash leg; shown as an external inflow plus interest cost. |
| Asset purchase | Property bought with mortgage | Three records: transfer cash→property (down payment), transfer liability→property (financed amount), expense `acquisition_cost`. Net worth changes only by costs. |
| Property | €20,000 renovation | Expense entry of kind `capital_improvement`: cash −20,000, cost basis +20,000, market value unchanged; total net worth −20,000 until a new valuation. Optional value-add estimate shown as an estimate. |
| Other assets | Car bought for €20,000, excluded from financial net worth | Total net worth unchanged; financial net worth −20,000 shown as "purchase of non-financial asset". |
| Asset sale | Property sold, mortgage repaid at closing | Transfer property→cash (gross proceeds), liability payment `payoff` from cash, expense `disposal_cost`, valuation 0, position closed. |
| Historical corrections | Edit a balance 6 months back | In-place update with version check; audit before/after; derived analytics recompute on read; affected months listed in the confirmation dialog. |
| Historical corrections | Delete a flow | Hard delete with before-image; the month's reconciliation changes accordingly. |
| Scenario | Obligation in USD, cash only in EUR | Without auto-funding: `currency_deficit` (USD) and infeasibility if the obligation is required; with auto-funding: simulated EUR→USD conversion at the FX path plus spread, recorded in the month state. |
| Scenario rebasing | Actuals corrected after scenario creation | Scenario keeps its frozen start; UI shows "starting state from <month>, newer data exists"; Rebase creates a new revision with a new frozen state; events dated before the new start are flagged "already in the past". |

**Areas where the specification is already correct and adopted as-is:** native-currency storage (§7.1), reconciliation per currency (§18), transfer semantics (§37), loan proceeds (§40), no double counting rules (§2.5, §129), recurring templates as suggestions (§14), review state not locking months (§55), scenario frozen start plus explicit rebase (§71), cash policy ordering (§79), finance-engine separation (§102), numeric rules (§107), logging rules (§98).

---

## 3. Resolved ambiguities / recommended corrections

The rules below supersede the corresponding spec text. Everything else in the spec stands.

| Rule | Statement |
|---|---|
| R1 (C1, C2) | Net-worth drivers = income + revaluations + FX + adjustments + newly tracked − consumption − interest/fees − transaction costs − capital improvements − removed from tracking. Contributions and principal repayments are allocations of savings, shown in a separate "where it went" view. |
| R2 (C3) | Each recorded flow belongs to exactly one bucket. External investment fees are costs; performance in the decomposition is gross of them. |
| R3 (C4) | Acquisition and disposal costs are `acquisition_cost`/`disposal_cost` expense entries: reduce net worth when paid, excluded from consumption, included in cost basis. |
| R4 (C5) | Valuations inherit the position's currency. Flow legs carry their own currency. |
| R5 (C7, F1) | Monthly spending status: `reliable` (month-end balances at both ends for every participating account, no exclusions), `estimated` (computed, but a pre-existing account's first balance falls in the month and is excluded), `provisional` (current month, month-to-date), `unavailable` (any participating non-dormant account lacks a month-end balance at either end), `unresolved` (computed but negative unclassified or open blocking issues). |
| R6 (F2) | Negative unclassified spending is never displayed as spending. Show "unexplained inflow" and "spending ≥ known". |
| R7 (F4) | A transfer's reporting value is its source leg at the dated rate; both legs use it. |
| R8 (F5, F6) | Dividends/interest are income entries with `settlement`; fees are expense entries with `settlement`. No separate distribution/fee tables. |
| R9 (F8) | Liability balance between confirmations is derived from recorded payments. The schedule only suggests. |
| R10 (F9) | Carried investment values are flow-adjusted. Carried property and other-asset values are not. |
| R11 (F13) | Growth rates: geometric monthly conversion. Loan interest: nominal/12. |
| R12 (T7) | Archive definitional entities; hard-delete financial rows with audit before-images. |
| R13 (M1–M18) | The added invariants are enforced as listed. |
| R14 (§61 vs §115) | Settings under System. Other assets are a tab of the Accounts page. The "Expenses" page is titled **Spending**; the route stays `/expenses`. |
| R15 (F1, F11) | A month's closing balance is the balance as of the last day of the month (`valued_on = end(M)`, `date_precision = 'month_end'`), written only once the month has ended (`today > end(M)`). An exact snapshot dated the last day is an ordinary snapshot until it is confirmed as the statement-end value. Reconciliation of a completed month uses month-end balances and the month's flows. |
| R16 (review) | The drivers decomposition has "newly tracked" and "removed from tracking" buckets; a first valuation is never performance. |
| R17 (C8, M5) | No actual record may be dated after today in the user's timezone. The current month is month-to-date and provisional through its last day; month-to-date spending is computed through the latest date on which every snapshot-required included account has an exact snapshot (8.6), and is unavailable only when no such date exists. |
| R18 (F21) | Two net-worth metrics: total (all assets − all liabilities the user tracks) and financial (cash + investments + real estate − all liabilities + included other assets). Only other assets carry an inclusion preference. User-facing names are **Total net worth** ("includes all assets and liabilities you track") and **Financial net worth**; the app never claims to know the user's complete real-world balance sheet. |
| R19 (F20) | Capital improvements are `capital_improvement` expense entries: cash out, cost basis up, market value unchanged unless a valuation or an explicit value-add estimate is entered. |
| R20 (F22) | An investment may record `opening_net_invested_basis` (capital invested net of withdrawals before tracking began); when present, gain and return use it and the first valuation is never treated as contributed capital; the UI never labels it or anything derived from it as "lifetime contributions". |
| R21 (F1) | When month-end balances exist at two month ends with missing month ends between them, the engine reports a multi-month reconciliation span for the whole gap; the months inside stay `unavailable`; the span is never averaged or attributed to one month. |
| R22 (C7) | "Confirm unchanged for this month" is an explicit action that writes a month-end valuation. Only accounts flagged dormant (balance exactly zero) carry automatically. |
| R23 (scenario) | Scenario cash is per currency; an obligation or contribution in currency X is funded from X cash; simulated conversions happen only when auto-funding is enabled, at the FX path plus a configured spread, and are recorded; otherwise a currency-specific deficit is reported. |
| R24 (F19) | Expense settlement is `tracked_cash` ("Paid from tracked account"), `untracked_self` ("Paid by me outside tracked accounts"), `third_party` ("Paid by someone else") or `deducted_from_asset`. Tracked spending, additional spending (`untracked_self`) and total spending (tracked + additional) are distinct figures; `third_party` expenses are informational. Neither untracked kind enters reconciliation; `third_party` never enters totals, savings or baselines; `untracked_self` counts in the personal savings rate and the projection baseline per the `count_additional_spending` setting (default on). |
| R25 (decomposition) | All generic net-worth mathematics uses an explicit sign per position: assets +1, liabilities −1. |
| R26 (T11) | FX refresh maintains the whole supported fiat set from global tables; runtime never reads across tenants. |
| R27 (T12) | Backups use a dedicated SELECT-only `BYPASSRLS` role available only to the backup workflow. |
| R28 (T13) | Currencies are fiat/official only; crypto is an investment asset class. |
| R29 (Monte Carlo) | Phase 12 ships explicit correlated returns: a positive-semidefinite asset-class matrix with a documented default labelled as an assumption and editable per scenario. |
| R30 (goals) | A custom goal is a target over a user-selected set of positions (signed net value). |
| R31 (T14) | Money is formatted from exact decimal strings, never via `Number`; charts may use numbers for coordinates only. |

### 3.1 Review history

- **Adversarial model review (v1 → v1.1):** recomputed every worked example (all confirmed) and found: flows summed by calendar month against balances taken on arbitrary dates; no bucket for positions first valued inside a period; the investment FX residual double-assigning the paid-out-dividend term; `external` dividends mislabelled as neutral; contradictory "assumed unchanged" rules; the schedule and the projection engine treating negative amortization differently; a withdrawal cap that could create cash; `percentOfSurplus` applied to a stock instead of the month's flow; a property bought mid-year zeroed by the growth step; `RESTRICT` FKs breaking account deletion; two representations of transfer fees; liability payments without settlement or a cross-currency leg; an invalid typed-FK shorthand. All fixed here.
- **Product-owner review (v1.1 → v2):** the sixteen corrections now embodied in R17–R31, M5, M14–M18 and U9–U10: no future-dated actuals; two net-worth metrics; capital improvements as capex; opening investment basis; monthly model with multi-month spans instead of per-account spans/windows; explicit per-month "confirm unchanged"; multi-currency scenario funding; tracked vs additional spending; explicit liability signs; global FX refresh; dedicated backup role; fiat-only currencies; one coherent Monte Carlo correlation behavior; concrete custom goals; exact display formatting; version wording.
- **Final consistency pass (v2 → v2.1):** month-end balances only after the month has ended (`today > end(M)`); month-to-date spending only on a common snapshot date; one savings definition with no double counting (F16, 12.5); expense settlement split into self-paid and third-party (R24); `opening_net_invested_basis` naming and labels (R20, 9.3); no inferred vacancy (F18); a single base-currency reserve target without per-currency shares (13.4); properties always in financial net worth in scenarios; no time-dependent database CHECKs (M5); hardened RLS expression (17.4); one-time role bootstrap (22.2); currency minor units 0..8; Monte Carlo factor model with an idiosyncratic component (13.9).
- **Freeze pass (v2.1 → v2.1.1):** month-to-date uses the *latest common* snapshot date and is unavailable only when no common date exists (8.6); one Monte Carlo correlation schema and an explicit default class matrix verified positive semi-definite (13.2, 13.9); explicit semantics for `income_entries.settlement = external` and a schema rule limiting `reinvested` to investment distributions (7.4, 12.5); explicit `recurring_template_skips` table replacing skip facts in JSON (6.2); a systematic nullability pass with PostgreSQL enums for every closed set (6.1–6.2); an orientation-independent `convertWithSpread` helper for scenario conversions (13.4); stale "lifetime"/"date backstop" wording removed.
- **MTD clarification (v2.1.9 → v2.1.10):** eleven questions the month-to-date engine could not answer from 8.4, 8.5 and 8.6 together (30.13): where `provisional` sits in the status order and whether a negative unclassified overrides it; that `D` is one global date while arithmetic failures after it are bucket-local; that no `D` means no MTD totals at all rather than totals over an invented cut-off; that an empty inclusion set does not satisfy the evidence predicate by vacuous truth; that `first_balance` is a month-level exclusion during the search; which issues apply to the current month; and the exact account set behind `mtd_newer_balances`. No identity, schema or delivered phase changes.
- **Result-shape correction (v2.1.8 → v2.1.9):** 8.3 returns an `unavailable` bucket before `Δ` is computed, while 8.9 required a `cashDelta` on every bucket, so an implementation had to invent a partial sum over whichever accounts happened to have endpoints — a figure indistinguishable, in the result, from the `Δ` of the identity (30.12). `cashDelta` is now optional and absent in exactly that case. The four role sums are unaffected: they are source-flow sums over the 8.1 scope and stay exact in every status.
- **Issue-catalogue correction (v2.1.7 → v2.1.8):** the two `unexplained_inflow` variants were split on `ΣK` against `TrackedTotalSpending`, a predicate the issue’s own trigger makes impossible to satisfy on the variant-A side (30.11). Variant A is now selected by a **negative** `TrackedTotalSpending` — cash grew more than the recorded flows explain — and variant B by a non-negative one. No identity, algorithm or amount changed; the forgotten-salary example in 8.10 is variant A and its unexplained inflow is still €1,702.
- **Pre-deployment clarification (v2.1.6 → v2.1.7):** two semantics the implementation could not settle for itself (30.10): "received today" may materialize only the **earliest unresolved future occurrence** of a template, which bounds early acceptance by the schedule rather than by an invented number of days; and `archived_at` is current-state metadata rather than a historical schedule boundary, so a template archived today cannot erase an occurrence a past month was expecting.
- **Pre-Phase-3 clarification, second pass (v2.1.5 → v2.1.6):** recurring templates materialize tracked-cash flows only in Phase 3, so accepting a suggestion never has to guess a settlement; the occurrence invariant tightened from an implication to both-or-neither; occurrence generation bounded by `start_date` and `end_date` without moving the anchor; term selection keyed to `occurrence_date`; `settlement = external` restricted in Phase 3 to the ordinary income kinds 7.4 actually covers; and one deferred note about a Phase 9 foreign key (30.9).
- **Pre-Phase-3 clarification (v2.1.4 → v2.1.5):** the questions the Phase 3 implementation map raised, answered before implementation (30.8): the bulk editor’s known-expense-total column deferred to Phase 7 for want of a source representation; an explicit `occurrence_date` giving a recurring occurrence a durable identity distinct from the flow’s financial date; that identity carried structurally on `transfers` too; materialized flows keeping their template identity (`NO ACTION`, archive rather than delete); race-safe accept/skip; fixed-anchor short-month recurrence; frozen recurrence identity once history exists; the month-to-date snapshot-required account set; dormancy clearing; and savings availability propagation.
- **Final corrections (v2.1.1 → v2.1.2):** month-to-date opening balances follow 8.1 exactly (previous month-end, `opened_zero`, `first_balance` exclusion); scenario revision pointers are constrained to the same scenario and user by composite foreign keys (M19); the personal savings rate counts self-paid additional spending per a default-on user setting so "Total spending" and "Savings rate" agree (12.5); dependency lines are stated as Next.js 16.x and Better Auth 1.7.x. The "Freeze check" section at the end summarizes the result.

---

## 4. Architecture overview

### 4.1 Shape

```text
Browser (React 19 client components; charts; forms)
   │  RSC render (reads)            │  Server Actions (mutations)      │  Route handlers (auth, cron, export)
   ▼                                ▼                                  ▼
apps/web  ── Next.js App Router; proxy.ts (session gate, security headers); thin action/route wrappers
   │
   ▼
packages/application ── use cases: requireSession → authorize → validate → transaction(SET LOCAL app.current_user_id) → repositories → finance → audit → DTO
   │                          │
   ▼                          ▼
packages/db                packages/finance ── pure decimal engines (money, fx, reconciliation, investments, mortgage,
(Drizzle schema, RLS,       net worth, decomposition, projections). No IO, no framework imports.
 migrations, repositories)
   │
   ▼
PostgreSQL (Neon, Frankfurt) — NUMERIC storage, RLS, audit table; roles app_owner / app_user / app_backup
```

`packages/validation` (Zod 4 schemas, DTO types, money/date codecs) is imported by `apps/web`, `application` and `db`. `finance` depends only on decimal.js. `db` depends on Drizzle and `validation`. `application` depends on `db`, `finance`, `validation`. `apps/web` depends on `application` and `validation` (never directly on `db` or `finance`, enforced by ESLint `no-restricted-imports` and a `dependency-cruiser` rule in CI).

### 4.2 Request patterns

- **Reads:** server components call `application` query services with a `RequestContext` (`userId`, `settings`, `today` in the user's timezone, `reportingCurrency`). Services load the user's positions, valuations and flows for the needed range in a few bulk queries, run the finance engines in memory, and return serializable DTOs (money as `{ amount: string, currency }`). No client-side data-fetching library initially; navigation and `revalidatePath`/`updateTag` handle freshness.
- **Mutations:** every server action is defined through one `defineAction(inputSchema, handler)` helper that parses input with Zod, obtains the session (fails closed), builds the context (including `today`), runs the handler, maps `DomainError` subclasses to `ActionResult` (`{ ok: true, data } | { ok: false, error: { code, message, fieldErrors? } }`), and logs `{ action, userId, durationMs, errorCode }` and nothing else. Actions never accept `userId`.
- **Route handlers:** `/api/auth/[...all]` (Better Auth), `/api/cron/fx-refresh` (bearer `CRON_SECRET`; touches only global tables), `/api/health` (DB ping), `/api/export` (session-authenticated GET streaming JSON). A future `/api/v1/*` would call the same application services.
- **Instant feedback:** the monthly editor imports the `finance` reconciliation engine on the client to recompute the reconciliation panel as the user types; the server result after save is authoritative.

### 4.3 What is deliberately absent

No Redis, no queue, no event bus, no microservices, no background worker process. One Vercel cron (daily FX refresh). Monte Carlo runs in a Vercel function (Fluid compute) and is designed to move to a worker later without touching the engine. Derived analytics are computed on demand; the only caches are `projection_runs.result` (disposable) and per-request memoization.

### 4.4 Environments

`development` (local Postgres via Docker, or a Neon dev branch), `preview` (Vercel preview + Neon branch per PR, seeded with fixtures, never production data), `production`. Secrets only in Vercel/GitHub environments; `.env.example` lists names only.

---

## 5. Domain model

### 5.1 Entity catalogue

| Entity (plan name) | Spec names covered | Kind | Lifecycle | Notes |
|---|---|---|---|---|
| User | User | identity (Better Auth) | created at signup; deleted on account deletion (cascades everything) | No app columns. |
| UserSettings | UserSettings | source | 1:1, created at signup | base currency, reporting currency, timezone, locale, favorite currencies, stale thresholds, theme. |
| Currency | Currency | global reference | seeded | ISO code, minor units, name; fiat/official currencies supported by the FX provider only. |
| FxRate | FXRate | global reference | append-only | EUR-pivot daily reference rates with source and fetched time. |
| Category | Category | source | archive, never delete while referenced | `kind` fixes accounting semantics; name/icon/color/group are user organization. |
| Tag | Tag | source | delete allowed | Free-form labels. |
| **Position** (supertype) | Account, Investment, Property, other asset, Liability | source | active → closed/archived; never deleted while any valuation/flow references it | Common: name, currency, kind, open/close dates. No inclusion flag here. |
| CashAccount | Account | source (subtype) | with position | account type, institution, `is_dormant`. |
| InvestmentAccount | InvestmentAccount | source (container) | archive | groups Investments; not a position. |
| Investment | Investment | source (subtype) | with position | asset class, container account, **opening net invested basis** (optional; capital invested net of withdrawals before tracking began). |
| Property | Property | source (subtype) | with position | type, address, purchase date/price. |
| OtherAsset | other asset | source (subtype) | with position | asset type, acquisition date/value, **`include_in_financial_net_worth`**. |
| Liability | Liability, Mortgage | source (subtype) | with position | type, original principal, start date, linked property, amortization policies. Always in both net-worth metrics. |
| LiabilityTerms | Mortgage terms/rate history | source (versioned) | append rows effective-from a date | rate, rate type, payment, end date. |
| PositionValuation | AccountSnapshot, InvestmentSnapshot, PropertyValuation, LiabilitySnapshot, other-asset value | source (historical) | insert; in-place correction with version; hard delete with audit image | one per position per date; never future-dated; `month_end` precision marks a month-closing balance and can be written only after the month has ended (the financial date is the last day of the month; `created_at` records when it was entered). |
| RecurringTemplate | IncomeSource, RecurringTemplate, contribution plan | source (versioned) | archive | kind income/expense/contribution; identity fields; frequency. |
| RecurringTemplateTerms | salary history | source (versioned) | append effective-from rows | net/gross amounts per period. |
| RecurringTemplateSkip | (explicitly skipped suggestion) | source | insert/update/delete with audit | one row per skipped occurrence of a template with a reason; the only source of occupancy facts. Accepted occurrences are the actual flow rows carrying `template_id` **and** `occurrence_date`; that pair is the occurrence’s identity in both tables (6.2). |
| IncomeEntry | IncomeEntry, InvestmentDistribution (cash dividends), rental income | source (flow) | insert/update/delete with audit | kind, net/gross, settlement, links. |
| ExpenseEntry | ExpenseEntry, PropertyExpense, InvestmentFee, acquisition/disposal costs, **capital improvements**, transfer fees | source (flow) | same | category (kind-typed), settlement, links, optional value-add estimate for improvements. |
| Transfer | Transfer, InvestmentContribution, InvestmentWithdrawal, loan proceeds, asset purchase/sale | source (flow) | same | endpoint-typed; two legs with own currency/amount. |
| LiabilityPayment | mortgage payment, debt repayment | source (flow) | same | total = interest + principal + fee; settlement; optional cross-currency cash leg. |
| MonthReview | MonthlyReview | source (state) | upsert | reviewed flag, notes, dismissed issue keys. |
| AuditEntry | AuditEntry | historical (immutable) | insert-only | before/after images of source rows. |
| Goal (+ GoalPosition) | Goal | source | active/achieved/archived | kind, target, date, scope; custom goals reference a set of positions. |
| Scenario / ScenarioRevision / ProjectionRun | Scenario, ScenarioRevision, ScenarioAssumption, ScenarioEvent, ProjectionRun | source / immutable / derived | archive / append-only / disposable | frozen starting state + definition + engine version; cached results. |

**Derived concepts that are not entities** (computed by `finance`, never stored as truth): position state at a date (value, freshness), monthly cash bucket reconciliation and multi-month spans, month-to-date provisional spending, net-worth snapshots and series (total and financial), wealth-change decompositions, investment performance and XIRR, amortization schedule, property analytics, projection month states, goal progress.

### 5.2 Aggregate boundaries and consistency rules

- **Position aggregate** = position row + subtype row + its valuations + (liabilities) its terms. Invariants M1, M4, M5, M6 are enforced inside this aggregate's services. Closing a position is a single transaction that writes the final valuation and status together.
- **Flow aggregates** (income entry, expense entry, transfer, liability payment) are independent rows that reference positions by `(id, user_id)`; validated against the referenced positions (currency match, open/close window, kind pairs, date ≤ today) at write time; they never modify positions.
- **Recurring template aggregate** = template + terms. Materializing a suggestion creates a flow row with `template_id` **and** `occurrence_date` set; the flow is then independent, and correcting its financial date later never changes which occurrence it fulfilled (6.2).
- **Scenario aggregate** = scenario + revisions + runs. Editing creates a revision; the scenario's `current_revision_id` moves forward with an optimistic check.
- **Audit** is written in the same transaction as the mutation it records, by the repository layer, for every insert/update/delete of source rows.

### 5.3 Source of truth vs derived

Source: everything in 5.1 marked source. Derived: all totals, all reporting-currency values, spending inference, performance, decompositions, schedules, projections, completeness scores, goal progress. Historical records: valuations, flows, terms, revisions, audit entries, FX rates — all dated, never overwritten by "current" values; corrections are explicit edits with audit images.

---

## 6. Database schema design

### 6.1 Conventions

- PostgreSQL 16+. Snake_case names. `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`.
- Every user-owned table has `user_id uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE`, `created_at`/`updated_at timestamptz` (trigger-maintained), and, where user-editable, `version integer NOT NULL DEFAULT 1` (optimistic concurrency).
- Parent tables that children reference expose `UNIQUE (id, user_id)`; children reference `(parent_id, user_id)` as a composite FK (M8).
- **Typed position references.** Every column that must point at a specific kind of position has a companion constant column `<ref>_kind position_kind` with `CHECK (<ref>_kind = '<kind>')` (nullable when the reference is nullable), and the FK is `(<ref>_id, user_id, <ref>_kind) → positions (id, user_id, kind)` with `MATCH SIMPLE`, so a NULL reference passes and a non-NULL reference must be a position of that kind. "typed `cash`" below is shorthand for this pattern.
- **Delete actions.** Child → parent FKs between user-owned tables use `ON DELETE NO ACTION` (checked at the end of the statement), never `RESTRICT`, so the account-deletion cascade from `"user"` succeeds while an ordinary attempt to delete a referenced parent still fails. The delete-account use case also deletes in dependency order inside one transaction; an integration test proves both.
- **Dates.** Financial dates are `date`; system times are `timestamptz` (UTC). The "not after today" and "month-end only after the month has ended" rules (M5) are enforced only in application/domain validation with the user's local `today`. **No CHECK constraint may reference `current_date`, `now()` or any other moving time**: database constraints express timeless row invariants only (amounts, enums, the month-end date shape, uniqueness, ownership, payment parts, static date relationships).
- Money: `NUMERIC(24,8)`. FX rates: `NUMERIC(24,12)`. Rates/percentages as fractions: `NUMERIC(12,8)`. Never `float`, never `money`.
- **Enumerations.** Every closed set is a PostgreSQL enum type created with `pgEnum` and referenced by name in 6.2: `position_kind`, `position_status`, `cash_account_type`, `asset_class`, `property_type`, `other_asset_type`, `liability_type`, `amortization_method`, `extra_payment_policy`, `rate_change_policy`, `rate_type`, `valuation_source`, `date_precision`, `template_kind`, `income_kind`, `recurrence_frequency`, `income_settlement`, `expense_settlement`, `liability_settlement`, `liability_payment_kind`, `record_source`, `skip_reason`, `transfer_kind`, `category_kind`, `goal_kind`, `goal_status`, `run_mode`, `run_status`, `audit_action`. No column uses `text + CHECK IN (...)`. Adding a value is an additive migration (`ALTER TYPE … ADD VALUE`); values are never removed or renamed in place.
- **Nullability.** Every column is `NOT NULL` unless written `NULL` in 6.2. A `CHECK` never stands in for `NOT NULL` (a CHECK passes on NULL); every required column has a test proving that a NULL insert is rejected, and every enum column a test proving that an unknown value is rejected (21.3).
- JSONB only in: `scenario_revisions.starting_state`, `scenario_revisions.definition`, `projection_runs.params/result`, `audit_entries.before/after`, `month_reviews.dismissed_issues` (UI dismissal keys only), `user_settings.preferences`. Nothing relational lives in JSON: an explicit skip of a recurring suggestion is a row in `recurring_template_skips`, never a JSON entry.
- **Roles.** Created once per environment by the platform-admin bootstrap script (22.2), never by an application migration: `app_owner` (owns all objects; DDL; used only by CI migrations over the direct endpoint), `app_user` (runtime: DML on user tables under RLS, `NOBYPASSRLS`, SELECT/INSERT on `fx_rates`, SELECT on `currencies`, no UPDATE/DELETE on `audit_entries` and `scenario_revisions`), `app_backup` (SELECT on all tables, `BYPASSRLS`, no DML/DDL; credential only in the backup workflow). `ALTER DEFAULT PRIVILEGES FOR ROLE app_owner` grants these privileges automatically on objects later created by migrations. RLS is enabled on every user-owned table with the policy expression `user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid` (Section 17.4); global tables and Better Auth tables have no RLS.
- Currency codes are `char(3)` referencing `currencies(code)`.

### 6.2 Tables

Columns listed as `name type [constraints]`. "Own" = `user_id uuid NOT NULL` ownership column plus the composite FK pattern of 6.1; `id` = `uuid PRIMARY KEY DEFAULT gen_random_uuid()`; `version` = `integer NOT NULL DEFAULT 1`; `created_at`/`updated_at` = `timestamptz NOT NULL`. `→` = foreign key. **Every column is `NOT NULL` unless written `NULL`.** Enum types are those of 6.1; their values are listed once where the type first appears.

**`currencies`** (global) — `code char(3) PRIMARY KEY`, `name text NOT NULL`, `minor_units smallint NOT NULL CHECK (minor_units BETWEEN 0 AND 8)`, `is_fx_supported boolean NOT NULL DEFAULT true`, `is_active boolean NOT NULL DEFAULT true`. Seeded with the fiat/official currencies published by the FX provider (ECB set plus other central-bank currencies available through Frankfurter v2), each with its actual ISO 4217 minor units (0 for JPY, 2 for most, 3 for KWD/BHD/…, 4 for CLF/UYW); no assumption that fiat means ≤ 3 decimals. No crypto codes. No delete.

**`fx_rates`** (global, append-only) — `id`, `base char(3) NOT NULL → currencies` (always `EUR` initially), `quote char(3) NOT NULL → currencies`, `rate_date date NOT NULL`, `rate NUMERIC(24,12) NOT NULL CHECK (rate > 0)`, `source text NOT NULL`, `fetched_at timestamptz NOT NULL`. `UNIQUE (base, quote, rate_date, source)`. Index `(quote, rate_date DESC)`. Rows are never updated. `app_user`: INSERT/SELECT only.

**`user_settings`** — `user_id uuid PRIMARY KEY →`, `base_currency char(3) NOT NULL →`, `reporting_currency char(3) NOT NULL →`, `timezone text NOT NULL` (IANA), `locale text NOT NULL` (BCP 47), `favorite_currencies char(3)[] NOT NULL DEFAULT '{}'`, `stale_investment_months smallint NOT NULL DEFAULT 2`, `stale_property_months smallint NOT NULL DEFAULT 12`, `count_additional_spending boolean NOT NULL DEFAULT true` (whether spending paid from outside tracked accounts counts in the personal savings rate and seeds the projection baseline; UI label "Count spending I paid from outside my tracked accounts in my savings rate"), `preferences jsonb NOT NULL DEFAULT '{}'`, `version`.

**`categories`** — `id`, own, `kind category_kind NOT NULL` (`general, housing, transport, food, travel, health, insurance, tax, subscriptions, maintenance, major_purchase, custom, property_operating, investment_fee, transfer_fee, acquisition_cost, disposal_cost, capital_improvement, external_outflow`), `name text NOT NULL`, `group_name text NULL`, `icon text NULL`, `color text NULL`, `is_default boolean NOT NULL DEFAULT false`, `sort_order int NOT NULL DEFAULT 0`, `archived_at timestamptz NULL`, `version`. `UNIQUE (user_id, name) WHERE archived_at IS NULL`. The seven kinds `property_operating`, `investment_fee`, `transfer_fee`, `acquisition_cost`, `disposal_cost`, `capital_improvement`, `external_outflow` are "system kinds": non-consumption semantics, one category of each created per user at signup, cannot be archived. Audit: yes.

**`tags`** — `id`, own, `name text NOT NULL`, `UNIQUE (user_id, name)`.

**`positions`** — `id`, own, `kind position_kind NOT NULL` (`cash, investment, property, other_asset, liability`), `name text NOT NULL`, `currency char(3) NOT NULL →`, `status position_status NOT NULL DEFAULT 'active'` (`active, closed, archived`), `opened_on date NULL`, `closed_on date NULL`, `notes text NULL`, `sort_order int NOT NULL DEFAULT 0`, `version`. `UNIQUE (id, user_id)`, `UNIQUE (id, user_id, kind)`, `CHECK (closed_on IS NULL OR opened_on IS NULL OR closed_on >= opened_on)`, `CHECK (status <> 'closed' OR closed_on IS NOT NULL)`. Index `(user_id, kind, status)`. Currency is immutable after the first valuation or flow. `opened_on` is asked at creation for cash accounts ("new account, started empty on <date>" vs "existing account I am starting to track", which stores NULL). There is **no** net-worth inclusion flag on this table (M15). Delete: only if no valuations/flows. Audit: yes.

**`cash_accounts`** — `position_id uuid PRIMARY KEY`, own, `kind position_kind NOT NULL DEFAULT 'cash' CHECK (kind = 'cash')`, FK `(position_id, user_id, kind) → positions(id, user_id, kind)`; `account_type cash_account_type NOT NULL` (`checking, savings, cash, brokerage_cash, other`), `institution text NULL`, `is_dormant boolean NOT NULL DEFAULT false` (settable only while the latest month-end balance is exactly 0; the service clears it when a non-zero balance or an attributed flow is recorded). Audit: with position.

**`investment_accounts`** — `id`, own, `name text NOT NULL`, `institution text NULL`, `notes text NULL`, `archived_at timestamptz NULL`, `version`, `UNIQUE (id, user_id)`. Audit: yes.

**`investments`** — `position_id uuid PRIMARY KEY` (typed, kind `investment`), own, `investment_account_id uuid NOT NULL → investment_accounts (id, user_id) NO ACTION`, `asset_class asset_class NOT NULL` (`equity, fixed_income, cash_like, real_estate_fund, commodities, crypto, pension, other`), `custom_label text NULL`, `opening_net_invested_basis NUMERIC(24,8) NULL CHECK (opening_net_invested_basis >= 0)` (capital invested **net of withdrawals** before tracking began, as of the first valuation date; NULL = unknown), `opening_basis_note text NULL`. Richer pre-tracking history (gross contributions, gross withdrawals, distributions) is not modelled in v1; when an importer can supply it, it is added as three further nullable columns in an additive migration and the net basis becomes derived from them. Index `(user_id, investment_account_id)`. Audit: with position.

**`properties`** — `position_id uuid PRIMARY KEY` (kind `property`), own, `property_type property_type NOT NULL` (`apartment, house, land, commercial, other`), `address text NULL`, `purchase_date date NULL`, `purchase_price NUMERIC(24,8) NULL CHECK (purchase_price >= 0)`, `is_rental boolean NOT NULL DEFAULT false`. Purchase price also seeds a valuation with source `purchase` on the purchase date (one transaction).

**`other_assets`** — `position_id uuid PRIMARY KEY` (kind `other_asset`), own, `asset_type other_asset_type NOT NULL` (`vehicle, collectible, private_equity, equipment, receivable, custom`), `acquisition_date date NULL`, `acquisition_value NUMERIC(24,8) NULL CHECK (acquisition_value >= 0)`, `include_in_financial_net_worth boolean NOT NULL DEFAULT false` (the only inclusion preference in the schema; not a dated attribute — toggling recomputes the financial series consistently and is audited).

**`liabilities`** — `position_id uuid PRIMARY KEY` (kind `liability`), own, `liability_type liability_type NOT NULL` (`mortgage, personal_loan, car_loan, other`), `original_principal NUMERIC(24,8) NULL CHECK (original_principal >= 0)`, `start_date date NULL`, `linked_property_position_id uuid NULL` + `linked_property_kind position_kind NULL CHECK (linked_property_kind = 'property')` with FK `(linked_property_position_id, user_id, linked_property_kind) → positions (id, user_id, kind)`, `payment_day smallint NULL CHECK (payment_day BETWEEN 1 AND 31)`, `amortization_method amortization_method NOT NULL DEFAULT 'annuity'` (`annuity, interest_only, manual`), `extra_payment_policy extra_payment_policy NOT NULL DEFAULT 'shorten_term'` (`shorten_term, reduce_payment`), `rate_change_policy rate_change_policy NOT NULL DEFAULT 'recompute_payment'` (`recompute_payment, keep_payment`).

**`liability_terms`** — `id`, own, `liability_position_id uuid NOT NULL → positions (id, user_id) NO ACTION` (typed `liability`), `effective_from date NOT NULL`, `annual_rate NUMERIC(12,8) NOT NULL CHECK (annual_rate >= 0)`, `rate_type rate_type NOT NULL` (`fixed, variable`), `payment_amount NUMERIC(24,8) NULL CHECK (payment_amount > 0)`, `term_end_date date NULL`, `note text NULL`, `version`. `UNIQUE (liability_position_id, effective_from)`. `effective_from` may be in the future (it is a term, not an observation). Audit: yes.

**`position_valuations`** — `id`, own, `position_id uuid NOT NULL → positions (id, user_id) NO ACTION`, `valued_on date NOT NULL`, `amount NUMERIC(24,8) NOT NULL`, `source valuation_source NOT NULL` (`entered, confirmed_unchanged, accepted_expected, purchase, imported, bulk_entered`), `date_precision date_precision NOT NULL DEFAULT 'exact'` (`exact, month_end`), `note text NULL`, `version`. `UNIQUE (position_id, valued_on)`; `CHECK (date_precision <> 'month_end' OR valued_on = (date_trunc('month', valued_on) + interval '1 month - 1 day')::date)`. Index `(position_id, valued_on DESC)`, `(user_id, valued_on)`. Sign: negative allowed only for cash (service rule). Delete: hard, with audit image. Audit: yes.

**`recurring_templates`** — `id`, own, `kind template_kind NOT NULL` (`income, expense, contribution`), `name text NOT NULL`, `counterparty text NULL`, `income_kind income_kind NULL` (`employment, rental, interest, dividend, freelance, bonus, other, external_inflow, adjustment`), `category_id uuid NULL → categories (id, user_id) NO ACTION`, `currency char(3) NOT NULL →`, `frequency recurrence_frequency NOT NULL` (`monthly, quarterly, semiannual, annual`), `day_of_month smallint NULL CHECK (day_of_month BETWEEN 1 AND 31)`, `start_date date NOT NULL`, `end_date date NULL`, `cash_position_id uuid NULL` (typed `cash`), `property_position_id uuid NULL` (typed `property`), `target_investment_position_id uuid NULL` (typed `investment`), `archived_at timestamptz NULL`, `version`. `UNIQUE (id, user_id)`; `CHECK ((kind = 'income') = (income_kind IS NOT NULL))`, `CHECK (income_kind IS NULL OR income_kind NOT IN ('external_inflow','adjustment'))`, `CHECK (kind <> 'expense' OR category_id IS NOT NULL)`, `CHECK (kind <> 'contribution' OR target_investment_position_id IS NOT NULL)`. **Occurrence schedule.** Occurrences are generated from a fixed anchor, never by iterating a clamping month step (which drifts permanently): the target months follow `start_date` and `frequency`, and in each the day is `day_of_month` — or `start_date`’s day when it is NULL — clamped independently to that month’s length. A monthly anchor of 31 therefore yields 31 Jan, 28 Feb (29 in a leap year), 31 Mar, 30 Apr, 31 May; an annual anchor of 29 Feb yields 28 Feb in common years and 29 Feb in leap years. Generation is then **bounded by the template’s own dates**: any generated occurrence earlier than `start_date`, or later than `end_date` when one is set, is discarded, and discarding one never moves the anchor. A template starting 2026-01-20 with `day_of_month = 5` therefore has its first occurrence on 5 Feb 2026 — January’s 5th falls inside the first target month but before the template existed.

**Settlement.** A template carries no settlement column, so in Phase 3 a template materializes **tracked-cash flows only**: an accepted income occurrence is `settlement = tracked_cash` and an accepted expense occurrence likewise, with `cash_position_id` taken from the template when it has one and otherwise left NULL under the ordinary tracked-cash null-leg rule of 8.1 (which requires a participating cash account in that currency). Settlement is never inferred from `cash_position_id` being NULL, and a one-click acceptance never asks the user to choose one. Recording income received outside tracked accounts, or an expense paid outside them or by somebody else, stays fully available manually; those settlements simply do not come from a template in Phase 3. Recurring external or untracked templates would need an explicit settlement column and are deferred to the phase that justifies one. **Archive is not a schedule boundary.** `start_date` and `end_date` define the template’s **historical schedule**; `archived_at` is a current product-state flag that hides the template from the active suggestion feed and blocks new acceptances and skips. It is undated with respect to history, so it must never be read as an effective-date cutoff: a source that genuinely stopped existing on a date says so with `end_date`. Unarchiving restores the template to the active feed and rewrites no historical schedule truth (30.10). **Frozen identity.** Once any materialized flow or `recurring_template_skips` row references the template, the fields that decide what its historical occurrences were are immutable: `kind`, `income_kind`, `category_id`, `currency`, `frequency`, `day_of_month`, `start_date` and the default position linkage the suggestion uses. `end_date` may not be moved earlier than the latest referenced occurrence. A genuine schedule or semantic change is a new template, with the old one ended or archived — editing one in place would rewrite which occurrences history is supposed to contain. Amounts are deliberately outside this rule: they are versioned in `recurring_template_terms`. The fields that stay editable are exactly `name` and `counterparty` — the only two this table carries that no engine reads — plus `end_date` under the restriction above and `archived_at` through archiving. Audit: yes.

**`recurring_template_terms`** — `id`, own, `template_id uuid NOT NULL → recurring_templates (id, user_id) CASCADE`, `effective_from date NOT NULL`, `amount NUMERIC(24,8) NOT NULL CHECK (amount >= 0)`, `gross_amount NUMERIC(24,8) NULL CHECK (gross_amount >= 0)`, `note text NULL`, `version`. `UNIQUE (template_id, effective_from)`. The term of an occurrence is the row with the **greatest `effective_from ≤ occurrence_date`** — keyed to the occurrence’s scheduled identity, never to the flow’s financial date, so an occurrence scheduled for 1 October but received on 30 September still takes October’s term. (The same shape as the liability rule of 11.3.) "From this month on" writes a term with `effective_from` equal to that occurrence’s `occurrence_date`; "This month only" writes no term at all and changes just the one materialized occurrence. Adding a later term never rewrites an already materialized flow. Audit: yes.

**`recurring_template_skips`** — `id`, own, `template_id uuid NOT NULL → recurring_templates (id, user_id) CASCADE`, `occurrence_date date NOT NULL` (the suggestion's scheduled date), `reason skip_reason NOT NULL` (`skipped, vacant, non_payment, other`), `note text NULL`, `version`. `UNIQUE (template_id, occurrence_date)`. Index `(template_id, occurrence_date)`. Domain rule: `vacant` and `non_payment` only for templates with `income_kind = 'rental'`. This is the durable record of an explicitly skipped suggestion and the **only** source of occupancy facts (11.2). Accepted occurrences are represented by the actual income/expense/transfer row carrying the same `(template_id, occurrence_date)` pair. A skip suppresses the suggestion for that occurrence and never creates a flow. An occurrence is accepted **or** skipped, never both: accept and skip each lock the template row (`SELECT … FOR UPDATE`) before checking the other table, so the two cannot interleave (20.3). Deleting the accepted flow, or deleting the skip row, makes the occurrence due again. Nothing else is scheduled or materialized. Audit: yes.

**`income_entries`** — `id`, own, `template_id uuid NULL → recurring_templates (id, user_id) NO ACTION`, `occurrence_date date NULL` (the scheduled occurrence this row materializes — scheduling metadata, immutable after creation, never the financial date), `kind income_kind NOT NULL`, `received_on date NOT NULL`, `net_amount NUMERIC(24,8) NOT NULL CHECK (net_amount >= 0)`, `gross_amount NUMERIC(24,8) NULL CHECK (gross_amount >= 0)`, `currency char(3) NOT NULL →`, `settlement income_settlement NOT NULL DEFAULT 'tracked_cash'` (`tracked_cash, reinvested, external`), `cash_position_id uuid NULL` (typed `cash`), `property_position_id uuid NULL` (typed `property`), `investment_position_id uuid NULL` (typed `investment`), `description text NULL`, `tags text[] NOT NULL DEFAULT '{}'`, `is_one_off boolean NOT NULL DEFAULT false`, `version`. `CHECK (settlement <> 'reinvested' OR (investment_position_id IS NOT NULL AND kind IN ('dividend','interest')))` (only investment distributions may be reinvested, 7.4), `CHECK (settlement = 'tracked_cash' OR cash_position_id IS NULL)`, `CHECK ((template_id IS NULL) = (occurrence_date IS NULL))` (a manual flow carries neither; a materialized occurrence carries both). Partial unique index `(template_id, occurrence_date) WHERE template_id IS NOT NULL AND occurrence_date IS NOT NULL` — one accepted entry per scheduled occurrence. Indexes `(user_id, received_on)`, `(investment_position_id, received_on)`, `(property_position_id, received_on)`, GIN on `tags`. Audit: yes.

**`expense_entries`** — `id`, own, `template_id uuid NULL → recurring_templates (id, user_id) NO ACTION`, `occurrence_date date NULL` (as on `income_entries`), `category_id uuid NOT NULL → categories (id, user_id) NO ACTION`, `incurred_on date NOT NULL`, `amount NUMERIC(24,8) NOT NULL CHECK (amount > 0)`, `currency char(3) NOT NULL →`, `settlement expense_settlement NOT NULL DEFAULT 'tracked_cash'` (`tracked_cash, untracked_self, third_party, deducted_from_asset`; UI labels: "Paid from tracked account", "Paid by me outside tracked accounts", "Paid by someone else", "Deducted from the investment's value"), `cash_position_id uuid NULL` (typed `cash`), `property_position_id uuid NULL` (typed `property`), `investment_position_id uuid NULL` (typed `investment`), `other_asset_position_id uuid NULL` (typed `other_asset`), `transfer_id uuid NULL → transfers (id, user_id) ON DELETE CASCADE` (a transfer's fee), `value_add_estimate NUMERIC(24,8) NULL CHECK (value_add_estimate >= 0)` (only for `capital_improvement` categories: the user's explicit estimate of market value added; NULL = none), `description text NULL`, `tags text[] NOT NULL DEFAULT '{}'`, `is_one_off boolean NOT NULL DEFAULT false`, `version`. `CHECK (settlement <> 'deducted_from_asset' OR investment_position_id IS NOT NULL)`, `CHECK (settlement = 'tracked_cash' OR cash_position_id IS NULL)`, `CHECK (value_add_estimate IS NULL OR property_position_id IS NOT NULL OR other_asset_position_id IS NOT NULL)`, `CHECK ((template_id IS NULL) = (occurrence_date IS NULL))`. Partial unique index `(template_id, occurrence_date) WHERE template_id IS NOT NULL AND occurrence_date IS NOT NULL`. Domain rules: a `capital_improvement` entry must link a property or other asset; `untracked_self` and `third_party` entries never carry a cash position. Indexes `(user_id, incurred_on)`, `(category_id)`, `(property_position_id, incurred_on)`, `(transfer_id)`, GIN `tags`. Audit: yes.

**`transfers`** — `id`, own, `kind transfer_kind NOT NULL` (`cash_transfer, contribution, withdrawal, investment_switch, loan_proceeds, financed_purchase, asset_purchase, asset_sale`), `occurred_on date NOT NULL`, `template_id uuid NULL → recurring_templates (id, user_id) NO ACTION`, `occurrence_date date NULL` (the same occurrence identity as the entry tables, present so an accepted `contribution` occurrence is representable; **both must be NULL in Phase 3**, which materializes `cash_transfer` only), `from_position_id uuid NULL → positions (id, user_id) NO ACTION`, `from_currency char(3) NOT NULL →`, `from_amount NUMERIC(24,8) NOT NULL CHECK (from_amount > 0)`, `to_position_id uuid NULL → positions (id, user_id) NO ACTION`, `to_currency char(3) NOT NULL →`, `to_amount NUMERIC(24,8) NOT NULL CHECK (to_amount > 0)`, `description text NULL`, `tags text[] NOT NULL DEFAULT '{}'`, `version`. `UNIQUE (id, user_id)`. `CHECK (from_position_id IS NOT NULL OR to_position_id IS NOT NULL)`, `CHECK (from_position_id IS DISTINCT FROM to_position_id)`, `CHECK (from_currency <> to_currency OR from_amount = to_amount)` (M13), `CHECK ((template_id IS NULL) = (occurrence_date IS NULL))`. Partial unique index `(template_id, occurrence_date) WHERE template_id IS NOT NULL AND occurrence_date IS NOT NULL`. Fees are `expense_entries` rows of kind `transfer_fee` with `transfer_id` (M14); the fee is its own source row, so a transfer edit never silently rewrites the fee’s account, currency, amount or date — an edit that would leave the fee incompatible either carries the fee’s new values in the same mutation or is rejected with an actionable error. Indexes `(user_id, occurred_on)`, `(from_position_id, occurred_on)`, `(to_position_id, occurred_on)`. Allowed endpoint kinds per `transfer_kind` are validated in the domain (7.5); a null side is allowed only for a cash endpoint. Audit: yes.

**`liability_payments`** — `id`, own, `liability_position_id uuid NOT NULL → positions (id, user_id) NO ACTION` (typed `liability`), `paid_on date NOT NULL`, `total_amount NUMERIC(24,8) NOT NULL CHECK (total_amount >= 0)`, `interest_amount NUMERIC(24,8) NOT NULL CHECK (interest_amount >= 0)`, `principal_amount NUMERIC(24,8) NOT NULL CHECK (principal_amount >= 0)`, `fee_amount NUMERIC(24,8) NOT NULL DEFAULT 0 CHECK (fee_amount >= 0)`, `currency char(3) NOT NULL →` (the loan's currency), `settlement liability_settlement NOT NULL DEFAULT 'tracked_cash'` (`tracked_cash, untracked`; `untracked` = paid by a third party or from an untracked account: the liability still falls, no cash leg), `cash_position_id uuid NULL` (typed `cash`), `cash_currency char(3) NULL →`, `cash_amount NUMERIC(24,8) NULL CHECK (cash_amount > 0)` (both set only when the paying cash currency differs from the loan currency; reconciliation uses the cash leg, split pro-rata between the principal and the interest+fee parts), `kind liability_payment_kind NOT NULL` (`scheduled, extra, payoff`), `source record_source NOT NULL DEFAULT 'entered'` (`entered, accepted_suggestion`), `description text NULL`, `version`. `CHECK (total_amount = interest_amount + principal_amount + fee_amount)` (M3), `CHECK ((cash_currency IS NULL) = (cash_amount IS NULL))`, `CHECK (settlement = 'tracked_cash' OR cash_position_id IS NULL)`. Indexes `(liability_position_id, paid_on)`, `(user_id, paid_on)`. Audit: yes.

**`month_reviews`** — `id`, own, `month date NOT NULL CHECK (month = date_trunc('month', month)::date)`, `reviewed_at timestamptz NULL`, `notes text NULL`, `dismissed_issues jsonb NOT NULL DEFAULT '[]'` (array of dismissed advisory issue keys — UI/reconciliation dismissal state only; never a source of financial or occupancy facts), `version`. `UNIQUE (user_id, month)`. A month can be marked reviewed only once it is completed (`today > end(month)`; service rule).

**`goals`** — `id`, own, `kind goal_kind NOT NULL` (`net_worth, financial_net_worth, investments, cash_reserve, debt_payoff, property_down_payment, passive_income, custom`), `name text NOT NULL`, `target_amount NUMERIC(24,8) NOT NULL CHECK (target_amount >= 0)`, `currency char(3) NOT NULL →`, `target_date date NULL`, `position_id uuid NULL → positions (id, user_id) NO ACTION` (debt payoff target, or a specific investment), `scenario_id uuid NULL → scenarios (id, user_id) ON DELETE SET NULL`, `status goal_status NOT NULL DEFAULT 'active'` (`active, achieved, archived`), `achieved_on date NULL`, `notes text NULL`, `version`. `UNIQUE (id, user_id)`. Audit: yes.

**`goal_positions`** — `goal_id uuid NOT NULL → goals (id, user_id) CASCADE`, `position_id uuid NOT NULL → positions (id, user_id) NO ACTION`, `user_id uuid NOT NULL`, `PRIMARY KEY (goal_id, position_id)`. The selected set for `custom` goals (any kinds; liabilities count with sign −1).

**`scenarios`** — `id`, own, `name text NOT NULL`, `description text NULL`, `is_baseline boolean NOT NULL DEFAULT false`, `current_revision_id uuid NULL`, `archived_at timestamptz NULL`, `version`. `UNIQUE (id, user_id)`; partial unique `(user_id) WHERE is_baseline`. Composite FK `(current_revision_id, id, user_id) → scenario_revisions (id, scenario_id, user_id)` `MATCH SIMPLE DEFERRABLE INITIALLY DEFERRED` (circular with the revision's `scenario_id`; deferred so a scenario and its first revision can be created in one transaction), so the current revision can only ever be a revision of this scenario owned by this user (M19). Audit: yes.

**`scenario_revisions`** — `id`, own, `scenario_id uuid NOT NULL → scenarios (id, user_id) CASCADE`, `revision_no int NOT NULL`, `parent_revision_id uuid NULL`, `starting_state jsonb NOT NULL`, `starting_state_meta jsonb NOT NULL`, `definition jsonb NOT NULL`, `definition_schema_version int NOT NULL`, `engine_version text NOT NULL`, `change_summary text NULL`, `created_at`. `UNIQUE (scenario_id, revision_no)`, `UNIQUE (id, scenario_id, user_id)` (target of the two composite FKs); composite FK `(parent_revision_id, scenario_id, user_id) → scenario_revisions (id, scenario_id, user_id)` `MATCH SIMPLE` (a parent must be a revision of the same scenario and user; NULL for the first revision); `CHECK (parent_revision_id IS DISTINCT FROM id)`. Immutable (no UPDATE grant).

**`projection_runs`** — `id`, own, `revision_id uuid NOT NULL → scenario_revisions (id, user_id) CASCADE`, `engine_version text NOT NULL`, `mode run_mode NOT NULL` (`deterministic, monte_carlo`), `seed bigint NULL`, `params jsonb NOT NULL`, `params_hash text NOT NULL`, `status run_status NOT NULL` (`queued, running, succeeded, failed`), `result jsonb NULL`, `error_code text NULL`, `started_at timestamptz NULL`, `finished_at timestamptz NULL`. `UNIQUE (revision_id, engine_version, mode, seed, params_hash)`. Disposable.

**`audit_entries`** — `id`, `user_id uuid NOT NULL → user CASCADE`, `actor_user_id uuid NULL`, `entity_table text NOT NULL`, `entity_id uuid NOT NULL`, `action audit_action NOT NULL` (`insert, update, delete`), `before jsonb NULL`, `after jsonb NULL`, `changed_fields text[] NOT NULL DEFAULT '{}'`, `reason text NULL`, `request_id text NULL`, `occurred_at timestamptz NOT NULL DEFAULT now()`. Index `(user_id, entity_table, entity_id, occurred_at DESC)`. `app_user`: INSERT and SELECT only.

### 6.3 Delete behavior summary

| Table | User action | Mechanism |
|---|---|---|
| positions + subtypes | "Close" (keeps history) or "Delete" (only when no history) | status change; `NO ACTION` FKs from valuations/flows guarantee no orphaned history while the whole-account cascade still succeeds |
| valuations, income, expenses, transfers, payments | Delete | hard delete + audit before-image; deleting a transfer also removes its linked fee entry, which the service deletes first with its own audit before-image, so the `ON DELETE CASCADE` never removes a financial fact that went unrecorded |
| categories | Archive | `archived_at`; `NO ACTION` FK from expense entries blocks deletion while referenced |
| templates | Archive | `archived_at`. Materialized flows keep their `(template_id, occurrence_date)` identity, so the FKs from `income_entries`, `expense_entries` and `transfers` are `NO ACTION`: a template with accepted history can be archived but never hard-deleted. A hard delete is possible only while no materialized flow references it, and then cascades its terms and skips |
| recurring_template_skips | Un-skip | hard delete + audit image |
| goals | Archive; hard delete allowed (cascades `goal_positions`) | cascade |
| scenarios | Archive; hard delete allowed (cascades revisions and runs) | cascade |
| user | Delete account | `ON DELETE CASCADE` from every table reaches every row; verified by a test that counts rows per table before/after |

### 6.4 Why not separate snapshot tables per kind

Five snapshot tables would mean five freshness implementations, five bulk-editor adapters, five net-worth branches and polymorphic references without foreign keys from transfers. The supertype costs one join per subtype read and buys real FKs, one valuation engine and uniform RLS. Subtype-specific behavior (overdrafts, purchase-price seeding, payment-derived liability balances, flow-adjusted investments vs. valuation-only properties, the other-asset inclusion flag) lives in the domain layer keyed by `positions.kind`.

---

## 7. Financial calculation model

### 7.1 Representation by layer

| Layer | Representation | Rule |
|---|---|---|
| PostgreSQL | `NUMERIC(24,8)` amounts, `NUMERIC(24,12)` FX, `NUMERIC(12,8)` rates | Exact. No float columns anywhere. |
| Drizzle | custom column type `decimalNumeric` mapping `NUMERIC` ↔ `Decimal` (string on the wire; never `mode: 'number'`) | Application code never sees a JS `number` for money. |
| `finance` / `application` | `Decimal` from a package-local `Decimal.clone({ precision: 40, rounding: ROUND_HALF_UP, toExpNeg: -30, toExpPos: 40 })` | Cloned so third-party code cannot change global decimal.js config. |
| DTO / RSC → client boundary | `{ amount: "1234.56", currency: "EUR" }` canonical strings (no exponent) | Serializable, exact. |
| Client display | **exact string path** (7.1.1) | Money never passes through `Number` for display. |
| Charts | `number` for coordinates only | Visual precision; tooltips and tables format from the exact string. |

**7.1.1 Exact display formatting (`apps/web/src/lib/format.ts`, shared with `finance` explanations).** `formatMoney(amount: string, currency, locale)`: (1) round the decimal string to the currency's minor units with `Decimal` (half-up) and re-serialize as a plain decimal string; (2) pass that **string** to `Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: minor, maximumFractionDigits: minor })`. `Intl.NumberFormat.prototype.format` accepts decimal strings as exact mathematical values (Intl.NumberFormat v3, shipped in the browser and Node versions the project targets), so no precision is lost at any magnitude. (3) A startup self-test formats `"12345678901234567.89"` and, if the engine does not produce the exact digits, switches to the fallback assembler: split the rounded string into integer and fraction parts, group the integer part with the locale's grouping separator obtained from `formatToParts(1234567.5)`, and place the currency symbol per the same parts template. Percentages follow the same path with `style: 'percent'`. Charts receive `Number(amount)` for coordinates only. Lint: `parseFloat`, `Number(`, and unary `+` are banned on identifiers named `amount|balance|value|rate|price|total` in `finance`, `application`, `db` and the format module.

### 7.2 Precision, scale and input validation

- Storage scale 8 (headroom for unit prices and future needs); integer digits 16.
- Input scale: a user-entered amount may not have more decimals than the currency's `minor_units` (EUR 2, JPY 0, KWD 3, CLF 4; any value 0–8 from the seed). Enforced in Zod (`moneyInput(currency)`) and again in the domain; display uses the same minor units. Rates accept up to 6 decimals as percentages and are stored as fractions.
- Computed values are never truncated silently: when a computed amount is persisted (accepted expected balance, accepted suggested payment), it is rounded to minor units first and the rounding is part of the record (source flag).

### 7.3 Rounding boundaries

1. Inside engines: none (40 significant digits).
2. Amortization schedule rows: interest and payment rounded half-up to minor units per month; principal = payment − interest; the last row absorbs the residual.
3. Persisted computed values: minor units, half-up.
4. Display: minor units, half-up. Percentages: 2 decimals (1 in dense tables). Abbreviations only on chart axes.
5. Displayed sums equal displayed parts: components are rounded individually and the rounding residual is added to the designated residual component (`reconcileRoundedParts`).
6. Half-up, away from zero everywhere (decimal.js `ROUND_HALF_UP`; `Intl` `halfExpand`).

### 7.4 Semantic matrix

Every record type has exactly one meaning in each dimension: its role in tracked-cash reconciliation (Section 8), its effect on **total** net worth, its bucket in the total-net-worth drivers decomposition (Section 12), and its classification in spending analytics. `I` = external cash inflow, `Nin` = non-income cash inflow, `Nout` = non-expense cash outflow, `K` = known tracked expense outflow, `—` = no cash role. Financial-net-worth differences are in 12.4.

| Record | Kind / settlement | Cash role | Total-NW effect | Drivers bucket | Spending analytics |
|---|---|---|---|---|---|
| income | employment, freelance, bonus, rental, other; `tracked_cash` | I | + | Income | — |
| income | dividend, interest; `tracked_cash` | I | + | Investment income | — |
| income | dividend, interest linked to an investment; `reinvested` (the only records allowed to use `reinvested`; schema CHECK) | — | 0 (already in value) | — (memo) | — |
| income | dividend, interest linked to an investment; `external` (distribution paid to an untracked account) | — | − d (the ex-distribution drop is inside the investment's value; nothing arrives in tracked cash) | Investment income (+d) **and** External outflows (−d); the drop sits in Investment returns; the three lines net to −d. Counts in `Dout` (9.2); not in `ExternalIncome`, `TrackedSavingsFromIncome` or `PersonalSavings` (12.5) | — |
| income | `external_inflow` | I | + | External inflows | — |
| income | `adjustment` | I | + | Adjustments | — |
| income | employment, freelance, bonus, rental, other; `external` (received outside the tracked balance sheet) | — | 0 (never entered the tracked system) | — (informational income the user chose to record; in no bucket and not in `ExternalIncome`, `TrackedSavingsFromIncome` or `PersonalSavings`) | — |
| expense | consumption kinds (general … major_purchase, custom, tax); `tracked_cash` | K | − | Spending | tracked consumption (by category) |
| expense | any kind; `untracked_self` ("Paid by me outside tracked accounts") | — | 0 (the source account is outside the tracked system) | — (memo) | **additional spending** (the user's own spending; by category, marked; in total spending; in a projection baseline only by opt-in) |
| expense | any kind; `third_party` ("Paid by someone else") | — | 0 | — (memo) | **paid by others** (informational; never in totals or baselines) |
| expense | `property_operating`; `tracked_cash` | K | − | Property costs (rental) / Spending (non-rental) | property costs / tracked consumption |
| expense | `investment_fee`; `tracked_cash` | K | − | Interest & fees | investment costs |
| expense | `investment_fee`; `deducted_from_asset` | — | 0 | — (memo) | investment costs (memo) |
| expense | `transfer_fee` (linked to a transfer) | K | − | Interest & fees | fees |
| expense | `acquisition_cost`, `disposal_cost` | K | − | Transaction costs | transaction costs |
| expense | `capital_improvement` (linked to a property/other asset) | Nout | − amount (+ `value_add_estimate` if given) | − Capital improvements; + Estimated value added (labelled estimate) | capital expenditure (never consumption) |
| expense | `external_outflow` | K | − | External outflows | excluded from consumption |
| unclassified inferred spending | derived | (residual) | − | Spending | tracked consumption (unclassified) |
| transfer | `cash_transfer` | Nout (from) + Nin (to) | 0 | — | — |
| transfer | `contribution` | Nout | 0 | allocation view: → investments | — |
| transfer | `withdrawal` | Nin | 0 | allocation view: ← investments | — |
| transfer | `investment_switch` | — | 0 | — | — |
| transfer | `loan_proceeds` | Nin | 0 | allocation view: ← debt | — |
| transfer | `financed_purchase` | — | 0 | — | — |
| transfer | `asset_purchase` | Nout | 0 | allocation view: → assets (financial view: − Purchases of excluded assets when the target is an excluded other asset) | — |
| transfer | `asset_sale` | Nin | 0 | allocation view: ← assets (financial view: + Sales of excluded assets) | — |
| liability payment | principal part; `tracked_cash` | Nout | 0 | allocation view: → debt reduction | — |
| liability payment | interest + fee parts; `tracked_cash` | K | − | Interest & fees | interest |
| liability payment | any; `untracked` | — | + principal | External inflows (+total) and Interest & fees (−interest−fee) | — |
| valuation change | investment (net of flows), property, other asset | — | ± | Investment returns / Property revaluation / Other-asset revaluation | — |
| valuation change | liability (confirmed vs derived) | — | ∓ (sign −1) | Debt adjustments | — |
| first valuation of a position | any kind | — | ± (sign) | Newly tracked | — |
| FX residual | derived | — | ± | FX effect | — |

**`external` and the two kinds of distribution.** The matrix covers `external` twice, and they are different facts: ordinary income (`employment`, `freelance`, `bonus`, `rental`, `other`) received outside the tracked balance sheet is purely informational, while a `dividend` or `interest` distribution **linked to an investment** and paid externally carries the investment-performance credit paired with an equal external outflow (F5). A `dividend` or `interest` row with `settlement = external` and **no** investment link falls under neither row, and Phase 3 — which has no investment positions at all — can only ever produce that uncovered case. Phase 3 therefore accepts `external` for the five ordinary kinds only and keeps `dividend` and `interest` to `tracked_cash`, which is what the 8.10 golden’s €31 of interest needs. External distributions arrive in Phase 4 together with the investment link and the +d/−d decomposition that gives them meaning.

### 7.5 Transfer kinds and allowed endpoints

| `transfer_kind` | from → to | Null side allowed | Meaning |
|---|---|---|---|
| `cash_transfer` | cash → cash | no | Same or cross currency; an optional fee is a linked `transfer_fee` expense entry. |
| `contribution` | cash → investment | from may be null (currency required) | Capital into an investment. |
| `withdrawal` | investment → cash | to may be null | Capital (or gains) out of an investment. |
| `investment_switch` | investment → investment | no | Rebalance; withdrawal from A and contribution to B in one record. |
| `loan_proceeds` | liability → cash | to may be null | New borrowing; liability balance increases by `from_amount`. |
| `financed_purchase` | liability → property \| other_asset | no | Loan disbursed directly to the asset (mortgage at purchase). |
| `asset_purchase` | cash → property \| other_asset | from may be null | Down payment or full price; the asset's purchase valuation is written in the same transaction. |
| `asset_sale` | property \| other_asset → cash | to may be null | Net proceeds to cash. |

Capital improvements are **not** transfers (R19). Liability-reducing flows are `liability_payments`.

### 7.6 Money and Decimal API (package `finance/money`)

```ts
type CurrencyCode = string & { readonly __brand: 'CurrencyCode' };
interface Money { readonly amount: Decimal; readonly currency: CurrencyCode }
add(a, b) / sub(a, b)        // throws CurrencyMismatchError unless same currency
mul(m, k: Decimal) / div(m, k) / neg / abs / isZero / cmp / sum(list, currency)
roundToMinor(m, minorUnits)  // only at boundaries (7.3)
allocate(m, weights[])       // largest-remainder split that sums exactly
class MoneyBag               // Map<CurrencyCode, Decimal>; add(Money); entries(); convert(fx, date, to) → Money | Unavailable
serialize(m) → { amount: string; currency } ; parse(dto) → Money
```

`Unavailable` is a first-class value (`{ kind: 'unavailable', reason }`), never `0`, never `null`. Aggregations over a list containing an `Unavailable` produce `Partial<Money>` (`{ value, missingCount, reasons }`).

### 7.7 Rates and dates

| Quantity | Stored as | Monthly conversion | Used by |
|---|---|---|---|
| Loan annual nominal rate | fraction | `r / 12` | amortization |
| Expected return, appreciation, salary growth, rent growth, inflation | fraction | `(1 + r)^(1/12) − 1` | projection engine |
| Monte Carlo volatility | fraction (annual σ) | `σ / √12` on log returns | stochastic paths |

Dates in the domain are ISO `YYYY-MM-DD` strings wrapped as `PlainDate` with helpers (`endOfMonth`, `addMonths`, `daysBetween`, `monthKey`, `isMonthEnd`). "Today" is computed once per request in the user's timezone and passed in the context; engines never call `Date.now()`. Every validator for an actual record checks `date ≤ today` (M5).

### 7.8 Sign convention (finance core, `finance/positions/sign.ts`)

```ts
export const netWorthSign = (kind: PositionKind): 1 | -1 => (kind === 'liability' ? -1 : 1);
```

Every generic aggregation and decomposition uses it: `NW(t) = Σ_p s(p)·V_p(t)·r_p(t)`; a position's signed change is `ΔNW(p) = s(p)·ΔV(p)`; a flow that increases a liability's balance therefore decreases net worth. Liability balances stay positive in storage and in the UI. Proofs of the two canonical cases (with `r ≡ 1`):

- **Loan proceeds X:** cash `+X` (s = +1) → `+X`; liability balance `+X` (s = −1) → `−X`; `ΔNW = 0`.
- **Principal repayment X:** cash `−X` → `−X`; liability balance `−X` × (−1) → `+X`; `ΔNW = 0`.
- Interest part `I`: cash `−I`, liability unchanged → `ΔNW = −I` (cost).
- Debt adjustment (confirmed balance exceeds derived by `A`): liability revaluation `+A` × (−1) → `ΔNW = −A`.
- FX on a USD loan when USD strengthens (`r1 > r0`): FX residual `B0(r1 − r0) > 0` × (−1) → negative effect.

No special-case intuition is used anywhere: the property tests in 21.2 exercise the sign through random positions.

---

## 8. Reconciliation / inferred-spending algorithm

### 8.1 Definitions

- **Month M**: calendar month in the user's timezone. `end(M)` is its last day. A month is **completed** when `today > end(M)`; it is the **current month** when `start(M) ≤ today ≤ end(M)`.
- **Month-end balance** of account `a` for M: a valuation with `valued_on = end(M)` **and** `date_precision = 'month_end'` ("the balance at the end of M as read from a statement"). It can be written only once the month has ended (`today > end(M)`, M5): on 1 October a user may type September's statement balance, or confirm an exact snapshot dated 30 September as the statement-end value (which upgrades that row's precision, audited), or import a statement whose financial date is 30 September. An exact snapshot dated the last day of the month is, until then, an ordinary snapshot. "Confirm unchanged for this month" writes a month-end valuation (`source = confirmed_unchanged`) equal to the previous month-end balance, and is likewise available only once the month has ended.
- **Same-day rule**: a valuation dated `d` reflects every flow dated `≤ d`.
- **Bucket (M, C)**: all cash positions of currency C open at any time during M: `(opened_on IS NULL OR opened_on ≤ end(M)) AND (closed_on IS NULL OR closed_on ≥ start(M))`.
- **Closing state** `close(a, M)`: `month_end` if a month-end balance exists; `closed_zero` if `closed_on ∈ M` (balance 0 by definition); `dormant_zero` if `is_dormant` and no month-end balance (carried 0); `carried` if the latest valuation ≤ `end(M)` exists but is not a month-end balance for M; `missing` if no valuation ≤ `end(M)` exists.
- **Opening state** `open(a, M)` = `close(a, M−1)`, except `opened_zero` if `opened_on ∈ M`, and `first_balance` if the account has no valuation before `start(M)` but has its first month-end balance at `end(M)` (a pre-existing account that starts being tracked this month).
- **Flows in (M, C)**: records dated within M (calendar) whose cash leg has currency C and `settlement = tracked_cash` (transfers: the cash side), per 7.4. A flow with a null cash position but currency C belongs to the bucket; validation requires a participating cash account of that currency. Flows referencing a specific cash position must have that position's currency. A cross-currency liability-payment cash leg is split pro-rata between the principal and interest/fee parts.
- **Included accounts**: those with both `open` and `close` in `{month_end, opened_zero, closed_zero, dormant_zero}`. Accounts whose opening is `first_balance` are **excluded** from the bucket for M (their Δ and their attributed flow legs), with the info issue `first_balance`; their first valuation is a "newly tracked" amount (12.3), not cash change.

### 8.2 Identity

For a bucket (M, C), in native currency C, with `Δ = Σ_{a ∈ included} (close_a − open_a)` and sums over the month's flows (attributed to included accounts, or null-leg):

```
TrackedTotalSpending  = Σ I + Σ Nin − Σ Nout − Δ
Unclassified          = TrackedTotalSpending − Σ K
```

Equivalently `open + I + Nin − Nout − K − close = Unclassified` (spec §17). Same-currency `cash_transfer`s contribute `+x` (Nin) and `−x` (Nout) and cancel; cross-currency transfers hit two buckets. The identity holds exactly for any numbers; the algorithm's job is to decide whether they are trustworthy.

The two kinds of quantity in that identity behave differently when evidence is missing, and 8.9 keeps them apart. `ΣI`, `ΣNin`, `ΣNout` and `ΣK` are sums of **source records** over the flow scope 8.1 defines — currency C, dated in M, attributed to a participating non-`first_balance` account or to no account at all. They need no balance evidence, so they are exact in every status, and a zero among them means no such record exists rather than "unknown". `Δ` is **balance-derived** and is the change over the *complete* included set; a sum over part of that set is a different quantity and is not `Δ` (30.12). The role sums alone are not a spending figure: only the identity turns them into one, and only when `Δ` exists.

### 8.3 Algorithm (completed months)

```
reconcileMonth(user, M):                     // M completed
  currencies ← currencies with ≥ 1 participating cash position ∪ currencies of null-leg flows dated in M
  for each currency C:
    accounts ← participating positions in (M, C)
    if accounts is empty: emit { C, status: 'unavailable', issues: [flow_without_cash_account] }; continue
    for a in accounts: open(a), close(a) per 8.1
    included ← accounts with both ends OK; excluded ← accounts with opening 'first_balance'
    if any account (not excluded) has an end in {carried, missing}: status ← 'unavailable' (issues: missing_month_end per account); emit; continue
    flows ← flows in (M, C) attributed to included accounts, plus null-leg flows; grouped by role (I, Nin, Nout, K)
    Δ ← Σ_{included} (close_a − open_a)
    total ← ΣI + ΣNin − ΣNout − Δ ;  unclassified ← total − ΣK
    status ← unclassified < 0 ? 'unresolved' : (excluded non-empty ? 'estimated' : 'reliable')
    issues ← detectIssues(...)                                        // 8.5
    residuals ← per included account: (close_a − open_a) − Σ attributed flows of a   // diagnostics
    emit BucketResult { C, accounts[], totals { I, Nin, Nout, K }, Δ, total, unclassified, status, issues, residuals, explanation[] }
  emit MonthReconciliation { M, buckets[], monthStatus = worst(bucket statuses), completeness (12.5) }
```

### 8.4 Status classification

| Status | Condition | Meaning shown to user |
|---|---|---|
| `unavailable` | Any participating, non-excluded account has `carried`/`missing` at either end; or no included account; or a null-leg flow has no account. For the current month also: no common as-of date `D` exists, or a bucket has no usable opening (8.6) | "Spending can't be inferred for September: month-end balance missing for BBVA." Net worth still shows (stale-labelled). Actions: enter the month-end balance; confirm unchanged. |
| `unresolved` | Computed but `unclassified < 0` (native currency, tolerance exactly 0), or open blocking issues. Applies to the current month too: `provisional` describes when the evidence stops, not whether it adds up, so a month-to-date bucket whose records contradict each other is `unresolved` (8.6, 30.13) | The wording follows the issue’s variant (8.5): with a negative tracked total, "Cash grew €102 more than your records explain."; with a non-negative one, "Known expenses exceed the cash that left." Total spending shown as "≥ €411 (known)". |
| `estimated` | Computed, `unclassified ≥ 0`, at least one excluded `first_balance` account | "Estimated — Savings started being tracked this month; its earlier movements are not included." |
| `reliable` | All participating accounts included, `unclassified ≥ 0`, no blocking issues | Plain number. |
| `provisional` | Current month only (8.6), through the latest date `D` in the month on which every **snapshot-required included** account has an exact snapshot (8.6 defines the set); if no such date exists the current month's spending is `unavailable` with the `mtd_no_common_date` issue. A `first_balance` exclusion leaves the current month `provisional` with its info issue, never `estimated` | "Month-to-date is through 6 Sep (provisional)"; when some accounts have newer individual balances: "Some accounts have newer individual balances; update all accounts to move the MTD date forward."; without any common date: "Update all cash accounts to the same date to calculate month-to-date spending." |

Month status = worst across buckets (`unavailable > unresolved > provisional > estimated > reliable`); the reporting-currency total is `partial` when any bucket is `unavailable`. A dormant account never affects status but is listed in the metadata ("dormant, carried at 0").

### 8.5 Issues catalogue

| Issue key | Trigger | Class | Suggested actions (each creates or edits an explicit record; nothing automatic) |
|---|---|---|---|
| `missing_month_end` | account closing (or opening) `carried`/`missing` for a completed month | blocking | Enter month-end balance (from the statement); Confirm the last-day snapshot as month-end; Confirm unchanged for this month; Mark dormant (only if balance is 0); Close account |
| `mtd_no_common_date` | current month: no date in the month on which every **snapshot-required included** account has an exact snapshot (8.6), including the case where no candidate date has an included account at all | blocking for MTD only, and **global**: the whole month-to-date result is `unavailable` with no reconciliation totals (8.6); balances still shown | Update all cash accounts today (Quick update, all accounts pre-selected) |
| `mtd_newer_balances` | current month: MTD is valid through `D`, and an account that is **included and snapshot-required at `D`** has an exact valuation dated after `D` and on or before today. Accounts excluded as `first_balance`, accounts not yet open at `D`, and accounts structurally zero at `D` are not counted: a newer balance on one of those could not move `D` | advisory (MTD stays valid through `D`) | Update all cash accounts today to move the MTD date forward |
| `first_balance` | pre-existing account first tracked in M | info | Enter an earlier month-end balance (bulk editor) if known |
| `flow_without_cash_account` | null-leg flow in a currency with no participating cash account | blocking | Choose the cash account; add the account |
| `unexplained_inflow` | `unclassified < 0`. Variant A when `total < 0` ("cash grew more than your records explain"); variant B when `total ≥ 0` ("known expenses exceed the cash that left; an inflow may be missing, or an expense was paid from outside tracked cash"). The trigger already implies `ΣK > total`, so that comparison cannot separate the two (30.11); the sign of the tracked total does, with exactly zero on variant B’s side because a tracked total of zero is not cash growth. The amount reported is `−unclassified`, in both variants | blocking | Add income; Add withdrawal/loan proceeds/asset sale; Add transfer from another currency; Correct a balance; Mark an expense as paid from an untracked source; Accept as adjustment (creates `income_entries.kind = adjustment`) |
| `possible_missing_conversion` | bucket C1 has `unexplained_inflow` X and bucket C2 has a spending spike ≥ X converted within ±5 % at the month's average rate | advisory | Link as cross-currency transfer (prefilled) |
| `possible_missing_interest` | per-account residual on a savings/brokerage_cash account is positive and < 0.5 % of its balance | advisory | Record interest income (prefilled) |
| `suggested_income_missing` | active income template with an occurrence scheduled in M for which no flow carries that `(template_id, occurrence_date)` and no `recurring_template_skips` row exists | advisory | Accept suggestion (date ≤ today); Skip this occurrence (writes a `recurring_template_skips` row; rental templates ask for a reason) |
| `suggested_payment_missing` | liability with terms and no payment in M | advisory | Accept suggested payment; Skip |
| `large_unclassified` | unclassified > 2 × trailing-6-month median of reliable months | advisory | Add known expenses |
| `stale_investment` / `stale_property` | age > threshold | advisory (completeness only) | Update valuation; Keep |

Dismissing an advisory issue writes its key to `month_reviews.dismissed_issues`. Blocking issues are resolved by data or left open (`unresolved`).

### 8.6 Current month: month-to-date (provisional)

For the current month the engine computes a **provisional month-to-date** figure, clearly labelled and never stored as monthly spending, and only when the arithmetic is valid:

- **Opening**: per account exactly as in 8.1 — `close(a, M−1)`, the previous month-end balance, for an existing account; `opened_zero` for an account with `opened_on ∈ M`; `dormant_zero` for a dormant account; `first_balance` for a pre-existing account whose first valuation falls in M, which is **excluded** from the MTD bucket (its balance change and its attributed flow legs) with the info issue `first_balance`, exactly as for a completed month. If any non-excluded participating account has no usable opening (`carried`/`missing`), MTD is `unavailable` with reason `missing_opening`.
- **Common as-of date `D`**: the **latest** date in M (≤ today) on which the included account set is **non-empty** and every **snapshot-required included** account has an exact snapshot dated exactly that day. `D` is **global**: one date for the whole current-month result, chosen over the snapshot-required included accounts of every native currency together, so an account with weaker evidence moves `D` back for every bucket and the phrase "month-to-date through 6 Sep" is true of the whole view. An included account is snapshot-required unless its value at `D` is already known structurally: an account with `closed_on ≤ D` is worth zero (`closed_zero`) and a `dormant_zero` account carries zero, so neither needs a snapshot at `D` — while both still contribute their attributed flows through `D`. Everything else does: an account with `closed_on > D` is still open at `D`, and an account opened in M (`opened_zero`) needs one too, because opening at zero says nothing about its value at `D`. Accounts excluded as `first_balance` take no part in the MTD bucket and therefore no part in choosing `D`; the classification is made once for M from the evidence available through today, not re-decided per candidate date, so an account whose first valuation lands on the 8th is the month's `first_balance` exclusion at a candidate of the 6th as well. An account with `opened_on > d` does not participate in the interval `[start(M), d]` at all: it needs no snapshot at `d`, contributes no balance change and can carry no attributed flow, so opening an account later in the month never invalidates an earlier common date. Accounts may have newer individual snapshots than `D` (BBVA on the 6th and the 8th, Savings on the 6th → `D` = 6 Sep): MTD remains valid through `D`, and the advisory `mtd_newer_balances` reads "Month-to-date is through 6 Sep. Some accounts have newer individual balances; update all accounts to move the MTD date forward." Only when no date in the month is shared by every account (BBVA only on the 6th, Savings only on the 3rd) is MTD `unavailable`, with issue `mtd_no_common_date` and the message "Update all cash accounts to the same date to calculate month-to-date spending."; individual balances are still displayed with their own dates. The engine never pairs a balance from one date with a flow cut-off from another, never interpolates or rolls balances back, and never emits a knowingly biased figure.
- **An empty inclusion set is not evidence.** The snapshot predicate is satisfied without any snapshot when every included account is structurally known — all `closed_zero` or `dormant_zero` — and such a date is a valid `D`, up to and including today. It is **not** satisfied when there is no included account at all, whether because every participating account is excluded as `first_balance` or because none participates through the candidate date: there is nothing to reconcile, and a vacuous truth must not produce a month-to-date figure of zero. If no candidate date in the month yields a non-empty included set with its evidence, MTD is `unavailable` with `mtd_no_common_date`.
- **No `D` means no month-to-date arithmetic at all.** Flows are those dated `≤ D`, so without `D` there is no interval and therefore no MTD figure of any kind: no `ΣI`, `ΣNin`, `ΣNout` or `ΣK`, and no `cashDelta`, `trackedTotalSpending` or `unclassified`. Summing the month's records to today instead would pair a flow cut-off with no balance date at all, which is the one thing this engine must never do. The result carries no `asOf`, the status `unavailable` and the reason `mtd_no_common_date`; individual account balances are still displayed with their own dates, and they are not a reconciliation total.
- Flows: those dated `≤ D`, inclusive — the snapshot at `D` reflects every flow dated on or before it (8.1's same-day rule).
- `MTD spending = ΣI + ΣNin − ΣNout − Σ_{included accounts} (balance at D − opening)`; `unclassified` likewise; status `provisional` with "through D" (and the `first_balance` note when an account is excluded).
- **Once `D` exists, evidence is judged per bucket.** `D` is global, but each native currency reconciles on its own, so an opening that is `carried`/`missing` makes **that** bucket `unavailable` with reason `missing_opening` and leaves the others computing through the same `D`. A missing EUR opening must not erase a truthful USD reconciliation. The month's status is the worst of its buckets, so the result above is still `unavailable` overall — the difference is that the USD figure survives to be read.
- **Status precedence.** An otherwise computable bucket is `provisional`, and stays `provisional` when an account is excluded as `first_balance` — `provisional` outranks `estimated`, and the exclusion is carried as its info issue. A bucket whose arithmetic ran but whose `unclassified < 0` is `unresolved`, exactly as for a completed month and with the same variant split (8.5, 30.11): the month being unfinished is the weaker fact, and `provisional` must not hide records that contradict each other. A bucket whose arithmetic could not run is `unavailable`. The MTD engine therefore emits only `provisional`, `unresolved` and `unavailable`; `reliable` and `estimated` belong to completed months.
- **Which issues apply.** `first_balance` (info), `flow_without_cash_account` (blocking, for a null leg dated in `[start(M), D]` whose currency has no participating cash account through `D`), `unexplained_inflow` (blocking), `mtd_no_common_date` (blocking, global) and `mtd_newer_balances` (advisory). `missing_month_end` does not: an unfinished month is not missing a statement. `possible_missing_interest` does not, because 8.6 specifies no per-account residual for the current month and the trigger has nothing to read. `suggested_income_missing` does not: an occurrence scheduled later this month has not been missed, and the current month's recurring surface is the operational one — due and upcoming suggestions, and "received today" (30.10) — not a completeness report. Without `D` no issue whose trigger needs the interval or the arithmetic is evaluated at all; only `mtd_no_common_date` is raised.
- Quick update writes snapshots dated today for **all** active cash accounts by default (dormant excluded), which is the normal way to advance the common date to today.
- The Monthly page for the current month shows MTD income, MTD tracked spending (provisional or unavailable with the message), upcoming suggested flows (dated after today; not acceptable until their date, or acceptable today with "received today", which reaches only the **earliest unresolved future occurrence** of that template — 30.10), and — from the first day of the following month — the prompt "Enter end-of-September balances to close the month." The current month stays provisional through its entire last calendar day.
- Nothing provisional feeds monthly averages, baselines or completeness.

### 8.7 Multi-month reconciliation spans

When, for bucket C, month-end balances exist for every participating account at `end(M0)` and `end(M1)` with `M1 ≥ M0 + 2` and at least one month in between is `unavailable` for lack of month-end balances, the engine computes a **span** over `(end(M0), end(M1)]` with the same identity using all flows dated in `M0+1 … M1` and the same inclusion rules:

`SpanResult { from: start(M0+1), to: end(M1), months, totals, trackedTotalSpending, unclassified, status ∈ {reliable, estimated, unresolved}, perMonthAverageInformational }`

Presentation: "Combined unclassified spending 1 Sep – 31 Oct: €722 (two months)". The months inside remain `unavailable` individually and link to the span; the span is **never** attributed to a single month, never included in monthly series or rolling averages, and never used by the projection baseline. The wealth decomposition over the same period is exact (it takes any month-end endpoints). Spans are recomputed on read (not stored) and are maximal (the longest gap between consecutive complete month ends).

### 8.8 Special cases

- **New account opened in M** (`opened_on ∈ M`): opening `opened_zero`. Money placed in it must be a transfer/income; otherwise its residual surfaces as `unexplained_inflow`.
- **Pre-existing account first tracked in M**: excluded for M (8.1); a transfer BBVA → new account of 5,000 then contributes only its BBVA leg (`Nout` 5,000) against BBVA's Δ of −5,000, so spending is unaffected. Month `estimated`.
- **Account closed in M**: closing `closed_zero`. The remaining balance must have been transferred out or it becomes spending; the close flow asks "Where did the remaining €X go?".
- **Dormant account**: carried at 0 without confirmation; any non-zero balance or attributed flow clears `is_dormant` and the month then needs a month-end balance. An **attributed** flow is a tracked-cash income or expense whose cash position is that account, or a transfer with that account on either side; a null-leg flow attributes to no account and clears nothing. The clear happens inside the flow’s own transaction and is audited, and it applies to a back-dated flow as well — the conservative direction, because clearing only ever asks for more evidence, whereas keeping the flag would let an assumption make a month look reliable. Deleting the last attributed flow does **not** restore dormancy: dormancy is a user assertion, re-made only through the explicit action, which requires the latest balance to be exactly zero.
- **Intra-month snapshots** (quick updates): used for net worth, history charts and month-to-date only; they never close a completed month. A snapshot dated the last day of the month is still an ordinary snapshot; once the month has ended the editor offers to confirm it as the statement-end balance (upgrading its precision) or to enter the statement figure. A month that has only ordinary snapshots is `unavailable` until a month-end balance exists.
- **Cross-currency transfer**: `from_amount` is `Nout` in C1; `to_amount` is `Nin` in C2; the fee is a `transfer_fee` expense (`K`). Neither bucket sees an FX effect.
- **Contribution with null source / withdrawal with null destination**: `Nout`/`Nin` in the bucket of the stated currency.
- **Two valuations on the same date**: impossible (M1); a correction edits the row.
- **Zero-balance dormant accounts**: never block.

### 8.9 Data-quality metadata (DTO)

```ts
interface BucketResult {
  currency; status: 'reliable' | 'estimated' | 'provisional' | 'unavailable' | 'unresolved';
  accounts: { positionId; opening: { amount?, valuedOn?, state }; closing: { … }; residual?; dormant?: boolean }[];
  totals: { externalInflows; nonIncomeInflows; nonExpenseOutflows; knownTrackedExpenses; cashDelta?; trackedTotalSpending?; unclassified? };
                                     // the four role sums are exact in every status (8.2, 30.12);
                                     // cashDelta is the complete included-set change or absent;
                                     // trackedTotalSpending and unclassified need cashDelta
  additionalSpending;                // untracked_self expenses in this currency and month (never in the identity)
  thirdPartyPaid;                    // third_party expenses (informational; never in totals)
  mtd?: { asOf?: PlainDate; status: 'provisional' | 'unavailable'; reason?: 'mtd_no_common_date' | 'missing_opening'; accountsWithNewerBalances: PositionId[] };
}

// The current month's own result (8.6). Two shapes, because without a common
// as-of date there is no interval to report totals over — and a type that could
// hold both an absent D and a set of totals would invite inventing them.
type MonthToDateResult =
  | { month; asOf: null; status: 'unavailable'; reason: 'mtd_no_common_date'; issues: Issue[] }   // no D: no buckets, no totals
  | { month; asOf: PlainDate; status; buckets: BucketResult[]; accountsWithNewerBalances: PositionId[]; issues: Issue[] };
  issues: Issue[];
  explanation: string[];             // formula lines with the actual inputs, for "How was this calculated?"
}
```

### 8.10 Worked examples

**Golden test `reconciliation/basic-eur-september`.** EUR bucket, September 2026 (completed). Accounts: BBVA (checking), Savings. All balances are month-end.

| Input | Value |
|---|---|
| BBVA month-end balances | 31 Aug: 8,055.00; 30 Sep: 7,880.00 |
| Savings month-end balances | 31 Aug: 8,509.00; 30 Sep: 8,740.00 |
| Income | 25 Sep net salary 2,100.00 → BBVA |
| Transfer | 5 Sep cash_transfer BBVA → Savings 200.00 |
| Transfer | 10 Sep contribution BBVA → S&P 500 (EUR) 1,000.00 |
| Liability payment | 1 Sep mortgage 346.00 = interest 111.00 + principal 235.00, from BBVA |
| Expense | 12 Sep insurance 300.00 from BBVA |
| Expense | 20 Sep dinner 80.00, `settlement = third_party` (paid by a partner) |
| Expense | 22 Sep coffee 50.00, `settlement = untracked_self` (paid from an old, untracked account) |

`Δ = (7,880 − 8,055) + (8,740 − 8,509) = −175 + 231 = 56`. `ΣI = 2,100`. `ΣNin = 200`. `ΣNout = 200 + 1,000 + 235 = 1,435`. `ΣK = 300 + 111 = 411` (neither untracked expense is in K).
`TrackedTotal = 2,100 + 200 − 1,435 − 56 = 809`. `Unclassified = 809 − 411 = 398`. Status `reliable`. Additional spending: 50. Total spending: 859. Paid by others (informational): 80, excluded from every total and from projection baselines.
Per-account residuals: BBVA `−175 − (2,100 − 200 − 1,000 − 346 − 300) = −429`; Savings `231 − 200 = +31` → advisory `possible_missing_interest`. `398 = 429 − 31` ✓.
If the €31 interest is recorded: `ΣI = 2,131`, `Total = 840`, `Unclassified = 429`. If the salary is forgotten: `Total = −1,291` → `unresolved`, `unexplained_inflow: 1,702`, **variant A** (the tracked total is negative, so cash grew more than the records explain — which is exactly the missing salary).

**Golden test `reconciliation/span-sep-oct`.** Same accounts; September month-end balances missing; October month-end balances: BBVA 7,700.00, Savings 8,900.00. Flows in Sep + Oct: two salaries (2,100 each), two transfers to Savings (200 each), two contributions (1,000 each), two mortgage payments (346 = 111 + 235 each), insurance 300 (Sep), car repair 450 (Oct).
September: `unavailable` (`missing_month_end`). October: `unavailable` (opening missing). Span 1 Sep – 31 Oct: `Δ = (7,700 − 8,055) + (8,900 − 8,509) = 36`; `ΣI = 4,200`; `ΣNin = 400`; `ΣNout = 400 + 2,000 + 470 = 2,870`; `ΣK = 300 + 450 + 222 = 972`; `Total = 4,200 + 400 − 2,870 − 36 = 1,694`; `Unclassified = 722`. Presented as "combined Sep–Oct"; both monthly cells stay empty in the Spending series.

### 8.11 Reporting-currency presentation

Known flows convert at their dated rates. Unclassified spending of bucket C converts at the monthly average rate `r̄(C→R, M)` (for a span: the average over the span's months, weighted by days) and is marked `estimatedConversion`. The month's tracked spending in R is the sum over buckets, `partial` if any bucket is `unavailable`. The FX residual of the cash positions (Section 12) absorbs the difference between these conventions and the closing-rate revaluation, so the decomposition still reconciles exactly.

---

## 9. Investment calculation model

### 9.1 Position state at a date

For investment `i` at date `t`: `V(t)` = latest valuation ≤ t, flow-adjusted: `V(t) = V(last) + Σ contributions(last, t] − Σ withdrawals(last, t]` (switches count as withdrawal on the source and contribution on the target; same-day rule). Freshness: `confirmed` if the valuation is within the requested period, `carried_adjusted` if older and flows exist since, `carried` if older with no flows, `missing` if none. Stale threshold for warnings: `user_settings.stale_investment_months`.

### 9.2 Period performance (native currency)

For period `(t0, t1]` with confirmed valuations `V0` at `t0` and `V1` at `t1`. If the investment's first valuation `V_s` (date `t_s`) falls inside the period, the period starts at `t_s` with `V0 = V_s`; **`V_s` is never performance**. An investment created with no valuation and a first contribution `c` at `t_c` starts at `t_c` with `V0 = 0` and `C ∋ c`.

```
C     = Σ contributions (incl. switch-in)      in (t0, t1]
W     = Σ withdrawals   (incl. switch-out)     in (t0, t1]
Dout  = Σ dividend/interest entries with settlement tracked_cash or external, linked to i, in (t0, t1]
Fext  = Σ investment_fee expenses with settlement tracked_cash, linked to i, in (t0, t1]
ValueChangeNet       = V1 − V0 − C + W          // pure value movement net of capital flows
Performance          = ValueChangeNet + Dout    // spec §25, gross of external fees
PerformanceNetOfFees = Performance − Fext       // display metric only
```

Availability: if `V1` is not confirmed within the period, `Performance` is `unavailable('no_valuation_in_period')`; the next valuation's month reports the span "since <date>". Reinvested distributions and deducted fees are already inside `V1`.

### 9.3 Opening net invested basis and cumulative metrics

Let `t_s` be the first valuation date and `V_s` the first valuation. Each investment may carry `opening_net_invested_basis` (`B_open`): the capital the user had invested **net of withdrawals** as of `t_s`. It is entered at onboarding ("current value" and, optionally, "amount you have invested so far, net of anything withdrawn") and can be edited later (audited). Because it is a net figure it is never presented as gross or lifetime contributions.

```
basisKnown                 = B_open is not null
OpeningNetInvestedBasis    = basisKnown ? B_open : V_s                   // without a basis the first valuation is the starting point "since tracking"
ContributionsSinceTracking = Σ C
WithdrawalsSinceTracking   = Σ W
CurrentNetInvested         = OpeningNetInvestedBasis + Σ C − Σ W
Gain                       = V_now + Σ Dout − Σ Fext − CurrentNetInvested // total gain vs net invested (incl. paid-out distributions, net of external fees)
UnrealizedGain             = V_now − CurrentNetInvested
SimpleReturn               = Gain / (OpeningNetInvestedBasis + Σ C)       // "return on net invested capital (not time-weighted)"; unavailable if the denominator is 0
GainSinceTracking          = V_now + Σ Dout − Σ Fext − (V_s + Σ C − Σ W)  // always available; equals Gain when the basis is unknown
```

Labels (UI and DTO): "Opening net invested basis", "Contributions since tracking", "Withdrawals since tracking", "Current net invested", "Gain", "Gain since tracking", "Return on net invested (not time-weighted)". Nothing is ever labelled "lifetime contributions" or "total invested"; when the basis is unknown the page says "since <t_s>" throughout. The first valuation is never treated as contributed capital when the basis is known. Richer pre-tracking history (gross contributions, gross withdrawals, distributions) is an additive future extension (6.2); when present, the net basis becomes derived from it and gross labels become available.

**Golden example (`investments/opening-basis`)**: `V_s = 41,870` on 31 Aug, `B_open = 33,359`, contribution 1,000 on 10 Sep, `V_now = 43,300` on 30 Sep. `CurrentNetInvested = 34,359`; `Gain = 43,300 − 34,359 = 8,941`; `SimpleReturn = 8,941 / 34,359 = 26.02 %`; `GainSinceTracking = 43,300 − (41,870 + 1,000) = 430`; period performance Sep = 430. Without the basis: `CurrentNetInvested = 42,870`, `Gain = 430`. The test also asserts that no DTO field or label for this investment contains "lifetime" or "total invested".

### 9.4 Reporting-currency decomposition

Let `r(t)` be the native→R rate on date t. Over `(t0, t1]`:

```
Δ_R           = V1·r(t1) − V0·r(t0)
FlowsAtDated  = Σ c_i·r(t_i) − Σ w_j·r(t_j) − Σ d_k·r(t_k)
NativePerf_R  = Performance · r(t1)
FX_R          = Δ_R − NativePerf_R − FlowsAtDated
              = V0·(r(t1) − r(t0)) + Σ c_i·(r(t1) − r(t_i)) − Σ w_j·(r(t1) − r(t_j)) − Σ d_k·(r(t1) − r(t_k))
```

An algebraic identity, so the parts always sum to `Δ_R`. **Golden (`investments/usd-fund-fx-decomposition`)**: `V0 = 10,000 USD` at `0.89`, contribution `1,000 USD` at `0.90`, `V1 = 11,300 USD` at `0.93`: `Δ_R = 1,609`, `NativePerf_R = 279`, `FlowsAtDated = 900`, `FX_R = 430` ✓.

**Relation to the wealth decomposition (12.3).** The decomposition regroups the same `Δ_R`: paid-out distributions are cash-side income at dated rates, the investment's revaluation is `ValueChangeNet·r(t1)`, and its FX residual uses position-moving flows only: `FX'_R = V0·(r1 − r0) + Σ c_i·(r1 − r_i) − Σ w_j·(r1 − r_j)`. Identity: `NativePerf_R + FX_R = ValueChangeNet·r1 + FX'_R + Σ d_k·r(t_k)`. The two FX figures differ by `Σ d_k·(r1 − r_k)` in payout months; the explain panel says so.

### 9.5 XIRR (money-weighted annualized return, since tracking began)

Cash flows from the investor's view: `−V_s` at `t_s` (or `−B_open`? **No**: the basis has no date, so XIRR always starts from the first valuation), `−c_i` at `t_i`, `+w_j`, `+d_k` (paid-out), `−f` at external fee dates, `+V_now` at `t_now`.

`NPV(r) = Σ cf_n · (1 + r)^(−(t_n − t_0)/365)` (ACT/365, decimal.js). Require ≥ 1 negative and ≥ 1 positive flow and `t_now − t_s ≥ 365 days`. Newton–Raphson from `r = 0.1`, max 60 iterations, stop at `|NPV| < 10⁻⁹·Σ|cf|` or `|Δr| < 10⁻¹²`; bisection fallback on a scanned bracket `{−0.99, −0.9, −0.5, −0.2, 0, 0.1, 0.3, 0.6, 1, 2, 5, 10}`; `unavailable('no_root')` without a bracket. Displayed as "XIRR since <t_s>"; a lifetime XIRR is shown only when dated pre-tracking flows exist (future importer), never from an undated basis. Reporting-currency XIRR converts flows at dated rates ("includes FX"). For spans < 12 months: `SimpleReturn`/`GainSinceTracking` only.

### 9.6 Errors this model prevents

| Error | Prevention |
|---|---|
| Dividend counted twice | One `income_entries` row; `Dout` enters `Performance`; the decomposition uses `ValueChangeNet` and shows the dividend under income. |
| Reinvested dividend counted as contribution | `settlement = reinvested` is neither `C` nor `Dout`. |
| Fee counted twice | Deducted fees never appear in formulas; external fees are a cost bucket and only enter `PerformanceNetOfFees`. |
| Contribution shown as return | `C` subtracted in `ValueChangeNet`; property test. |
| FX shown as native return | Native first; `FX_R` a separate identity term. |
| Carried value treated as zero return | `unavailable` in the period series; span attributed on the next valuation. |
| First valuation treated as contributed capital when history is known; a net basis mislabelled as gross or lifetime contributions | Opening net invested basis with the 9.3 labels. |
| Lifetime XIRR fabricated from an undated basis | 9.5 rule. |

### 9.7 Portfolio-level metrics

Portfolio value in R = Σ positions at `r(t)`; allocation by investment and by asset class; portfolio performance in R = Σ per-investment `NativePerf_R` (FX = Σ `FX_R`), so the portfolio decomposition also reconciles exactly. Per-currency subtotals when more than one native currency exists. Portfolio "current net invested" = Σ `CurrentNetInvested` (rows with a known basis and rows measured since tracking are marked). Portfolio XIRR uses the union of all flows converted to R.

---

## 10. FX architecture

### 10.1 Components

```ts
// packages/finance/fx — pure
interface FxTable { rateOn(quote, date): RateLookup | Unavailable; monthlyAverage(quote, month): RateLookup | Unavailable }
convert(money, to, on: PlainDate, mode: 'dated' | 'monthly_average', table): Converted | Unavailable
// Converted = { amount, rate, rateDate, source, exact: boolean, mode }
convertWithSpread({ fromCurrency, toCurrency, sourceAmount?, targetAmount?, marketRate, spreadPct, fixedFee? }): SpreadConversion
// orientation-independent haircut used by scenario conversions (13.4); SpreadConversion = { sourceAmount, destinationAmount,
//   marketEquivalent, spreadCost, fixedFee, effectiveRate }

// packages/application/fx — IO
interface FxProvider { id: string; supportedCurrencies(): Promise<CurrencyCode[]>; fetchTimeSeries(base: 'EUR', quotes, from, to): Promise<RateRow[]>; fetchLatest(base, quotes): Promise<RateRow[]> }
FxService.refreshAll()                       // cron: all supported currencies, latest + 14-day backfill
FxService.ensureHistory(currency, from)      // on first use of a currency by any user: one time-series call
FxService.loadTable(quotes, from, to)        // reads fx_rates into an FxTable for one request
```

- **Pivot:** all stored rates are `EUR → quote`. Cross rate `A→B` on date d = `rate(EUR→B, d) / rate(EUR→A, d)`; `EUR→EUR = 1`.
- **Primary provider:** Frankfurter v2 (`api.frankfurter.dev`): ECB reference rates (daily since 1999) plus other central banks' official rates; no key; time-series endpoint returns whole ranges in one call. The `currencies` table is seeded from the provider's supported fiat set; `source` records which central bank published each rate.
- **Crypto:** not a currency in v1 (R28). A crypto holding is an investment position in the fiat currency its broker reports (asset class `crypto`). Crypto-denominated positions require a pricing provider behind the same interface (deferred).
- **Fallback:** none automatic in Phase 1. A conversion with no rate is `Unavailable`, surfaced as partial totals. A second provider and per-user manual rates are deferred.

### 10.2 Lookup semantics

| Need | Rule |
|---|---|
| Rate on date d | Greatest `rate_date ≤ d` for the preferred source, looking back at most **10 calendar days**; result carries `rateDate` and `exact = (rateDate = d)`. |
| Monthly average for M | Arithmetic mean of stored daily rates with `rate_date ∈ M`; if none (or fewer than 5 for the current month), `rateOn(end(M))` marked `approximate`. Spans: day-weighted average of the months' averages. |
| Today / "current" | `rateOn(today)`. |
| Future dates (scenarios) | Never looked up; the scenario FX path supplies rates (13.8). |

### 10.3 Conversion conventions by use

| Use | Date used | Mode |
|---|---|---|
| Position value at as-of date t (net worth, charts) | t (a carried USD balance at 30 Sep is valued at the 30 Sep rate) | dated |
| Dated flows | the flow's date | dated |
| Cross-currency transfer / contribution / withdrawal | source leg at its date; destination inherits the same R value (12.2) | dated |
| Unclassified inferred spending for (M, C) or a span | M / the span | monthly average, `estimatedConversion` |
| Monthly analytics series | end of each month | dated |
| Current dashboard | today | dated (latest) |
| Scenario start state | frozen `rateOn(start)` stored in the starting-state document | dated, frozen |

### 10.4 Persistence and refresh (global; no tenant data involved)

- `fx_rates` rows are immutable; an alternative rate is a new row with another `source`; readers apply source preference.
- **Daily cron** (`/api/cron/fx-refresh`, Vercel cron `0 16 * * *` UTC after the ECB fixing, bearer secret): `refreshAll()` fetches the latest rates for **every currency in `currencies` with `is_fx_supported`** (one request) and backfills any missing business days in the last 14 days. It reads and writes only `currencies` and `fx_rates` under `app_user` (whose RLS-protected tables return nothing without a user context anyway). It never queries positions or settings of any user (R26).
- **On first use of a currency** (a user creates a position, sets a reporting currency or favorite in that currency): `ensureHistory(currency, from)` runs in that user's request and fetches the full history from `from` (the user's earliest financial date − 31 days, or 1999-01-04 when unknown) to today in one time-series call; history is global, so later users benefit. Provider failure does not fail the user's action; conversions are `Unavailable` until the next cron.
- Rate rows are global and excluded from user deletion.

### 10.5 Failure behavior

| Situation | Behavior |
|---|---|
| No rate within 10 days of d | `Unavailable('fx_missing')`; aggregates `partial`; banner "Retry fetching rates". |
| Provider HTTP failure in cron | Structured log; Sentry cron monitor failed; retried next day; alert after 3 consecutive failures. |
| Provider returns a rate ≤ 0 or > 10⁶ | Row rejected, logged. |
| Currency not in the supported set | Position creation refused for reporting/native use with an explanation ("not supported as a currency; track it as an investment"). |

### 10.6 Decomposition of reporting-currency change

For any native-currency position over `(t0, t1]`: `Δ_R = Σ flows·r_flow + Reval·r(t1) + FX`, where `Reval` is the native change net of position-moving flows and `FX` is the residual `V0·(r1 − r0) + Σ flow·(r1 − r_flow)`. *Flows* are the records that move value into or out of **that position**: transfers (contributions, withdrawals, switches, purchases, sales, loan proceeds), principal repayments, and — for cash positions only — income, expenses (incl. capital improvements), interest/fee parts and the unclassified residual. Income/expense entries *linked* to an investment or property (dividends, fees, rent, opex, improvements) are cash-side flows, not flows of the linked position; their effect on the linked position, if any, is inside `Reval` (or, for improvements, is zero by design). Signed by `s(p)` (7.8). A position whose tracking starts inside the period starts its identity at `t_start` with the opening amount defined in 12.3 ("newly tracked"), so purchases are explained by their flows and pre-existing positions by their first valuation.

---

## 11. Property / mortgage model

### 11.1 Property lifecycle as records

| Event | Records written (one transaction) |
|---|---|
| Acquisition | `positions(kind=property)` + `properties(purchase_date, purchase_price)`; valuation `purchase` on the purchase date = price; `transfers(asset_purchase)` cash → property for the cash-funded part; `transfers(financed_purchase)` liability → property for the financed part (the liability is created with an initial balance valuation = financed amount); `expense_entries(acquisition_cost)`. Net worth changes by −costs only. |
| Pre-existing property at onboarding | Position + a current valuation (`entered`); optional purchase data for cost basis. |
| Revaluation | `position_valuations(entered)` on the valuation date (≤ today). |
| Rent | `income_entries(kind=rental, property_position_id)`; suggested monthly by a template. Skipping the suggestion asks for a reason (`vacant`, `non_payment`, `other`) and writes a `recurring_template_skips` row (6.2); this is the only source of occupancy facts. |
| Operating costs | `expense_entries(category.kind=property_operating, property_position_id)`. |
| **Capital improvement** | `expense_entries(category.kind=capital_improvement, property_position_id, amount, value_add_estimate NULL)`. Cash −amount; cost basis +amount; **market value unchanged**. If the user enters a `value_add_estimate`, the carried value rises by that estimate from that date with freshness `carried_estimated` and the UI labels it "includes €X estimated value added by improvements (your estimate)". The next explicit valuation replaces any estimate. |
| Sale | `transfers(asset_sale)` property → cash for gross proceeds; `liability_payments(kind=payoff)`; `expense_entries(disposal_cost)`; final valuation 0; status closed. |

### 11.2 Property metrics

With `V(t)` the carried value (latest valuation, plus value-add estimates since it, if any), `B(t)` the sum of balances of liabilities linked to the property, trailing-12-month (T12) sums over rent `Rent`, operating costs `Opex`, interest `Int`, principal `Prin`, and `Imp` the improvements in a period:

| Metric | Formula | Availability |
|---|---|---|
| Equity | `V − B` | always (stale-labelled) |
| LTV | `B / V` | V > 0 |
| Gross yield | `Rent_T12 / V` | `is_rental` and ≥ 1 rental entry in T12 |
| Net yield | `(Rent_T12 − Opex_T12) / V` | as above |
| Net operating income | `Rent − Opex` | — |
| Cash flow (period) | `Rent − Opex − Int − Prin − Imp` | — |
| Cost basis | `purchase_price + Σ acquisition_cost + Σ capital_improvement` | purchase data present |
| Value change (period) | `V(t1) − V(t0)` between confirmed valuations, recognized in the month of the later valuation, labelled with the span | two confirmed valuations |
| Appreciation net of improvements | `V(t1) − V(t0) − Imp(t0, t1]` | as above; labelled |
| Annualized value change | `(V1/V0)^(365/days) − 1` over confirmed spans | as above |
| Unrealized gain | `V − cost basis` | purchase data present |
| Total return (period) | `Value change − Imp + NOI − Int` (equity holder's return) | — |
| Occupancy (explicit facts only) | a month is **occupied** if a rent entry exists, **vacant** if the rent suggestion was skipped with reason `vacant` (a `recurring_template_skips` row), **non-payment** for reason `non_payment`, otherwise **unknown**, shown as "No rent recorded"; no occupancy or vacancy rate is computed from unknown months | never inferred from absence (F18) |
| Equity IRR (Phase 8) | XIRR of: −(down payment + acquisition costs) at purchase, −improvements, monthly `Rent − Opex − payments`, `+Equity` at end | purchase data + ≥ 12 months |

### 11.3 Mortgage model

- A liability has zero or more `liability_terms` rows; the terms effective on date d are the row with the greatest `effective_from ≤ d`. A liability without terms is balance-only.
- Balance at date t: last confirmed valuation ≤ t **minus** principal of `liability_payments` dated in `(valuation date, t]` (state `derived`), plus loan proceeds after the valuation; `carried`/`missing` when there are no payments.
- **Schedule** — pure functions shared by actuals and projections:

```
schedule(fromDate, fromBalance, terms[], policies, extraPayments[], horizonEnd):
  B ← fromBalance; d ← first scheduled payment date ≥ fromDate (payment_day, clamped to month length)
  P ← undefined; lastTerms ← undefined
  while B > 0 and d ≤ horizonEnd:
    T ← terms effective at d;  i ← T.annual_rate / 12
    n ← months from d to T.term_end_date inclusive (≥ 1)
    if T.term_end_date is null and T.payment_amount is null → return 'schedule_unavailable'
    if T ≠ lastTerms:
        if T.amortization = 'interest_only': P ← undefined
        else if P is undefined or T.payment_amount is set or policies.rate_change = 'recompute_payment':
            P ← T.payment_amount ?? annuity(B, i, n)          // annuity(B,i,n) = i = 0 ? B/n : B·i / (1 − (1+i)^(−n))
        lastTerms ← T                                           // 'keep_payment': P retained, term floats
    row ← amortizeMonth(B, i, P, T, isFinal = (d = T.term_end_date))
    B ← row.balance; emit row
    for each extra payment e dated in (d, d + 1 month]:
        B ← B − min(e.amount, B); emit extra row
        if policies.extra_payment = 'reduce_payment' and T.amortization ≠ 'interest_only': P ← annuity(B, i, remaining n)
    d ← addMonths(d, 1)

amortizeMonth(B, i, P, T, isFinal):
  interest ← roundMinor(B × i)
  if T.amortization = 'interest_only': principal ← isFinal ? B : 0                       // balloon at term end
  else if isFinal: principal ← B; if interest + B > 1.5 × roundMinor(P): flag 'balloon_at_term_end'
  else: principal ← roundMinor(P) − interest                                              // may be negative
        if principal < 0: flag 'negative_amortization'                                    // unpaid interest capitalized
        if principal > B: principal ← B
  return { payment: interest + principal, interest, principal, balance: B − principal, flags }
```

- **Extra payment**: reduces `B` on its date; `shorten_term` keeps `P`, `reduce_payment` recomputes it.
- **Rate change**: new terms row; `recompute_payment` (default) or `keep_payment`.
- **Interest-only**: `principal = 0` until `term_end_date`, then balloon.
- **Monthly suggestion for M** (only for completed months or once the payment day has passed): the schedule row dated in M from the latest confirmed/derived balance at `start(M)`, shown as "Suggested: €474.21 (interest €250.00, principal €224.21)". Accepting writes a `liability_payments` row (`source = accepted_suggestion`, rounded), dated the scheduled day (≤ today). Nothing is written without acceptance.
- **Actual balance confirmation**: writes a valuation (≤ today). If it differs from the derived balance, the difference is a **debt adjustment** in that month's decomposition; subsequent rows anchor on the confirmed balance.
- **Payoff** (`kind = payoff`): principal = current balance; final valuation 0; status closed.

**Golden example (`mortgage/annuity-100k-3pct-300m`)**: balance 100,000.00, 3.00 % nominal, 300 months, annuity. `P = 474.21`. Row 1: interest 250.00, principal 224.21, balance 99,775.79. Row 2: interest 249.44, principal 224.77, balance 99,551.02. Exactly 300 rows; the final row's principal equals the remaining balance (payment ≈ 474.70 after rounding drift); Σ principal = 100,000.00; total interest ≈ 42,263.49. The test computes and asserts these.

### 11.4 Actual vs expected: states

| State | Source | Shown as |
|---|---|---|
| `confirmed` | bank-provided balance entered by the user | plain value, date |
| `accepted_expected` | user accepted the schedule's balance | "accepted from schedule" badge |
| `derived` | last confirmed − principal of recorded payments | "derived from payments since <date>" |
| `expected` | schedule only | only in the monthly suggestion, never in net worth |
| `carried` | last confirmed, no payments, no terms | value with age |

Net worth uses `confirmed` → `accepted_expected` → `derived` → `carried`, never `expected`.

---

## 12. Net-worth and wealth-decomposition model

### 12.1 Definitions at an as-of date t, reporting currency R

- Position value `V_p(t)`: cash — latest valuation ≤ t (never flow-adjusted); investment — flow-adjusted carried value (9.1); property / other asset — latest valuation ≤ t plus any `value_add_estimate` of improvements dated after it (state `carried_estimated`), **never** adjusted by purchase/improvement cash flows themselves; liability — 11.3 rule. Each value carries a freshness state and age.
- Sign `s(p)` per 7.8. Closed positions contribute 0 after `closed_on`. Conversion `V_p(t)·r_p(t)` (10.3).

| Aggregate | Definition |
|---|---|
| Cash & savings | Σ cash positions |
| Investments | Σ investment positions |
| Property value | Σ property positions |
| Property debt | Σ liabilities linked to a property |
| Property equity | Property value − Property debt |
| Other assets (included) | Σ other assets with `include_in_financial_net_worth` |
| Other assets (excluded) | Σ other assets without it (memo line) |
| Total liabilities | Σ liabilities (linked and unlinked) — never excludable |
| Liquid assets | Cash & savings + Investments |
| **Total net worth** (internal `totalNetWorth`) | `Σ_p s(p)·V_p·r_p` over **all** tracked positions = Cash + Investments + Property value + all Other assets − Total liabilities. User-facing copy: "Total net worth includes all assets and liabilities you track." |
| **Financial net worth** (headline; internal `financialNetWorth`) | Total net worth − Other assets (excluded) = Cash + Investments + Property value + Other assets (included) − Total liabilities |
| Net-worth change | `NW(t1) − NW(t0)` for either metric, same R |

The dashboard headline is financial net worth (spec §32 "headline"); total net worth is shown beside it whenever the two differ. The UI never uses the phrase "economic net worth": the application only knows what the user tracks and does not claim to know their complete real-world balance sheet. Both series are computed from the same records at each month end; the inclusion preference is not dated, so toggling it recomputes the financial series consistently across all history (audited). Any `Unavailable` conversion makes an aggregate `partial` with the list of excluded positions.

### 12.2 Transfer valuation rule (makes internal flows neutral for total net worth in every R)

A transfer, contribution, withdrawal, switch, loan proceeds, financed purchase, asset purchase/sale, or the principal part of a liability payment has **one** reporting value: `value_R = from_amount · r(from_currency → R, date)` (for liability payments: `principal · r(payment currency → R, date)`). Both positions use that value, each with its sign. Same-currency and cross-currency internal flows therefore cancel exactly in total net worth; the gap between the achieved and market rate becomes part of the destination position's FX residual.

### 12.3 Drivers view for **total** net worth (sums exactly to Δ Total NW_R)

Over `(t0, t1]` with both endpoints at month ends:

| Bucket | Content |
|---|---|
| Income | ordinary income entries (employment, freelance, bonus, rental, other) with `settlement = tracked_cash`, at dated rates. Ordinary income settled `external` is informational only and appears in no bucket (7.4). |
| Investment income | dividend/interest entries with settlement `tracked_cash` or `external`, at dated rates; each `external` one is paired with an equal External outflow (7.4) |
| External inflows / Adjustments | `external_inflow` / `adjustment` income entries; `untracked` liability payments (+total) |
| − Spending | known tracked consumption expenses (incl. tax, non-rental property_operating) + unclassified inferred spending (monthly-average rate). When a bucket's month is `unavailable`, the line reads "unexplained cash change" instead of "spending" (same number, different label); spans use the span residual. |
| − Property costs | property_operating expenses of rental properties |
| − Interest & fees | interest + fee parts of liability payments, cash-paid investment fees, transfer fees (in scenarios: also simulated conversion spreads) |
| − Transaction costs | acquisition/disposal costs |
| − Capital improvements | `capital_improvement` expenses (cost basis; market value unchanged) |
| + Estimated value added | Σ `value_add_estimate` of improvements in the period (user estimates; labelled) |
| − External outflows | `external_outflow` expenses; `external` dividends (−d) |
| Investment returns (excl. distributions) | Σ investments `ValueChangeNet · r(t1)` |
| Property revaluation | Σ (confirmed valuation changes, net of any value-add estimates already recognized) · r(t1); 0 labelled "no valuation" when carried |
| Other-asset revaluation | same for other assets |
| − Debt adjustments | Σ (confirmed liability balance − derived balance) · r(t1), sign −1 |
| Newly tracked positions | Σ s(p)·opening amounts, at dated rates, of positions whose tracking starts inside the period. A position's identity starts at `t_start` = its `opened_on` if set (opening amount 0), else the earlier of its first valuation date and its first inbound position-moving flow date; the opening amount is 0 when `t_start` is a flow date, else the first valuation minus inbound position-moving flows dated that same day. A property or car created through a purchase therefore contributes 0 here (its value is explained by the purchase flow); a pre-existing account, investment or property entered at onboarding contributes its first valuation. Never performance, never income. |
| − Removed from tracking | Σ s(p)·last carried values of positions archived in the period without closing flows |
| FX effect | Σ_p s(p)·(10.6 residual with position-moving flows only); 0 when everything is in R |

**Proof sketch.** `Δ Total NW_R = Σ_p s(p)·Δ_R(p)`. For a position tracked throughout, `Δ_R(p)` = position-moving flows at dated rates + revaluation at the closing rate + FX residual. Every internal flow appears in exactly two positions with the same value (12.2) and opposite signed contributions: cash → investment (+1·(−x) and +1·(+x)); liability → cash proceeds (−1·(+x) and +1·(+x)); cash → liability principal (+1·(−x) and −1·(−x)); cash → property purchase (+1·(−x) and +1·(+x) via the purchase valuation written with the transfer). They cancel. The remaining flows are exactly the external ones listed above; cash "revaluation" is by definition the unclassified residual (negative spending); capital improvements are cash outflows with no offsetting position flow (their `Reval` on the asset is zero by design, or the explicit estimate); the other revaluations are the valuation-change buckets; first/last valuations of positions entering/leaving tracking are the newly-tracked/removed buckets. Nothing is estimated in the identity; only labels depend on data quality.

### 12.4 Drivers view for **financial** net worth

`Δ Fin NW_R = Δ Total NW_R − Σ_{p ∈ excluded other assets} s(p)·Δ_R(p)`. Concretely the financial view is the total view with these changes:

- Remove the excluded assets' own lines: their revaluation, value-add estimates, FX, newly tracked / removed amounts.
- Add **− Purchases of non-financial assets**: cash legs of `asset_purchase` (and `financed_purchase` financed amounts, since the liability stays in the metric) into excluded assets, at dated rates.
- Add **+ Sales of non-financial assets**: `asset_sale` proceeds from excluded assets.
- Capital improvements on excluded assets stay in "− Capital improvements" (the cash left); their value-add estimates are dropped.

Example: buying a €20,000 car (excluded) from BBVA on 15 Sep: total net worth unchanged (cash −20,000, car +20,000 via the purchase valuation); financial net worth −20,000, shown as "Purchases of non-financial assets −20,000". Selling it a year later for €15,000 with the car last valued at €16,000: total view shows Other-asset revaluation −1,000 (final valuation vs sale) and a neutral sale; financial view shows "+ Sales of non-financial assets +15,000". Invariant M16 states transfer neutrality for total net worth; the financial view's exceptions are exactly these two explicit lines.

### 12.5 Savings, savings rate and the allocation view ("where the savings went")

One savings concept, each flow counted once (F16):

```
ExternalIncome      = Income + Investment income received in tracked cash   // employment, freelance, bonus, rental, other, dividends and interest with settlement tracked_cash; excludes external_inflow, adjustment, ordinary income settled external (informational) and distributions paid externally (the +d/−d pair of 7.4)
Consumption              = known tracked consumption (incl. tax, non-rental property_operating) + unclassified inferred spending
TrackedSavingsFromIncome = ExternalIncome − Consumption − PropertyOperatingCosts − InterestAndFees − TransactionCosts
AdditionalSpending       = Σ expense entries with settlement untracked_self (any kind)      // the user's own spending from outside tracked accounts
PersonalSavings          = TrackedSavingsFromIncome − (count_additional_spending ? AdditionalSpending : 0)   // user setting, default on
SavingsRate              = PersonalSavings / ExternalIncome             // unavailable when ExternalIncome = 0
TotalSpending            = TrackedTotalSpending + AdditionalSpending    // Spending-page headline; third_party never included
```

`Consumption`, `PropertyOperatingCosts`, `InterestAndFees` and `TransactionCosts` are the 12.3 buckets. `TrackedTotalSpending` from 8.2 equals `Consumption + PropertyOperatingCosts + InterestAndFees + TransactionCosts + ExternalOutflows`, so the savings formula never subtracts a cost that is already inside another term. Contributions, principal repayments, asset purchases and capital improvements are allocations of savings, not expenses; withdrawals and loan proceeds are not income. Additional spending (`untracked_self`) never enters the tracked identity of 8.2, but it is the user's own consumption, so by default it reduces **personal** savings and therefore the savings rate — this keeps "Total spending" (tracked + additional) and "Savings rate" consistent with each other; the user may turn `count_additional_spending` off, in which case the rate is tracked-only and labelled so. Third-party-paid expenses enter nothing. Ordinary income settled `external` stays informational (F5) and is not in the denominator; the explain panel states this next to the rate.

Allocation identity (cash-role flows only): `CashSavings = TrackedSavingsFromIncome + External inflows + Adjustments − External outflows`, where "External outflows" here means the `external_outflow` expense entries paid from tracked cash; the non-cash pair created by an externally paid distribution (+d Investment income, −d External outflows) cancels outside this identity. Identically, `CashSavings = ΔCash + Contributions + Principal repaid + Asset purchases (all, incl. excluded other assets) + Capital improvements − Withdrawals − Loan proceeds − Asset sales` (all at dated rates; ΔCash at closing rates leaves the cash FX residual as a line). Both follow from the 8.2 identity (`ΣI − ΣK − U = Δ + ΣNout − ΣNin`) with `K` split into its buckets. `PersonalSavings = CashSavings − counted AdditionalSpending − External inflows − Adjustments + External outflows`, and the "where it went" view shows the line "Spent from outside tracked accounts −X" when additional spending is counted. User-facing labels: "Saved from income (tracked accounts)", "Personal savings", "Savings rate", "Where it went".

**Availability.** These figures are derived from reconciliation and inherit its status; none of them is ever computed by reading a missing or negative residual as zero. For a bucket whose status is `unavailable`, `Consumption`, `TrackedSavingsFromIncome`, `PersonalSavings` and `SavingsRate` are `Unavailable` with that bucket’s reason. For an `unresolved` bucket, a negative unclassified is not negative consumption: the same four are `Unavailable` until the discrepancy is resolved, while the page still shows 8.4’s lower bound ("spending ≥ known") and the unexplained-inflow amount. An `estimated` bucket computes them and propagates `estimated` with its reason; the current month computes them through the MTD date `D` and labels them provisional through `D`. `AdditionalSpending` and paid-by-others remain computable in every case, because neither enters the tracked identity. Across currencies the reporting-currency figures use the `Partial` machinery of 7.6: a valid bucket’s contribution is preserved and the aggregate is marked partial with the missing buckets’ reasons, never completed with a zero. `SavingsRate` is an exact scalar only when numerator and denominator are both complete and every rate it needs exists; otherwise it is `Unavailable` or partial with a reason rather than a misleading percentage — as it also is when `ExternalIncome = 0`.

### 12.6 Completeness and freshness for a completed month M

| Item | Satisfied when |
|---|---|
| Each active cash account (non-dormant) | closing `month_end`/`closed_zero` |
| Each active investment | valuation within M, or carried with age ≤ `stale_investment_months` |
| Each active liability with terms | payment recorded in M or balance confirmed in M |
| Each active liability without terms | balance confirmed within the last 3 months |
| Each occurrence scheduled in M by a template whose `start_date`/`end_date` cover M | a flow carries that `(template_id, occurrence_date)`, or a `recurring_template_skips` row does. Whether the template is **currently archived is irrelevant here**: archiving is present-tense state, so filtering on it would let an action taken today erase an occurrence a past month was expecting (30.10) |
| Each property | never required; counted as stale if age > `stale_property_months` |

`completeness = satisfied / required`. State: `incomplete` if any cash item is unsatisfied; `partial` if cash is complete but other items are missing; `sufficient` if all items are satisfied; `stale` if the month has no valuation at all in any position. Completeness is defined for completed months only; the current month shows "in progress: N of M accounts updated this month; closes on <end(M)>".

### 12.7 Worked example (golden test `decomposition/september-basic`)

Extends 8.10 with the €31 interest recorded, an EUR investment (S&P 500: 31 Aug 41,870; contribution 1,000 on 10 Sep; 30 Sep 43,300), a mortgage (31 Aug confirmed 98,500; September payment principal 235 → derived 98,265, sign −1) and a carried property (117,300). No excluded other assets, so total = financial.

`NW(31 Aug) = 8,055 + 8,509 + 41,870 + 117,300 − 98,500 = 77,234`. `NW(30 Sep) = 7,880 + 8,740 + 43,300 + 117,300 − 98,265 = 78,955`. `ΔNW = 1,721`.

Drivers: Income 2,100 + Investment income 31 − Spending (300 + 429) − Interest 111 + Investment returns 430 (= 43,300 − 41,870 − 1,000) + Property revaluation 0 (carried) − Debt adjustments 0 + FX 0 = **1,721** ✓. Signed check on the mortgage: liability flow "principal −235" × (−1) = +235 on the position, cancelled by cash −235 → 0 ✓.
Allocation: `CashSavings = 2,131 − 411 − 429 = 1,291 = ΔCash 56 + Contributions 1,000 + Principal 235` ✓.
Savings (golden `savings/september-basic`): `ExternalIncome = 2,131` (salary 2,100 + interest 31), `Consumption = 729`, `InterestAndFees = 111`, `TrackedSavingsFromIncome = 2,131 − 729 − 111 = 1,291`; `AdditionalSpending = 50` (the untracked coffee of 8.10), so with the default setting `PersonalSavings = 1,241` and `SavingsRate = 58.24 %` (tracked-only: 1,291 and 60.58 % when the setting is off); `TotalSpending = 840 + 50 = 890`; the partner-paid €80 appears nowhere; interest is subtracted exactly once, and the €235 principal and €1,000 contribution appear only in "where it went", which now also carries "Spent from outside tracked accounts −50" ✓.
Variant with a €20,000 excluded car bought on 15 Sep from BBVA (BBVA 30 Sep then 7,880 − 20,000 = −12,120, an overdraft, purely to keep the other numbers): total ΔNW unchanged at 1,721 (cash −20,000 and car +20,000 through the purchase flow; Newly tracked 0 by the 12.3 rule, since the car's first valuation equals its same-day purchase flow); financial ΔNW = 1,721 − 20,000 = −18,279 with "Purchases of non-financial assets −20,000" ✓.

---

## 13. Scenario / projection architecture

### 13.1 Boundaries

```ts
// packages/finance/projection (pure, deterministic)
simulate(input: { startingState, definition, settings, backend: NumericBackend, returns: ReturnPathProvider, fx: FxPathProvider }): ProjectionResult
```

- `NumericBackend` is a 10-method interface (`from`, `add`, `sub`, `mul`, `div`, `pow`, `cmp`, `min`, `max`, `round`). `DecimalBackend` (decimal.js, precision 28) for deterministic runs; `FloatBackend` (IEEE-754) for Monte Carlo paths. A golden test runs every deterministic fixture on both backends and asserts month-by-month agreement within 0.01 units.
- `ReturnPathProvider.monthlyReturn(month, investmentRef)`; `FxPathProvider.rate(month, currency)`.
- Cash in scenarios is modelled **per currency bucket** (one projected balance per currency). Value never moves between buckets except through an explicit simulated conversion (13.4, M18).

### 13.2 Scenario documents

**Starting state** (frozen JSONB, `startingStateSchema` v1): as-of date (= end of a **completed** source month, i.e. `today > end(M)`); reporting and base currency; FX rates at as-of for every currency present; cash buckets `{ currency, balance }` (sum of cash accounts by currency); investments `{ ref, name, currency, assetClass, value, freshness, openingBasis? }`; properties `{ ref, value, currency, freshness, linkedLiabilityRefs, isRental }`; other assets `{ …, includeInFinancial }`; liabilities `{ ref, balance, currency, termsEffective, policies }`; active income templates; active recurring expenses; active contribution plans; baseline tracked-spending suggestion with its basis (13.6); completeness state of the source month.

**Definition** (JSONB, `scenarioDefinitionSchema` v1, validated by Zod on every write):

```ts
{
  horizonMonths: 12..600, startMonth, reportingCurrency, baseCurrency,
  inflation: { annualRate },
  cashPolicy: { reserve: { amount, currency: baseCurrency, includeForeignCash: false },
                deficitFunding: 'flag' | 'liquidate_investments', liquidationOrder?: ref[] },
  incomes:      [{ ref, name, currency, monthlyNet, monthlyGross?, growth: { kind: 'none' | 'annual_pct', rate, anniversaryMonth }, activeFrom?, activeTo? }],
  spending:     { baseline: { monthly, currency, inflationLinked: true, basis: string, includeAdditionalSelfPaid: boolean /* initialized from user_settings.count_additional_spending */ }, recurring: [{ ref, name, monthly, currency, inflationLinked, activeFrom?, activeTo? }] },
  investments:  [{ ref, name, currency, assetClass, startValue, expectedReturn, volatility, annualFeeRate? }],
  contributions:{ stages: { fixed?: { monthly, currency }, percentOfIncome?: { pct }, percentOfSurplus?: { pct }, reserveSweep?: boolean },
                  allocation: [{ investmentRef, weight }], schedule: [{ fromMonth, stages?, allocation? }],
                  extraDebtRepayment?: [{ liabilityRef, monthly }] },
  properties:   [{ ref, startValue, currency, appreciation, rent?: { monthly, growth, vacancyPct }, opex?: { monthly, inflationLinked }, linkedLiabilityRef? }],   // properties are always in both net-worth metrics
  otherAssets:  [{ ref, startValue, currency, annualGrowth, includeInFinancial }],
  liabilities:  [{ ref, startBalance, currency, terms, scheduledRateChanges: [{ month, annualRate }] }],
  cash:         [{ currency, startBalance, interestRate?: 0 }],
  fx:           { mode: 'constant' | 'trend', trends?: Record<currency, annualPct>,
                  autoFunding: { enabled: false, spreadPct: 0.005, fixedFee?: { amount, currency }, sweepForeignSurplus: false } },
  monteCarlo?:  { correlation: 'default' | 'independent' | { assetClasses: AssetClass[]; classMatrix: number[][]; withinClass: Record<AssetClass, number> } },   // one schema; 'default' resolves to the explicit matrix and loadings in 13.9
  events:       ScenarioEvent[],
  settings:     { display: 'nominal' | 'real' }
}
```

On creation the definition is populated from the starting state (every actual item becomes an editable assumption with defaults), so a new scenario is runnable immediately.

### 13.3 Monthly processing order (normative)

For each projected month `m = 1..H`, with `S` the state carried from `m−1`:

| Step | Action | Why here |
|---|---|---|
| 0 | **Open**: copy closing balances of `m−1`; reset accumulators (`flows_m` per investment/asset, `income_m` per currency, spending, contributions, conversions, flags). **Advance the FX path**: `rate_m` per currency (constant, or `rate_{m−1} × (1 + g)^(1/12)`), used for every conversion and reporting figure in the month. | Growth applies to opening balances; one rate per month for all in-month conversions. |
| 1 | **Apply definitions effective in m**: scheduled income changes and anniversary growth; rent growth anniversaries; contribution schedule steps; scheduled liability rate changes (recompute payment per policy); definition-phase events dated in m. | Parameters settle before money moves. |
| 2 | **Income** (per currency): `cash[ccy] += monthlyNet`; rental `cash += rent × (1 − vacancy)`; cash interest on opening balance if configured. `income_m[ccy]` accumulates these. | Paid before bills; visible to the reserve check. |
| 3 | **Required outflows** (each in its own currency X): (a) baseline spending × `idx_{m−1}`; (b) recurring expenses; (c) property opex; (d) scheduled liability payments via `amortizeMonth` (11.3). Each outflow is funded from `cash[X]`; if insufficient, apply the **currency funding rule** (13.4): auto-funding conversion if enabled, else `currency_deficit(X)` and `deficit`. | Obligations before discretionary decisions; never funded by skipping the mortgage; never by teleporting value across currencies. |
| 4 | **Capital events dated in m — inflows first**: asset/property sale (proceeds to cash in the asset's currency; linked liability paid off from proceeds, converting per the funding rule if the loan currency differs), new loan (cash in the loan currency + liability), explicit investment withdrawal (capped at `avail = V_open × (1 + r_m − fee_m) + flows_m so far`; only the capped amount is credited, `withdrawal_capped` flagged), cash injection. | "Sell A then buy B" must work; cash only receives what existed. |
| 5 | **Capital events dated in m — outflows**: one-off expense, cash withdrawal, extra loan payment, lump-sum investment (`flows_m +=`), asset purchase, property purchase (down payment + costs from cash in the property's currency; mortgage and property created; the property's `flows_m` receives the price so it closes the month at its purchase price). Each discretionary outflow event (`onShortfall ≠ fail`) first checks the **reserve rule** (13.4: it may not take eligible cash below the base-currency reserve unless the event sets `ignoresReserve`), then the **currency funding rule** (`cash[X]`, or an explicit auto-funding conversion), applying `onShortfall` on failure. Required events (`onShortfall = fail`) skip the reserve check and apply the funding rule only. | Planned decisions after obligations, using the month's income; the reserve is one global target, never split per currency. |
| 6 | **Discretionary pipeline** (target computed in the base currency). Definitions: `income_m` = the additions of step 2 converted at `rate_m` (capital inflows of step 4 are not income); `flowSurplus_m = income_m − required outflows (3) − planned outflows (5)` in base currency, floored at 0; `eligibleCash = cash[base] + (includeForeignCash ? Σ cash[X]·rate_m(X→base) : 0)`; `stockSurplus = eligibleCash − reserve`. (a) extra debt repayments (each in its loan currency; funded per 13.4; capped at `stockSurplus`); (b) contributions: `target = fixed + pctIncome × income_m`; `target += pctSurplus × max(0, flowSurplus_m − target)`; if `reserveSweep`: `target = max(target, stockSurplus)`; `target = min(target, max(0, stockSurplus))`; allocate by weights with largest-remainder; each allocation to an investment in currency X is funded from `cash[X]`; if insufficient and auto-funding is off, that allocation is reduced to the available X cash (`contribution_reduced(reason: currency)`); if auto-funding is on, convert base → X (13.4). Flags `contribution_reduced` / `contribution_stopped` when the total is below plan. `flows_m +=` per investment. | Percentages apply to the month's flows; the reserve is a single base-currency target measured over eligible cash (a valuation for measurement, never a conversion) and applied last as the global discretionary capacity; the target currency must then actually be funded from its own bucket or by an explicit auto-funding conversion. |
| 7 | **Sanity**: assert every investment satisfies `V_open × (1 + r_m − fee_m) + flows_m ≥ 0` and every bucket that went negative carries a flag (engine bugs otherwise). | |
| 8 | **Investment growth**: `V = V_open × (1 + r_m − fee_m) + flows_m` (flows are end-of-month). | Deterministic; mirrors the actuals formula. |
| 9 | **Property and other-asset growth**: `V = V_open × (1 + a_m) + flows_m` (purchase price of an asset bought this month). Improvements are not modelled in scenarios beyond one-off expenses. | Same convention. |
| 10 | **Inflation index**: `idx_m = idx_{m−1} × (1 + π)^(1/12)`; real values = nominal / `idx_m`. | Reporting layer; month 1 spends the un-inflated baseline. |
| 11 | **Close**: convert the closing state to R at `rate_m`; record `MonthState` (native balances per bucket/item, R aggregates for total and financial net worth, income, spending, contributions, interest, principal, conversions with spread cost, drivers buckets, flags); evaluate goals (14); carry to `m+1`. | |

Within a step, events are ordered by explicit `order` then `id`. The order is part of `engine_version`; any change bumps it and invalidates caches.

### 13.4 Cash constraints, currency funding and infeasibility

**Reserve rule.** `cashPolicy.reserve.amount` is one global target denominated in `baseCurrency`. `eligibleCash = cash[base]` when `includeForeignCash = false`; when `true`, foreign buckets are added **converted at `rate_m` for measurement only** — measuring the reserve never moves money between buckets. `discretionaryCapacity = max(0, eligibleCash − reserve)` (base currency). Required obligations may take cash below the reserve; the reserve is a target, not an obligation. Discretionary actions (extra debt payments, discretionary contributions, optional purchase events) may not reduce `eligibleCash` below the reserve unless the action explicitly sets `ignoresReserve`; their size is first capped by `discretionaryCapacity` (compared at `rate_m`) and then each must be funded in its own currency by the rule below. There is no per-currency reserve share: a EUR reserve valuation never funds a USD obligation.

**Currency funding rule** (applied whenever an amount `A` in currency X must leave `cash[X]` and `cash[X] < A`):

1. If `fx.autoFunding.enabled`: fund the shortfall `A − cash[X]` from `cash[base]` (X ≠ base) or, for a base-currency shortfall, from foreign buckets in descending balance order if `sweepForeignSurplus`, through `convertWithSpread` with `targetAmount = A − cash[X]` (below); the spread cost and fixed fee are recorded as a **simulated conversion cost** (drivers bucket "Interest & fees", line "conversion costs"); the conversion is an explicit `MonthState.conversions[]` record carrying the helper's output. If the source bucket cannot supply the required source amount, fall through to 2.

**Conversion helper (`finance/fx/convertWithSpread`, pure).** All scenario conversions — auto-funding and explicit `currency_conversion` events — go through one helper whose semantics do not depend on how the FX path quotes the pair:

```
convertWithSpread({ fromCurrency, toCurrency, sourceAmount? | targetAmount?, marketRate, spreadPct ≥ 0, fixedFee? })
  frictionless(x)  = convert(x, fromCurrency → toCurrency, marketRate)          // the ordinary FX primitive, whatever the quote orientation
  feeInTarget      = fixedFee ? convert(fixedFee.amount, fixedFee.currency → toCurrency, marketRate) : 0
  known source:    destination = frictionless(sourceAmount) × (1 − spreadPct) − feeInTarget      // haircut on what the user receives
  known target:    source      = frictionless⁻¹((targetAmount + feeInTarget) / (1 − spreadPct))  // more source needed under the same convention
  returns { sourceAmount, destinationAmount, marketEquivalent = frictionless(sourceAmount), spreadCost = marketEquivalent − destinationAmount − feeInTarget (in toCurrency, also reported in R at rate_m), fixedFee, effectiveRate = destinationAmount / sourceAmount }
```

Invariants (tested, 21.1–21.2): with `spreadPct = 0` and no fee the result equals the ordinary conversion; a positive spread or fee always leaves the user weakly worse off than the frictionless conversion (destination ≤ frictionless for a known source; source ≥ frictionless source for a known target); expressing `marketRate` as EUR→USD or USD→EUR changes nothing. The month state never contains a conversion that the helper did not produce.
2. Otherwise: for a **required** outflow (steps 3, 4 payoff, 5 with `onShortfall = fail`): `cash[X]` goes negative, flags `currency_deficit(X, amount)` and `deficit`; the scenario is `infeasible` from `m`. For a **discretionary** amount (steps 5 `skip/partial/liquidate`, 6): reduce/skip per policy and flag; never a deficit.

| Situation | Behavior |
|---|---|
| Required outflows exceed cash in their currency | Funding rule; with `deficitFunding = liquidate_investments`, first withdraw from investments **denominated in X** in `liquidationOrder` until `cash[X] ≥ 0` (flag `liquidated_to_fund`); cross-currency liquidation only via auto-funding. |
| Planned event cannot be funded | `onShortfall`: `fail` (default for property purchase, lump sums): apply, flag `infeasible_event`; `skip`; `partial` (lump sums only); `liquidate`. |
| Discretionary contribution breaches the reserve or its currency's cash | Reduce, then stop, flag; never a deficit. |
| Reserve unaffordable | Not an error; the reserve is a target. |
| Negative cash in any bucket | Only ever with `deficit`/`currency_deficit`/`infeasible_event` flags. Never silent. |
| Foreign surplus | Stays in its bucket unless `sweepForeignSurplus`. |

Results carry `feasibility: { status, firstInfeasibleMonth?, reasons[] (with currency) }` and per-month flags. Property test (M18): across random scenarios, the sum over buckets of native balances changes only by recorded flows and recorded conversions.

### 13.5 Assumption catalogue

| Domain | Assumption types |
|---|---|
| Income | constant; annual % growth on anniversary; scheduled changes; active window; gross projected for display |
| Spending | historical **tracked** baseline (13.6) with inflation link; explicit recurring items; one-off events |
| Investments | expected nominal return per investment (defaults by asset class: equity 6 %, fixed income 3 %, cash-like 2 %, real-estate fund 4 %, commodities 3 %, crypto 8 %, pension 5 %, other 3 %); volatility (15/5/1/12/15/60/10/10 %); annual fee drag; contribution pipeline; allocation; scheduled changes |
| Property | appreciation; rent growth; vacancy %; opex with inflation link; mortgage per terms |
| Debt | amortization per 11.3; scheduled rate changes; extra repayments |
| FX | constant (default); annual trend per currency; auto-funding off by default, with spread (default 0.5 %) and optional fixed fee when on |
| Inflation | single annual rate; nominal/real toggle |
| Monte Carlo | per-investment volatility; correlation `default` (13.9) / `independent` / custom PSD matrix |

Historical personal returns are shown next to inputs as reference, never auto-filled (spec §77).

### 13.6 Spending baseline suggestion

Input: tracked **Consumption** (12.5: known tracked consumption + unclassified; excludes `is_one_off` expenses, property costs of rental properties, interest & fees, transaction costs and capital improvements, which the engine models separately) in the scenario's currency for months with status `reliable`. Additional self-paid spending (`untracked_self`) is added when `spending.baseline.includeAdditionalSelfPaid` is on — initialized from the user's `count_additional_spending` setting (default on) and editable per scenario — and then appears as its own line in the basis text; expenses paid by others (`third_party`) are never included. Estimator: median of the last 6 reliable months; if ≥ 9 reliable months in the last 12, the 20 % trimmed mean of the last 12; if fewer than 3 reliable months, empty with "enter a baseline" (spans and provisional months are never used). The basis text is stored in the definition. Additional self-paid spending is shown next to the baseline ("€X/month paid from outside your tracked accounts is included — change?", or "…is excluded — change?"); expenses paid by others are never suggested.

### 13.7 Event model

`ScenarioEvent = { id, type, month, order?, label?, params }` as a Zod discriminated union; one handler file per type registered in a map (`phase: 'definition' | 'inflow' | 'outflow'`, `schema`, `validate`, `apply`). Every monetary param carries a currency; funding follows 13.4.

| Type | Phase | Params | Effect |
|---|---|---|---|
| `salary_change` | definition | incomeRef, newMonthlyNet, newMonthlyGross? | replaces amount from m |
| `income_start` / `income_end` | definition | income spec / incomeRef | activates/deactivates |
| `recurring_expense_start` / `_end` | definition | expense spec / ref | |
| `contribution_policy_change` / `allocation_change` | definition | stages / allocation | |
| `one_off_expense` | outflow | amount, currency, onShortfall | cash −; counted as spending |
| `lump_sum_investment` | outflow | investmentRef, amount (investment currency), onShortfall | cash −, `flows_m` + |
| `investment_withdrawal` | inflow | investmentRef, amount | `flows_m` −, cash + (investment currency) |
| `property_purchase` | outflow | price, currency, costsPct or amount, downPayment, mortgage { rate, termMonths, rateType, currency }, rent?, appreciation, opex?, onShortfall | creates property and liability (both always in financial net worth); cash −(down + costs); costs = transaction costs |
| `property_sale` | inflow | propertyRef, salePrice or `projected` (= `V_open` in the sale month), costsPct | cash + net proceeds; linked liability paid off; both removed |
| `asset_purchase` / `asset_sale` | outflow / inflow | value, currency, growth, includeInFinancial / ref | |
| `new_loan` | inflow | amount, currency, terms | cash +, liability + |
| `extra_loan_payment` | outflow | liabilityRef, amount, onShortfall | balance −, cash − |
| `cash_injection` / `cash_withdrawal` | inflow / outflow | amount, currency, label | external money in / out (external inflows/outflows) |
| `currency_conversion` | outflow | from, to, sourceAmount or targetAmount, spreadPct? (default `fx.autoFunding.spreadPct`), fixedFee? | explicit user-planned conversion through `convertWithSpread` (13.4), recorded exactly like an auto-funding conversion |
| `adjustment` | outflow or inflow | target, delta, label | generic value adjustment; always labelled |

### 13.8 FX assumptions

`constant`: `rate_m = rate_0` (frozen start rates). `trend`: per-currency annual drift applied geometrically. Auto-funding is a separate switch (13.4). Charts distinguish actual history (before start) from assumptions (after start). Stochastic FX is a later `FxPathProvider`.

### 13.9 Monte Carlo (designed now, built in Phase 12)

- `StochasticReturnProvider(seed, investments, correlationModel)`: PRNG xoshiro128** seeded via splitmix32. Each month it draws one standard-normal **class factor** per asset class present, correlated through the Cholesky factor `L` of the asset-class matrix (`F = L·z_class`), plus one independent standard-normal **idiosyncratic shock** `ε_i` per investment. Investment `i` in class `c` gets `z_i = √ρ_c · F_c + √(1 − ρ_c) · ε_i`, where `ρ_c ∈ [0, 1]` is the class's within-class loading; its monthly log-return is `μ_m + σ_m·z_i` with `μ_m = ln(1 + μ)/12 − σ_m²/2`, `σ_m = σ/√12`; return `= exp(·) − 1`. Implied correlations: an investment with itself 1; two investments of the same class `ρ_c`; investments of classes `c` and `d` `√(ρ_c·ρ_d)·M_cd`. Because each `z_i` is a linear combination of independent standard normals, the implied investment covariance is positive semi-definite by construction whenever the class matrix `M` is PSD and every `ρ_c ∈ [0, 1]`.
- **Correlation model, one coherent behavior:** `monteCarlo.correlation` is `'default'`, `'independent'` or `{ assetClasses, classMatrix, withinClass }` (13.2). The engine validates symmetry, unit diagonal and positive semi-definiteness of `classMatrix` (Cholesky with a small ridge fallback; failure → `SCENARIO_INVALID`) and every `withinClass` loading in `[0, 1]`; `'default'` resolves to the explicit configuration below and is validated by the **same** function as a custom matrix. `independent` sets `M = I` and every `ρ_c = 0`, so each investment's shock is independent.
- **Documented illustrative default** (UI label: "assumed long-run correlations — illustrative, not calibrated to your holdings"). Class order, fixed: `[equity, fixed_income, cash_like, real_estate_fund, commodities, crypto, pension, other]`. Class matrix `M`:

| | equity | fixed_income | cash_like | real_estate_fund | commodities | crypto | pension | other |
|---|---|---|---|---|---|---|---|---|
| equity | 1.00 | 0.10 | 0.00 | 0.60 | 0.30 | 0.40 | 0.75 | 0.20 |
| fixed_income | 0.10 | 1.00 | 0.00 | 0.30 | 0.20 | 0.20 | 0.40 | 0.20 |
| cash_like | 0.00 | 0.00 | 1.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| real_estate_fund | 0.60 | 0.30 | 0.00 | 1.00 | 0.20 | 0.20 | 0.20 | 0.20 |
| commodities | 0.30 | 0.20 | 0.00 | 0.20 | 1.00 | 0.20 | 0.20 | 0.20 |
| crypto | 0.40 | 0.20 | 0.00 | 0.20 | 0.20 | 1.00 | 0.20 | 0.20 |
| pension | 0.75 | 0.40 | 0.00 | 0.20 | 0.20 | 0.20 | 1.00 | 0.20 |
| other | 0.20 | 0.20 | 0.00 | 0.20 | 0.20 | 0.20 | 0.20 | 1.00 |

  Within-class loadings `ρ_c`: equity 0.85, fixed_income 0.70, cash_like 0.90, real_estate_fund 0.80, commodities 0.60, crypto 0.80, pension 0.70, other 0.50. This matrix is symmetric with unit diagonal and its smallest eigenvalue is ≈ +0.0265 (computed during planning; the Cholesky factorization succeeds), so it passes the validator. The earlier draft value of 0.80 for equity–pension gave a smallest eigenvalue of ≈ −0.0106 and would have been rejected by the blueprint's own validator, which is why the value is 0.75. A dedicated golden test (`monte-carlo/default-correlation-psd`) asserts that the shipped default passes the same validator as custom matrices and pins these eigenvalue facts. Same-class investment correlation is governed by `ρ_c`, not by the class matrix, so two equity funds correlate at 0.85, never 1.
- Tests assert that under the default two equity funds have a sample return correlation ≈ 0.85 (strongly positive, strictly below 1), an equity/bond pair ≈ 0.1·√(0.85·0.7) ≈ 0.08, an investment with itself exactly 1, and that `independent` yields ≈ 0; no empirical claim is made in the UI or tests.
- Run = N paths × the same `simulate()` with `FloatBackend`. Defaults N = 1,000; max 5,000 within one request; above that, queued (future worker). Outputs: per-month percentiles (P5/P25/P50/P75/P95) of total and financial net worth, investments, cash, debt; feasibility probability; per goal: probability by target date and percentile achievement months; the deterministic run shown alongside.
- Reproducibility: `seed` stored; identical (revision, engine version, seed, N) → identical output.

### 13.10 Revisions, caching, rebase, comparison

- Editing assumptions/events → new `scenario_revisions` row (`revision_no + 1`); `scenarios.current_revision_id` advanced with an optimistic check. Duplicating copies the current revision.
- `projection_runs` caches results per (revision, engine version, mode, seed, params hash); deterministic runs compute synchronously on miss (< 1 s for 40 years).
- **Rebase**: capture a new starting state (T4 rule; as-of ≤ today), create a revision keeping assumptions and events, drop synthetic items for positions that no longer exist (flagged), mark events dated before the new start as `in_the_past`.
- **Comparison**: up to 4 scenarios; each run's `MonthState.drivers` (12.3 taxonomy, with cash injections/withdrawals as external inflows/outflows and conversion costs under interest & fees) cumulated to the comparison date; the difference table is bucket-by-bucket for total net worth (and for financial net worth with the 12.4 lines), so "+€51,000 vs baseline" is explained by lines that sum exactly. Allocation lines are compared in a separate table (R1).

### 13.11 Result document

`ProjectionResult { engineVersion, backend, months: MonthState[], summary: { at: [12, 60, 120, 240, H] → aggregates nominal & real, total & financial }, feasibility, goals: GoalOutcome[], warnings[] }`; `MonthState` holds native balances per bucket/item, R aggregates, index, rates, flows, conversions and flags. Compact JSON; 40 years ≈ 150 KB.

---

## 14. Goals architecture

| Kind | Progress metric (actuals, in goal currency) | Achieved when |
|---|---|---|
| `net_worth` | total net worth at latest as-of | ≥ target |
| `financial_net_worth` | financial net worth | ≥ target |
| `investments` | total investments (or one investment if `position_id`) | ≥ target |
| `cash_reserve` | cash & savings | ≥ target |
| `debt_payoff` | balance of `position_id` (or total debt); progress = 1 − balance/original | balance = 0 |
| `property_down_payment` | cash & savings (optionally cash-like investments) | ≥ target |
| `passive_income` | trailing-12-month rental + dividend + interest income | ≥ target (annual) |
| `custom` | `Σ s(p)·V_p·r_p` over the positions in `goal_positions` (any kinds; liabilities with sign −1) — "signed net value of a chosen set of positions" | ≥ target |

- **Actual history**: monthly series of the metric vs the target line; achievement detected on read and persisted (`achieved_on`) with an audit entry when confirmed.
- **Deterministic scenario**: evaluated per month (13.3 step 11); `GoalOutcome { goalId, projectedMonth | null, valueAtTargetDate, shortfall }`. Custom goals map their positions to scenario refs; a position absent from the scenario (closed before start) contributes 0 and the outcome is marked `partial_scope`.
- **Monte Carlo**: probability of achievement by `target_date`; P10/P50/P90 of `projectedMonth`.
- A goal may pin a `scenario_id`; otherwise the baseline scenario is used; goals with no scenario show actual progress only. No gamification.

---

## 15. Application / page architecture

### 15.1 Navigation

Desktop sidebar as specified (Overview: Dashboard, Monthly · Finances: Accounts, Income, Spending, Investments, Real Estate, Debts · Planning: Analytics, Projections, Goals · System: Settings), with two refinements: the Expenses page is labelled **Spending** (R14), and **Other assets** are a tab inside Accounts. Global shell: reporting-currency selector (`EUR ▾`), month picker in the Monthly area, "Quick update" as a primary button on Dashboard and Monthly (a modal), user menu. Mobile: bottom tabs Dashboard · Monthly · Investments · Analytics · More.

Routes: `/dashboard`, `/monthly/[yyyy-mm]`, `/monthly/[yyyy-mm]/history` (bulk editor), `/accounts` (`?tab=cash|other`), `/accounts/[id]`, `/income`, `/income/sources/[id]`, `/expenses`, `/investments`, `/investments/[id]`, `/real-estate`, `/real-estate/[id]`, `/debts`, `/debts/[id]`, `/analytics/(wealth|cash-flow|investments|real-estate|income)`, `/projections`, `/projections/[scenarioId]`, `/projections/compare`, `/goals`, `/goals/[id]`, `/settings/(profile|security|currencies|categories|data)`, `/onboarding/[step]`, `/auth/(sign-in|sign-up|verify|reset)`.

### 15.2 Page catalogue

| Page | Purpose | Primary data | Primary actions | Visualizations | Empty state | Stale / incomplete state | Mobile |
|---|---|---|---|---|---|---|---|
| Dashboard | "Where am I, what changed" | financial net worth (headline) with total net worth beside it when they differ; month/YTD change; drivers summary; current month "in progress" state; freshness per component; history; allocation | Quick update; open current month; switch currency | NW area chart (both metrics selectable), allocation bar, drivers mini-waterfall | Onboarding checklist until ≥ 1 valuation | Completeness banner for the last completed month; "September in progress (updated through 6 Sep)"; component age badges; partial markers | Single column |
| Monthly (completed month) | Maintain one month | everything for M (15.3) | Enter month-end balances, confirm unchanged, accept suggestions, add flows, resolve issues, mark reviewed | Reconciliation panel, prev/current columns | Prompt to add positions or enter last month's balances | Status chips per section; blocking issues at top | Accordion; sticky summary |
| Monthly (current month) | Month to date | opening balances, latest snapshots per account (with dates), MTD flows, upcoming suggestions | Quick update (all cash accounts), record flows dated ≤ today, accept suggestions whose date has passed | MTD provisional panel through the latest common date (with a newer-balances note when applicable), or the no-common-date message | — | "Month-to-date is through <D>"; "Some accounts have newer individual balances; update all accounts to move the MTD date forward"; or "Update all cash accounts to the same date to calculate month-to-date spending"; from the first day of the following month: "Enter end-of-September balances to close the month" | same |
| Bulk history editor | Reconstruct history | grid: completed months × (positions' month-end values, income per template); the known-expense-total column arrives with the complete editor in Phase 7 (15.3) | Paste/enter, save batch | grid | Blank grid from a chosen start | Carried cells greyed; current month row disabled | Desktop-first |
| Accounts | Cash overview | total cash (by currency and in R), accounts with balance, age, dormant flag | Add account, quick update, close, mark dormant | Cash history stacked area | "Add your first account" | Age badges; "no month-end balance for September" | List cards |
| Account detail | One account | balance timeline (month-end and intra-month snapshots distinguished), monthly changes, edit history | Add/edit/delete valuation, close | Line + table | — | Carried spans dotted | Timeline table scrolls |
| Other assets (tab) | Vehicles etc. | value, **included in financial net worth** flag, age, cost basis | Add/revalue/improve/sell; toggle inclusion | table | "Track something else you own" | Age | list |
| Income | Income overview | net/gross by month, by source, annual totals, progression | Add source, add entry, edit terms | Bars by month, source composition, base vs bonus | "Add a salary or other income source" | Months with due-but-missing template flagged | bars scroll |
| Spending | Tracked + additional | per month: tracked spending (consumption, known/unclassified, costs), **additional spending** (paid by me outside tracked accounts), **total spending** (tracked + additional), **paid by others** (informational, outside totals); statuses; spans; saved from income and savings rate (12.5); rolling 3/6/12 (tracked, reliable months only); categories; largest known | Add known expense with how it was paid (tracked account / by me outside tracked accounts / by someone else), open month | Stacked bars (known/unclassified) with status hatching; span bars across gaps; additional spending as a separate series; paid-by-others as a muted memo series; category bars; table | "Enter two month-end balances to see inferred spending" | Unavailable months as gaps with reason and span links; provisional current month hatched or "update all accounts" note | bars scroll |
| Investments | Portfolio | value, current net invested (basis-known vs since-tracking rows marked), gain, gain since tracking, XIRR / return on net invested, allocation, performance by month | Add account/investment (with optional opening net invested basis), record flows/valuations | Value vs net invested area, performance bars, allocation | "Add an investment" | Stale badge; performance gaps | cards + chart |
| Investment detail | One investment | value history, flows, performance, FX decomposition, dividends, fees, opening net invested basis, contributions/withdrawals since tracking, metrics with availability reasons | Record flow/valuation/dividend/fee, edit basis, close | Value & net invested lines, monthly performance bars, FX/native stacked | — | — | — |
| Real Estate | Portfolio | total value, debt, equity per property, yields | Add property | Equity bars | "Add a property" | Age badge; "includes estimated value added" marker | list |
| Property detail | One property | acquisition, valuations, improvements (cost basis), mortgage, rent by month (received / skipped with reason / "No rent recorded"), costs, cash flow, yields, value change, returns | Revalue, add rent/cost, add improvement (with optional value-add estimate), sell | Value vs debt, cash-flow bars | — | Value-change spans; unknown rent months never shown as vacant | — |
| Debts | Liabilities | total debt, balance state, rate, payment, projected payoff | Add liability, record payment/balance | Balance projection vs actual | "Add a mortgage or loan" | `derived`/`carried` badges | list |
| Debt detail | One liability | balance history (confirmed vs derived), terms history, payments, interest/principal split, schedule | Add terms, payment, confirm balance, extra payment, payoff | Schedule area, balance lines | — | — | schedule scrolls |
| Analytics (5 areas) | 15.5 | | | | | | |
| Projections | Scenarios list | scenarios, baseline, last run summary | New scenario, duplicate, compare, rebase | NW sparkline per scenario | "Create your first scenario from <month>" | Start-state age warning | list |
| Scenario | Edit + results | assumptions (incl. currency funding and reserve), events timeline, results (nominal/real; total/financial), feasibility with currency deficits, goals | Edit, add events, run, save revision | NW/components lines, per-currency cash lines with reserve band, event markers, conversions markers, drivers waterfall | — | Infeasible shading from first month | results first |
| Compare | Diff vs baseline | up to 4 scenarios, metrics at dates, driver differences | Choose scenarios/dates, toggle diff, total/financial | Multi-line NW, diff table | — | — | table scroll |
| Goals | Goals list/detail | progress, projected date, probability; custom goals show their position set | Add goal (pick positions for custom), pin scenario | progress bar + series vs target | "Set a target" | — | list |
| Settings | Profile, security (password, 2FA, sessions), currencies (base, favorites), spending preferences ("Count spending I paid from outside my tracked accounts in my savings rate", default on), categories/tags, data (export, delete account) | | | | | | |
| Onboarding | Steps 1–10 of spec §90, skippable; balances entered are dated today (exact) | | | | | | |

### 15.3 Monthly editor (the core workflow)

One page per month, eight sections in a left sub-navigation (desktop) or accordion (mobile), each with a status chip (`complete`, `needs input`, `suggested`, `issue`). Target: a normal completed month in under three minutes.

1. **Overview**: net income, tracked spending (with status), unclassified, additional spending, total spending, saved from income (tracked accounts), personal savings and savings rate, invested, investment performance, mortgage principal, Δ total/financial net worth; completeness; "Mark reviewed" (completed months only); blocking issues with jump links. For the current month: MTD figures labelled "through <D>" (the latest date every cash account shares), with "Some accounts have newer individual balances; update all accounts to move the MTD date forward" when applicable, or "Update all cash accounts to the same date to calculate month-to-date spending" when no common date exists, plus "September can be closed from 1 Oct".
2. **Income**: one row per due template ("Salary — suggested €2,100 on 25 Sep — Accept · Edit · Skip"). Suggestions dated after today are shown as "upcoming" and cannot be accepted until their date — or through "received today", which records the flow’s financial date as today while keeping the occurrence’s own `occurrence_date`, so the occurrence counts as fulfilled and is never suggested again. **"Received today" reaches exactly one occurrence: the earliest scheduled occurrence after today that is neither already materialized nor explicitly skipped.** There is no horizon in days or months — the bound is the schedule itself, so a user cannot claim an occurrence while an earlier one of the same template is still unresolved, and the genuinely next occurrence of an annual source stays reachable however far off it is (30.10). A salary scheduled for 1 October and actually received on 30 September is one income entry with `occurrence_date = 2026-10-01` and `received_on = 2026-09-30`: September’s reconciliation correctly sees the cash arrive on the 30th, and October never suggests it a second time. Editing a suggested amount offers "This month only" — which changes that one materialized occurrence — or "From this month on", which writes a `recurring_template_terms` row with `effective_from` at that occurrence’s `occurrence_date` (6.2) and leaves every already materialized flow alone. Skipping any suggestion writes a `recurring_template_skips` row for that occurrence; for rental income it asks for a reason (vacant / tenant did not pay / other), which is the only occupancy fact the app records.
3. **Known expenses**: list + inline add (amount, category, date ≤ today, and how it was paid: "Paid from tracked account" with the account picker, "Paid by me outside tracked accounts", or "Paid by someone else"); templates suggested like income; one-off flag; capital improvements are added from the asset's page, not here.
4. **Accounts (completed month)**: table Account · Previous (end of M−1) · Current (end of M) · Status. The Current cell is the **balance at the end of M**, saved dated `end(M)` with `month_end` precision; it is editable only once the month has ended (`today > end(M)`, i.e. from 1 Oct for September). If a snapshot dated the last day of the month exists, the cell is prefilled from it with "Confirm as statement balance"; other intra-month snapshots are shown as a hint ("last snapshot 8,120 on 24 Sep"). Enter moves down; `=` or "Unchanged this month" writes a `confirmed_unchanged` valuation dated `end(M)`; "Confirm all untouched as unchanged" for the rest; dormant accounts show "dormant (0)"; closed/opened-in-month rows show 0 with explanation; a pre-existing account first tracked this month shows "first balance — not part of this month's spending".
   **Accounts (current month)**: Previous · Latest snapshot (with its date) · "Update today" input that writes an exact snapshot dated today, plus "Update all today" for every active cash account so the month-to-date date advances to today; no month-end column until the month has ended, including on its last day.
5. **Investments**: Previous · Contribution · Withdrawal · Current · Performance (live). Flows dated ≤ today. Current-month valuations are dated today.
6. **Properties**: last valuation + age; "Keep" / "Update valuation" (dated ≤ today); rent and costs suggested from templates; improvements listed with their cost-basis effect.
7. **Debts**: Previous · Suggested payment (once its scheduled day has passed) · Accept · Expected balance · "Confirm actual balance" (dated ≤ today).
8. **Reconciliation**: per currency: the identity with real numbers, status, issues with one-click actions, per-account residuals; for the current month the provisional MTD identity "through <D>", with the newer-balances note or the no-common-date message, each offering the "Update all today" action. Recomputed client-side on every change; the server's result replaces it after save.

Every field autosaves on blur with optimistic UI and version checks. Keyboard: Tab/Enter navigation, `[`/`]` previous/next month.

**Quick update** (modal): all active cash accounts pre-selected (dormant excluded) plus any other positions the user ticks, one input each, dated **today** (exact precision) — no other date is offered (M5). Leaving a cash account blank keeps its older snapshot, and the modal notes that the month-to-date date then stays at the latest date every account shares. On the last day of the month the modal states that these are ordinary snapshots and that the month can be closed from the next day by confirming them as statement balances or entering the statement figures.

**Historical correction**: editing a past valuation or flow opens the inline editor with a confirmation showing before → after and the affected months and spans; reason optional; audit written.

**Bulk history**: grid columns = each position (month-end value, `month_end` precision) and each income template (net); rows = completed months from a chosen start (the current month row is disabled); paste from a spreadsheet (TSV, locale-aware numbers); per-cell validation; batch save in one transaction, aborted entirely on any conflict (20.3). An income cell is an ordinary editor over the occurrence it names: filling an empty cell materializes that occurrence, changing a filled one updates the existing row against its version, and clearing one hard-deletes that row with its audit image and makes the occurrence due again unless a skip exists. The cell is identified by the same `(template_id, occurrence_date)` as everywhere else — never by description text or a hidden marker — and is disabled for a month in which the template has no occurrence.

A **"known tracked expenses (total)"** column is deliberately **not** part of v1 and belongs to the complete editor in Phase 7. A single monthly total has no unique representation in this schema: no category, no native currency once a user holds more than one, no cash-account attribution, no financial date, no durable row identity for a later edit or clear, and no rule saying whether the ordinary expense rows already recorded for that month are inside the total or additional to it. Choosing any of those silently would create hidden accounting semantics, and a monthly-expense-total table would be exactly the stored aggregate 5.3 forbids. Nothing is lost meanwhile: month-end balances plus income already reconstruct a correct `TrackedTotalSpending` for each month, and the column would only move money from the inferred residual into the known part — so until Phase 7 defines the representation, uncategorized historical spending stays honestly in the residual.

### 15.4 Dashboard composition

Top: financial net worth in R (large, tabular numerals) with "Total incl. other assets: €X" beneath when different; Δ month and Δ YTD with sign and arrow; state chip for the current month ("September in progress — month to date through 6 Sep", with "newer balances on some accounts" when applicable, or "no common balance date — update all accounts") and completeness of the last completed month ("August 100 % complete"). Row of five compact figures: Cash · Investments · Property equity · Debt · Liquid assets, each with freshness. Main: NW history area chart (12M/All; metric toggle; stale months hatched; current month drawn as a provisional point). Secondary: last completed month's drivers (income, spending, returns, interest, FX) as a small horizontal waterfall; investment performance (month, YTD, XIRR if available); income vs tracked spending; allocation bar. No hero cards.

### 15.5 Analytics areas

| Area | Calculations | Charts | Tables | Ranges | Data dependency |
|---|---|---|---|---|---|
| Wealth | total and financial NW series, liquid assets, composition by kind and currency, debt series, drivers decomposition per period (both metrics) | NW area (metric toggle); composition stacked area; drivers waterfall and stacked bars | Period decomposition table with reconciliation row | 3M · 6M · YTD · 1Y · 3Y · 5Y · All | Stale positions shaded; partial months marked; current month excluded from period decompositions |
| Cash flow | income, tracked spending, consumption, known/unclassified, additional spending, total spending, paid by others (memo), saved from income (tracked accounts), personal savings and savings rate (12.5; additional spending counted per the user setting, labelled either way), rolling 3/6/12 averages (reliable months only) | income vs spending bars; savings-rate line; rolling averages | Monthly table with status column and span rows | same | Unavailable months excluded from averages; spans shown but never averaged |
| Investments | contributions vs value, performance per month, gain vs current net invested (basis marked where known) and gain since tracking, XIRR, native vs FX, allocation | value vs net invested area; performance bars; native/FX stacked; allocation | Per-investment metrics with availability reasons and basis marker | same | Performance gaps for carried months |
| Real estate | equity, value change over confirmed spans, appreciation net of improvements, yields, amortization, cash flow, total return; occupancy only from explicit facts (received / skipped-vacant / unknown) | equity area; interest/principal stacked; cash-flow bars | Per-property metrics | same | Spans; estimated value-add marked; unknown rent months shown as unknown |
| Income | gross/net progression (base vs bonus), annual totals, source composition | step lines; annual bars; composition | Source table | same | — |

Every chart has "View as table" and an explain-this-number popover for derived values.

---

## 16. UX / design-system plan

### 16.1 Direction

Calm, dense, typographic. The number is the interface. References in spirit: Linear's restraint, Stripe Dashboard's tables. Light and dark themes with identical structure.

### 16.2 Tokens (Tailwind v4 `@theme`, shadcn CSS variables, both modes)

- **Spacing**: 4 px base; section padding 24 px desktop / 16 px mobile; table row height 36 px (dense) / 44 px (forms); rhythm 8 / 16 / 24 / 40.
- **Typography**: Inter (or Geist) with `font-feature-settings: "tnum" 1`; `font-variant-numeric: tabular-nums` on every numeric cell. Scale: 12 (meta), 13 (table), 14 (body), 16 (section title), 20 (page title), 28/32 (headline figure, weight 600).
- **Containers**: sidebar 240 px (collapsible to 64); content max-width 1,280 px (analytics 1,440); tables full-width with sticky header and sticky first column on overflow.
- **Color**: neutral scale for surfaces and text; one accent for interactive elements; semantic positive/negative/warning(stale)/info/unavailable; contrast ≥ 4.5:1 text, ≥ 3:1 chart lines. Neutral data stays neutral.
- **Financial direction**: sign always rendered (`+€430`, `−€729`), arrow glyph for changes, color as reinforcement only. Unavailable: `—` with a tooltip reason, never `0`.
- **Stale / carried / provisional / estimated**: amber dot + age text; charts draw carried segments dotted, provisional points hollow, estimated values and spans hatched.
- **Borders and radius**: 1 px borders, radius 6/8 px; no shadows except menus/dialogs; no gradients; no glass.
- **Motion**: 120–160 ms ease-out; numbers do not animate; charts animate only on first render.

### 16.3 Charts (Recharts, wrapped in `apps/web/components/charts/*`)

Time series as line/area; composition/decomposition as stacked bars and waterfalls with reconciliation totals; no 3D, no pies (allocation as horizontal stacked bars, donut only with a legend table); one series palette (6 hues, then patterns); tooltips formatted from exact strings; keyboard-focusable points; "View as table" under every chart; historical vs projected as solid vs dashed with a divider; multi-currency scenario cash as one line per currency.

### 16.4 Tables

Right-aligned numerals, tabular figures, unit in header, subtotal rows bold, status column with icon+text, sortable headers, 36 px rows, hover highlight, inline edit cells with clear focus ring, sticky headers, horizontal scroll container on narrow screens.

### 16.5 Responsive behavior

Desktop (≥ 1,280): sidebar + content, side-by-side comparisons, dense tables. Laptop (1,024–1,279): collapsible sidebar. Tablet (768–1,023): sidebar behind a button, sections stack, tables scroll. Phone (< 768): bottom tabs, single column, accordion monthly editor, numeric keyboards (`inputmode="decimal"`), simplified charts.

### 16.6 Accessibility (WCAG 2.2 AA)

Semantic landmarks, skip link, heading order; sidebar `nav` with `aria-current`. Keyboard: every action reachable; visible `:focus-visible` rings; roving tabindex in grids; dialogs trap and restore focus (Base UI); no keyboard traps in charts. Forms: visible labels; errors linked with `aria-describedby`/`aria-invalid`; error summary on submit; `aria-live="polite"` for autosave and reconciliation status. Charts: `role="img"` with a summary sentence plus the table alternative; series distinguishable by pattern. Color never the only carrier of direction or state. Target size ≥ 24×24 px; reduced motion respected; 200 % zoom usable. Locale-correct formatting via the exact formatter (7.1.1); numeric inputs accept both `,` and `.` decimal separators.

---

## 17. Authentication / security model

### 17.1 Better Auth configuration (1.7.x)

| Concern | Setting |
|---|---|
| Sign-up / sign-in | `emailAndPassword: { enabled: true, requireEmailVerification: true, minPasswordLength: 12, maxPasswordLength: 128, autoSignIn: false }`; passwords checked against Have I Been Pwned via `isPasswordCompromised` (k-anonymity) at sign-up and change; default scrypt hashing (no custom crypto). |
| Verification | `emailVerification: { sendOnSignUp: true, expiresIn: 3600, autoSignInAfterVerification: true }`. |
| Reset | `sendResetPassword` with 1-hour single-use tokens; `revokeSessionsOnPasswordReset: true`. |
| Sessions | DB-backed, `expiresIn: 30 d`, `updateAge: 1 d`, `cookieCache: { enabled: true, maxAge: 300 }`; cookies `httpOnly`, `secure` in production, `sameSite: 'lax'`, `__Secure-` prefix. `freshAge: 600` — password change, 2FA changes, account deletion and data export require a session younger than 10 minutes or re-authentication. |
| 2FA | `twoFactor({ issuer: 'Vaultide' })` plugin: TOTP + backup codes; lockout after 5 wrong codes; optional per user. The issuer string is what authenticator apps display. |
| Rate limiting | `rateLimit: { enabled: true, storage: 'database', window: 60, max: 30, customRules: { '/sign-in/email': { window: 60, max: 5 }, '/sign-up/email': { window: 600, max: 3 }, '/forget-password': { window: 900, max: 3 }, '/two-factor/verify-totp': { window: 300, max: 5 } } }`. |
| Origins | `trustedOrigins: [APP_URL]`. |
| IDs | `advanced.database.generateId` returning UUID v4 so auth tables use `uuid` columns. |
| Next.js | `nextCookies()` as the last plugin; route handler at `app/api/auth/[...all]/route.ts`. |
| Email | `Mailer` interface in `application` with a provider adapter (EU sending region where offered) and a capturing stub for tests. Sender identity and template branding are "Vaultide" (`EMAIL_FROM` such as `Vaultide <no-reply@vaultide.app>`); verification and reset messages name the product. |
| Later | `passkey()` and social providers are plugin additions. |

### 17.2 Session → authorization flow

1. `proxy.ts` redirects unauthenticated requests for `/(app)/*` to sign-in when the session cookie is absent, and adds security headers. A convenience gate, not the authority.
2. Every server component under `(app)` and every server action calls `requireSession()` → `RequestContext { userId, sessionId, settings, today, reportingCurrency }`. Missing session → `AUTH_REQUIRED`.
3. `application` services take the context first; repositories take `ctx.userId` and always filter by it; the DB transaction sets `app.current_user_id` (17.4). Client-provided ids are only ever used inside `WHERE id = $1 AND user_id = $ctx`. Cross-user ids produce `NOT_FOUND`.

### 17.3 Threats and controls

| Threat | Control |
|---|---|
| CSRF | Server actions are POST-only with per-build ids and Next.js verifies `Origin`/`Host`; Better Auth verifies `Origin`; custom mutating route handlers require an allow-listed `Origin` or a bearer secret; `SameSite=Lax`. |
| XSS | React escaping; `dangerouslySetInnerHTML` banned; strict CSP with per-request nonce (`script-src 'self' 'nonce-…' 'strict-dynamic'`, `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`, `form-action 'self'`, `style-src 'self' 'unsafe-inline'` for Recharts inline styles); no third-party scripts. |
| IDOR | Ownership filter in every repository, composite `(id, user_id)` FKs, RLS default-deny, parametrized security test replaying every action with another user's ids. |
| SQL injection | Drizzle parameterizes everything; `sql.raw` allowed only in migrations; lint rule. |
| Session fixation / hijacking | Fresh session token on sign-in; sessions are server rows revocable from Settings; `Secure`+`HttpOnly`; HSTS preload. |
| Brute force | DB-backed rate limits; TOTP lockout; password policy; HIBP check. |
| Enumeration | Sign-up wrapper returns the same message whether or not the email exists and emails the existing owner; forgot-password always returns success; resend rate-limited. |
| Insecure DB access | Neon with TLS required; roles per 6.1: `app_owner` (DDL; credentials only in GitHub Actions), `app_user` (runtime; `NOBYPASSRLS`; no DDL), `app_backup` (SELECT + `BYPASSRLS`; credentials only in the backup workflow, never in Vercel). No role in runtime can read across tenants. |
| Cross-tenant discovery by jobs | Jobs operate on global tables only (FX refresh, 10.4); there is no job that iterates users' financial data. |
| Leaked secrets | Env vars only; `gitleaks` in CI; `BETTER_AUTH_SECRET` ≥ 32 random bytes; rotation runbook. |
| Log leaks | Section 18.2. |
| Supply chain | pnpm lockfile, `minimumReleaseAge` 3 days, Renovate weekly, `pnpm audit --audit-level high` in CI. |
| Client secrets | Only `NEXT_PUBLIC_SENTRY_DSN` and app URL are public. |

### 17.4 Row Level Security

- Every user-owned table: RLS enabled (Drizzle `pgTable.withRLS`), one policy for role `app_user`: `USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)`. `current_setting(…, true)` returns NULL when the GUC was never set and `''` when it was set empty (or reset in some pooling situations); `NULLIF` turns both into NULL, the cast of NULL is NULL, the comparison is NULL, and the policy denies — without a cast error and without ever matching a row. Tables without `user_id` (`currencies`, `fx_rates`) and auth tables have no RLS.
- `db.withUser(ctx, fn)`: `BEGIN; SELECT set_config('app.current_user_id', $userId, true); … ; COMMIT`. Transaction-local, safe under PgBouncer transaction pooling. Every service call runs inside one such transaction. `withUser` is the **only** code path that sets the GUC; it validates `userId` against the canonical UUID pattern before calling `set_config`, and the value always comes from the authenticated session, never from request input, so a malformed value cannot be injected.
- A query outside `withUser` sees a missing GUC, so RLS returns no rows — failing closed. This is also why the FX cron, which runs as `app_user` without a user context, can only touch global tables.
- Migrations run as `app_owner` over the direct endpoint (table owner; bypasses RLS implicitly; never the runtime role).
- `app_backup` is `BYPASSRLS` by design so `pg_dump` is complete; it has no DML/DDL grants and its credential exists only in the backup workflow's environment.
- Tests (21.3–21.4), run as raw SQL under `app_user`: GUC missing → zero rows and no error; GUC set to `''` → zero rows and no error; GUC = A → only A's rows; GUC = B → only B's rows; an `INSERT` with B's `user_id` under A's setting fails `WITH CHECK`; a dump under `app_backup` contains both users' rows; `app_backup` cannot `INSERT`.

---

## 18. Audit / privacy / data lifecycle

### 18.1 Audit mechanism

- `packages/db/repositories/audited.ts`: `auditedInsert/Update/Delete(tx, ctx, table, …)` loads the before-image inside the same transaction (`SELECT … FOR UPDATE`), performs the mutation, computes `changed_fields`, and inserts one `audit_entries` row with `before`, `after`, `actor_user_id`, `request_id`, optional `reason`. Every source table marked "Audit: yes" goes through these helpers only (lint forbids direct writes elsewhere).
- Audit rows contain full structured financial values; they live in the same protected database (RLS, roles) and are never copied to logs, Sentry or analytics.
- Restore = a new audited mutation writing the `before` image back. UI: "History" drawer (Phase 7).
- Retention: for the life of the account; deleted with the account. Bulk saves: one entry per row sharing a `request_id`.

### 18.2 Logging and telemetry redaction

- `pino` with a fixed schema (`time, level, request_id, user_id, action|route, duration_ms, error_code, entity_table?, entity_id?`); a `redact` list for keys matching `/^(amount|balance|value|rate|price|net|gross|total|salary|payment|principal|interest|basis)/i` as a backstop; DTOs and inputs are never passed to the logger.
- Domain error messages never interpolate user values.
- Sentry (EU): `sendDefaultPii: false`; `beforeSend` deletes `request.data`, `request.query_string`, `extra`, `contexts.state`, fetch/xhr/console breadcrumbs; server-action argument capture disabled; client SDK without Session Replay; `ignoreErrors` for expected domain codes. Cron monitors for FX and backups.
- No product analytics vendor.

### 18.3 Privacy, export and deletion

- Hosting in Frankfurt (Vercel `fra1`, Neon `eu-central-1`, Sentry DE); email provider with an EU region.
- **Export** (Phase 7): `/api/export` streams a ZIP with `export.json` (every user-owned table, native values, ids, opening bases, inclusion flags) and one CSV per table; fresh session required; rate-limited. Runs as `app_user` inside `withUser`, so it can only ever contain the requesting user's rows.
- **Deletion** (Phase 1): Settings → Delete account → re-authenticate → typed confirmation → `auth.api.deleteUser` and `DELETE FROM "user"`; every table cascades (6.1), verified by a test that seeds every table for a user, deletes, and asserts zero rows remain. Confirmation email sent.
- **Backups** retain deleted data until they expire (22.5); stated in the privacy notice; no selective purge from backups.
- GDPR readiness: DSAR = export; erasure = deletion; retention policy in `docs/privacy/retention.md`; processors: Vercel, Neon, Sentry, email provider, backup storage (DPAs); no consent banner needed.

### 18.4 Lifecycle summary

| Data | Created | Edited | Archived/closed | Deleted | In backups |
|---|---|---|---|---|---|
| Positions, templates, categories | user | audited | user | only when unreferenced | yes |
| Valuations, flows, payments, terms | user / accepted suggestion (dated ≤ today) | audited, versioned | — | hard delete + audit image | yes |
| Scenarios | user | new revisions | archive | hard delete cascades | yes |
| Projection runs | system | — | — | any time (cache) | yes (harmless) |
| Audit entries | system | never | — | with account | yes |
| FX rates | cron / first-use backfill | never | — | never | yes |
| Auth data | Better Auth | user | — | with account | yes |

---

## 19. Repository / module structure

```text
vaultide/
├── apps/web/                          # @vaultide/web — Next.js (App Router)
│   ├── src/app/
│   │   ├── (auth)/sign-in|sign-up|verify|reset/
│   │   ├── (app)/dashboard|monthly/[month]|accounts|income|expenses|investments|real-estate|debts|analytics|projections|goals|settings|onboarding/
│   │   ├── api/auth/[...all]/route.ts · api/cron/fx-refresh/route.ts · api/health/route.ts · api/export/route.ts
│   │   └── layout.tsx (shell, theme, currency selector; app metadata title "Vaultide")
│   ├── src/components/ui/             # shadcn (Base UI) generated components, customized
│   ├── src/components/charts/         # Recharts wrappers with table fallback
│   ├── src/components/finance/        # MoneyText, DeltaText, FreshnessBadge, StatusChip, ExplainPopover
│   ├── src/components/forms/          # MoneyInput, DateInput (max = today), PositionPicker
│   ├── src/features/<area>/           # page-level client components per area (monthly editor, bulk grid, scenario editor)
│   ├── src/server/actions/<area>.ts   # defineAction wrappers only
│   ├── src/server/context.ts          # requireSession → RequestContext (today in user tz)
│   ├── src/lib/format.ts              # exact money/percent formatting (7.1.1)
│   ├── proxy.ts · next.config.ts · instrumentation.ts · sentry.*.config.ts
├── packages/finance/                  # @vaultide/finance — PURE: money, dates, fx, positions (freshness, sign), reconciliation (month, mtd, spans), investments,
│   ├── src/…                          # mortgage, property, networth (total, financial), decomposition, analytics, projection/{engine,events,backends,mc,fx-funding}, goals, rules
│   └── test/{fixtures,golden,properties}
├── packages/db/                       # @vaultide/db
│   ├── src/schema/<domain>.ts         # drizzle tables, enums, policies, roles
│   ├── src/migrations/                # generated SQL (committed) + meta
│   ├── src/client.ts                  # pool, withUser(ctx, fn)
│   ├── src/repositories/<domain>.ts   # typed queries, always user-scoped; audited helpers
│   └── src/seed/                      # fixtures loader (dev/preview/test)
├── packages/validation/               # @vaultide/validation — zod: primitives (money, date ≤ today, currency), enums, inputs per use case, DTOs, scenarioDefinition
├── packages/application/              # @vaultide/application — services per domain; unit of work; audit; fx; export; users
├── packages/config/                   # @vaultide/config — tsconfig.base.json, eslint.config.js, dependency-cruiser.cjs
├── e2e/                               # Playwright
├── docs/                              # adr/, ops/ (runbooks, restore log), privacy/
├── .github/workflows/                 # ci.yml, deploy-production.yml, nightly-backup.yml
└── README.md · pnpm-workspace.yaml · package.json (name "vaultide") · turbo.json · .env.example
```

**Boundary rules (dependency-cruiser in CI):**

| From → To | finance | validation | db | application | apps/web |
|---|---|---|---|---|---|
| finance | — | ✗ | ✗ | ✗ | ✗ |
| validation | ✗ | — | ✗ | ✗ | ✗ |
| db | ✗ | ✓ (enum literals) | — | ✗ | ✗ |
| application | ✓ | ✓ | ✓ | — | ✗ |
| apps/web | ✗ (except `@vaultide/finance/client` for previews and formatting) | ✓ | ✗ | ✓ | — |

No circular imports; each package limits public entry points via `exports`. Workspace packages are named `@vaultide/finance`, `@vaultide/db`, `@vaultide/validation`, `@vaultide/application`, `@vaultide/config` and `@vaultide/web`; the paths above are where they live.

---

## 20. Validation / error / concurrency strategy

### 20.1 Validation layers

| Layer | Tool | Responsibility | Example |
|---|---|---|---|
| Client | same Zod schema via `react-hook-form`; locale-aware number parsing; date pickers capped at today | immediate feedback; never trusted | "Use at most 2 decimals for EUR"; "Balances can't be dated in the future" |
| Server (action) | `defineAction(schema)` — parse raw payload, strip unknown keys, bound sizes; the schema for any actual-record date is `plainDateNotAfter(ctx.today)`, and a `month_end` valuation input is accepted only when `ctx.today > end(M)` | authoritative shape/type validation | rejects a future date, or a month-end balance for a month that has not ended, even if the client was bypassed |
| Domain (`finance/rules` + `application`) | typed rule functions returning `RuleViolation[]` | financial invariants needing other records | leg currency = position currency; transfer kind pair; date within position window; withdrawal ≤ current value; one valuation per date; month-end balances only when `today > end(M)`; capital improvement links an asset; null cash leg has a participating account; untracked settlements carry no cash position; `reinvested` only for dividend/interest linked to an investment; skip reasons `vacant`/`non_payment` only for rental templates; dormant only at zero; closing rules |
| Database | constraints in Section 6 | timeless structural integrity even if code is wrong | `CHECK total = interest + principal + fee`; composite/typed FKs; unique dates; the month-end date-shape CHECK; **no constraint references the current time** |

Money inputs are strings validated by `moneyString(currency)`; dates by `plainDate` with `≤ today` for actuals (terms' `effective_from` and scenario dates may be future); percentages by `percent`. Schemas are defined once in `validation` and composed per use case.

### 20.2 Error taxonomy

| Code | Raised when | Shown to user | Logged | Retry |
|---|---|---|---|---|
| `VALIDATION_ERROR` | Zod or domain rules fail (incl. future dates, month-end before month end) | field-level messages | count only | no |
| `AUTH_REQUIRED` | no/expired session | redirect | no | — |
| `NOT_FOUND` | id not owned or nonexistent | "Not found" | no | no |
| `CONFLICT_VERSION` | optimistic check fails | "Changed elsewhere — reload" + current values | info | user-driven |
| `CONFLICT_DUPLICATE` | unique violation (valuation date, terms date, accepted suggestion twice) | specific message | info | no |
| `IMPOSSIBLE_OPERATION` | withdrawal > value, closing with balance, negative liability, same-position transfer | specific message | info | no |
| `INCOMPLETE_DATA` | operation needs missing data (scenario from a month with no valuations) | explanation | info | no |
| `FX_UNAVAILABLE` | conversion has no rate (a value, not an exception) | partial marker + retry link | warn | background |
| `FX_PROVIDER_FAILURE` | cron/backfill call fails | "rates are being fetched" | error | next cron |
| `SCENARIO_INVALID` | definition fails schema (incl. non-PSD correlation matrix) | field messages | no | no |
| `SCENARIO_INFEASIBLE` | result flag, never thrown | shaded months + reasons (with currency) | no | — |
| `RATE_LIMITED` | auth / export limits | "Try again in N minutes" | info | after window |
| `INTERNAL` | anything else | generic message + reference id | error (redacted) | maybe |

### 20.3 Concurrency

- Optimistic concurrency via `version` on valuations, flows, payments, terms, templates, positions, goals, settings; `UPDATE … WHERE id AND user_id AND version = expected RETURNING *`; zero rows → `CONFLICT_VERSION` with the current row.
- Monthly editor autosave sends `expectedVersion` per field; conflicts show the server value with "Reload".
- Bulk editor: per-row versions; the batch aborts entirely on any conflict.
- `month_reviews`: last write wins. Scenario pointer: compare-and-set on `current_revision_id`.
- Accepting a suggestion twice: the client disables the control, and the partial unique index on `(template_id, occurrence_date)` rejects a second accepted flow for the same occurrence with `CONFLICT_DUPLICATE`.
- Accept versus skip: the two facts live in different tables, so check-then-insert is not enough. Both actions run in one transaction that first locks the template row (`SELECT … FOR UPDATE`), then checks the occurrence against the materialized-flow table for the template’s kind **and** `recurring_template_skips`, then writes. Concurrent Accept and Skip therefore serialize and exactly one wins.
- No distributed locks.

---

## 21. Testing strategy

Effort is weighted toward financial correctness: `finance` targets ≥ 95 % line and branch coverage; `application` ≥ 85 %; UI is covered by E2E flows plus component tests for the exact formatter and money inputs. Tests control "today" explicitly: engines take `today` as input, and the app reads it from the request context, which test builds can override through a `TEST_CLOCK` header honored only when `NODE_ENV = 'test'`.

### 21.1 Unit tests (`finance`, Vitest)

| Module | Cases |
|---|---|
| money / format | add/sub currency mismatch; `allocate` sums exactly; half-up rounding; serialization round-trip; `MoneyBag` partials; **exact formatting** of `"12345678901234567.89"` in `de-DE`, `en-US`, `ja-JP` (0 decimals) via the string path and via the fallback assembler; a 4-minor-unit currency (CLF) round-trips input, storage and display exactly; percent formatting |
| dates | end-of-month, month arithmetic, `isMonthEnd`, days between, timezone "today" |
| fx table | on-or-before lookup, 10-day limit, monthly average (full, partial, none), span day-weighted average, cross rates via pivot, EUR identity; `convertWithSpread`: zero spread and fee equals `convert`; a positive spread never improves the user's outcome for a known source or a known target amount; expressing the market rate as EUR→USD or USD→EUR gives identical results; the recorded fields (source, destination, market equivalent, spread cost, fee, effective rate) reconcile |
| positions / freshness / sign | every cash state in 8.1 (`month_end`, `closed_zero`, `dormant_zero`, `carried`, `missing`, `opened_zero`, `first_balance`); flow-adjusted investments; **properties not adjusted by improvements**; value-add estimate → `carried_estimated`; liability derived balances; `netWorthSign` |
| reconciliation | 8.10 goldens (basic, span); each status rule incl. `provisional`; each issue trigger; accounts opened/closed mid-month; pre-existing account first tracked (excluded, `estimated`); dormant carry; **month-end clock**: with the clock on 30 Sep an exact 30 Sep snapshot is accepted and a September `month_end` valuation is refused, with the clock on 1 Oct it is accepted and the 30 Sep snapshot can be confirmed as month-end; ordinary last-day snapshots never close a month; **MTD common date**: BBVA snapshots 6 and 8 Sep with Savings 6 Sep → provisional through 6 Sep with `mtd_newer_balances`; BBVA only 6 Sep and Savings only 3 Sep → `unavailable` with `mtd_no_common_date`; both 6 Sep → provisional through 6 Sep equal to the identity; `untracked_self` reported as additional and `third_party` as informational, neither in K; cross-currency transfer with linked fee; untracked and cross-currency liability payments (pro-rata split); null-leg validation |
| investments | performance with contributions/withdrawals/switches; dividends per settlement; fees per settlement; carried spans; **opening net invested basis** golden (9.3) with and without basis, including the assertion that no label or DTO field says "lifetime" or "total invested"; 9.4 golden; XIRR known values (doubling in exactly 2 years → 41.42 %); XIRR never uses an undated basis; availability rules; portfolio aggregation with basis markers; a salary marked `reinvested` is rejected; ordinary income settled `external` is informational and outside `ExternalIncome`; an externally paid dividend counts in `Dout` and produces the +d/−d pair |
| mortgage | 11.3 golden rows 1–2, exactly 300 rows, final-row clearing, totals; zero rate; interest-only + balloon; extra payment under both policies; rate change under both policies; negative amortization capitalizes identically in schedule and engine; payoff; derived balance and adjustment on confirmation |
| property | equity, LTV, yields, value change over spans, appreciation net of improvements, cost basis with improvements, cash flow, unrealized gain; occupancy from explicit facts only (a month with no rent entry is `unknown`, never vacant; a skip with reason `vacant` is vacant) |
| net worth | total vs financial with excluded other assets; liabilities never excludable; closed positions; partial conversions; liability preference order; sign convention through random positions |
| decomposition | 12.7 golden and the excluded-car variant; each bucket in isolation incl. capital improvements, value-add estimate, newly tracked, removed, purchases/sales of non-financial assets; FX residual with USD position; drivers = ΔNW for random inputs (both metrics); **savings golden** (12.7): interest counted once, principal and contribution only in "where it went", `SavingsRate = 58.24 %` with the €50 additional spending counted (default) and `60.58 %` tracked-only when the setting is off, `TotalSpending = 890`, allocation identity holds |
| projection | each step of 13.3; every event type; discretionary pipeline; **currency funding**: obligation in USD with EUR-only cash → `currency_deficit` and infeasibility; auto-funding on → conversion recorded with spread cost, no deficit; **reserve**: a €10k base-currency reserve counts USD cash only when `includeForeignCash`, the measurement never creates a conversion, and a EUR reserve valuation never funds a USD obligation; no `reserveShare` anywhere; each `onShortfall`; inflation index; FX trend; goal evaluation; Decimal vs Float agreement |
| Monte Carlo | PRNG determinism; lognormal moments; PSD validation rejects a non-PSD class matrix and a loading outside [0, 1]; **the shipped default class matrix passes the same validator as custom matrices** (golden `monte-carlo/default-correlation-psd`: smallest eigenvalue ≈ +0.0265; the 0.80 equity–pension variant is rejected with ≈ −0.0106); under the documented default two equity funds have sample return correlation ≈ 0.85 (positive and strictly < 1), an equity/bond pair ≈ 0.08, an investment with itself exactly 1; `independent` yields ≈ 0 cross-correlation; identical seed ⇒ identical percentiles |

### 21.2 Property / invariant tests (`fast-check`)

1. Internal transfer (any kind pair, any currencies, random rates) leaves **total** net worth unchanged in every reporting currency; for financial net worth the only change is the explicit non-financial purchase/sale line (M16).
2. A contribution-only month has zero investment performance and does not change tracked spending.
3. Principal repayment changes cash and liability equally and never appears in spending or interest; loan proceeds never appear as income (proved through `netWorthSign`, random amounts).
4. Asset sale never appears as income.
5. Changing reporting currency never changes any serialized source record.
6. Adding a known tracked expense to a `reliable` month with `unclassified ≥ amount` leaves tracked total spending unchanged and reduces unclassified by exactly the amount; adding an untracked expense changes neither.
7. Reconciliation identity holds exactly (native) for random month-end valuations and flows, for months and for spans.
8. Drivers buckets sum to ΔNW exactly (total and financial); allocation identity holds exactly.
9. `allocate` and `reconcileRoundedParts` outputs sum to their inputs.
10. Amortization principal sums to the balance; balance never negative; exactly the expected number of rows.
11. XIRR: NPV at the returned rate is within tolerance; monotonic in terminal value.
12. Projection: same inputs ⇒ byte-identical result; Float vs Decimal within 0.01/month; no bucket negative without a flag; investments never negative.
13. Every event type is either applied or produces a flag.
14. Month partition: over any sequence of completed months with month-end balances, monthly totals sum to the whole-range span total; a span never overlaps a reliable month.
15. A position first valued inside a period contributes exactly its first valuation to "newly tracked" and nothing to performance.
16. Schedule and projection engine produce identical rows for the same terms, including negative amortization and the final row.
17. No engine output ever carries a date after `today`; every validator rejects future-dated actuals and refuses `month_end` precision unless `today > end(M)`.
21. `TrackedSavingsFromIncome + External inflows + Adjustments − External outflows = CashSavings` and `PersonalSavings = TrackedSavingsFromIncome − counted AdditionalSpending` for random flows and both settings of `count_additional_spending`; no cost term appears in more than one bucket; `TotalSpending = TrackedTotalSpending + AdditionalSpending`; third-party expenses change nothing (12.5).
22. Month-to-date: MTD equals the 8.2 identity evaluated through the latest date on which every participating account has a snapshot; it is `unavailable` exactly when no such date exists; snapshots newer than that date never change the figure.
23. Scenario conversions: for random amounts, market rates in either quote orientation, spreads ≥ 0 and fees ≥ 0, `convertWithSpread` yields a destination ≤ the frictionless amount (known source) and a required source ≥ the frictionless source (known target), with equality iff spread = fee = 0; results are identical under both quote orientations.
18. Capital improvements: for random improvements without estimates, every asset valuation is unchanged and total net worth falls by exactly the improvement (M17).
19. Scenario currency conservation: Σ native balances per bucket change only by recorded flows and recorded conversions; no auto-funding ⇒ no conversions (M18).
20. Financial net worth = total net worth − Σ excluded other assets at every month end.

### 21.3 Integration tests (`db` + `application`, Testcontainers Postgres 16)

Real migrations per suite. Cover: repositories with user scoping; audited helpers; `withUser` + RLS (GUC missing, empty, A, B — 17.4); version conflicts; every unique/CHECK constraint (each has a test that proves it rejects the bad row, including the `month_end` date-shape CHECK and the `reinvested` kind CHECK; there are no time-dependent constraints); **every `NOT NULL` column** (a generated test per table inserts each required column as NULL and asserts rejection) and **every enum column** (an unknown value is rejected); `recurring_template_skips` (unique per occurrence, `vacant`/`non_payment` refused for non-rental templates, skips audited, a skipped occurrence suppresses the suggestion and never creates a flow); **recurring occurrence identity** (the partial unique index rejects a second accepted flow for one occurrence; concurrent Accept and Skip under the template row lock leave exactly one winner; correcting a flow’s financial date does not move its `occurrence_date`; a template referenced by a materialized flow cannot be hard-deleted, and archiving it leaves the flow’s `template_id` intact; a recurrence-defining field cannot be edited once an occurrence has been materialized or skipped); **scenario revision integrity** (a `current_revision_id` pointing at another scenario's revision, or at another user's, is rejected by the composite FK; a `parent_revision_id` from another scenario is rejected; a revision cannot be its own parent; creating a scenario with its first revision in one transaction succeeds under the deferred constraint); cascade on user deletion (every table, including `goal_positions`); **role bootstrap and roles**: on an empty database run `scripts/db/bootstrap-roles.sql` as the admin role, then migrations as `app_owner`, then assert `app_user` cannot DDL, cannot bypass RLS, cannot UPDATE `audit_entries`; `app_backup` `pg_dump` of a two-user database contains both users' rows; `app_backup` cannot INSERT; running the bootstrap script twice is a no-op; the FX cron under `app_user` completes without a user context and touches only `fx_rates`; FX `refreshAll`/`ensureHistory` with a stubbed provider (gap filling, failure tolerance, immutability); services end-to-end: onboarding → month-end data → `reconcileMonth` equals the golden; span detection; MTD for the current month with a controlled clock; scenario create → run → cache hit → edit → new revision → rebase.

### 21.4 Security tests

- Parametrized over every server action and query service: user A with user B's ids gets `NOT_FOUND`/empty; registry fails the suite if an action is missing.
- RLS raw checks and role checks (17.4).
- Future-dated payloads (valuation, flow) and `month_end` valuations submitted while `today ≤ end(M)` are rejected server-side even when the client is bypassed.
- Auth: verification required; reset token single-use; rate limits; 2FA; sessions revoked on reset; fresh-session gate on deletion/export.
- Headers: CSP, HSTS, frame-ancestors (Playwright).
- Export contains only the requesting user's rows; a backup dump contains all rows.

### 21.5 End-to-end (Playwright, seeded Postgres, capturing mailer, controlled clock)

Sign-up → verify → onboarding (base currency, timezone, one account, one salary; balances dated today) → dashboard shows "in progress"; **month close**: on 30 September a quick update creates ordinary snapshots and no month-end confirmation is offered; advance the clock to 1 October, confirm the 30 September snapshots as statement balances (or enter statement figures), accept the salary, reconciliation shows a `reliable` number; **current month**: quick update of all accounts on the 6th → provisional MTD through the 6th; update only one account on the 8th → MTD still through the 6th with "Some accounts have newer individual balances"; a user whose two accounts were only ever updated on different days sees "Update all cash accounts to the same date"; **skipped month** → span shown on the Spending page, both months unavailable; investment update with an opening net invested basis → gain vs net invested and gain since tracking, no "lifetime" label; expense paid by a partner → shown under "paid by others", absent from totals; mortgage month (accept suggested payment, confirm balance → adjustment); property improvement → value unchanged, cost basis up; property month with no rent entry → "No rent recorded", no vacancy rate; car purchase excluded → total vs financial net worth differ; historical correction (edit a past month-end balance → affected months, audit, restore); currency switch (native values unchanged); scenario (USD investment with EUR-only cash → currency deficit; enable auto-funding → conversions recorded; property purchase infeasible → flagged; compare with baseline → differences sum); 2FA; account deletion. Mobile viewport run for dashboard, monthly, investments.

### 21.6 Golden scenario tests

Hand-verifiable fixtures under `packages/finance/test/golden/`, each with a `README` showing the manual computation:

| Fixture | Content | Verified outputs |
|---|---|---|
| `simple-user` | 2 checking accounts, 1 salary, 6 completed months with month-end balances, then a current month in which both accounts are snapshotted on the 6th and one of them again on the 8th, plus a variant where the accounts were only snapshotted on the 3rd and the 6th respectively | inferred spending per month; saved from income and savings rate (12.5); NW series; MTD provisional through the 6th with `mtd_newer_balances`; MTD `unavailable` with `mtd_no_common_date` in the variant |
| `investor` | 2 investment accounts, 3 investments (EUR), one with an opening net invested basis, monthly contributions, one switch, dividends (cash and reinvested), external fee, one carried month | performance per month, current net invested and gain (basis-known vs since tracking), XIRR after 12 months, availability reasons, no "lifetime" labels |
| `property-owner` | rental property bought with mortgage, rent, opex, a month with no rent entry and a month skipped as vacant, a €20,000 improvement (no estimate) then a revaluation, extra payment, rate change | equity, LTV, yields, schedule rows, derived vs confirmed balance, adjustment, value change over the span, cost basis, total NW dip at the improvement, occupancy shown as received / vacant / unknown with no inferred rate |
| `multi-currency` | EUR + USD accounts, USD fund, EUR→USD conversion with spread and fee entry, USD salary, USD loan paid from EUR cash, EUR reporting | per-bucket reconciliation, pro-rata payment split, FX residuals, decomposition = ΔNW, monthly-average conversion of unclassified |
| `complex-user` | everything above plus a car excluded from financial net worth, a personal loan, transfers, a skipped month (span), an unexplained inflow, a self-paid untracked expense and a partner-paid expense, a dormant account, an account closed mid-month | statuses (`unavailable`, `estimated`, `unresolved`), span result, issues, completeness, both net-worth metrics and decompositions, allocation view, additional vs paid-by-others spending |
| `scenario-user` | 30-year deterministic projection from `complex-user`, with salary growth, inflation, contribution policy with a €10k base-currency reserve (USD cash excluded from it), a USD investment (auto-funding off → reduced contributions; on → conversions), property purchase in year 4, sale in year 20, retirement in year 25 | month-by-month state for selected months computed by hand/spreadsheet; feasibility flags with currencies; reserve measured without conversions; goal dates; Float/Decimal agreement; comparison vs a no-purchase baseline with driver differences summing to ΔNW difference |

### 21.7 CI pipeline

`pnpm lint` (ESLint + dependency-cruiser + gitleaks) → `pnpm typecheck` → `pnpm test:unit` → `pnpm test:integration` (Testcontainers) → `pnpm build` → `pnpm test:e2e` (Chromium + WebKit, desktop + mobile) → coverage gates. Required on every PR; the production deploy job depends on it.

---

## 22. Deployment / operations plan

### 22.1 Recommendation

| Item | Choice | Why |
|---|---|---|
| App hosting | Vercel project `vaultide`, **Pro** for any non-personal use (Hobby only while strictly personal), Fluid compute, Node 22, functions region `fra1` | zero-ops Next.js hosting, previews, cron, EU region |
| Database | Neon project `vaultide`, `aws-eu-central-1` (Frankfurt), **Launch** once real data exists; Free for Phases 0–2 | serverless Postgres with branching, PITR, EU |
| Errors | Sentry, EU org, project `vaultide-web` | EU residency, cron monitors |
| Email | transactional provider with an EU region (Postmark or Resend), behind `Mailer` | verification/reset only |
| Uptime | external check on `/api/health` every 5 min | independent of Vercel |
| Backups store | S3-compatible EU bucket (Hetzner Object Storage or Cloudflare R2, EU jurisdiction) | independent of Neon |

Portability: no Vercel-specific APIs beyond `vercel.json` cron/regions and env vars; `output: 'standalone'` runs on any Node host; Postgres is plain. Alternatives considered: Hetzner VPS + Coolify (cheapest, more ops), Railway (EU region, weaker previews), Supabase (RLS/auth story, but Better Auth already covers auth and Neon's branching suits previews). Vercel + Neon wins on maintenance at this scale.

### 22.2 Environments, roles and secrets

| Env | App | DB | Data | Secrets |
|---|---|---|---|---|
| local | `pnpm dev` | Docker Postgres 16 or a personal Neon branch | fixtures | `.env.local` |
| preview | Vercel preview per PR | Neon branch `preview/<git-branch>` created by the Neon–Vercel integration, migrated in the build step, seeded with fixtures, auto-deleted on merge | fixtures only | Vercel preview env |
| production | Vercel production | Neon `main` | real | Vercel production env (`app_user` URL only) + GitHub environments `production` (`app_owner` URL), `backup` (`app_backup` URL, `age` public key) and `bootstrap` (platform-admin URL; manual workflow only) |

**Role bootstrap (one-time per environment, before migration 0).** `scripts/db/bootstrap-roles.sql` is run **as the platform/admin role** (Neon's default project owner, or the Docker superuser locally) and is idempotent (`DO $$ … IF NOT EXISTS …` for each role, `GRANT`s and `ALTER DEFAULT PRIVILEGES` re-runnable). It creates `app_owner` (`NOLOGIN`-less login role, `CREATEDB` not needed; owner of the application schema), `app_user` (`LOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE`), `app_backup` (`LOGIN BYPASSRLS`), sets their passwords from `bootstrap`-environment secrets, makes `app_owner` the schema owner, and declares `ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user` (with the audit/revision exceptions applied by migrations) and `GRANT SELECT ON TABLES TO app_backup`, so every table later created by migrations carries the right grants. It is invoked by a manual GitHub Actions workflow (`bootstrap-database.yml`) for production, by `pnpm db:bootstrap` against the local Docker database, and once for the Neon `dev` parent branch (Neon branches inherit roles from their parent, so preview branches need no bootstrap). The admin credential is never present in Vercel and is not needed by ordinary CI after bootstrap. All application migrations then run as `app_owner`.

The Vercel runtime holds only the `app_user` pooled URL; CI migrations hold only `app_owner`; the backup workflow holds only `app_backup`; the bootstrap workflow holds only the admin URL. Env vars: `DATABASE_URL` (pooled, `app_user`), `DATABASE_URL_DIRECT_OWNER` (CI only), `DATABASE_URL_BACKUP` (backup workflow only), `DATABASE_URL_ADMIN` (bootstrap workflow only), `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `EMAIL_API_KEY`, `EMAIL_FROM` (`Vaultide <no-reply@…>`), `CRON_SECRET`, `SENTRY_DSN`, `SENTRY_AUTH_TOKEN` (build), `BACKUP_BUCKET_*` (bucket named for the Vaultide environment, e.g. `vaultide-backups-prod`). Rotation runbook in `docs/ops/secrets.md`.

### 22.3 Migrations

- `drizzle-kit generate` produces SQL files committed with the PR; every migration must be **expand-safe** (additive first; contract in a later release).
- Production migrations run from GitHub Actions: CI green → `drizzle-kit migrate` as `app_owner` over the direct endpoint → trigger the Vercel production deploy hook. Vercel's automatic production deploy is disabled. Previews run `pnpm db:migrate` in the build command against their branch.
- Destructive migrations require a pre-migration Neon snapshot/branch and a restore plan in the PR.
- `app_user` cannot run DDL; the owner URL exists only in CI.

### 22.4 Connections

`pg` Pool (max 5, idle 30 s) against Neon's pooled endpoint (transaction mode) — compatible with `set_config(..., true)` and unnamed prepared statements. Direct endpoint only for migrations and dumps.

### 22.5 Backups and restore

- Layer 1: Neon instant restore (7 days on Launch).
- Layer 2: nightly GitHub Actions job (`backup` environment): `pg_dump -Fc` over the direct endpoint as **`app_backup`** (`BYPASSRLS`, SELECT-only), encrypted with `age` (public key in CI, private key offline), uploaded to the EU bucket; retention 30 daily + 12 monthly via lifecycle rules; Sentry cron monitor; the job also runs `pnpm db:verify-dump` which compares per-table row counts in the dump with `SELECT count(*)` under `app_backup` so an RLS-empty dump can never pass silently.
- Restore runbook (`docs/ops/restore.md`): new Neon branch/project, `pg_restore`, `pnpm db:verify` (row counts vs manifest, FK integrity, reconciliation golden on restored data), preview deployment pointed at it, sign-off. **Drill quarterly**, logged in `docs/ops/restore-log.md`; the first drill is a Phase 7 acceptance criterion.

### 22.6 Monitoring and alerting

Sentry (errors, cron monitors for FX and backup), Vercel logs/metrics, Neon dashboard, uptime monitor on `/api/health`. Alerts: any new production error, cron failure, uptime failure, Neon storage > 80 %.

### 22.7 Cost estimate

Personal phase ≈ €0–5/month (Hobby + Neon Free + free tiers). Public phase: Vercel Pro ≈ €20 + Neon Launch ≈ €19–25 + Sentry Team ≈ €26 + email ≈ €10 + object storage ≈ €1 ≈ **€80/month**.

---

## 23. Performance / indexing plan

### 23.1 Scale assumptions

| Quantity | Per user (30 years) | 1,000 users |
|---|---|---|
| Positions | ≤ 50 | 50k |
| Valuations | ≈ 20 positions × 360 months + intra-month snapshots ≈ 10k | 10M |
| Flows | ≈ 40/month ≈ 15k | 15M |
| Audit entries | ≈ 25k | 25M |
| Scenario revisions / runs | ≤ 200 / ≤ 400 (≈ 150 KB each) | prune runs older than 90 days |
| FX rates (global) | ≈ 60 currencies × 260 days × 27 years ≈ 420k rows | same |

All comfortably inside Neon Launch limits; per-user working sets (≈ 30k rows) load in tens of milliseconds.

### 23.2 Query strategy

One request = a handful of bulk, index-backed queries by `user_id` and date range, then in-memory computation in `finance`: `loadFinancialWindow(ctx, from, to)` loads positions, valuations (range), flows (range), terms and the FX table once. Total and financial net worth, spans and both decompositions are produced in the same pass. Recurring templates are loaded by **two** different questions, and one loader cannot serve both: the active suggestion feed filters `archived_at IS NULL`, while historical completeness loads every template whose `start_date`/`end_date` overlap the period being evaluated, archived or not (12.6, 30.10). Dashboard and monthly pages load ≈ 13 months; analytics "All" loads everything (≈ 30k rows ≈ 200 ms target); deterministic projections compute ≈ 360 months in < 1 s and are cached per revision.

### 23.3 Indexes

As defined in Section 6: `positions (user_id, kind, status)`; `position_valuations (position_id, valued_on DESC)`, `(user_id, valued_on)`; `income_entries (user_id, received_on)`, `(investment_position_id, received_on)`, `(property_position_id, received_on)`; `expense_entries (user_id, incurred_on)`, `(category_id)`, `(property_position_id, incurred_on)`, `(transfer_id)`; `transfers (user_id, occurred_on)`, `(from_position_id, occurred_on)`, `(to_position_id, occurred_on)`; `liability_payments (liability_position_id, paid_on)`, `(user_id, paid_on)`; `liability_terms (liability_position_id, effective_from DESC)`; `fx_rates (quote, rate_date DESC)` + unique; `audit_entries (user_id, entity_table, entity_id, occurred_at DESC)`; `goal_positions (position_id)`; `projection_runs` unique key; GIN on `tags`.

### 23.4 Not now

Materialized net-worth or monthly summary tables; Redis or any external cache; read replicas; incremental recomputation; edge runtime; static/ISR rendering of financial pages; web workers for deterministic projections; background job infrastructure for Monte Carlo below 5,000 paths. Revisit when p95 page latency exceeds 500 ms or a user exceeds ≈ 100k financial rows.

---

## 24. Dependency graph

```text
Money / Decimal / Dates ("today") / Currency / Sign convention ───────────────┐
        │                                                                     │
        ▼                                                                     ▼
   FX table & conversion (global refresh)                          Validation schemas (Zod; date ≤ today)
        │                                                                     │
        ▼                                                                     ▼
   Positions & valuations (freshness; month-end rule; investments flow-adjusted) ◄── DB schema + RLS + roles + audit
        │
        ├──────────► Cash accounts ──► Monthly reconciliation / MTD / spans / tracked vs additional spending ──┐
        │                                                                                                    │
        ├──────────► Investments (performance, opening basis, FX split, XIRR) ───────────────────────────────┤
        │                                                                                                    │
        ├──────────► Liabilities (terms, amortizeMonth, derived balance) ────────────────────────────────────┤
        │                        │                                                                           │
        ├──────────► Properties (metrics; cost basis incl. improvements; linked debt; rent/opex links)        │
        │                                                                                                    │
        └──────────► Other assets (financial-inclusion preference) ──────────────────────────────────────────┤
                                                                                                             ▼
                                        Net worth (total, financial) ──► Decompositions (both) ──► Completeness
                                                                                                             │
                              Monthly workflow & bulk editor ◄───────────────────────────────────────────────┤
                                                                                                             ▼
                                        Dashboard ──► Analytics (5 areas)
                                                                                                             │
                                        Goals (actuals; custom = position sets) ◄────────────────────────────┤
                                                                                                             ▼
                     Scenario starting state (frozen from positions/flows/templates/FX; as-of ≤ today)
                                                                                                             ▼
                     Projection engine (backends, events, policies, currency funding) ──► Goals (projected)
                                                                                                             ▼
                                        Comparison / baseline diff ──► Monte Carlo (correlated classes)
```

Nothing above depends on anything below it. Investments, liabilities, properties and other assets are independent of each other except properties → liabilities (linked debt) and properties → income/expense links; all four feed net worth. Projections depend on every actuals module for the starting state and on mortgage/investment math for simulation.

---

## 25. Phased implementation roadmap

Each phase is a usable vertical slice, sized so a Claude Code session can complete it as 5–12 reviewable tasks. Every phase ends with a **checkpoint**: run the app locally with the fixtures (and the test clock), walk through the listed manual checks, and only then start the next phase.

### Phase 0 — Foundations

- **Objective:** an empty, deployable monorepo with the numeric, validation, logging, role and testing foundations in place.
- **Functionality:** sign-in-less landing page; `/api/health`.
- **Schema:** `scripts/db/bootstrap-roles.sql` (one-time, idempotent, run by the platform-admin credential; 22.2) creating the three roles, grants and default privileges; migration pipeline running as `app_owner`; `currencies` seed (fiat/official only, ISO minor units 0–8).
- **Finance:** `money`, `dates` (with `today` injection), `Decimal` clone, `allocate`, `reconcileRoundedParts`, `Unavailable`/`Partial`, `netWorthSign`, `NumericBackend` with both backends.
- **Backend:** pnpm workspace, packages skeleton, dependency-cruiser rules, `defineAction`, `RequestContext` with `today` in the user's timezone and the `TEST_CLOCK` override for test builds, pino with redaction, Sentry init with `beforeSend`, error taxonomy, `withUser`, drizzle config with two connection roles, migration workflow files.
- **Frontend:** Next.js app, Tailwind v4 tokens (light/dark), shadcn init (Base UI), app shell, `MoneyText` using the **exact formatter** with its startup self-test, `MoneyInput`, `DateInput` capped at today.
- **Testing:** unit tests for money/dates/backends/formatter; property tests for `allocate`; CI green; Playwright smoke.
- **Ops:** Vercel project `vaultide` (fra1), Neon project `vaultide` (Frankfurt) bootstrapped with the role script, GitHub Actions CI + bootstrap-database (manual) + deploy-production + nightly backup skeleton running as `app_backup` against an empty DB with the dump-count verification, Sentry EU project `vaultide-web`.
- **Acceptance:** CI green; the shell renders; `"12345678901234567.89"` formats exactly in three locales and a 4-minor-unit currency (CLF) round-trips input, storage and display; `0.1 + 0.2 = 0.3` in `Money`; a fresh PostgreSQL database is provisioned from scratch in CI (bootstrap as admin → migrations as `app_owner` → role assertions: `app_user` cannot DDL or bypass RLS, `app_backup` reads all rows but cannot write, bootstrap re-run is a no-op); deploy hook flow exercised once; the backup job produces a verified encrypted dump.
- **Dependencies:** none.

### Phase 1 — Auth, users, settings, currencies, FX

- **Objective:** real users can sign up, verify, sign in, manage settings; the FX engine works globally.
- **Functionality:** sign-up/verify/sign-in/out/reset, optional TOTP, settings (base/reporting currency, timezone, locale, favorites), account deletion (re-auth), FX refresh cron for the whole supported set, first-use history backfill, reporting-currency selector.
- **Schema:** Better Auth tables, `user_settings`, `fx_rates`, `categories` (incl. the seven system kinds) + `tags`. RLS on `user_settings`, `categories`, `tags`.
- **Finance:** `FxTable`, `convert` (dated, monthly average, span average), pivot cross rates, lookup rules.
- **Backend:** Better Auth config, `requireSession`, `Mailer`, sign-up enumeration wrapper, `FxService` (`refreshAll`, `ensureHistory`, `loadTable`), cron route, user deletion service, audit helpers.
- **Frontend:** auth pages, settings pages, onboarding steps 1–3.
- **Testing:** auth security tests, FX unit tests, cron-without-user-context integration test, RLS on settings, cascade deletion scaffold, E2E sign-up → verify → settings.
- **Acceptance:** verification-gated sign-in; rate limits; 2FA; settings persist; the cron fills rates for every supported currency without reading any user table; a Saturday conversion uses Friday's rate with `exact = false`; BTC is not offered as a currency; deleting the account removes all rows.
- **Dependencies:** Phase 0.

### Phase 2 — Cash accounts, valuations, two net-worth metrics (cash + other assets)

- **Objective:** users record balances over time (never future-dated) and see truthful net worth with freshness, in both metrics.
- **Functionality:** create/edit/close cash accounts (new vs pre-existing question; dormant flag); add/edit/delete valuations (≤ today; month-end precision only once the month has ended; confirm a last-day snapshot as the statement balance); "Confirm unchanged for this month"; quick update dated today for all cash accounts; Accounts page + detail; other-assets tab with the financial-inclusion flag; minimal dashboard (cash, other assets, total vs financial net worth, 12-month chart, freshness, "in progress" chip for the current month).
- **Schema:** `positions`, `cash_accounts`, `other_assets`, `position_valuations` with constraints, RLS, audit.
- **Finance:** freshness engine (8.1 cash states), total/financial net-worth engine for cash + other assets, monthly series, partial conversions.
- **Backend:** position/valuation services (windows, uniqueness, closing rules, future-date and month-end rules), `loadFinancialWindow`, audited repositories, version checks.
- **Frontend:** accounts pages, valuation editor, quick update, dashboard v0, freshness badge, explain popover.
- **Testing:** freshness unit tests; constraint integration tests (unique date, typed FK, `NOT NULL` and enum rejection, `month_end` CHECK, `NO ACTION` semantics); security test for cross-user valuation access; E2E quick update and month close with the test clock.
- **Acceptance:** a balance cannot be dated tomorrow; neither on 6 Sep nor on 30 Sep does the current month offer a month-end column, on 1 Oct it does and the 30 Sep snapshot can be confirmed as the statement balance; a bypassed request with `month_end` precision on 30 Sep is rejected by the server; a pre-existing account's first balance is marked "first balance"; two accounts in EUR and USD total correctly with a partial marker if USD rates are missing; a car excluded from financial net worth changes total but not financial net worth; editing a past balance produces an audit row; closing an account with a non-zero balance is refused with guidance.
- **Dependencies:** Phase 1.

### Phase 3 — Income, known expenses, transfers, reconciliation, monthly editor v1

- **Objective:** inferred spending with honest statuses, maintainable in minutes; the current month as month-to-date.
- **Functionality:** income sources (templates + terms) and entries, including ordinary income received outside tracked accounts as `settlement = external`, for the five ordinary kinds only (informational; outside `ExternalIncome`, `TrackedSavingsFromIncome` and `PersonalSavings` per 7.4 — `reinvested` stays Phase 4, `dividend` and `interest` stay tracked-cash until Phase 4 gives an external distribution its investment link, and `external_inflow` and `adjustment` are always tracked-cash because both exist to explain tracked cash); templates materialize tracked-cash flows only (6.2), so accepting a suggestion never guesses a settlement; categories UI; known expenses with how they were paid (tracked account / by me outside tracked accounts / by someone else); cash↔cash transfers (incl. cross-currency with a linked fee entry); monthly editor sections Overview, Income, Known expenses, Accounts (completed vs current month behavior), Reconciliation; suggestions (accept when dated ≤ today / upcoming / this month only / from now on / skip, with a reason for rental income); issues with one-click actions; month review state (completed months only); Spending page with tracked spending, additional spending, total spending, paid-by-others (informational), spans, saved from income and savings rate (12.5); Income page v1; bulk history editor v1 (completed months: position month-end balances and income-template net amounts; the known-expense-total column is Phase 7, 15.3).
- **Schema:** `recurring_templates`, `recurring_template_terms`, `recurring_template_skips`, `income_entries`, `expense_entries` (with `transfer_id`), `transfers` (`cash_transfer` only; its `template_id` and `occurrence_date` exist for the later contribution workflow and must both be NULL in Phase 3), `month_reviews`. Materialized flows carry `(template_id, occurrence_date)` under a partial unique index, with a `NO ACTION` template FK so accepted history keeps its template identity (6.2, 6.3).
- **Finance:** reconciliation engine (Section 8) complete: monthly statuses, MTD provisional on a common snapshot date only, spans, issues, residual diagnostics, explanations; spending analytics (rolling averages over reliable months only); saved from income and savings rate per 12.5.
- **Backend:** flow services with domain rules, suggestion generation (pure), accept/skip services, bulk save transaction, reconciliation and span query services.
- **Frontend:** monthly editor (15.3 sections 1–4, 8) with autosave and client-side preview; Spending page; Income pages; bulk grid with paste.
- **Testing:** 8.10 goldens; every status and issue; property tests 6, 7, 14, 17; fixed-anchor recurrence across short months and leap years; early materialization reaching only the next unresolved future occurrence; savings availability propagation for `unavailable`, `unresolved`, `estimated` and partial multi-currency months; integration: suggestions idempotent, accept twice → conflict, concurrent accept and skip serialized, a referenced template refusing hard deletion; E2E monthly close, current-month MTD, skipped month → span, historical correction.
- **Acceptance:** the `simple-user` fixture reproduces its goldens; skipping September yields September and October `unavailable` and a "combined Sep–Oct" span that is absent from monthly averages; a quick update of all accounts on the 6th yields a provisional MTD figure through the 6th; updating only one account on the 8th keeps MTD through the 6th with the newer-balances note; accounts that never share a snapshot date give the no-common-date message; skipping a suggestion writes a `recurring_template_skips` row and suppresses it; no month-end balance can be entered until 1 Oct; forgetting the salary yields `unresolved` with "unexplained inflow" and the accept action creates a visible adjustment record; a self-paid untracked expense appears as additional spending and a partner-paid dinner under paid-by-others, neither changing tracked spending; the golden month's savings rate is 58.24 % counting the €50 additional spending (60.58 % tracked-only when the setting is off), with interest counted once and total spending €890; a cross-currency transfer with a fee leaves both buckets reconciled with the fee counted once; "confirm unchanged" is per month and never automatic for a non-zero account; a normal completed month for the fixture user takes < 3 minutes.
- **Dependencies:** Phase 2.

### Phase 4 — Investments

- **Objective:** investments with performance that separates flows, distributions, fees and FX, and honest cumulative metrics.
- **Functionality:** investment accounts; investments with asset class and optional **opening net invested basis**; valuations; contributions/withdrawals/switches; dividends/interest (income entries with settlement); fees (expense entries with settlement); Investments page and detail (current net invested with basis marker, gain, gain since tracking, XIRR, FX/native split, availability reasons); monthly editor Investments section; dashboard adds investments and liquid assets.
- **Schema:** `investment_accounts`, `investments` (with `opening_net_invested_basis`); transfer kinds `contribution`, `withdrawal`, `investment_switch`.
- **Finance:** Section 9 complete.
- **Testing:** 9.3 and 9.4 goldens; XIRR known values; property tests 2, 5, 15; `investor` fixture; E2E investment update with a basis.
- **Acceptance:** the opening-basis example shows current net invested €34,359, gain €8,941 (26.0 %) and gain since tracking €430, with no "lifetime" or "total invested" label anywhere; without a basis it shows net invested since tracking €42,870 and gain €430; the USD fund example shows native +300 USD, FX +€430, contribution €900 and total +€1,609; a month without a valuation shows performance "—" with a reason; a reinvested dividend changes nothing; an external fee appears in costs once; XIRR is offered only after 12 months and never from the undated basis.
- **Dependencies:** Phase 3.

### Phase 5 — Liabilities and mortgages

- **Objective:** debts with terms, schedules, payments (incl. untracked and cross-currency), derived balances and confirmations.
- **Functionality:** liabilities; terms history; payments with interest/principal split, settlement and optional cash leg; suggested payment (after its scheduled day); confirm actual balance with adjustment; loan proceeds; Debts page and detail; monthly editor Debts section; dashboard adds debt.
- **Schema:** `liabilities`, `liability_terms`, `liability_payments`; transfer kind `loan_proceeds`.
- **Finance:** 11.3 schedule with `amortizeMonth`, derived balances, adjustments, payoff; net worth with liabilities (sign −1).
- **Testing:** 11.3 golden; property tests 3, 4, 10, 16; `property-owner` fixture's mortgage part; E2E mortgage month.
- **Acceptance:** 100k/3 %/300 months shows €474.21 with the golden rows and exactly 300 rows; accepting the suggestion writes a payment and reconciliation counts €250 interest as expense and €224.21 principal as non-expense; confirming a balance €12 higher than derived shows a +€12 debt adjustment; a rate change recomputes the payment; a USD loan paid from EUR cash reconciles in the EUR bucket with a pro-rata split; a third-party payment reduces the debt with no cash leg.
- **Dependencies:** Phase 3.

### Phase 6 — Real estate

- **Objective:** properties with acquisition, valuations, rent, costs, improvements, linked mortgages and metrics.
- **Functionality:** property create (existing or purchase flow), revaluation with age, rent (templates), operating costs, **capital improvements** (expense entries with optional value-add estimate), sale flow; Real Estate page and detail; monthly editor Properties section; dashboard adds property equity.
- **Schema:** `properties`; transfer kinds `financed_purchase`, `asset_purchase`, `asset_sale`; category kinds `property_operating`, `acquisition_cost`, `disposal_cost`, `capital_improvement` in use.
- **Finance:** 11.2 metrics; property revaluation bucket; `carried_estimated` values.
- **Testing:** `property-owner` fixture; property tests for purchase/sale neutrality and M17; E2E purchase and improvement flows.
- **Acceptance:** buying a €200k property with €50k cash, €150k mortgage and €15k costs changes net worth by exactly −€15k; a €20,000 improvement leaves the valuation unchanged, raises cost basis by €20,000 and lowers total net worth by €20,000 until the next valuation; entering a €12,000 value-add estimate shows "includes €12,000 estimated" and is replaced by the next valuation; a revaluation after 8 stale months attributes the value change to that month with the span label; net yield matches the hand computation; a month with no rent entry shows "No rent recorded" and no vacancy rate, and skipping the rent suggestion as vacant records that fact.
- **Dependencies:** Phase 5.

### Phase 7 — Full monthly workflow, decompositions, historical editing, export

- **Objective:** the complete "how did I get here" layer and safe history editing.
- **Functionality:** wealth-change decompositions for total and financial net worth (drivers + allocation) per month and per range; completeness with missing items; monthly editor complete (all eight sections, current-month behavior, keyboard flow, confirm-all-unchanged); history drawer with restore; bulk editor complete — including the "known tracked expenses (total)" column deferred from Phase 3 (15.3), whose source representation (category, native currency, cash attribution, financial date, durable row identity, and its relationship to ordinary expense rows) this phase must define explicitly before building it; data export; onboarding steps 5–10.
- **Finance:** Section 12 complete (signed identities, newly tracked/removed, non-financial purchases/sales, capital improvements, FX residuals, completeness).
- **Testing:** 12.7 golden and the excluded-car variant; property tests 1, 8, 18, 20; `multi-currency` and `complex-user` fixtures; export security test; full cascade deletion; **first restore drill** with dump-count verification.
- **Acceptance:** for every fixture and random data, drivers sum to ΔNW exactly for both metrics; buying the excluded car shows "Purchases of non-financial assets −20,000" only in the financial view; the dashboard shows "August 83 % complete — missing mortgage balance" and "September in progress"; restoring a valuation from history creates a new audit row; export contains every table for the user and nothing else; the restore drill is logged.
- **Dependencies:** Phases 4, 5, 6.

### Phase 8 — Dashboard and analytics

- **Objective:** the analytical surfaces at full quality.
- **Functionality:** dashboard per 15.4; the five analytics areas per 15.5 (spans, additional spending and paid-by-others memo, savings rate, both metrics, occupancy from explicit facts only); category icons/colors/groups; property/equity IRR; stale thresholds in settings.
- **Testing:** series builders (unavailable months and spans excluded from averages); axe audit; performance budget (analytics "All" on `complex-user` < 500 ms server time).
- **Acceptance:** every chart has a table alternative and passes axe; dashboard numbers equal page numbers; rolling averages ignore spans and the current month; dark mode contrast verified.
- **Dependencies:** Phase 7.

### Phase 9 — Goals (actuals)

- **Objective:** goals with progress from actual data, including custom position-set goals.
- **Functionality:** goal CRUD for all kinds (incl. `financial_net_worth` and `custom` with a position picker), progress and series vs target, achieved detection.
- **Schema:** `goals`, `goal_positions`.
- **Finance:** goal metrics (Section 14).
- **Acceptance:** each goal kind computes the correct metric for `complex-user`; a custom goal over "cash A + investment C − loan L" equals the signed sum; debt payoff progress reaches 100 % on payoff.
- **Dependencies:** Phase 7.

### Phase 10 — Deterministic projections

- **Objective:** scenarios with frozen start, assumptions, events, per-currency funding, feasibility, nominal/real, cached runs.
- **Functionality:** create scenario from a completed month; assumption editors (incl. reserve, foreign-cash inclusion, auto-funding with spread); event timeline; run and results (both metrics; per-currency cash; conversions; deficits with currency); revisions; duplicate; rebase; goals' projected dates.
- **Schema:** `scenarios`, `scenario_revisions`, `projection_runs`.
- **Finance:** Section 13 engine (Decimal backend), event handlers, policies, currency funding, baseline suggestion (tracked only), goal evaluation, result document.
- **Testing:** step and event unit tests; property tests 12, 13, 19; `scenario-user` golden; Float/Decimal agreement; integration cache/revision/rebase; E2E scenario creation with a currency deficit and with auto-funding.
- **Acceptance:** the `scenario-user` golden months match; a USD contribution with EUR-only cash and auto-funding off is reduced and flagged; with auto-funding on, a conversion with spread cost appears in the month state and drivers; a USD mortgage payment with no USD cash and no auto-funding flags `currency_deficit(USD)` and infeasibility; a €10k base-currency reserve is measured over EUR cash only unless foreign cash is included, the measurement creates no conversion, and it never funds a USD obligation; a property purchase that cannot be funded flags infeasibility with the shortfall; identical inputs produce byte-identical results; runs < 1 s; a revision pointer or parent from another scenario is rejected by the database.
- **Dependencies:** Phases 8, 9.

### Phase 11 — Scenario comparison and baseline difference

- **Objective:** decision support.
- **Functionality:** compare up to 4 scenarios; metrics at chosen dates for both net-worth metrics; "difference from baseline" with driver decomposition; goal dates; real/nominal.
- **Acceptance:** driver differences sum exactly to the net-worth difference at every compared date for both metrics; the `scenario-user` comparison matches the hand-computed table.
- **Dependencies:** Phase 10.

### Phase 12 — Monte Carlo

- **Objective:** stochastic, correlated investment returns on the same engine.
- **Functionality:** MC mode per scenario (paths, seed, correlation model: documented default with class matrix and within-class loadings / independent / custom with PSD and loading validation), percentile fan charts for both metrics, goal probabilities, feasibility rate.
- **Finance:** stochastic factor-model provider (13.9), percentile aggregation, Float backend runs.
- **Testing:** PRNG and distribution tests; PSD and loading validation; reproducibility golden; correlation behavior tests (21.1); runtime budget (1,000 paths × 360 months < 3 s).
- **Acceptance:** same seed ⇒ same percentiles; P50 of a zero-volatility run equals the deterministic run; under the default two equity funds have a return correlation ≈ 0.85 (positive and strictly below 1) and ≈ 0 under `independent`; a non-PSD class matrix or a loading outside [0, 1] is rejected with a field error; the shipped default configuration passes that same validator (dedicated test); the UI labels the default as an illustrative assumption.
- **Dependencies:** Phase 11.

### Cross-cutting checkpoints

After Phases 3, 7, 10 and 12: full E2E suite on desktop and mobile viewports, accessibility audit, security suite (incl. role tests), restore drill (7 and 12), dependency update, and a manual "fresh user" walkthrough with the clock advanced across a month boundary.

---

## 26. Acceptance criteria by phase (consolidated checklist)

| Phase | Must be true before the next phase starts |
|---|---|
| 0 | CI green; shell renders; exact money formatting in three locales and for a 4-minor-unit currency; both numeric backends agree; fresh database provisioned from scratch (bootstrap → migrate → role assertions); deploy pipeline exercised; verified backup dump as `app_backup`. |
| 1 | Verification-gated sign-in; rate limits; TOTP; settings persist; FX cron fills the whole supported set without reading user tables; weekend lookup; no crypto currencies; account deletion cascades to zero rows. |
| 2 | No future-dated balances; month-end balances only once the month has ended (not on its last day), server-enforced; last-day snapshots confirmable as statement balances afterwards; first-balance marking; multi-currency cash total with partial markers; other-asset inclusion affects only financial net worth; audit on valuation edit; closing rules; cross-user access returns not found; RLS denies on missing and empty GUC without errors. |
| 3 | Golden reconciliation numbers; all five statuses reachable and explained; MTD through the latest common snapshot date, unavailable only when none exists; recurring skips stored as rows; spans reported separately and excluded from averages; issue actions create explicit records; self-paid untracked expenses as additional spending, partner-paid as informational, neither in tracked spending; savings rate per 12.5 (58.24 % counting additional spending, 60.58 % tracked-only, on the golden month); cross-currency transfer with one fee; per-month confirm-unchanged; a month takes < 3 minutes. |
| 4 | Opening net invested basis metrics with the 9.3 labels and no "lifetime" wording; FX/native/flow split; carried months unavailable; reinvested dividend neutral; fee counted once; XIRR gating without basis. |
| 5 | Golden schedule with 300 rows; suggested payment acceptance; derived balance and adjustment; rate-change recompute; loan proceeds not income; untracked and cross-currency payments. |
| 6 | Purchase changes NW by costs only; improvements never move valuations; value-add estimates labelled; value change attributed to the valuation month; yields correct; occupancy never inferred from missing rent; sale flow closes cleanly. |
| 7 | Drivers = ΔNW for both metrics and allocation identity on all fixtures and random data; non-financial purchase line; completeness text; restore from history; the complete bulk editor, with the known-expense-total column resting on a documented source representation rather than a hidden aggregate; export scoped; first restore drill logged. |
| 8 | Charts have tables; axe clean; dashboard numbers equal page numbers; averages ignore spans and the current month. |
| 9 | Every goal kind computes, including custom position sets. |
| 10 | Golden projection months; currency deficits and conversions behave; single base-currency reserve measured without conversions; properties always in financial net worth; infeasibility flags; determinism; rebase; < 1 s runs. |
| 11 | Difference drivers sum exactly for both metrics; comparison golden. |
| 12 | Seeded reproducibility; zero-volatility equals deterministic; same-class correlation positive and strictly below 1 under the default, ≈ 0 under independent; PSD and loading validation; the shipped default validates. |

---

## 27. Risk register

| # | Risk | Severity | Likelihood | Area | Mitigation | Test strategy |
|---|---|---|---|---|---|---|
| 1 | Inferred spending wrong because a stale, intra-month or future-dated balance is treated as a month-end balance | High | Medium | reconciliation | Month-end rule; no future dating; MTD provisional; spans; explicit per-month confirmation; dormant flag only at zero | unit tests per state; `complex-user` fixture; E2E with test clock |
| 2 | FX revaluation misclassified as spending or as investment return | High | Medium | fx / decomposition | Native-currency reconciliation and performance; FX as algebraic residual; transfer valuation rule | property tests 1, 8; `multi-currency` fixture |
| 3 | Investment return errors (first valuation as capital, dividend/fee double count) | High | Medium | investments | Opening basis; single-assignment matrix; settlement fields | property tests 2, 15; `investor` fixture |
| 4 | Property value overstated by improvements or purchase mechanics | High | Medium | property | Improvements are capex; values change only by valuation or labelled estimate | property test 18; `property-owner` fixture |
| 5 | Net-worth semantics abused (liability excluded; toggle jumps) | High | Low | net worth | Inclusion flag only on other assets; two defined metrics; non-dated preference | property test 20; schema |
| 6 | Historical corruption from edits | High | Low | data model | Hard delete with before-images; versions; `NO ACTION` FKs; single-transaction closes | integration tests; E2E correction/restore |
| 7 | Cross-user data exposure (runtime or jobs) | High | Low | security | Context-scoped repositories; composite FKs; RLS default-deny; jobs on global tables only; `app_user` cannot bypass | security suite; RLS and role tests |
| 8 | Incomplete backups because of RLS | High | Medium (without the fix) | ops | `app_backup` with `BYPASSRLS`; dump-count verification; restore drills | backup verification test; drills |
| 9 | Scenario engine drift or hidden cross-currency funding | Medium | Medium | projections | `engine_version` bump on order changes; explicit funding rule and conversion records; goldens | `scenario-user` golden; property test 19; byte-identical test |
| 10 | Floating-point creeping into money paths (incl. display) | High | Low | arithmetic | Decimal column type; exact string formatting with self-test; lint rule; Float only in MC | lint; formatter tests |
| 11 | Stale data presented as fresh on dashboard | Medium | Medium | UX | Freshness badges, "in progress" chip, hatched/provisional chart styles; `—` for unavailable | E2E assertions; component tests |
| 12 | Decomposition components rounded so they no longer sum on screen | Low | High | presentation | `reconcileRoundedParts` | property test 9 |
| 13 | FX provider outage or coverage gaps | Medium | Medium | fx | On-or-before lookup, partial results, cron retries, alerting, provider interface | integration with stubbed failures |
| 14 | Mortgage conventions differ by lender | Medium | Medium | liabilities | Schedule is a suggestion; actual balances re-anchor; adjustment bucket | golden + adjustment tests |
| 15 | Monte Carlo correlation assumptions read as fact | Low | Medium | projections | Default labelled "assumed, illustrative"; editable; independence available | UI copy test; correlation tests |
| 16 | Migration applied after code breaks production | Medium | Low | ops | CI-run migrations before deploy hook; expand/contract | workflow dry run on preview |
| 17 | Legacy spreadsheet history cannot be represented | Low | Medium | import (deferred) | Aggregate positions + month-end valuations + opening basis mapping (1.3) | importer tests when built |
| 18 | Monthly editor becomes slow to maintain | Medium | Medium | UX | Suggestions + confirm-unchanged + keyboard flow; "update all today"; time-boxed manual check | manual checkpoint |
| 19 | Month-to-date figure computed from balances and flows that do not share one date | High | Medium | reconciliation | Latest-common-date rule (8.6): balances and the flow cut-off always share one date; newer individual balances only add a note; unavailable with an actionable message only when no common date exists; quick update covers all cash accounts | property test 22; fixture variant; E2E |
| 20 | Database role bootstrap cannot run (circular ownership) or leaves wrong grants | Medium | Low | ops | One-time admin bootstrap script with default privileges; fresh-database provisioning test in CI | Phase 0 acceptance; integration test |

---

## 28. Decision log

| # | Decision | Alternatives considered | Rationale | Consequences |
|---|---|---|---|---|
| D1 | Unified `positions` supertype + single `position_valuations` table | Five snapshot tables | One freshness engine, real FKs, uniform RLS/audit/bulk editing | Kind enforced by typed FKs |
| D2 | Dividends/interest = income entries with `settlement`; fees, property costs, acquisition costs, improvements = expense entries with kind-typed categories | Separate tables | Fewer tables, one reconciliation query | Analytics filter by kind/settlement |
| D3 | Endpoint-typed `transfers` for internal capital moves; `liability_payments` separate | Generic flows table | Real FKs and kind pairs; payments need an interest split | Kind-pair validation in domain |
| D4 | Monthly model: reconciliation on month-end balances; missing month-end ⇒ month unavailable; multi-month spans reported separately | Per-account spans/windows (v1); estimating from carried balances | Simple, never attributes a multi-month residual to one month, never averages spans | Users enter month-end balances; quick updates are intra-month |
| D5 | Transfers valued from the source leg in R; spread lands in FX bucket | Convert each leg at market | Exact neutrality for total net worth in any R | FX bucket includes spreads (explained) |
| D6 | Drivers view excludes contributions/principal; separate allocation view | Spec's single list | Components must sum to ΔNW | Two views; both identities tested |
| D7 | Investment returns in drivers = value change net of flows; paid-out distributions under income | Total performance as one bucket | Avoids double counting | Investments page shows total performance separately |
| D8 | Investments flow-adjusted while carried; properties/other assets valuation-only (plus labelled value-add estimates); cash never adjusted | Adjust all non-cash | Contributions mechanically change portfolio value; improvements do not prove market value | Total net worth dips at improvements until revalued |
| D9 | Liability balance derived from payments; schedule suggests only | Auto-write schedule balances | Truth stays user-confirmed; adjustments visible | Users accept suggested payments |
| D10 | `NUMERIC(24,8)`, decimal.js precision 40, half-up, no intermediate rounding; exact string formatting | (19,4); banker's; `Number` formatting | Headroom; matches Intl; no precision loss anywhere | Formatter self-test and fallback |
| D11 | Frankfurter/ECB, EUR pivot, DB cache, daily refresh of the whole supported fiat set, first-use history backfill | Per-user currency discovery; commercial API | No cross-tenant reads by jobs; free, reliable, EU source | ≈ 60 currencies × daily rows (trivial) |
| D12 | Scenario documents in JSONB (frozen state, definition, results) | Relational assumptions/events | Immutable versioned engine inputs | Zod schema versioning |
| D13 | Numeric backend abstraction: Decimal for deterministic, Float for MC | Duplicate engines; Decimal everywhere | One engine; MC feasible in-request | Agreement tests |
| D14 | Fixed month order (13.3), flows end-of-month, growth on opening balances, FX path advanced at open | Mid-month conventions | Deterministic, conservative, one rate per month | Contributions earn from the next month |
| D15 | Negative cash allowed only with flags; simulation continues | Stop at first deficit | Shows size/persistence of the hole | UI shades infeasible months |
| D16 | Better Auth 1.7.x with DB sessions, DB rate limits, TOTP plugin | Auth.js; custom | Mature; Drizzle adapter | Auth tables managed by its CLI |
| D17 | RLS via transaction-local `set_config` + `app_user`; composite `(id, user_id)` FKs; three roles incl. `app_backup` | App-level only; JWT RLS; a single DB role | Defense in depth; fails closed; complete backups without weakening runtime | Every query inside `withUser`; owner and backup URLs never in runtime |
| D18 | Hard delete + audit before-image; archive for definitional entities | Soft delete everywhere | Clean uniqueness and queries | Restore = new mutation |
| D19 | Server actions for mutations, RSC for reads, thin wrappers over `application` | REST first; tRPC | No public API needed; services reusable | `defineAction`; action registry for security tests |
| D20 | pnpm workspace with `finance`, `db`, `validation`, `application`; no `ui` package yet | Single package | Enforced boundaries | Slightly more setup |
| D21 | Vercel Pro + Neon Launch (Frankfurt), CI-run migrations, nightly encrypted dumps by `app_backup`, quarterly restore drill | Hetzner/Coolify; Railway; Supabase | Lowest maintenance; EU; branching previews | ≈ €80/month public phase |
| D22 | Scenario cash per currency bucket with explicit funding rule and optional auto-funding conversions | Per account; implicit conversion | Decisions don't depend on account split; value never teleports across currencies | Currency-specific deficits |
| D23 | Contribution pipeline as ordered optional stages; percentages on the month's flow | Free-form combination | Deterministic, explainable | Some combinations impossible |
| D24 | Tags as `text[]` | Junction tables | Simplicity | Rename rewrites arrays |
| D25 | Categories copied per user at signup | Global defaults + overrides | Uniform RLS; per-user renames | Default changes don't propagate |
| D26 | Route `/expenses`, page titled Spending; other assets as Accounts tab | Rename route; new nav item | Communicates inferred nature | — |
| D27 | No actual record dated after today; month-end balances only once the month has ended (`today > end(M)`), last-day snapshots confirmable afterwards; current month is month-to-date provisional through its last day | Allow month-end entries on the last day | A balance "at the end of the day" is unknowable at noon; facts are never fabricated ahead of time | Two Accounts-section modes; test clock in tests |
| D28 | Two net-worth metrics (total, financial); inclusion flag only on other assets; non-dated preference | Generic per-position toggle | Liabilities can never be excluded; both decompositions exact | Dashboard shows both when they differ |
| D29 | Transfer fees as expense entries linked by `transfer_id`; liability payments carry `settlement` and an optional cross-currency cash leg | Fee columns; single-currency payments | One representation per fact; third-party and foreign-currency payments representable | Transfer service writes two rows |
| D30 | Capital improvements are `capital_improvement` expense entries (capex): cost basis up, valuation unchanged, optional explicit value-add estimate | Flow-adjusted property values | Spending on a renovation is not evidence of value | Total NW dips until revalued; estimate labelled |
| D31 | Optional `opening_net_invested_basis` on investments (net of pre-tracking withdrawals); gain and return use it; labels never say "lifetime" or "total invested"; XIRR stays since-tracking; gross history fields are a future additive migration | Treat first valuation as capital; call the basis "invested capital" | Known history must not be discarded; a net figure must not be presented as gross; an undated basis must not fake an IRR | Importer sets the basis |
| D32 | Explicit per-month "Confirm unchanged"; `is_dormant` only at zero balance | Persistent assume-unchanged policy | A non-zero account can never silently make a month reliable | One click per dormant-looking account per month |
| D33 | Expense settlement `tracked_cash` / `untracked_self` / `third_party` / `deducted_from_asset`; tracked, additional and total spending distinct; third-party informational only | Single "untracked" settlement | "I paid from an untracked account" and "someone else paid" have different meanings for the user's own spending and for baselines | Personal savings rate and projection baseline count self-paid additional spending per `count_additional_spending` (default on); third-party never |
| D34 | Explicit `netWorthSign` in all generic mathematics | Implicit special-casing | Provable neutrality of proceeds and repayments | Property tests through signs |
| D35 | Fiat/official currencies only; crypto as an asset class | Seed BTC/ETH | No trustworthy crypto price source in the FX design | Crypto-denominated positions deferred |
| D36 | Monte Carlo factor model: PSD asset-class matrix plus within-class loadings and an idiosyncratic shock per investment; documented illustrative default; `independent` mode | One factor per class (perfect within-class correlation); independence only | Two equity funds are strongly but not perfectly correlated; PSD by construction; the label avoids false certainty | Matrix + loadings editor with validation |
| D37 | Custom goals = signed net value of a chosen position set (`goal_positions`) | Defer custom goals | Complete, generic, simple metric model | Position picker UI |
| D38 | Version wording: latest compatible patched stable versions at implementation time; pin only in the lockfile | Pin patch versions in the plan | Plans age; lockfiles pin | Verify major lines at Phase 0 |
| D39 | Month-to-date spending through the latest date on which every participating cash account has a snapshot; newer individual balances only add a note; unavailable only when no common date exists | Earliest-cut heuristic labelled provisional; unavailable whenever latest dates differ | A label does not make biased arithmetic valid, and a valid earlier common date must not be discarded; quick update advances the common date | "Update all today" action; `mtd_no_common_date` and `mtd_newer_balances` issues |
| D47 | Explicit `recurring_template_skips` rows for skipped suggestions (with rental reasons) instead of JSON dismissal entries | Skip facts inside `month_reviews.dismissed_issues` | Skips are relational facts tied to a template occurrence and feed occupancy; JSON is for UI dismissal state only | One small table; `dismissed_issues` back to keys only |
| D48 | PostgreSQL enum types for every closed set; explicit `NOT NULL` on every required column; NULL-rejection and enum tests generated per table | `text + CHECK IN` for most columns; implicit nullability | One convention; a CHECK never enforces presence | Additive `ALTER TYPE` migrations for new values |
| D49 | `convertWithSpread` as the only way a scenario converts currency; haircut semantics independent of quote orientation | `rate × (1 + spread)` in the algorithm text | The direction of "worse for the user" must not depend on how a pair is quoted | One helper for auto-funding and explicit conversion events; invariants tested |
| D40 | One savings definition (12.5) built from the decomposition buckets; personal savings = tracked savings minus counted additional spending; savings rate over external income | "Income − tracked total spending − interest"; tracked-only rate next to a total-spending figure that includes additional spending | The reconciliation total already contains costs; each flow must count once; "Total spending" and "Savings rate" must agree; reconciles to the allocation view | Labels "Saved from income (tracked accounts)", "Personal savings", "Savings rate", "Where it went"; a default-on user setting |
| D50 | `scenarios.current_revision_id` and `scenario_revisions.parent_revision_id` are composite FKs on `(revision id, scenario_id, user_id)` | Plain FK on the revision id | A pointer must never cross scenarios or tenants | `UNIQUE (id, scenario_id, user_id)` on revisions; deferred constraint for first-revision creation |
| D41 | Occupancy only from explicit facts (rent received, or a skip with reason); never inferred from missing rent | Infer vacancy from absence | Absence has many causes; unknown stays unknown | "No rent recorded"; occupancy-rate analytics deferred |
| D42 | One global reserve target in the base currency, measured over eligible cash (foreign cash optional, valued not converted); no per-currency reserve shares | `reserveShare(X)` | A reserve is a target, not a bucket; funding stays currency-specific | Discretionary capacity in base currency, then per-currency funding |
| D43 | No time-dependent database CHECK constraints; future-date and month-end timing rules live only in application/domain validation | `CHECK (col <= current_date + 1)` | CHECKs must be timeless row invariants; the authoritative rule already exists in validation | Server-boundary tests for bypassed clients |
| D44 | RLS predicate `user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid`; `withUser` is the only setter and validates the UUID | Bare `current_setting(...)::uuid` | Missing and empty GUC must deny without errors; value must never be user-controllable | Raw tests for missing / empty / A / B |
| D45 | One-time platform-admin bootstrap script creates the three roles and default privileges; migrations then run as `app_owner` | "Migration 0 creates the roles" | A migration cannot create the role it runs as | `bootstrap-database.yml`, `pnpm db:bootstrap`, fresh-database CI test |
| D46 | Properties never carry a financial-inclusion flag, in actuals or scenarios | `includeInFinancial` on scenario properties | Only other assets may be excluded from financial net worth | Scenario schema and `property_purchase` simplified |

---

## 29. Deferred work

### 29.1 Decide before Phase 0 (defaults given; none blocks)

| Decision | Recommended default |
|---|---|
| Product name / auth issuer string | **"Vaultide"** (decided; used for app metadata, the TOTP issuer, email sender branding, and hosting/monitoring project names) |
| Email provider | Postmark or Resend with an EU region; decide in Phase 1 |
| Vercel plan at launch | Hobby while personal; Pro before any second user |
| Neon plan | Free through Phase 2; Launch once real balances are entered |
| Backup bucket provider | Hetzner Object Storage (EU) |
| Default expected returns/volatilities and the default correlation matrix | tables in 13.5 and 13.9; editable |

### 29.2 Can be decided during implementation

Exact shadcn component set; chart wrapper API; `turbo` usage; Testcontainers vs Neon branch in CI; `date-fns` vs Temporal polyfill; exact rate-limit numbers; onboarding copy; default stale thresholds (2 / 12 months proposed); precise CSP allow-list; `cacheComponents` for the shell; dormant-account UI wording.

### 29.3 Intentionally deferred functionality

CSV/spreadsheet importer (mapping in 1.3, sets opening net invested bases), gross pre-tracking investment history fields (gross contributions, withdrawals, distributions) and the gross labels they enable, occupancy/vacancy-rate analytics beyond explicit skip reasons, bank/broker imports, Open Banking, public API, mobile apps, time-weighted returns and benchmarks, manual FX rates and a second FX provider, crypto-denominated positions with a pricing provider, stochastic inflation/FX/property, passkeys and social login, notifications/reminders, restore-from-backup self-service, per-account spending attribution, property equity IRR beyond Phase 8, scenario modelling of improvements, household sharing, tax modules, localization beyond English (strings through a message catalog from Phase 0), category icon library.

---

## Verification (how the next session validates this plan during implementation)

1. **Phase 0 starts from this frozen document.** No code exists to run before it.
2. **During each phase:** the phase's acceptance criteria (Sections 25–26) are the definition of done; the golden fixtures in 21.6 are created in Phases 0–3 and extended per phase; every identity in Sections 8, 9, 11, 12 and 13 has a property test named in 21.2 that must be green; the test clock is used for every month-boundary and month-to-date check.
3. **Proof points:** the worked examples in 8.10, 9.3, 9.4, 11.3 and 12.7 are encoded as tests with the numbers in this document; a disagreement is resolved by hand computation and this document is updated, never by changing the test to match the code.
4. **Operational proof points:** the fresh-database provisioning test and the verified backup dump (Phase 0), the security and role suite (Phase 2 onward) and the first restore drill (Phase 7) are gates.

---

## 30. Final consistency check

### 30.1 What changed from v2

| # | Correction | Where it landed |
|---|---|---|
| 1 | Month-end balances only once the month has ended (`today > end(M)`); last-day snapshots are ordinary until confirmed as statement balances; financial date vs entry timestamp kept distinct | 1, C8, T3, M5, R15, R17, 6.2, 8.1, 8.8, 13.2, 15.2–15.3, 20.1, 21, Phases 2–3, D27 |
| 2 | Month-to-date spending through the latest common snapshot date; unavailable only when no common date exists ("Update all cash accounts to the same date"); newer individual balances add a note; quick update covers all cash accounts | 2.6, 8.4–8.6, 8.9, 15.2–15.4, 21, Phase 3, risk 19, D39 |
| 3 | One savings definition without double counting; savings rate over external income; allocation identity restated | F16, 12.5, 12.7, 13.6, 15.5, Phase 3, D40 |
| 4 | Expense settlement split into `untracked_self` and `third_party`; tracked / additional / total spending and "paid by others"; user-facing net-worth names "Total net worth" / "Financial net worth" | F19, R18, R24, 6.2, 7.4, 8.9–8.10, 12.1, 13.6, 15.2–15.5, 21, Phase 3, D33 |
| 5 | `opening_net_invested_basis` with net-invested labels; no "lifetime contributions"; gross history as a future additive extension | 1, F22, R20, 5.1, 6.2, 9.3, 9.6–9.7, 15.2, 21, Phase 4, D31, 29.3 |
| 6 | Occupancy never inferred from missing rent; explicit skip reasons only | F18, U1, 6.2, 11.1–11.2, 15.2–15.5, 21, Phase 6, D41, 29.3 |
| 7 | Single base-currency reserve measured over eligible cash; `reserveShare` removed; discretionary capacity global, funding per currency | 13.2–13.4, 21, Phase 10, D42 |
| 8 | `includeInFinancial` removed from scenario properties and `property_purchase` | 13.2, 13.7, D46 |
| 9 | No time-dependent database CHECK constraints; timing rules only in validation | 6.1–6.2, M5, 20.1, 21.3–21.4, D43 |
| 10 | RLS predicate hardened with `NULLIF`; `withUser` the only setter, UUID-validated | 1, 6.1, 17.4, 21.3, D44 |
| 11 | One-time platform-admin role bootstrap; migrations as `app_owner` afterwards; fresh-database provisioning test | 6.1, 22.2, Phase 0, risk 20, D45 |
| 12 | Currency `minor_units` 0..8 with ISO values seeded; formatter and input tests for a 4-decimal currency | 6.2, 7.2, 21.1, Phase 0 |
| 13 | Monte Carlo factor model with within-class loadings and idiosyncratic shocks; PSD by construction; tests for 0 < ρ < 1 | 1, 13.9, 21.1, Phase 12, D36 |
| 14 | Stale wording removed (`today ≥ end(M)`, mixed-date MTD, `opening_invested_capital`, inferred vacancy, `reserveShare`, property `includeInFinancial`, `current_date` CHECKs, `minor_units 0..3`, same-class correlation = 1, double-counted savings formulas, "economic net worth" in UI copy) | throughout |

### 30.2 Identities revalidated after the corrections

- **Reconciliation (8.2, 8.10):** `opening + inflows − non-expense outflows − known tracked expenses − unclassified = closing` holds for the September golden (`16,564 + 2,300 − 1,435 − 411 − 398 = 16,620`) and for the Sep–Oct span (`16,564 + 4,600 − 2,870 − 972 − 722 = 16,600`); `TrackedTotalSpending = known tracked + unclassified` (`809 = 411 + 398`; `1,694 = 972 + 722`). The self-paid €50 and the partner-paid €80 appear nowhere in the identity. Month-to-date uses the same identity through the latest date every participating account shares (BBVA 6 and 8 Sep, Savings 6 Sep → through 6 Sep; no shared date → unavailable).
- **Total net worth (7.8, 12.3):** with explicit signs, loan proceeds (`+X` cash, `−1·+X` liability) and principal repayments (`−X` cash, `−1·−X` liability) cancel; internal transfers and asset purchases cancel through the 12.2 rule and the purchase valuation; capital improvements reduce total net worth by their amount until a valuation or an explicit value-add estimate recognizes value; the September golden still sums to `ΔNW = 1,721`.
- **Financial net worth (12.4):** equals total net worth minus excluded other assets; purchases/sales of excluded assets are explicit lines (car example: total `1,721`, financial `−18,279`); properties and liabilities are always inside, in actuals and in scenarios.
- **Investment performance (9.2–9.4):** contributions are not returns, withdrawals are not negative returns; paid-out distributions, reinvested distributions and fees each count once; the opening net invested basis changes only the cumulative labels (`CurrentNetInvested = 34,359`, `Gain = 8,941`, `GainSinceTracking = 430`) and never the since-tracking XIRR; `NativePerf_R + FX_R = ValueChangeNet·r1 + FX'_R + Σ d·r_d` still regroups the same `Δ_R`.
- **Savings and allocation (12.5, 12.7):** `TrackedSavingsFromIncome = 2,131 − 729 − 111 = 1,291 = ΔCash 56 + Contributions 1,000 + Principal 235`; `PersonalSavings = 1,291 − 50 = 1,241` and `SavingsRate = 58.24 %` with the default setting (60.58 % tracked-only); `TotalSpending = TrackedTotalSpending 840 + AdditionalSpending 50 = 890` (the post-interest tracked total, not 8.10's pre-interest 809); interest is subtracted once because `TrackedTotalSpending` is decomposed into its buckets before any subtraction; the tracked identity of 8.2 is untouched by additional spending.
- **Scenarios (13.3–13.4):** native balances per currency change only by recorded flows and explicit conversion records (M18); the reserve is measured (valuation at `rate_m`) and never converts; a EUR reserve valuation cannot fund a USD obligation; properties created by `property_purchase` are in both net-worth metrics.
- **Monte Carlo (13.9):** `z_i = √ρ_c·F_c + √(1 − ρ_c)·ε_i` gives `Corr(z_i, z_i) = 1`, same-class `ρ_c`, cross-class `√(ρ_c ρ_d)·M_cd`; the implied covariance is PSD by construction for PSD `M` and `ρ ∈ [0, 1]`. The shipped default class matrix (equity–pension 0.75) has smallest eigenvalue ≈ +0.0265 and passes the validator; the earlier 0.80 draft had ≈ −0.0106 and would have been rejected.
- **Scenario conversions (13.4):** `convertWithSpread` with zero spread and fee reproduces `convert`; any positive spread or fee is weakly worse for the user in both quote orientations; every conversion in a month state is a helper output.

### 30.3 Remaining contradictions

None found. A final sweep of the document for the stale terms listed in 30.1 (row 14) and for the v2.1.1 items in 30.4 returned no occurrence outside the audit findings and decision log that describe them as rejected alternatives. The remaining choices in 29.1 are defaults that affect neither the schema nor the engines.

### 30.4 v2.1.1 defect-fix pass

| # | Defect | Fix | Where |
|---|---|---|---|
| 1 | Later sections made MTD unavailable whenever accounts' *latest* snapshots differed, contradicting 8.6 | Latest-common-date rule: MTD through `D`, `mtd_newer_balances` advisory, `mtd_no_common_date` only when no shared date exists | 1, 2.6, 8.4–8.6, 8.9, 15.2–15.4, 21, Phase 3, 26, risk 19, D39, 30.1 |
| 2 | Two Monte Carlo schemas; the prose default matrix was not PSD (smallest eigenvalue ≈ −0.0106) | One typed schema; explicit matrix in fixed class order with equity–pension 0.75 (≈ +0.0265), validated by the same function as custom matrices with a dedicated test | 13.2, 13.9, 21.1, Phase 12, 26, 30.2 |
| 3 | Overlapping rules for `income_entries.settlement = external` | Ordinary external income = informational, no bucket, outside savings; external distributions = +d/−d pair, in `Dout`, outside savings; `reinvested` limited to investment distributions by CHECK and domain rule | F5, 6.2, 7.4, 12.3, 12.5, 20.1, 21.1 |
| 4 | Skip facts stored in `month_reviews.dismissed_issues` JSON | `recurring_template_skips` table; `dismissed_issues` back to UI keys only | 5.1, 6.1–6.3, 8.5, 11.1–11.2, 15.3, 21.3, Phase 3, D47 |
| 5 | Implicit nullability; mixed `text + CHECK` and enum conventions | Every required column `NOT NULL`; every closed set a PostgreSQL enum; generated NULL/enum rejection tests | 6.1–6.2, 21.3, Phase 2, D48 |
| 6 | Orientation-dependent `rate × (1 + spread)` in the funding rule | `convertWithSpread` helper with haircut semantics and invariants; used by auto-funding and conversion events | 10.1, 13.4, 13.7, 21.1–21.2, D49 |
| 7 | Stale "lifetime" and "date backstop" wording | Replaced with "gain vs opening net invested basis" / "cumulative metrics" / `NOT NULL` and enum tests | 2.6, Phases 2 and 4 |

### 30.5 v2.1.2 corrections

| # | Correction | Where |
|---|---|---|
| 1 | Month-to-date opening balances follow 8.1 exactly: previous month-end for existing accounts, `opened_zero` for accounts opened during the month, `first_balance` exclusion for pre-existing accounts first tracked during the month, `missing_opening` otherwise | 8.6, 8.9 |
| 2 | Scenario revision integrity: `current_revision_id` and `parent_revision_id` are composite FKs on `(revision id, scenario_id, user_id)`; a revision cannot be its own parent | M19, 6.2, 21.3, Phase 10, D50 |
| 3 | Personal savings rate counts self-paid additional spending per a default-on user setting (`count_additional_spending`), so "Total spending" and "Savings rate" agree; tracked savings, total spending and the projection baseline restated consistently | 1, F16, F19, R24, 6.2, 12.5, 12.7, 13.2, 13.6, 15.2–15.5, 21.1–21.2, Phase 3, 26, D33, D40, 30.2 |
| 4 | Dependency lines stated as Next.js 16.x and Better Auth 1.7.x (latest compatible stable release within those lines at implementation time) | Context, 17.1, D16 |

### 30.6 v2.1.3 correction

Raised after Phase 2 was frozen and production-verified, while reconciling the
acceptance record against this document. It is a roadmap bookkeeping error, not
a design question: nothing about what onboarding *does* was ever in doubt.

| # | Correction | Where |
|---|---|---|
| 1 | Phase 7's onboarding scope read "steps 4–11", which both re-claimed a step already shipped and invented a step 11 that no section defines. Corrected to **steps 5–10** | 25 (Phase 7) |

**The contradiction.** 15.2 defines the wizard as **steps 1–10** of spec §90.
Phase 1 took steps **1–3**; Phase 2 took step **4**, the first cash account,
because Phase 2 is the phase that gives it something to ask about. Phase 7's
"steps 4–11" therefore disagreed with 15.2 at the top end and with the delivered
state at the bottom.

**The resolution**, decided by the product owner: the total remains **1–10** as
15.2 has always said, and the allocation is **Phase 1: 1–3 · Phase 2: 4 ·
Phase 7: 5–10**. Phase 7's other scope is untouched.

Nothing else changed: no product behaviour, no schema, no migration, no
accounting or security semantics, and no phase's implementation. `/onboarding/5`
and beyond still return 404, which remains the honest answer until Phase 7 gives
them something to ask.

Spec §90 itself is not part of this repository — 15.2's "steps 1–10 of spec §90"
is the authority relied on here, and the underlying specification was not
consulted directly.

### 30.7 v2.1.4 correction

Found while reading the Phase 3 goldens before Phase 3 began. Every identity and
formula was already right; one number was copied from the wrong state.

| # | Correction | Where |
|---|---|---|
| 1 | The post-interest savings golden computed `TotalSpending` from 8.10's **pre-interest** tracked spending of 809. With the €31 interest recorded, tracked spending is 840, so `TotalSpending = 840 + 50 = 890`, not 859 | 12.7, 21.1, 25 (Phase 3), 30.2 |

**What happened.** 8.10 builds the September example twice. Before the €31
interest is recorded: `TrackedTotalSpending = 2,100 + 200 − 1,435 − 56 = 809`,
`Unclassified = 398`, and with the €50 of additional spending `TotalSpending =
859`. 8.10 then records the interest and correctly recomputes `ΣI = 2,131`,
`Total = 840`, `Unclassified = 429`. Both states are right, and both are used:
the reconciliation golden is the pre-interest one, the savings golden the
post-interest one.

The savings golden carried 809 into the post-interest state. Its own components
already disagreed with it: `Consumption 729 + InterestAndFees 111 = 840`, which
is `TrackedTotalSpending` by the decomposition in 12.5, so the same sentence
that wrote `809 + 50` contained 840 implicitly.

**Nothing else in the golden moves**: `ExternalIncome 2,131`, `Consumption 729`,
`InterestAndFees 111`, `TrackedSavingsFromIncome 1,291`, `AdditionalSpending 50`,
`PersonalSavings 1,241`, `SavingsRate 58.24 %`, tracked-only `60.58 %`, and the
allocation identity `1,291 = ΔCash 56 + Contributions 1,000 + Principal 235`.
`TotalSpending` is not an input to any of them — it is the Spending-page
headline, and only it was wrong.

8.10's own "Total spending: 859" stays: it belongs to the pre-interest state and
is correct there. So does 30.2's `809 = 411 + 398`, which checks the
pre-interest reconciliation identity.

No accounting definition, identity, schema rule, algorithm or implemented
Phase 0–2 behaviour changes. Phase 3 has not started, so nothing built depends
on the figure.

---

### 30.8 v2.1.5 pre-Phase-3 clarification

Found while mapping Phase 3 against the frozen document and the delivered
Phase 0–2 code, before any Phase 3 code was written. Ten questions the blueprint
either left open or answered in two places at once. Each is settled here; three
change the Phase 3 schema and one narrows the Phase 3 scope. No phase already
delivered changes, and no accounting identity changes.

| # | Question | Resolution | Where |
|---|---|---|---|
| 1 | The bulk editor's `"known tracked expenses (total)"` cell had no source representation | Deferred to Phase 7 with the complete editor. Phase 3 ships month-end balances and income-template amounts | 15.2, 15.3, 25 (Phases 3, 7), 26 |
| 2 | A recurring occurrence had no durable identity: skips key on `occurrence_date`, accepted rows carried only `template_id`, and "received today" moves the financial date | `occurrence_date` added to `income_entries` and `expense_entries`, under a partial unique index with `template_id` | 5.1, 5.2, 6.2, 8.5, 12.6, 15.3, 20.3, 21.3 |
| 3 | 5.2 promised accepted occurrences on transfer rows, but `transfers` had neither field | `template_id` and `occurrence_date` added to `transfers`; both must be NULL in Phase 3 | 6.2, 25 (Phase 3) |
| 4 | Table definitions said `template_id` was `ON DELETE SET NULL`; 6.3 said templates are archived and entries keep `template_id` | Materialized flows keep their template identity: the FK is `NO ACTION` | 6.2, 6.3 |
| 5 | Accepted and skipped facts live in different tables, so a unique index alone cannot stop a concurrent accept and skip | Both actions lock the template row before checking either table | 6.2, 20.3, 21.3 |
| 6 | No rule for a monthly `day_of_month` of 29–31 in a shorter month | Fixed anchor, clamped independently per target month; never generated by iterating a clamping month step | 6.2, 25 (Phase 3) |
| 7 | Editing a template's schedule in place would rewrite which occurrences the past contained | Once an occurrence is materialized or skipped, the recurrence-defining fields are frozen; a real change is a new template | 6.2 |
| 8 | 8.6 required a snapshot at `D` from "every participating non-dormant account" while excluding some of those accounts from the bucket in the same paragraph | `D` is chosen from the snapshot-**required** included accounts; structurally known zeros and `first_balance` exclusions do not participate | 8.6 |
| 9 | 8.8 said an attributed flow clears dormancy, without saying which flows, or what a deletion or a back-dated flow does | Attributed = a tracked-cash income or expense on the account, or a transfer on either side; back-dated flows clear; deletion never restores | 8.8 |
| 10 | 12.5 defined savings from a residual without saying what happens when the residual is missing or negative | Availability propagates: `unavailable` and `unresolved` buckets make the four derived figures unavailable, `estimated` and `provisional` propagate their labels, and multi-currency aggregates stay `Partial` | 12.5 |

**Why the expense-total cell was deferred rather than designed (1).** One number
per month has to become durable source rows, and this schema offers no way to
decide which: `expense_entries` requires a category, a native currency, a
financial date and — for `tracked_cash` — an account or a null leg backed by a
participating account of that currency, and it offers no stable identity for the
cell so that a later edit updates rather than duplicates. Nor is there a rule
saying whether ordinary expense rows already recorded for the month sit inside
the total or beside it. Every one of those chosen quietly would be an accounting
decision hidden in a grid, and a table of monthly totals would be the stored
aggregate 5.3 forbids outright. Deferring costs little: month-end balances and
income already produce the correct `TrackedTotalSpending` for a reconstructed
month, and the cell would only have moved money out of the inferred residual and
into the known part. Phase 7, which owns historical editing, must define the
representation before building the column.

**Why an occurrence needs its own date (2, 3).** A scheduled occurrence and the
day money moved are different facts, and the interface already separates them:
"received today" exists precisely so a salary due on 1 October can be recorded
as received on 30 September. With only `template_id` and the financial date, the
October occurrence would still look unfulfilled, accepting it again would write
a second salary, and correcting a flow's date afterwards would silently move it
from one occurrence to another. `occurrence_date` is scheduling metadata, fixed
at creation; the financial date stays free to be corrected. `transfers` gets the
same pair now — not for Phase 3, which writes NULL in both, but because 5.2
already promised accepted occurrences would be representable there and a
half-built identity is worse than none.

**Why accepted history pins its template (4).** `SET NULL` would have quietly
erased the fact that a flow came from a template — the fact `suggested_income_missing`,
12.6's completeness and every occupancy question depend on — and it cannot be
expressed at all against the composite `(template_id, user_id)` ownership key
without nulling a `NOT NULL` tenant column. `NO ACTION` says the honest thing: a
template with history is archived, not deleted, and a hard delete stays available
only while nothing references it.

No accounting definition, identity, algorithm, engine or implemented Phase 0–2
behaviour changes. Phase 3 had not started when these were settled, so nothing
built depends on the previous wording.

---

### 30.9 v2.1.6 pre-Phase-3 clarification

A second reading of the Phase 3 map against the v2.1.5 schema, still before
migration 0006. One genuine gap, one invariant that was written too weakly, and
five points that were implementation convention where they should have been
text. Nothing already delivered changes; no accounting identity changes.

| # | Question | Resolution | Where |
|---|---|---|---|
| 1 | `recurring_templates` has no settlement column, so accepting a suggestion had no defined way to know whether it creates a tracked or an untracked flow | In Phase 3 a template materializes **tracked-cash flows only**; `cash_position_id` comes from the template, and a NULL one uses the ordinary tracked-cash null-leg rule | 6.2, 25 (Phase 3) |
| 2 | `CHECK (occurrence_date IS NULL OR template_id IS NOT NULL)` permitted a template-linked row with no occurrence, which the v2.1.5 semantics do not | Tightened to `CHECK ((template_id IS NULL) = (occurrence_date IS NULL))` on all three flow tables | 6.2 |
| 3 | Occurrence generation was bounded by neither `start_date` nor `end_date` | Occurrences outside the template's own dates are discarded, and discarding one never moves the anchor | 6.2 |
| 4 | No rule said which term an occurrence uses | The greatest `effective_from ≤ occurrence_date` — keyed to the scheduled identity, never the financial date | 6.2, 15.3 |
| 5 | `settlement = external` on `dividend`/`interest` with no investment link is covered by no row of 7.4 | Phase 3 accepts `external` for the five ordinary kinds only and keeps `dividend`/`interest` tracked-cash | 7.4, 25 (Phase 3) |
| 6 | The bulk editor's income cells read as insert-only | They are an ordinary editor over the occurrence: fill creates, change updates against the version, clear deletes with its audit image | 15.3 |
| 7 | `goals.scenario_id` carries the composite `SET NULL` defect | **Noted, not resolved** — see below | 6.2 (Phase 9) |

**Why a template materializes tracked cash (1).** The table has a default cash
position and no settlement preference, which is a coherent design for the common
case and silent about every other one. The three ways out were all worse than
restricting: inferring settlement from a NULL `cash_position_id` would collide
with 8.1, where a NULL cash leg is an ordinary tracked-cash flow awaiting
attribution, not an untracked one; asking for a settlement on every acceptance
would destroy the one-click flow the monthly editor's three-minute target rests
on; and adding a settlement column now would be schema invention ahead of a
product need. Manual entry still covers `external`, `untracked_self` and
`third_party` in full — they simply do not arrive from a template yet, and the
phase that wants recurring untracked flows can add the column additively.

**Why both-or-neither (2).** The v2.1.5 rule is that a manual flow carries
neither field and a materialized occurrence carries both. The implication form
allowed a third state — a template-linked row with no occurrence — which the
partial unique index does not constrain, so two such rows could name the same
template with nothing to tell them apart as occurrences. The biconditional is a
timeless row invariant and belongs in the database.

**Why `dividend`/`interest` stay tracked-cash in Phase 3 (5).** 7.4 defines
`external` twice, and both rows are about a fact Phase 3 cannot represent:
ordinary income received outside the tracked balance sheet names five kinds, and
neither of them is a distribution; an externally paid distribution is defined
only when it is *linked to an investment*, where it keeps the performance credit
and pairs with an equal external outflow. Phase 3 has no investment positions, so
every `dividend`/`interest` row it could write with `settlement = external` would
be the case the matrix does not cover. Refusing it costs nothing the phase needs
— the September golden's €31 of interest is tracked cash — and prevents Phase 3
quietly acquiring a fragment of Phase 4's decomposition.

**Deferred, not decided (7).** `goals.scenario_id uuid NULL → scenarios (id,
user_id) ON DELETE SET NULL` has the same defect the template foreign keys had:
under the composite ownership convention of 6.1 the referencing columns are
`(scenario_id, user_id)`, and PostgreSQL's plain `SET NULL` nulls every one of
them, including a `NOT NULL` `user_id` — so deleting a scenario a goal points at
would fail at runtime rather than at migration time. It must be revisited before
Phase 9 builds `goals`. **No Phase 9 design decision is taken here**: this pass
is scoped to Phase 3, `goals` has no table, no migration and no code, and the
right answer (a restricted-column `SET NULL`, `NO ACTION` with an explicit unpin,
or something else) belongs to the phase that builds the workflow.

No accounting definition, identity, algorithm, engine or implemented Phase 0–2
behaviour changes. Phase 3 had not started when these were settled.

---

### 30.10 v2.1.7 pre-deployment clarification

Two semantics the Phase 3 implementation surfaced and could not settle for
itself, resolved before migrations 0006/0007 reached production. Neither changes
the schema, an accounting identity, or a phase already delivered.

| # | Question | Resolution | Where |
|---|---|---|---|
| 1 | How far ahead may "received today" reach? v2.1.6 bounded the **financial** date and never bounded the **occurrence** | Only the **earliest unresolved future occurrence** of that template — no horizon in days or months | 8.6, 15.3, 25 (Phase 3) |
| 2 | Is `archived_at` a historical schedule boundary or current state? | Current state. `start_date`/`end_date` are the historical schedule; historical completeness ignores archive state | 6.2, 12.6, 23.2 |

**Why the bound is the schedule, not a horizon (1).** Every rule v2.1.6 stated
about acceptance bounds the date the money moved: T9's "only for dates ≤ today",
8.6's "not acceptable until their date", 15.2's "accept suggestions whose date
has passed". None bounded how far ahead the *occurrence* could be, so an
implementation was free to let somebody claim an occurrence a year out and date
the cash today — which is not a fact about their money, it is a hole.

A horizon in days or months would have been arbitrary and wrong at both ends: too
short for an annual source whose genuine next payment is eight months away, too
long for a monthly one. The schedule already contains the right answer. Taking
the earliest occurrence that is neither materialized nor skipped means the user
can always record what actually arrived early, and can never step over an earlier
occurrence that is still unresolved — because doing so would leave a hole in the
sequence that completeness (12.6) would then report for ever.

On `ctx.today`, eligibility is computed by generating the template's occurrences
under 6.2's fixed-anchor rule and its `start_date`/`end_date`, keeping those
strictly after today, discarding any already carrying a `(template_id,
occurrence_date)` flow or a skip row, and taking the first. That occurrence is
the only future one that may be materialized, its identity stays the scheduled
date, and its financial date is exactly today. Occurrences on or before today are
untouched by this rule and keep their ordinary due semantics.

The canonical example is unchanged: on 30 September, with 1 October unresolved,
"received today" writes `occurrence_date = 2026-10-01` and
`received_on = 2026-09-30`.

**Why archiving cannot reach backwards (2).** `archived_at` is a timestamp
without an effective date, and 12.6 previously asked for "each occurrence of an
**active** income template scheduled in M". Read literally, archiving a salary
today would remove September's expected salary from September's completeness —
so a month that was 90 % complete becomes 100 % complete because of an action
taken months later, and a genuinely missing record disappears from the report
that exists to find it. That is the same failure ADR 0004 §6 rejected for the
other-asset inclusion flag, and the same answer applies in reverse: an undated
classification must not be read as a dated event.

So the two facts are separated. `start_date` and `end_date` are historical
schedule truth — a source that really stopped in June says so with `end_date`,
and that correctly removes July's expectation. `archived_at` is present-tense
visibility: it withdraws the template from the active suggestion feed and blocks
new acceptances and skips, and it changes nothing about what any past month
expected. Unarchiving restores the feed and rewrites no history.

The consequence for the code is a rule about loaders, stated here because it is
easy to get wrong by reuse: **the active-suggestion loader may filter
`archived_at IS NULL`; the historical-completeness loader must not.** Completeness
loads every template whose schedule overlaps the period, archived or not.
Accepted and skipped rows are source facts and stay readable either way.

---

### 30.11 v2.1.8 completed-reconciliation issue correction

One predicate in the 8.5 issue catalogue was impossible to satisfy. It is
corrected here, before the completed-month engine reaches production. Nothing
else moves: no accounting identity, no schema, no status rule, no amount, and no
phase already delivered.

**The defect.** 8.5 raised `unexplained_inflow` when `unclassified < 0`, and
split it into variant A when `ΣK ≤ total` and variant B when `ΣK > total`. But
8.2 defines

```
Unclassified = TrackedTotalSpending − ΣK
```

so `unclassified < 0` *is* `ΣK > total`. The trigger and variant B's condition
are the same statement, and variant A's condition is the trigger's negation:
under the only circumstances the issue is raised at all, `ΣK ≤ total` can never
hold. Every unexplained inflow was therefore variant B, including 8.10's own
forgotten-salary example — whose natural reading, and the message 8.4 shows for
`unresolved`, is variant A's "cash grew more than your records explain".

**The correction.** The two variants are selected on the sign of the tracked
total, which is the quantity that actually distinguishes the two situations:

| Variant | Condition | What happened | Message |
|---|---|---|---|
| A | `unclassified < 0` **and** `total < 0` | Tracked cash grew by more than the recorded flow set explains | "Cash grew €X more than your records explain." |
| B | `unclassified < 0` **and** `total ≥ 0` | Spending was inferred as non-negative, yet the explicitly known tracked expenses exceed it | "Known expenses exceed the cash that left; an inflow may be missing, or an expense was paid from outside tracked cash." |

The reported amount is `−unclassified` in both, and there is **no epsilon**: the
tolerance stays exactly zero, as 8.4 requires. Zero belongs to variant B —
`total = 0` says the month's flows explain the cash exactly, which is not cash
growth, even though `ΣK > 0` still leaves known expenses the cash cannot account
for. Since `unclassified < 0` already implies `ΣK > total`, variant B is the
strictly weaker statement and needs no further condition of its own.

The issue key is unchanged. `unexplained_inflow` is one key with two readings,
and it stays one key: `month_reviews.dismissed_issues` stores keys, so splitting
it would silently un-dismiss issues somebody had already dealt with, and the two
messages are a presentation difference rather than two different problems.

**8.10 restated.** The forgotten-salary variant of the golden has
`total = −1,291`, `ΣK = 411` and `unclassified = −1,702`. Under v2.1.8 it is
**variant A** with an unexplained inflow of **€1,702** — the number is the one
8.10 always gave, and only the reading is corrected.

**Boundaries, for the tests.** `total = −0.01`, `ΣK = 0` → `unclassified =
−0.01` → variant A. `total = 0`, `ΣK = 0.01` → `unclassified = −0.01` → variant
B. `total = 0`, `ΣK = 0` → `unclassified = 0` → no issue at all. `total = 100`,
`ΣK = 120` → `unclassified = −20` → variant B.

---

### 30.12 v2.1.9 unavailable cash-delta correction

A second correction the completed-month engine surfaced, of the same kind as
30.11: a place where the specification obliged an implementation to invent
something. Nothing here changes an identity, a status rule, an issue, the schema
or a phase already delivered.

**The defect.** 8.3 emits an `unavailable` bucket and moves on *before* `Δ` is
computed:

```
if any account (not excluded) has an end in {carried, missing}: status ← 'unavailable' (…); emit; continue
flows ← …
Δ ← Σ_{included} (close_a − open_a)
```

But 8.9 typed `cashDelta` as present on every bucket, with only
`trackedTotalSpending` and `unclassified` optional. So a bucket that never
reached `Δ` still had to carry one, and the only values available were a zero —
which would be a lie whenever balances did move — or a sum over whichever
accounts happened to have usable endpoints. The second is worse than it looks:
in the result it is indistinguishable from the `Δ` of the identity, so a reader
or an interface could take a partial change over a subset of the bucket for the
bucket's cash change, and could pair it with the role sums to produce a spending
figure the evidence does not support.

**The correction.** `cashDelta` is the exact change over the **complete**
included account set, or it is absent.

| Bucket | `cashDelta` |
|---|---|
| `reliable`, `estimated`, `unresolved` | `Σ_{a ∈ included} (close_a − open_a)`, exact. `unresolved` is not an evidence problem — the arithmetic ran and `Unclassified < 0` is its answer — so the change is present there like anywhere else |
| `unavailable`, for any of 8.3's reasons | **absent** |

Absent, and specifically not zero. Zero is a real answer that means the complete
included set exists and its net change is exactly nothing; it must stay
available to say that. A bucket with no included account, or one where every
participating account was excluded as `first_balance`, has no complete set to
measure and therefore no `Δ` — not a `Δ` of zero.

No partial-subset figure is reported under this field or any other. If a partial
balance diagnostic is ever wanted it needs its own name and its own definition;
reusing this one is exactly the confusion this correction removes.

**What does not change.** `ΣI`, `ΣNin`, `ΣNout` and `ΣK` stay exact in every
status, over 8.1's flow scope, because they are sums of source records and need
no balance evidence: a September with a recorded salary and no statement balance
still reports `ΣI = 2,100`, and reporting `0` there would discard a fact the
user entered. They are not a spending total on their own — `TrackedTotalSpending`
and `Unclassified` remain absent whenever `cashDelta` is, since they are derived
from it.

---

### 30.13 v2.1.10 MTD evidence and status clarification

The month-to-date engine of 8.6 could not be written from 8.4, 8.5 and 8.6 as
they stood: between them they described the evidence date three ways and left
nine questions to an implementer's judgement. They are settled here, before the
first line of that engine. Nothing about completed months, the schema, an
identity or a delivered phase changes.

1. **`provisional` has a rank.** 8.4's ordering line named four statuses and
   omitted the fifth. It is now `unavailable > unresolved > provisional >
   estimated > reliable`.
2. **A negative unclassified outranks `provisional`.** 8.6 said "status
   `provisional`" flatly while 8.4's `unresolved` row was unscoped. `provisional`
   describes when the evidence stops, not whether it adds up, so a month-to-date
   bucket with `unclassified < 0` is `unresolved`, with 30.11's variant split
   unchanged.
3. **`D` is global.** 8.6 quantified over "every snapshot-required included
   account" without naming a currency, and there is one `D` in the singular
   throughout. One date for the whole result; an account with weaker evidence
   moves it back for every bucket.
4. **After `D` exists, failure is bucket-local.** A missing opening makes its own
   native bucket `unavailable` with reason `missing_opening` and leaves the
   others computing through the same `D`. The month takes the worst of them, so
   the overall answer is still `unavailable` — but a truthful USD reconciliation
   is not erased by a missing EUR opening.
5. **No `D` means no totals.** Flows are "those dated `≤ D`"; without `D` there
   is no interval, so no role sum and no balance-derived figure exists. Summing
   to today instead would attach a flow cut-off to no balance date at all.
6. **An empty inclusion set is not vacuous success.** A candidate date with
   included accounts, all of them structurally zero, needs no snapshot and is a
   valid `D`. A candidate date with *no* included account is not: it would
   produce a month-to-date of zero out of nothing.
7. **All-structural-zero reaches today.** Following from 6, a month whose
   included accounts are all `closed_zero`/`dormant_zero` has `D = today`.
8. **`first_balance` is decided once for M.** The classification uses the
   evidence available through today and does not move with the candidate date,
   so an account whose first valuation lands on the 8th is the month's
   `first_balance` exclusion at a candidate of the 6th as well — not a missing
   account there.
9. **8.6's wording supersedes the shorthand.** 8.4's `provisional` row and 8.5's
   `mtd_no_common_date` trigger said "every participating non-dormant cash
   account", which would demand a snapshot from a `first_balance` account and
   from one closed mid-month. Both now say "snapshot-required included account
   (8.6)". Snapshot-required excludes `first_balance` exclusions, accounts
   structurally zero at `D`, and accounts not yet open at `D`; it includes
   ordinary accounts open at `D`, accounts with `closed_on > D`, and accounts
   opened in M and still open at `D` — `opened_zero` fixes an opening, not a
   value at `D`.
10. **The MTD issue set is closed.** `first_balance`, `flow_without_cash_account`,
    `unexplained_inflow`, `mtd_no_common_date` and `mtd_newer_balances` apply.
    `missing_month_end` does not — an unfinished month is not missing a
    statement. `possible_missing_interest` does not, because 8.6 specifies no
    per-account residual for the current month, and no residual is computed for
    it: the diagnostic and the issue stay completed-month-only until a phase
    defines them here deliberately. `suggested_income_missing` does not, because
    an occurrence scheduled later this month has not been missed; the current
    month's recurring surface is operational (due and upcoming suggestions, and
    "received today" — 30.10), not a completeness report.
11. **`mtd_newer_balances` names a precise set.** An account counts when it is
    included **and** snapshot-required at `D` **and** has an exact valuation
    dated after `D` and on or before today. Those are the accounts whose newer
    evidence could have moved `D` and did not, which is what the advisory's
    action — update every account to the same date — is about. A `first_balance`
    exclusion, an account not yet open at `D`, or one structurally zero there
    could not have moved `D`, so none of them raises it.

---

## Ready for Phase 0

No genuine blockers remain. The blueprint was frozen as v2.1.2 and Phase 0 began from it; it is frozen as v2.1.10 after the corrections in 30.6, 30.7, 30.8, 30.9, 30.10, 30.11, 30.12 and 30.13, none of which changed a phase already delivered.

---

## Freeze check

- The seven v2.1.1 defects (30.4), the four v2.1.2 corrections (30.5), the v2.1.3 onboarding-range correction (30.6), the v2.1.4 savings-golden correction (30.7) the v2.1.5 pre-Phase-3 clarifications (30.8), the v2.1.6 second pass (30.9), the v2.1.7 pre-deployment clarification (30.10), the v2.1.8 issue-catalogue correction (30.11), the v2.1.9 result-shape correction (30.12) and the v2.1.10 MTD clarification (30.13) were corrected and propagated to the schema, algorithms, tests, phases and acceptance criteria; no accounting identity changed except in wording or representation (30.2), and the personal savings rate is an additional derived figure layered on the unchanged tracked identity.
- The default Monte Carlo configuration validates: the explicit class matrix in 13.9 is symmetric with unit diagonal, its smallest eigenvalue is ≈ +0.0265 and its Cholesky factorization succeeds, so it passes the same PSD validator as custom matrices; a dedicated golden test asserts this.
- No contradictory month-to-date rules remain: every section now states the latest-common-date rule, with unavailability only when no common snapshot date exists.
- Required schema nullability is explicit: every column in 6.2 is `NOT NULL` unless written `NULL`, liability-payment parts are exact non-null non-negative `NUMERIC(24,8)`, every closed set is a PostgreSQL enum, and NULL/enum rejection tests are generated per table.
- Recurring skips are represented durably in `recurring_template_skips`, audited and RLS-protected like every other user table; JSON holds UI dismissal keys only.
- Scenario revision pointers cannot cross scenarios or tenants (composite foreign keys, M19), and month-to-date opening balances are defined by the same rules as completed months (8.1, 8.6).
- Recurring occurrences have a durable identity (`occurrence_date`) distinct from the financial date, an occurrence cannot be both accepted and skipped, accepted history keeps its template identity, and no template edit can rewrite which occurrences the past contained (6.2, 6.3, 20.3, 30.8).
- A materialized flow carries a template and an occurrence together or neither, a template materializes tracked cash only in Phase 3, and occurrence generation never precedes `start_date` or outlives `end_date` (6.2, 30.9).
- Early materialization is bounded by the schedule rather than by a horizon, and a template’s archive state cannot rewrite what a past month expected (6.2, 12.6, 15.3, 23.2, 30.10).
- Every issue predicate in 8.5 is satisfiable: the `unexplained_inflow` variants are selected on the sign of `TrackedTotalSpending`, not on a comparison the trigger already decides (8.5, 30.11).
- No result field obliges an engine to invent a figure: the role sums are exact source-flow sums in every status, and `cashDelta` is the complete included-set change or absent (8.2, 8.9, 30.12).
- The current month is stated once rather than three times: one global evidence date `D`, `provisional` ranked in the status order, bucket-local failure after `D`, no totals without `D`, and a closed MTD issue set (8.4, 8.5, 8.6, 8.9, 30.13).
- No remaining blocker was found. The blueprint is frozen as v2.1.10.

