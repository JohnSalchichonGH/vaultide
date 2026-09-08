# ADR 0004 — Phase 2 implementation decisions

**Status:** accepted · **Date:** 2026-09-08 · **Phase:** 2

Six decisions taken while building positions, valuations and the two
net-worth metrics that the blueprint does not settle, that a later phase could
plausibly get wrong, and whose reasoning is not obvious from the code alone.

Everything else in Phase 2 follows the frozen blueprint
(`docs/implementation-blueprint.md`, v2.1.2) as written; the deviations that do
exist are listed in `docs/phase-2-acceptance.md` and none of them changes the
architecture, the accounting model or the schema semantics.

---

## 1. Aggregates sum in a canonical order, because decimal addition is not associative

**Decision.** `netWorthAt` orders its position contributions by position id
before summing, and returns them in that order.

**Why.** A converted amount is a division. `USD 3,000 ÷ 1.1596` does not
terminate, so it is held to 40 significant digits (7.1), and adding several such
values in a different order can differ in the fortieth digit — decimal
arithmetic stops being associative the moment a value is rounded to any
precision at all.

This was found by a property test, not reasoned about in advance: the same
balance sheet, with its positions in two different orders, produced two strings
that differed in the last digit. The difference is invisible at any scale a
person sees and it would still have been wrong to allow, because "the same
records produce the same number" is not a thing a finance engine should leave to
the order a query happened to return rows in.

**Consequences.** Every aggregate in `finance/networth` accumulates
deterministically, and the property tests assert it for random balance sheets.
Phase 7's decompositions and Phase 10's projections should do the same: any new
aggregation over converted values needs a fixed accumulation order.

**Canonical position-id ordering is an arithmetic rule, not a presentation
contract.** It exists so that the same balance sheet produces the same string,
and nothing more. It does not require positions, components or accounts to be
shown to anyone in that order, and a future phase must not read it as an
instruction to sort a user interface by UUID.

The boundary already works this way, which is why the rule can be stated so
narrowly: `loadFinancialWindow` returns position rows ordered by `sort_order`
then `name` — a user-meaningful order — and `buildPositionDtos` looks the
engine's contributions up by id from a map while iterating those rows. The
canonical order is therefore consumed entirely inside the accumulation and never
reaches a DTO, a page or a chart. A presentation layer may apply any stable sort
it likes; doing so cannot change the order used internally to accumulate, and
changing the internal order to match a display preference is the thing that is
forbidden.

The related identity `financial = total − excluded` is therefore asserted
**exactly** where no division is involved, and to 10⁻²⁵ of a unit where a rate
is — twenty-three orders of magnitude below the smallest amount
`NUMERIC(24,8)` can hold. Asserting exact string equality there would be
asserting something the arithmetic cannot deliver; the tests say which case is
which and why.

---

## 2. "Not tracked yet" is a third answer, distinct from "unknown"

**Decision.** A position's value at a date can be `not_yet_tracked` — the
position was not on the balance sheet then — and that is **not** the same as
`missing`, which means it is tracked and nobody has said what it is worth.
`not_yet_tracked` positions are left out of totals entirely; `missing` ones make
every total containing them `partial`.

**Why.** Both would be "no valuation on or before this date" if the engine only
looked at rows, and collapsing them makes one of two errors inevitable:

- treat both as missing, and every month before an account was added turns the
  net-worth series `partial` — a chart of nothing but warnings;
- treat both as absent, and a car the user has tracked but never valued silently
  drops out of net worth while the total is presented as complete. That is
  precisely the failure the whole "unknown is not zero" rule exists to prevent.

The line between them is the blueprint's own: 12.3 defines when a position's
identity starts (`t_start` — its `opened_on` if set, otherwise its first
valuation), and before that date the position is genuinely not part of the
balance sheet.

**Consequences.** `trackingStartsOn` is the single place that answers it, and
Phase 7's "newly tracked" driver bucket is the same rule seen from the other
side — it should use this function rather than re-deriving it. A position with no
`opened_on` and no valuations at all is `missing` at every date, which is the
honest answer for "I own this, I have not said what it is worth".

---

## 3. `loadFinancialWindow` has no lower date bound, deliberately

**Decision.** The window loads every valuation dated on or before the as-of
date, with no `from`. The `from` argument that 23.2 shows is used for the FX
range only.

**Why.** A position's value at a date is its **latest valuation on or before**
it. A window that started at `from` would not find a balance carried from before
the window, and the engine would report it as `missing` — turning a correct,
carried figure into a partial total. The bound would be a performance
optimisation that silently changes financial output.

At the scale 23.1 assumes (≈ 10k valuations per user over thirty years) this is
a single indexed scan on `(user_id, valued_on)`.

**Consequences.** When volume makes a lower bound worth having, it has to arrive
**together with** a per-position "latest valuation before `from`" query, not
without one. A future session optimising this without that second query will
produce a subtly wrong balance sheet that no type checker will catch — which is
why it is recorded here rather than left as a comment.

---

## 4. Quick Update is one transaction, all or nothing

**Decision.** A quick update either writes every balance in the submission or
writes none. A version conflict on any entry rolls the whole thing back.

**Why.** 15.3 describes the modal but not what happens when one entry conflicts.
20.3 settles the same question for the bulk history editor — "the batch aborts
entirely on any conflict" — and a quick update is the same shape of write:
several positions' balances, saved together, read together a moment later as one
net-worth figure. A half-applied set of balances is exactly the state that makes
a total quietly wrong while looking complete.

**Consequences.** The modal reports one outcome rather than per-row results, and
`quickUpdateValuations` throws rather than skipping a conflicting row. Phase 3's
bulk history grid should behave identically, which is what 20.3 already says.

A related detail worth stating: a position that already has a balance for today
is **corrected**, not duplicated (M1 permits one valuation per position per
date). That touches today's row and no other, so no history is overwritten — the
distinction the blueprint draws between correcting the present and rewriting the
past.

---

## 5. There is no archive button in Phase 2

**Decision.** Positions can be created, edited, **closed** and deleted. They
cannot be archived. `position_status` keeps its `archived` value — the enum is
the closed set of 6.2 and later phases extend it rather than re-create it — but
nothing can produce a row in that state.

**Why.** §25 gives Phase 2 "create/edit/close cash accounts", and archiving was
built before that was checked. It had to come out, because there is no correct
answer available yet:

- If an archived position keeps counting, the button does nothing a user can
  observe, and the interface would have to lie about it.
- If it stops counting at every date, archiving silently rewrites every past
  net-worth figure — the balance sheet of last March changes because of
  something done today.

The right answer is 12.3's **removed from tracking** bucket: the position leaves
the balance sheet on a date, and the change is reported as a driver rather than
happening invisibly. That needs an archived-on date the schema does not carry
and a decomposition Phase 7 owns.

**Consequences.** Closing is the supported way to stop something counting, and
it is dated and exact: M6 requires a final valuation of zero, so the money is
always accounted for somewhere. Phase 7 adds archiving together with the date
column and the driver bucket.

One place to be careful when it does: `loadFinancialWindow` loads every
position regardless of status, which is correct today and would become the bug
above the moment archiving exists. A comment there says so.

---

## 6. `include_in_financial_net_worth` is a timeless classification, not a dated event

**Decision.** The other-asset inclusion preference is a **reporting definition**
with no effective date. Changing it never moves total net worth, changes whether
the asset participates in financial net worth, and recomputes the **entire**
historical financial-net-worth series under the current classification. It
creates no driver and no event, and there is no effective-date column.

**Why.** Financial net worth is a definition the user chooses, not a thing that
happens to them. If somebody decides cars are outside their financial net worth,
last March's figure has to be computed the same way as today's, or the series
is not comparable with itself — a chart whose earlier points use a definition
the user has since rejected is worse than useless for the one question it exists
to answer ("am I ahead of where I was?").

The alternative — treating the toggle as a dated event — would put a spike in
the series on the day a preference was edited, and would need 12.3's driver
machinery to explain it. That is the right model for *acquiring or disposing of*
an asset, which is a real event with a real date, and it is exactly what 12.4's
"purchases and sales of non-financial assets" lines are for. Reclassifying one
is not the same act.

M15 and R18 support this reading: the preference lives on `other_assets` alone,
12.1 says "the inclusion preference is not dated, so toggling it recomputes the
financial series consistently across all history (audited)", and total net worth
is defined over everything the user tracks with no preference in it at all.

**Consequences.** The engine reads the current flag at every as-of date, so no
code branches on "when was this changed". The toggle is still **audited**,
because it changes what a reported figure means even though it changes no
record. Verified by `networth.test.ts` → *reclassifies the whole history when
the inclusion flag is toggled*: total net worth is byte-identical at every point
of a thirteen-point series, the historical August point moves by exactly the
car's value along with the current point, and a month before the car was on the
balance sheet is unaffected either way.

Phase 7's decomposition must not invent a driver for this. If a user wants a
dated change of what they own, that is a purchase or a sale.
