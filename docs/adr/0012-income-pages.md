# ADR 0012 — The standalone Income pages

**Status:** accepted · **Date:** 2026-10-04 · **Phase:** 3 (standalone Income pages)

The decisions behind the standalone Income pages — 15.1's `/income` and
`/income/sources/[id]` — approved by the product owner in the Income design task
and recorded here before any of them is built. The blueprint
(`docs/implementation-blueprint.md`, v2.1.20) is the semantic authority, and
§30.23 is the product-level ruling this record builds on: what the pages count as
income, which month an entry belongs to, how their figures differ from Monthly's
"Income", when a gross figure exists, what base and bonus are, how the figures
convert, over which periods they total, and which occurrences the pages report
missing. None of that is restated here; this record settles how the pages are
built.

Freezing a decision here is not shipping it. At this record's date **none of it
is built**: there is no Income read, no `/income` route, no source page, and the
navigation entry still has no link. D9 says how it ships.

ADR 0003, 0004, 0005, 0006, 0007, 0008, 0009, 0010 and 0011 stand. No identity,
status rule, issue trigger, availability rule, rounding boundary or schema
changes here, and **no migration**. The pages add no write service and no server
action: every write they offer already exists.

---

## Why these decisions are needed

- **No figure for income recorded exists.** Monthly's Overview labels
  reconciliation's `externalIncome` "Income"
  (`apps/web/src/features/monthly/overview.tsx:49`). That figure is tracked cash
  only, inside a reconciliation bucket. `incomeRole`
  (`packages/finance/src/flows/roles.ts:99`) gives an income entry the `I` role
  only when it is settled `tracked_cash`. `contributionOfFact`
  (`packages/finance/src/reporting/contributions.ts:119-128`) turns an `I` leg
  into `externalIncome` only when `isExternalIncomeKind`
  (`packages/finance/src/savings/classify.ts:112`) accepts its kind, and that
  excludes `external_inflow` and `adjustment`. So income received outside
  tracked accounts, and income into an account in its `first_balance` month,
  are in no income total the product shows (§30.23 items 1 and 3).
- **Income has no per-entry conversion.** Spending's rows convert one by one —
  `knownSpendingItems` (`packages/finance/src/reporting/breakdown.ts:107`)
  converts each through `convertContribution` — while income is converted only
  inside a bucket's reporting figures.
- **A source's life has services and no screen.**
  `packages/application/src/recurring/templates.ts` has `createTemplate` (:216),
  `updateTemplateDetails` (:287), `archiveTemplate` (:335), `unarchiveTemplate`
  (:347) and `setTemplateTerm` (:447), each already a `financialAction` in
  `apps/web/src/server/actions/recurring.ts`. Monthly uses the first and the
  last for income. Nothing lets a user edit an income source's details or end
  date, or archive one. `setTemplateTerm` refuses an amount that starts before
  the source does (:374).
- **The navigation entry exists with no href**
  (`apps/web/src/components/shell/navigation.ts:67`).

## D1. The year view

**Decision.** `/income?year=YYYY` shows one calendar year; without `year` it
shows the current one. It has:

- monthly bars of net income in the reporting currency, split salary
  (`employment`), bonus (`bonus`) and other (every other counted kind) (§30.23
  items 1, 5 and 6);
- the year's total, split into tracked and outside (item 1);
- the last-12-months total (item 7);
- the totals of every year with income;
- a by-source table, with one "One-off payments" row for the entries that have
  no template, which expands by kind. "One-off" means exactly that: the entry's
  `is_one_off` flag plays no part;
- archived sources, labelled as archived.

The current year and month are labelled "so far" (item 7).

Where a rate is missing, the by-source table's order must not rest on a
conversion that does not exist (ADR 0008 §7). It is ordered by
reporting-currency total only when every row's total is complete; otherwise it
uses an order that needs no conversion, and the page says why.

A malformed year, or one that has not begun, is not a page: it answers
`notFound()`, as Spending treats a malformed month (ADR 0008 §1).

**Why.** A year is the unit 15.2's "annual totals" asks for, and its monthly bars
are the row's "by month". The year lives in the address, as Spending's month
does, so a link, a refresh and the back button all land on the same year. The
last-12-months total is the figure a calendar year cannot give in its first
months. `$500` and `€480` have no order by face value, so ranking sources on a
conversion that failed would present a guess as a ranking.

## D2. Missing flags

**Decision.** The year view reports missing occurrences as one line per source
per year — "Salary: 3 payments missing in 2023" — over the year's completed
months only.

Each missing occurrence is what `missingIncomeOccurrences`
(`packages/finance/src/reconciliation/completeness.ts:105`) returns for its month
(§30.23 item 8). The read calls that function per completed month, over every
income template whose schedule overlaps the year, archived or not, with the
`(template_id, occurrence_date)` of the recorded entries and skips as the
resolved set. That module's header (l.9-16) filters no archive state, and the
read must not add a filter. No reconciliation runs and no bucket is consulted.

For an **active** source, the line links to Monthly when one month is missing,
and to Bulk History, opened on the group's first missing month
(`/monthly/[yyyy-mm]/history`), when several are.

For an **archived** source, the line carries no Monthly or Bulk History link,
because neither can record or skip its occurrence:

- archiving blocks new acceptances and skips (§30.10 item 2), and the accept
  and skip services refuse an archived source
  (`packages/application/src/recurring/suggestions.ts:241`);
- Bulk History disables an archived source's unrecorded cells (ADR 0011 D5).

Its text says what resolves it instead: unarchive the source, or, if it really
ended, give it an end date before the missing payment. In the first build PR the
line has no link; once the source page exists (D4), it links there.

An end date can never be set before an occurrence that is already recorded or
skipped (`updateTemplateDetails` refuses it). So a missing payment between two
recorded ones is resolved only by unarchiving the source and recording or
skipping that payment.

**Why.** One line per source and year keeps a long history readable: a year of
a salary never entered is one line, not twelve. Completed months only, because a
current-month occurrence may still arrive; `suggested_income_missing` is
completed-month only as well (§30.13 item 10). A link goes only to a place where
the flag can be resolved.

## D3. Gross display

**Decision.** The gross column, and every gross figure, appears only when at
least one entry in view has a recorded `gross_amount`. Wherever it appears and
some entries in view lack one, the page says "N without gross" (§30.23 item 4).

**Why.** A user who never records gross should not see a column of dashes. A
user who records it for a salary but not for interest must see that the gross
covers fewer entries than the net.

## D4. The source page, `/income/sources/[id]`

**Decision.** The source page has:

- the source's details;
- its term history as a step line against what arrived, with a table (§30.23
  item 7), in the source's own currency;
- "Change the amount from…", which picks an occurrence, so `effectiveFrom` is
  that occurrence's scheduled date. It goes through `setTemplateTerm`, exactly
  as Monthly's "Change future amount" does
  (`apps/web/src/features/monthly/income-editor.tsx`). No occurrence precedes
  the source's start (6.2), so the start-date refusal (`templates.ts:374`) can
  never be reached from here;
- editing the name, payer and end date through `updateTemplateDetails`, which
  refuses an end date before the start or before an occurrence already recorded
  or skipped;
- archive and unarchive, through `archiveTemplate` and `unarchiveTemplate`;
- occurrences by year — received (with the date it arrived when that differs),
  skipped, missing — each linking to its month in Monthly.

There is no deletion of a source or a term in v1. The services deliberately
support neither: archiving retires a source and keeps every row, and a term is
corrected or superseded by a later one (the header of
`apps/web/src/server/actions/recurring.ts` says why).

**Why.** Each control maps to a service that already enforces its rule, so the
page adds a screen and no rule. Keying the amount change to an occurrence is
what makes an early payment behave (§30.9 item 4), and it is how Monthly already
does it; a free date would start an amount on a day no occurrence falls on. The
end date's refusal is what keeps a source from erasing an occurrence its history
says happened (§30.9).

## D5. Actions reuse what exists

**Decision.**

- **Add income source** is Monthly's `AddIncomeSourceForm`
  (`apps/web/src/features/monthly/income-editor.tsx`), shared rather than
  copied, over the same `createTemplateAction`.
- **Add a payment** is Monthly's income-entry form, shared rather than copied,
  over the same `createIncomeEntryAction` and the existing income-entry rules,
  for any date up to today. It offers the seven kinds the pages count (§30.23
  item 1). `external_inflow` and `adjustment` stay Monthly's, so a payment added
  here always appears here.
- **A new entry in a completed month** is a first assertion and saves directly
  (§30.22 item 2). When a new entry's dormancy consequence reaches completed
  history, whatever month the entry is dated in, the ordinary save is refused
  with `HISTORICAL_REVIEW_REQUIRED`. The Income pages then open Review changes →
  Confirm correction through the existing machinery:
  - the `income_create` correction draft
    (`packages/application/src/corrections/draft.ts`);
  - `useCorrection` (`apps/web/src/features/corrections/use-correction.ts`);
  - Historical correction's existing preview and confirm actions
    (`apps/web/src/server/actions/corrections.ts`).
- **Entries are not edited on the Income pages.** Each links to the month that
  holds it in Monthly — its `received_on` month — which stays the one editor.
- **No new write service and no new server action.** The read services are new
  (D7).

**Why.** Two forms for one record would drift, and one editor per record keeps
Historical correction's ceremony in one place. Offering only the counted kinds
keeps the page's own action consistent with what the page counts. Opening the
review, rather than showing the guard's refusal, is what ADR 0010 §1 and the
`income_create` draft already provide for a creation whose dormancy consequence
reaches completed history. The server has supported it since Historical
correction landed; only Bulk History uses it today.

## Known gap: Monthly's Add income does not open the review

Monthly's own Add income form does not do what D5 asks of the Income pages. When
`createIncomeEntry` refuses a creation whose dormancy consequence reaches
completed history — the guard test "createIncomeEntry attributed to a
historically dormant account"
(`packages/application/test/integration/historical-correction-guards.test.ts`)
covers that refusal — the form shows the refusal's message ("…has to be reviewed
before it is saved. Nothing was saved.") and offers no review. Nothing is
written, so the data is safe; the user is left without the way through. This is
a separate known gap. The Income pages do not change Monthly's behaviour, and
closing the gap is its own task.

## D6. Charts

**Decision.** The year's monthly bars and a source's step line are hand-written,
with no new dependency (ADR 0008 §9), and each has a "View as table" (15.5).

**Why.** ADR 0008 §9's reasons hold. Two restrained charts do not justify a
charting dependency, and the richer chart layer 16.3 describes stays with Phase
8.

## D7. Reads

**Decision.** Each page is served by one application read. It issues a fixed
number of set-wise statements whatever the range — however many years, sources
and entries the user has. It converts each entry at its `received_on`, with the
same dated conversion a known-spending row gets (`knownSpendingItems`), over the
existing reporting-rate loading (`loadReportingRates`,
`packages/application/src/reconciliation/reporting-service.ts`): stored rates
only, and no rate-provider call. Neither read needs balances, because nothing on
these pages is reconciliation-scoped (§30.23 item 3).

Each read has a bounded query-count test, as Spending's has ("the repository
transaction count is bounded by a constant",
`packages/application/test/integration/spending.test.ts`).

**Why.** The year view's totals for every year with income span the whole
history, so a read that grew with years or sources would grow with the user.
23.2 asks for a handful of bulk, index-backed queries per request, and the
Spending read showed it holds for a page of this shape.

## D8. Route wiring

**Decision.** The first build PR:

- gives the navigation entry its href
  (`apps/web/src/components/shell/navigation.ts:67`);
- adds `/income` to `PROTECTED_PREFIXES` in `apps/web/src/proxy.ts`, which covers
  `/income/sources/[id]` by prefix;
- updates the tests that now assert Income is not built:
  - `apps/web/test/navigation.test.ts`: its `NOT_BUILT` list, "links nowhere a
    section has not been built", and the unbuilt More items;
  - `e2e/tests/navigation.spec.ts`: More lists Income as Phase 3 text.

**Why.** The navigation table is the one source of the shell's destinations. The
proxy gate is what carries `next` through sign-in, so a signed-in route missing
from it sends an anonymous visitor to sign in and then loses where they were
going.

## D9. Delivery

**Decision.** Two build PRs, each reviewed on its own:

1. `/income`, the year view, with D8's route wiring;
2. `/income/sources/[id]`, with its edits (D4). From then on an archived
   source's missing-payment line (D2) links to it.

**Why.** The year view stands on its own and carries the larger read; the source
page carries the edits. Splitting them keeps each review narrow.

## Out of scope

- A cross-source progression chart, and the rest of 15.5's Income analytics
  (Phase 8).
- Deleting a source or a term.
- Editing an income entry on the Income pages; Monthly stays its editor.
- A missing flag for the current month.
- `reinvested` income, and income linked to an investment (Phase 4).
- Monthly's Add income review gap, above.
- The wording that keeps the Income pages' figures apart from Monthly's "Income"
  (§30.23 item 3). This record fixes the rule, not the words; the first build PR
  proposes them for review, on whichever page they land.
