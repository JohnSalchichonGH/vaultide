# ADR 0014 — Saying why month to date has nothing to measure

**Status:** accepted · **Date:** 2026-10-08 · **Phase:** 3 (first-month findings)

A new user's first month told them something untrue. This record writes down the
product owner's ruling on what the current month says when month to date has
nothing to measure (D1 of the first-month findings), why, and where the cause
comes from.

The blueprint (`docs/implementation-blueprint.md`, v2.1.21) is the semantic
authority, and §30.24 states the ruling. This record says how it is built.
Nothing here changes a status, an issue key, an issue class, a trigger, an
identity, the reconciliation arithmetic or the schema, and there is **no
migration**. ADR 0003 to ADR 0013 stand.

---

## The finding

A new user who adds their accounts as "It already existed — I am starting to
track it now" has each account's first balance inside the first month. 8.1 and
8.6 exclude every one of them as `first_balance`, so month to date has no
included account, and 8.6's "An empty inclusion set is not evidence" makes it
`unavailable` with `mtd_no_common_date`.

Every page then said "Your cash accounts do not share a balance date this
month… Update all cash accounts to the same date", and offered "Update all
today". Both were wrong for this user:

- **the accounts did share dates.** In the walkthrough they shared the 6th and
  the 30th;
- **"Update all today" could not change anything.** A snapshot today leaves an
  account whose first valuation is in the month a `first_balance` exclusion, so
  the included set stays empty.

A user with no cash account at all met the same sentence. With no participating
account no candidate date has an included account, and the result is the same
`mtd_no_common_date`.

## 1. The ruling: say why, and offer only what can help

**Decision.** When month to date is unavailable because no account is included,
the page says why, and offers no "Update all today", because that cannot change
the outcome. There are three cases:

| Cause | What the page says | What it offers |
|---|---|---|
| No cash account takes part in the month | That there is none, in the spirit of the finished month's "No cash account took part" | Adding a cash account |
| Every account taking part was first tracked this month | That there is nothing to measure yet, and that month to date starts next month from this month's closing balances. It echoes the finished month's "Every account of this currency was first tracked this month, so there is nothing to reconcile yet." | Nothing |
| Accounts are included but share no day | Today's words, unchanged | "Update all today", unchanged |

**What does not change:**

- **the status.** It is still `unavailable` (8.6);
- **the issue key.** It is still `mtd_no_common_date`, with its class
  `blocking`. The month-to-date issue set is closed (30.13 item 10), and
  `month_reviews.dismissed_issues` stores keys;
- **the arithmetic.** Without `D` there is still no interval and no figure of
  any kind (30.13 item 5).

Only the words and the offered action change.

**Why.** The blueprint's sentence and action are true of the third case, the
one 8.6's own example describes ("BBVA only on the 6th, Savings only on the
3rd"). In the first two cases they tell the user to fix something that is not
broken, with a control that cannot fix it. 30.21 item 1 already keeps out an
action the phase cannot carry out; this applies the same honesty to an action
that cannot change the outcome.

## 2. The engine supplies the cause, as a variant of the issue

**Decision.** `reconcileMonthToDate` puts the cause on the
`mtd_no_common_date` issue it raises, as `variant`
(`packages/finance/src/reconciliation/mtd.ts`, `NoCommonDateVariant` in
`types.ts`):

| `variant` | When |
|---|---|
| `no_cash_account` | No cash account participates in `[start(M), today]` under 8.1's predicate |
| `all_first_balance` | Every account that participates is one of the month's `first_balance` exclusions |
| `no_shared_date` | Otherwise: at least one participating account is included, and no candidate date gives every snapshot-required included account its snapshot |

The cause is computed from two things the engine already decides:

- participation through today;
- the month's first-balance exclusions, decided once for M (30.13 item 8).

The variant is present on that key whenever it is raised, and only when there
is no `D`. The DTO carries it unchanged (`ReconciliationIssueDto.variant`,
`NoCommonDateCauseDto`).

**Who reads it.** Both pages read this one variant, so they cannot disagree
about one month:

- **Monthly** reads it off the issue (`noCommonDateCauseOf`, in
  `apps/web/src/features/monthly/presentation.ts`) for the Overview, the
  Reconciliation card, the issue's title and summary, and its action;
- **Spending** reads it off the same engine result in its read. It carries it
  as `cause` on the no-date focus and as `noCommonDateCause` on the current
  month's history row.

**Why a variant, and not a field beside `reason`.**

- **The cause travels with the issue every page already reads.** Monthly's issue
  title, summary and action are functions of the issue alone (`issueTitle`,
  `issueSummary`, `issueActions`). A field on the month-to-date result would
  have to be threaded into each of them beside the issue, and the page would
  then hold the same fact in two places.
- **It is the shape the catalogue already has.** `unexplained_inflow` is one key
  with two readings, chosen by `variant` (30.11). A cause is a reading of
  `mtd_no_common_date` in exactly that sense: the same trigger, class and key,
  and different words.
- **It moves nothing else.** Historical correction's issue identity does not
  include `variant` (`issueIdentity`, `packages/application/src/corrections/impact.ts`),
  so no preview or fingerprint changes. Dismissal stores keys, and a blocking
  issue is not dismissable anyway.

**The cost.** `Issue.variant` is now a union of both keys' readings, so the type
alone would admit a cause on `unexplained_inflow`. Its documentation says which
values belong to which key, the engine is the only writer, and each reader
narrows by key before it reads the variant.

## 3. Every place that says it

| Page | Place | Cause-specific words |
|---|---|---|
| Monthly | Overview, current month without `D` | Yes; "Add a cash account" link when none takes part |
| Monthly | Reconciliation card in place of an identity | Yes; the same link when none takes part |
| Monthly | The issue's title | "No common balance date" / "Nothing to measure yet" / "No cash account this month" |
| Monthly | The issue's summary | Yes |
| Monthly | The issue's action | "Update all today" / none / "Add a cash account" |
| Spending | The state's sentence | Yes |
| Spending | The page's opening line | Yes |
| Spending | The state chip, in the summary and the history table | "No common date" / "First month tracked" / "No cash account" |
| Spending | The chart caption | "No date" / "First month" / "No account" |
| Spending | The link to Monthly's Accounts | Only when the accounts share no day |

The ruling named Spending's state sentence. The opening line, the chip, the
caption and the link say the same thing in other words, so they follow the same
rule. Leaving them would have kept the false claim on the same page.

## 4. The blueprint states the ruling

Blueprint v2.1.21 records D1 in §30.24. 8.5's `mtd_no_common_date` row named
this exact case in its trigger, and gave it one action, so the ruling belongs
in the blueprint rather than only here.

- **What changed in the blueprint.** 8.5's row now gives the action by cause,
  and 8.6's empty-inclusion bullet says the page names the cause.
- **Where it points to §30.24.** Beside the no-common-date words in 8.4's
  `provisional` row, 15.2's "Monthly (current month)" row, 15.3 sections 1 and
  8, and 15.4's state chip.
- **Where it stays as written.** 8.6's example of BBVA and Savings, and the
  other passages §30.24 lists, describe the case where accounts share no day,
  or record history.

## 5. Known edges

- **A pre-existing account with no balance at all.** 8.6's first balance needs a
  first valuation in the month, and this account has none. It is therefore
  included, owes a snapshot, and reads `no_shared_date`, so "Update all today"
  is offered.
  - After that update its first valuation falls in the month, so it becomes a
    `first_balance` exclusion.
  - If it was the only account, the month then reads `all_first_balance`.
  - The update changed the outcome, just not into a figure. The engine's unit
    tests pin this case.
- **No action for `all_first_balance`.** Entering an earlier month-end balance
  through the previous month's Accounts editor would also make such an account
  part of the month. That is 8.5's remedy for `first_balance`, and
  `first_balance` issues are not raised without `D` (8.6). The ruling names no
  action for this case, so none is offered. Whether to offer that one is a
  product question for later.
