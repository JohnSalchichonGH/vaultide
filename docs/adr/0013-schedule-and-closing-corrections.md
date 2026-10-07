# ADR 0013 — Which schedule and closing writes to a finished month are corrections

**Status:** accepted · **Date:** 2026-10-07 · **Phase:** 3 (Historical Correction)

ADR 0010 §1 says what a Historical Correction is: an update or delete of a
source financial fact whose financial period is completed, and a dormancy
transition that reaches completed history. It was written around flows and
balances. It did not say how four other writes to a finished month are judged:
restoring a skip, changing a template's end date or its terms, archiving a
template, and closing an account. The product owner has ruled on all four. This
record writes those rulings down with their authorities, and records what this
slice builds: the first of the corrections they define, restoring a skip.

The blueprint (`docs/implementation-blueprint.md`, v2.1.20) is the semantic
authority, and §30.22 is the ruling this record reasons from. Nothing here
changes it. ADR 0003 to ADR 0012 stand. No identity, status rule, issue trigger,
availability rule, rounding boundary or schema changes here, and **no
migration**: `recurring_template_skips` already has a `version` column, and the
audit already records a skip's before-image and the reason.

This closes cold-review finding **P3-27**, "Restoring a skip bypasses
Historical Correction".

---

## Why this record is needed

- **Restoring a skip was one click in any month.** Monthly's Income and Known
  expenses called `unskipSuggestion`, which deleted the row with its audit
  image and did nothing else. It ran no classifier, had no
  `HISTORICAL_REVIEW_REQUIRED` guard and checked no version, although the table
  has one. The classifier had no kind for a skip at all.
- **That rewrites a finished month without review.** A skip resolves its
  occurrence exactly as a recorded flow does (12.6). Restoring September's rent
  in October changes September's completeness, and raises September's
  `suggested_income_missing`, with nobody shown either.
- **ADR 0010 already lists the table.** §4 names `recurring_template_skips` as
  mutable financial evidence. §1 never said what period a skip belongs to.
- **The closing ruling had no record.** The Historical Correction work decided
  that a first close is an ordinary write. Only a test said so.

## 1. Restoring a skip in a finished month is a Historical Correction

**Decision.** Restoring a skip whose occurrence falls in a finished month is a
Historical Correction. Restoring one in the current month, or a later one, stays
one click.

**The authority.**

- §30.22 item 1 makes a correction "an update or delete of a source financial
  fact whose financial period is completed".
- §30.10 says "Accepted and skipped rows are source facts".
- ADR 0010 §4 lists `recurring_template_skips` as mutable financial evidence.

**A skip's financial period is the month of its `occurrence_date`.** That is
the month whose expectation it excuses, and a skip has no other date.

A materialized flow is different. Its `occurrence_date` is scheduling identity,
and its financial period is its own financial date (§30.9 item 2), as
`financialDateOf`'s doc says (`packages/application/src/corrections/classify.ts`).
A salary scheduled for 1 October and received on 30 September belongs to
September; a skip of the 1 October occurrence belongs to October, because
October is the month that stops expecting it.

**Creating a skip stays outside the ceremony in any month.** It is a first
assertion, by §30.22 item 2: there is no before-image to show.

**Identity.** The restore carries the skip's id and the version the page showed,
as ADR 0010 §11 has every other financial delete do. A stale version is
`CONFLICT_VERSION`, with nothing deleted and nothing audited. It is judged as the
skip is resolved, before anything asks whether the month has closed, so a stale
view gets the same answer in any month.

**What the review shows.** No figure moves: a skip is in no total. The finished
month's completeness moves, and for an income source so does its
`suggested_income_missing`. A known expense moves completeness only. 12.6's
count reads every kind, but 8.5's issue reads income alone
(`missingIncomeOccurrences`,
`packages/finance/src/reconciliation/completeness.ts`).

## 2. An end-date change that adds or removes an expected occurrence in a finished month is a correction

**Decision.** Changing a template's `end_date` so that a finished month gains or
loses an expected occurrence is a Historical Correction.

**The authority.** The same rule, §30.22 item 1, and §30.10: "`start_date` and
`end_date` are historical schedule truth". An end date decides which occurrences
a finished month expected, which is what its completeness and its missing income
are judged against.

**It is not built here.** It gets its own PR, which follows this one and comes
before Phase 4.

**Until then.** The existing end-date confirmation stays as it is
(`endDateChangeOf`, `apps/web/src/features/monthly/expenses-presentation.ts`,
used by Known expenses and by the income source page). It tells the user which
finished months the change reaches. The server does not guard the change:
`updateTemplateDetails` refuses only an end before an occurrence already
recorded or skipped. See *Known gaps*.

## 3. Neither a term change nor archiving is a correction

**Decision.** Setting a template's term and archiving or unarchiving a template
are not Historical Corrections, in any month.

**Why.**

- **A term.** A finished month's completeness takes no term or amount
  (`packages/finance/src/reconciliation/completeness.ts`: "No term or amount
  takes part either — an occurrence is expected because the schedule says so,
  not because a price was set for it"). A recorded flow keeps its own amount
  whatever the term says afterwards. So no finished month reports anything
  different.
- **Archiving.** §30.10 says archiving "changes nothing about what any past
  month expected". It is present-tense visibility, and the completeness loader
  ignores it.

## 4. A first close stays an ordinary write, even when it is dated in a finished month

**Decision.** Closing a position for the first time is an ordinary write, whatever
month its `closed_on` falls in.

**Where it was decided.** The Historical Correction work decided it, and until
now only a test recorded it. In
`packages/application/test/integration/historical-correction-guards.test.ts`:

- the header says that `closePosition`, `confirmMonthEnd`, `confirmUnchanged`
  and `confirmUnchangedBatch` "write dates into completed months by design, and
  those writes are not corrections";
- the describe block "month-closing source assertions remain ordinary first
  assertions" pins it.

This record writes the decision down. That test stays as it is.

**Why.** A first close takes back nothing the user said. Since PR #50, a close
cannot be dated before anything already recorded on the account (M4). So all it
can do is settle months the account had no evidence for, as confirming a month
unchanged does.

**Still without a rule.** Correcting or reopening a close (§30.22 item 13; ADR
0010 §14).

**A known gap, from §8.5.** §8.5 lists "Close account" among the resolutions for
a finished month's `missing_month_end`. The account page's Close always sends
today, so it never resolves one. Monthly's hint no longer offers it: it read
"Mark it dormant from the zero balance that emptied it, or close it, if it holds
nothing", and now drops "or close it". Offering a dated close on the account page
is later work. See *Known gaps*.

## What this slice builds

Rulings 1 and 4 are implemented here; ruling 2 is not; ruling 3 needs no code.

- **The skip, judged like every other source fact.** `SkipSourceFacts` is a
  `SourceFacts` kind (`packages/application/src/write-plan.ts`), and its
  financial date is its `occurrence_date`, so `classifyHistorical` judges it by
  the same two rules as every other kind.
- **The ordinary restore is guarded.** `unskipSuggestion` resolves the skip
  under `FOR UPDATE` with its expected version, then calls
  `assertNoHistoricalReview`, as the other ordinary mutations do
  (`resolveUnskipIn`, `decideUnskip` and `applyUnskipPlanIn` in
  `packages/application/src/recurring/suggestions.ts`).
- **The version, end to end.** `UnskipSuggestionArgs` and the action's input take
  `expectedVersion`. Monthly's occurrence DTOs carry `skipVersion` beside
  `skipId`.
- **A `skip_delete` CorrectionDraft.** It is resolved, previewed and confirmed by
  the existing machinery, through the same resolver the guard calls, so the guard,
  the preview and Confirm share one resolution. The preview's overlay takes the
  skip's occurrence out of the resolved set, and the completed-month engines
  then say what the month reports without it. The fingerprint covers the skip's
  identity and its before-image.
- **Monthly.** Income and Known expenses restore through `runCorrectableSave`.
  In the current month or a later one it is one click, as before. In a finished
  month the review opens; it shows the source, the scheduled date, the reason
  and the note being removed, the month it recalculates, and that month's
  completeness and issue changes.
- **Monthly's hint** for a finished month's missing statement no longer offers
  closing the account (ruling 4).

Bulk History needs nothing: it never restores a skip (ADR 0011 D5).

## Known gaps

1. **The end date is unguarded on the server** (ruling 2). Until its PR lands,
   `updateTemplateDetails` saves an end-date change that adds or removes an
   expected occurrence in a finished month without review. The only safeguard is
   the client's confirmation. Until then, "no editor can bypass the ceremony" is
   not true of an end date.
2. **§8.5's "Close account" cannot resolve a finished month's
   `missing_month_end`** (ruling 4), because the account page closes on today.
   The Phase 3 acceptance record carries this gap.

## Out of scope

- The end-date guard (ruling 2), in its own PR.
- Correcting or reopening a close, and a dated close on the account page.
- Any change to `closePosition` or to `historical-correction-guards.test.ts`.
- Any schema, migration or dependency change.
