# ADR 0006 — Phase 3 Monthly transfer decisions

**Status:** accepted · **Date:** 2026-09-14 · **Phase:** 3 (Monthly cash transfers)

Ten design decisions for maintaining cash transfers in Monthly, approved by the
product owner before that work begins. The blueprint
(`docs/implementation-blueprint.md`, v2.1.16) defines what a `cash_transfer` and
its linked fee are; it leaves open where they are maintained and how an edit of
the aggregate behaves, and those are the questions recorded here.

This records approved design, not shipped behavior. Monthly has no transfer
interface yet, and Phase 3 remains in progress and unfrozen. The transfer
application and server-action paths that already exist were written before these
decisions and are not evidence against them.

The rule that authoritative financial figures are recomputed on the server after
a mutation is established by the blueprint itself, in v2.1.16 §30.19. This record
applies that rule to the transfer aggregate. It does not override the blueprint,
and it does not replace ADR 0005, whose decisions stand.

---

## 1. Monthly Accounts owns transfer maintenance

**Decision.** Maintaining `cash_transfer` facts belongs to **Monthly → Accounts**.
For the month on screen, Accounts owns the transfer list, Add transfer, and
editing and deleting a transfer. There is no ninth Monthly section, no
standalone `/transfers` route and no Transfers item in the global navigation.

One reusable transfer dialog serves ordinary maintenance, and will later also
accept initial values from a reconciliation issue action. Wiring those actions
is not part of this decision.

**Why.** A cash transfer moves value between two of the user's own tracked cash
accounts. It is neither income nor spending, so it belongs beside the balances
it moves rather than in Income or Known expenses, and it needs no page of its
own: 15.1's routes and 15.2's page catalogue define none, and 15.3 keeps its
eight sections.

**Consequences.** Reconciliation stays primarily diagnostic and explanatory.
When issue corrective actions are built, an issue that points at a missing
transfer opens this same dialog with initial values rather than a second
editor.

---

## 2. A transfer is saved as one aggregate, with an explicit Save

**Decision.** A transfer is edited as one aggregate: its financial date, its two
endpoints, one native amount or two, and an optional linked fee with its payer,
amount and date. The dialog submits the whole aggregate with one explicit Save,
and the server commits it atomically or not at all. Its financial fields are
not autosaved one by one.

**Why.** The aggregate's fields are valid only together. Saved one at a time, an
endpoint and the fee paid from it, a cross-currency pair of amounts, or a date
and the accounts that must participate on it would pass through states the rules
refuse — or, worse, accept. Blueprint v2.1.16 §30.19 item 4 provides the explicit
atomic Save for exactly this kind of aggregate.

**Consequences.** This is not a ban on autosave. Monthly's simple field editors
keep autosaving as they do today.

---

## 3. Correcting an endpoint keeps the transfer's currencies

**Decision.** After creation, From and To may be corrected. Each endpoint may
move to another owned cash account with the same stored native currency as that
leg, so the transfer's currency pair never changes. Changing a leg's currency is
not a correction: the original fact is deleted and the right one recorded.

After any correction the final endpoints must differ, must each be an eligible
owned cash account, and must both participate on the transfer's financial date.

**Why.** A leg's currency must be its account's currency (20.1), and it is part
of what the fact records: the native amount that moved. Pointing a USD leg at a
EUR account would silently turn 100 USD into 100 EUR. Choosing the wrong account
of the right currency is an ordinary data-entry mistake, and it is corrected in
place with its audit history intact.

---

## 4. The linked fee stays a separate source fact

**Decision.** A transfer fee remains one `expense_entries` row linked by
`transfer_id`; `transfers` gains no fee column. The fee's lifecycle is
maintained through its transfer: a fee can be added to a transfer that has
none, corrected, or removed, and deleting the transfer deletes its linked fee.
Generic Known-expense editing keeps showing such a fee read-only.

**Why.** M14: every fact has exactly one representation. A fee column beside the
row would be a second one, and two representations of one fee are how it gets
counted twice. The fee is nonetheless its own source fact (6.2): a transfer edit
never silently rewrites it, so every change to the fee is an explicit part of
the Save that makes it.

---

## 5. The fee has its own financial date

**Decision.** The fee's `expense_entries.incurred_on` is an independent
financial date, not forced equal to `transfers.occurred_on`. The dialog may
default a newly entered fee's date to the transfer's date, but a fee genuinely
posted on another day stays representable.

**Why.** A charge can post on a different day from the transfer it belongs to,
across a month end included. 6.2 already treats that date as the fee's own: a
transfer edit never silently rewrites the fee's date.

**Consequences.**

- Moving a transfer never silently moves an existing fee.
- A September transfer may have an October fee.
- The fee belongs financially to the month of its own date, and converts to the
  reporting currency at that date (10.3's dated flows).
- Deleting the transfer still removes its linked fee, whatever month the fee is
  dated in.

---

## 6. The fee's payer and category are fixed by rule

**Decision.** The fee is a `tracked_cash` expense paid by one of the transfer's
two endpoints. Its currency is that account's currency, and that account must
participate on the fee's own date. It is filed under the user's protected
`transfer_fee` system category, counts once under Interest & fees, and is never
consumption (7.4).

The user does not choose a category for the fee. The application resolves the
user's `transfer_fee` category and fails closed, refusing the write, if that
invariant is broken.

**Why.** A category's kind is the fee's accounting meaning, not a label, and only
one meaning is right for a transfer fee. One category of each system kind per
user is an application invariant — provisioned at sign-up, never created a
second time, never archivable — rather than a database uniqueness constraint:
6.2 makes a live category's name unique per user, not its kind. So the
application looks the category up instead of trusting an identifier it was sent,
and stops rather than guesses when the invariant does not hold.

---

## 7. A displayed month's transfers are read as complete aggregates

**Decision.** Transfer maintenance reads every transfer whose financial date
falls in the displayed month together with every fee linked to it, whatever that
fee's own date. Completeness is defined by the transfers' links, not by the
ordinary month's expense window, which would miss a fee dated in another month.

The read stays bounded and batched: no query per transfer or per fee, and a
query shape that does not grow with the number of transfer or fee rows.

**Why.** Decision 5 makes a fee dated outside its transfer's month an ordinary
state, so an expense read scoped to the month can no longer be assumed to hold
every fee of that month's transfers. An editor working from an incomplete
aggregate would show a transfer without its fee and could save it that way.
Correctness comes first: if complete aggregates cost one more bounded query, the
query is worth it (23.2).

---

## 8. Recording or correcting a transfer clears dormancy on both final endpoints

**Decision.** Recording a transfer, or correcting one, clears dormancy on both of
its final endpoints in the same financial transaction, under the Phase 3
dormancy rule (8.8) and exactly as ADR 0005 §2 establishes for every attributed
flow. Deleting a transfer does not restore dormancy, and neither does moving an
endpoint off an account.

**Why.** A transfer attributes to the account on each side of it (8.8), and a
correction that lands on an account records the flow there. Dormancy is a user
assertion re-made only through its explicit action, so nothing that takes a flow
away from an account restores it (8.8). ADR 0005 §2 records why the clear runs
inside the flow's own transaction; that reasoning is not repeated here.

---

## 9. Monthly refreshes from the server after a transfer mutation

**Decision.** A transfer mutation runs on the server, where the `application`
and `finance` path recomputes the month's figures, and Monthly refreshes from
that authoritative result. The dialog may validate what is typed before sending
it — an amount's shape and its currency's minor units, a date not after today,
two different accounts — but React never recalculates reconciliation, spending,
savings or status to preview a transfer's effect.

**Why.** Blueprint v2.1.16 §30.19 establishes this for Monthly's financial
mutations; this decision applies it to the transfer aggregate without adding to
it.

---

## 10. Refunds, reimbursements and chargebacks are deferred

**Decision.** Refunds, reimbursements and chargebacks are not modeled as cash
transfers, and Monthly-transfer work introduces no semantics for them. Their
representation is deferred to later product modeling.

**Why.** A cash transfer moves value between the user's own tracked cash
accounts (7.5). Money that comes back from someone else is not that, and
recording it as a transfer would settle a question the product has not yet
modeled.
