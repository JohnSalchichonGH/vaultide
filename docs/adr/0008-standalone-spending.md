# ADR 0008 — The standalone Spending page

**Status:** accepted · **Date:** 2026-09-19 · **Phase:** 3 (standalone Spending)

The decisions behind the standalone Spending page (`/expenses`, labelled
Spending), approved by the product owner in the Spending task and recorded here
because the blueprint (`docs/implementation-blueprint.md`, v2.1.17) leaves each
of them open. The blueprint's 15.2 row for Spending says what the page covers;
8.x, 12.5 and the corrections in 30.14–30.17 and 30.20 say what every figure on
it means. None of that changes here. No identity, status, availability rule,
rounding boundary or schema changes, and ADR 0004, 0005, 0006 and 0007 stand.

Spending is not a transaction ledger. It shows reconciled monthly spending over
time: what tracked cash says was spent, how much of it the user identified, what
was spent outside tracked accounts, how trustworthy each month is, and where the
known part went.

---

## 1. The page opens on the last completed month, and the month is URL state

**Decision.** `/expenses` shows the last completed calendar month. On 19
September 2026 that is August. `/expenses?month=YYYY-MM` shows any other month
up to the current one, and the current month stays selectable. A malformed
month, or one that has not begun, is not a page: it answers 404, as Monthly
does. The month lives in the address only; no client state duplicates it.

**Why.** Spending is mainly a reconciled, historical view. Opening on a
completed month means the headline has completed-month meaning, not the
provisional month-to-date one.

## 2. With the current month in focus, rolling ends at the last completed month

**Decision.** The current month is never a rolling observation (8.6, 30.15
item 5). When it is the focus month, the 3-, 6- and 12-month averages are shown
for windows ending at the last completed month, and they say so ("through
August").

**Why.** 30.15 defines the window for a completed display month. The
alternative, a window ending at the current month, would give the current month
a seat it can never fill and show a three-month average of two months under a
label that suggests three.

## 3. One composite read, over one shared load

**Decision.** The page is served by one application read, `getSpendingPage`.
It loads once: one valuation window up to today, the flows of the history
window, categories, settings, the currency catalogue and one FX table. It then
derives everything in memory through the existing engines: completed-month and
month-to-date reconciliation, the reporting month, rolling, spans and the
known-spending breakdown. The page computes no financial figure, and neither
does the browser.

Two loader builders, completed-range inputs and month-to-date inputs, are
shared with the existing loaders, so a month on Spending is reconciled from the
same rows, sliced the same way, as the same month on Monthly.

**Why.** Composing the page from the existing top-level reads would load the
valuation window three times: the range, month to date and spans. It would also
scale reads with the parts of the page.

## 4. "Observed" means a reconciliation bucket exists, and nothing more

**Decision.** For Spending, a month is **observed** when reconciliation produced
at least one bucket for it (8.3, 8.4, 30.20). A completed month with no bucket
is shown as not observed: no cash account took part in it. It is never a zero,
never "missing evidence", and it offers nothing to fix.

No "before tracking began" state is invented for reconciliation. ADR 0004 §2's
`not_yet_tracked` is a net-worth valuation rule, and reconciliation does not
use it. A pre-existing account has `opened_on = NULL` and therefore takes part
in every earlier month (8.1). So the months before its first balance are
observed and unavailable for missing evidence, and they stay in the fixed
calendar window as they are. They are an honest invitation to reconstruct
history, not rows to trim or relabel. The month in which such an account
receives its first balance keeps the engine's own `first_balance` behaviour:
`unavailable` or `estimated`, depending on the rest of the bucket.

**Why.** A presentation rule that re-derived tracking start from first balances
would be a second reconciliation semantics. It would disagree with Monthly about
the same month, and it would hide exactly the months where history can be
recovered.

## 5. Partial spending is a lower bound; partial savings is not shown as a number

**Decision.** The DTO carries every figure with the engine's own availability,
unchanged. On the Spending page:

- a `Partial` **spending** figure is shown as `≥ €X`, because every missing
  contribution to it is non-negative (expense amounts are positive, and a
  reconciled residual is not negative). The word "known" is added only to the
  known-tracked figure itself;
- a `Partial` **saved from income**, **personal savings** or **savings rate**
  is shown as `—` with the reason. A missing spending contribution would make
  the partial value overstate the user's savings, so the partial value is not a
  bound, and printing it as a number would imply one.

This is a presentation decision for Spending only. The finance engine, the
DTOs and Monthly are unchanged. Monthly still shows a partial savings figure
with its Partial badge, so the two pages present that case differently.

**Why.** The repository has a tension here. 12.5's availability paragraph says
an unresolved bucket's savings figures are unavailable. 30.16 item 7's
per-figure rule, which the engine implements, makes them `Partial` whenever any
contribution can be stated. Resolving that is a blueprint question, and it is
not settled here. Spending takes the conservative display, which is correct
under either reading. The same rule covers a reliable month whose savings are
partial only because of a missing rate.

## 6. Categories and largest known cover the focus month and follow the reporting scope

**Decision.** Categories and the largest-known list cover the focus month only.
Both are built from the same rows the reporting figures consume:

- **Tracked known spending** is the `K` facts inside the reconciliation buckets'
  own scope. An account excluded as `first_balance` therefore contributes
  nothing, exactly as it contributes nothing to the identity.
- **Additional spending** is the `untracked_self` rows over the same interval.
  There is no second kind-based exclusion list. Whatever the reporting
  classification counts, the breakdown counts.
- Each row converts at its own date, by the rule the reporting month uses.

The category totals therefore add back to the reporting figures they explain:
exactly when no rate is involved, and to the 40th digit otherwise (ADR 0004 §1).

The following are **not** in the categories or the ranking:

- paid-by-others, which is memo only;
- unclassified spending, which is an inferred residual, shown on its own and
  never as an "Other" category;
- a tracked capital improvement, which is `Nout` and so never known spending.

Known tracked rows are presented as Consumption, Costs / fees, or Money out of
tracked accounts (not consumption). No category group, icon or colour system is
introduced.

In the current month with a common date `D`, every row stops at `D`. Without
`D` there is no tracked interval and no tracked row. Additional spending through
today may then be shown on its own, and it is never ranked against a tracked
interval that does not exist.

The largest-known list has five rows by default.

## 7. A missing rate prevents a false cross-currency order

**Decision.** Categories are ordered by reporting-currency amount only when
every category total is complete. Otherwise they keep the user's category order
and the page says why. The largest-known rows are ranked by reporting value
only when every candidate converted. Otherwise each native currency is ranked on
its own, with the mode (`reporting_currency`, `per_native_currency`,
`source_only`, `none`) in the DTO and the reason on the page. Ties break by the
later date, then the row id, so the order never depends on how rows arrived.

**Why.** `$500` and `€480` have no order by face value. Ranking the converted
rows while one is missing would present a partial list as the largest.

## 8. Spans: discovery has no fixed lookback, and they stay in native currency

**Decision.** Span intervals are discovered from the whole valuation history,
with no lower bound (ADR 0004 §3, 8.7). The page keeps the intervals that
overlap its history window, each one whole, and the span engine is asked for
those alone: the new `through` bound mirrors the existing `from`. Their flows
come from the rows already loaded when those cover them. Otherwise they come
from the existing constant extra read back to the earliest real `from`, and a
span is never reconciled over flows that start after its own start.

Spans are shown in their own native currency, per currency. Reporting-currency
span conversion is not wired in this slice, even though the FX table has a
`span_average` mode. A span is never split across its months, never averaged,
never a rolling observation, and never drawn to the monthly chart's
reporting-currency scale. The chart marks the covered months with a bracket
labelled in the span's own currency.

## 9. The visualization is hand-written SVG and CSS

**Decision.** Spending gets one restrained history chart, drawn in SVG with
the existing design tokens. It has:

- stacked known and unclassified tracked spending;
- estimated months hatched;
- additional spending as a separate mark;
- paid-by-others as a muted memo mark, outside the total;
- gaps for unavailable and unobserved months;
- the current month drawn as provisional;
- span brackets.

It has an accessible summary, and the history table is its exact-data
alternative. Category bars are plain CSS. No charting dependency is added.
Recharts and the richer chart layer that 16.3 describes stay with Phase 8's
analytics. The net-worth chart already follows the same precedent.

## 10. Spending ships as one complete product slice

**Decision.** One reviewed PR delivers all of the following:

- the summary, rolling, history, spans, categories, largest known and the
  chart;
- Add known expense, reusing Monthly's form and action, with its dates bounded
  to the focus month;
- Open month, linking into Monthly;
- the live navigation entry.

No half-page ships as "Spending". Phase 8's cash-flow analytics remains
separate: arbitrary ranges, rolling and savings-rate trend charts, and income
versus spending.
