# ADR 0007 — The dormant anchor

**Status:** accepted · **Date:** 2026-09-18 · **Phase:** 3 (pre-Spending correction)

Blueprint v2.1.17 §30.20 rules that a present-day dormant flag is not historical
evidence, and that a structural zero is permitted only on or after the dated
start of the account's current dormant episode. This record explains the one
column that stores that date, because a schema-level date is easy to
"simplify" later into something that means less. It does not restate the
blueprint, and ADR 0004 and ADR 0005 stand.

---

## 1. `cash_accounts.dormant_from` exists because the fact cannot be derived

**Decision.** `cash_accounts` gains `dormant_from date NULL`: the date from
which the account's **current** dormant episode is known to be at zero.

**Why.** A read of a historical month holds the valuations dated on or before
that month's end (`loadFinancialWindow`, ADR 0004 §3). A month whose account was
dormant throughout and a month that precedes a reactivation look identical in
those rows; they differ only in what was recorded later. A rule that tells them
apart would have to read past its own endpoint — making a single-month read and
a range read disagree about the same month — or read every attributed flow,
which span discovery deliberately does without. One stored date is smaller and
cannot disagree with itself.

## 2. It stores the zero-evidence date, not the click date

**Decision.** `dormant_from` is the `valued_on` of the zero valuation that
justified the transition: the account's latest valuation on or before today,
which must be exactly zero and must not be followed by an attributed flow. It is
never `today`, a timestamp, or `updated_at`.

**Why.** The carry is a statement about the balance, so it starts where the
balance is known. An account at zero since 31 January and marked dormant on 18
September is dormant from 31 January, and February to August need no statement;
anchoring on the click would demand seven confirmations for an account that
never moved. The attributed-flow guard is what makes that safe: a zero that
money has since moved past is stale, and may not start an episode. A flow dated
the same day as the balance is already reflected in it (blueprint 8.1).

The check and the transition run in one transaction that first locks the
account's `positions` and `cash_accounts` rows (`lockCashPositionsIn`). A flow
insert takes a key-share lock on the same `positions` row, so it either commits
before the evidence is read or waits and then wakes the account.

## 3. `is_dormant` stays

**Decision.** `is_dormant` remains the present-state flag, bound to the date by
`CHECK (is_dormant = (dormant_from IS NOT NULL))`.

**Why.** Every present-tense reader — quick update, the Accounts badges and
form, the verifier report — asks "is it dormant now", and none of them needs a
date. Deriving the flag from the date would touch all of them to save one
boolean. The CHECK makes the disagreeing states unrepresentable, so a writer
that forgets one column fails closed instead of leaving a carry with no start.
Only the finance engines read the date.

## 4. No episode history

**Decision.** Only the current episode is stored. Waking clears both columns,
and the ended episode is not remembered anywhere.

**Why.** An episode table is an account-state history system, which is more
model than this rule needs. What it would buy is that months of an ended
episode keep their zero carry after the account wakes. They already lose it
today, when the flag is cleared; they fall back to their own evidence — a
statement, a per-month confirmation, or the span across them — and a later
episode changes nothing before its own `dormant_from`. That direction can leave
a month `unavailable`. It cannot leave one `reliable` on an invented zero, which
is the failure this column exists to prevent.

Waking is deliberately not date-sensitive: any attributed flow or non-zero
balance wakes the account, back-dated or not (blueprint 8.8), and so does
deleting or re-dating the valuation at `dormant_from`. No other zero is searched
for. A wake can only ask for more evidence; the user marks the account dormant
again with one action, and the anchor is recomputed from the evidence then.

## 5. Migration and existing rows

**Decision.** Migration 0008 adds the column, backfills it, and then adds the
CHECK. For each account that is dormant at migration time: if its latest
valuation is exactly zero and no attributed flow — income, expense, either side
of a transfer — is dated after it, `dormant_from` is that valuation's date;
otherwise the account is woken (`is_dormant = false`, `dormant_from` NULL).

**Why.** That is exactly what marking the account dormant again under the new
rule would produce, so the migration asserts nothing a user action could not.
It reconstructs no earlier episode and uses no timestamp as evidence. An account
the old rule let through on a stale zero, or whose zero valuation was deleted
afterwards, simply asks for a balance again. The backfill runs as `app_owner`,
which row level security does not restrict (the tables are `ENABLE`, not
`FORCE`), and writes no audit rows: it is a schema migration, not a user edit,
and the migration itself is the record.
