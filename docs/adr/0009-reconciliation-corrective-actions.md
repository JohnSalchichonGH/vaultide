# ADR 0009 — Reconciliation corrective actions

**Status:** accepted · **Date:** 2026-09-20 · **Phase:** 3 (reconciliation issue corrective actions)

What a reconciliation issue offers the user, and what it is allowed to write.
The blueprint (`docs/implementation-blueprint.md`, v2.1.18) says which issues
exist, what each one means and what each one suggests; §30.21 records the
product rulings this slice took where the older §8.5 wording described a weaker
interaction. This record explains the reasoning behind them, and the boundaries
that keep the later Historical-correction and Bulk-history slices whole.

ADR 0004, 0005, 0006, 0007 and 0008 stand. No identity, status rule, issue
trigger, availability rule or rounding boundary changes here, and no migration.

---

## 1. What "one-click action" means

**Decision.** A corrective control takes **one click to enter a focused
corrective interaction**. A financial record is written only once the user can
see what will be recorded and confirms it explicitly.

That interaction is whichever one already fits the correction: a dialog over an
existing editor, the existing Quick update modal, or a link that lands on the
exact row or month that maintains the record.

**Why.** 15.3 item 8 asks for "issues with one-click actions" and 8.5 says every
suggested action "creates or edits an explicit record; nothing automatic". Read
together, the click belongs to the *navigation into the correction*, never to
the write. A button that silently wrote a financial fact would contradict 8.5,
R6 and the product's own rule that a suggestion is not a fact; a control that
merely scrolled to a section would not be a corrective action at all.

---

## 2. Issues are resolved by data, never by a flag

**Decision.** Nothing stores that an issue was handled. A blocking issue
disappears because the source records changed and the server recomputed the
month. Advisory dismissal stays exactly what it was: keys in
`month_reviews.dismissed_issues`, presentation state only, independent of every
corrective action.

**Consequences.** No `resolved_issue`, `issue_status` or equivalent column, and
no automatic dismissal after a write — a user can act on an advisory without
hiding it, and hiding one never implies it was fixed. After any corrective write
the page refreshes from the server's recomputed result (30.19); the browser
still calculates no figure.

---

## 3. Contextual hierarchy, not a button dump

**Decision.** Each issue instance presents what Vaultide **knows**, what it
**suspects** where it suspects anything, the corrections most likely to be the
real fix, and — where one exists — a lower-priority fallback. An action is
offered only when the current phase can carry it out.

`unexplained_inflow` therefore orders its choices by variant: variant A (cash
grew more than the records explain) leads with recording the missing income,
variant B (known expenses exceed the cash that left) leads with reviewing how
those expenses were paid. Both end with the adjustment.

Actions for record types Phase 3 has no table for — a withdrawal, loan proceeds,
an asset sale, a suggested liability payment, a stale investment or property
valuation — are **not shown at all**, rather than shown disabled. This is the
convention the Income section already follows for settlements a phase cannot
write.

---

## 4. Corrective actions reuse the existing editors

**Decision.** A corrective action never carries its own copy of a financial
form or save path. Existing editors gained generic props — initial values, date
bounds, a saved callback — and the mapping from an issue to those values lives
outside the editor, in one pure model
(`apps/web/src/features/monthly/issue-actions.ts`).

**Why.** Two forms that write income would be two places for a rule to drift
(M14's reasoning applied to interfaces). The editors stay unaware of
reconciliation: nothing in `AddIncomeForm`, `AddExpenseForm` or `TransferEditor`
names an issue key, and their ordinary use on Monthly and Spending is unchanged.

---

## 5. "Accept as adjustment" is a dedicated operation

**Decision.** Accepting an unexplained inflow is its own application service and
server action, not the generic income form with a prefilled kind. The browser
sends the month, the currency, the amount it displayed and an optional note. The
server recomputes the month's authoritative reconciliation, finds the current
`unexplained_inflow` for that currency, and derives every fact of the row
itself:

| Field | Value | Why |
|---|---|---|
| `kind` | `adjustment` | 8.5's own action; 7.4 gives it the `I` cash role, and 12.5 keeps it out of income |
| `net_amount` | the **server's** current unexplained amount | The row exists only because that discrepancy exists |
| `settlement` | `tracked_cash` | Only tracked cash can explain tracked cash (§30.9 item 1) |
| `cash_position_id` | `NULL` | See §6 |
| `received_on` | `end(M)`, or `D` for the current month | See §7 |
| `description` | "Reconciliation adjustment — September 2026", plus the note | The row has to be recognizable in Income |

The amount is **not editable** in the dialog. A user who wants a different
amount, or a real record, uses Add income — which is offered above the
adjustment in the same issue.

**Why a dedicated operation.** The adjustment is the one corrective action whose
justification is a *derived* figure rather than a fact the user is asserting. If
it were written from values the browser held, a stale page would happily record
an amount the month no longer shows: the identity would then be satisfied twice,
the month would read `reliable`, and the phantom spending would be silent. Every
other corrective action states a real-world fact the user confirms and can edit.

---

## 6. The adjustment carries no cash account

**Decision.** `cash_position_id` is `NULL`, always. The dialog does not offer an
account.

**Why.** `unexplained_inflow` is a **bucket-level** fact: 8.2's residual is the
whole native currency's, and 8.3's per-account residuals are diagnostics that
attribute nothing. Naming an account would invent an attribution the evidence
does not support, would move that account's residual — which can raise or
silence `possible_missing_interest` — and would clear its dormancy (8.8, ADR
0005 §2). The ordinary tracked-cash null-leg rule still applies: a participating
account of that currency must exist, and 8.1's own rule is checked by the
existing service.

---

## 7. The adjustment's date is the interval's endpoint

**Decision.** A completed month's adjustment is dated `end(M)`; the current
month's is dated `D`, the month-to-date evidence date. The user is not asked for
a date, and the dialog says plainly that this is a bookkeeping date rather than a
claim about when the missing event happened.

**Why.** The discrepancy is measured between two balance observations, so the
honest date is the one where the measurement ends. Any other date inside the
interval would produce the same reconciliation while asserting something about a
day nobody observed, and asking the user to choose one would be asking them to
invent it. The row stays an ordinary income entry afterwards: its date, kind and
amount can be corrected or deleted through Income like any other row.

---

## 8. The adjustment applies to the current month too

**Decision.** `unexplained_inflow` is raised for the current month as well
(8.6, 30.13 item 10), and the adjustment is offered there, dated `D`. Where
there is no `D` there is no interval, no such issue, and no adjustment.

**Why.** A month-to-date bucket whose records contradict its balances is
`unresolved` for the same reason a completed one is; 8.6 ranks the arithmetic
above the month being unfinished. Refusing the correction there would leave the
blocking issue with no fallback at all.

---

## 9. Stale protection instead of a new constraint

**Decision.** The service refuses with the repository's existing conflict error
when the issue has gone or its amount has changed. A second acceptance after a
successful one therefore fails rather than recording a second adjustment. The
precondition is read before the write transaction; the control is disabled while
a save is in flight.

**Why not a database constraint.** A unique index over "one adjustment per month
and currency" would be a new schema rule invented for a race the product's own
interaction does not produce, and it would refuse a legitimate second adjustment
in a month a user genuinely corrected twice. The realistic failure — a page left
open while the month changed elsewhere — is exactly what the precondition
catches. The residual window between the check and the insert is the same shape
the tracked-cash null-leg check already has, and is recorded here rather than
hidden.

---

## 10. The cross-currency suggestion prefills residuals, never evidence

**Decision.** `possible_missing_conversion` opens the existing transfer editor
with the two **native residuals**: `U2` out of the source currency and `X` into
the destination. The comparison amount `X2` and the month's average rate stay on
screen as the evidence for the suggestion and are never written into a field.
The date starts empty and both accounts start unchosen — **even when exactly one
account of a currency takes part in the month**. The fee starts off.

**Why.** 30.15 item 9 and 30.17 item 7 already say the prefill uses `U2` and `X`
and that no account is chosen automatically when more than one exists. This
record locks the "exactly one" case the same way: the advisory knows two
currencies and two residuals, and it knows nothing about which bank account the
money actually moved between or on what day. Preselecting the only candidate
would make a guess look like a finding, and the transfer editor's own contract
already says a currency "narrows the choices and never chooses an account". The
same reasoning applies to the fee: a spread between `U2` and `X2` is not proof
that a fee was charged.

Several qualifying source currencies stay several separate suggestions, in the
engine's own order, each with its own control. Nothing picks a best one.

---

## 11. The interest suggestion knows more, and says which part it knows

**Decision.** `possible_missing_interest` opens the existing Add income
interaction with the kind, the currency, **the account** and the residual
amount prefilled, and the date left empty for the user.

**Why.** Unlike the conversion advisory, this diagnostic is per account (8.3's
residual, 8.5's trigger), so the account is evidence rather than a guess. The
amount is a suggestion: the residual is what the balance change does not
explain, not what the bank credited, so it stays editable and the copy says to
record what the statement shows. No date is evidenced at all, so none is
prefilled.

---

## 12. `first_balance` gets a single-month correction now

**Decision.** The informational `first_balance` issue offers "Enter an earlier
balance", which lands on that account's row in the **previous month's** Accounts
section. 8.5's parenthetical "(bulk editor)" named the tool a future slice will
add; it is not the only way to enter one earlier month-end balance, and the
existing single-month editor already does it safely.

**Why.** Making a user wait for Bulk history to record one balance they already
know would be a worse product for no financial gain. Bulk history remains the
multi-month reconstruction workflow, and this decision does not pull any part of
it forward: the target is the shipped Monthly Accounts editor, one month, one
account. 30.21 updates the blueprint so it no longer implies otherwise.

---

## 13. `flow_without_cash_account` identifies the record

**Decision.** The issue instance carries the source record's identity — its
kind, its id and its financial date — so the interface can say which record is
unattributed and link straight to its row. The actions are "Add a ⟨currency⟩
cash account" and "Review this record".

**Why.** 8.5 suggests "Choose the cash account; add the account", but under the
issue's own trigger no cash account of that currency takes part in the month, so
there is nothing to choose until one exists. Telling the user to look for the
record "somewhere under Income" would leave them hunting, and the engine already
holds the identity in the role leg it raised the issue from. Once an account of
that currency participates, the null leg is supported and the flow can
optionally be attributed through its ordinary row editor — which is what
"choose the cash account" means in this product.

The addition is result metadata only: the same trigger, class, currency and
amount, and no change to any sum, status or residual.

---

## 14. A current-month correction stays inside the month-to-date interval

**Decision.** A correction launched from a current-month issue is bounded by
`[start(M), D]`. Every corrective target that carries a date carries that
interval: the income dialog's dates stop at `D`, the transfer editor's range
stops at `D`, and the adjustment is dated `D`. The interval travels with the
action rather than being read from the page around it, whose own editors
legitimately reach today.

**Why.** Month-to-date reconciliation covers flows dated on or before `D` (8.6),
so a record dated after it cannot change the issue that offered the correction.
Offering a date that silently fails to fix the problem would teach the user that
the correction does not work. Recording something genuinely dated after `D`
stays available in the ordinary Monthly editors, where it is not presented as a
correction.

---

## 15. The Historical-correction boundary

**Decision.** This slice may create a new explicit source record dated inside
the issue's month, or take the user to the surface that already maintains the
record in its owning month. It introduces no new way to change an existing
record, moves nothing between months, and adds no before → after confirmation.

The generic historical-correction framework of 15.3 — the inline editor showing
before → after, the affected months and spans, and an optional reason — remains
the next slice, and it will decide which existing edits gain that confirmation.
Bulk history remains the multi-month grid after it.

---

## 16. Read topology

**Decision.** The corrective actions add no read to the Monthly page. Every
option a dialog offers — cash accounts, categories, currencies, the month's
bounds — comes from the composite read the page already performs, and the issue
metadata comes from the reconciliation result it already returns. The only new
read is on the adjustment's write path, where the server loads the month once to
recompute the authoritative discrepancy before writing.
