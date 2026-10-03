# ADR 0011 — Bulk History

**Status:** accepted · **Date:** 2026-10-03 · **Phase:** 3 (Bulk History)

Bulk History is the multi-month grid of 15.1's `/monthly/[yyyy-mm]/history`:
completed months down the side, a column per position and per income source
across the top, a spreadsheet paste, and one save for the whole batch. The
blueprint (`docs/implementation-blueprint.md`, v2.1.19) settles what the grid
holds and that every save is one reviewed, atomic act (15.2, 15.3 "Bulk
history", 18.1, 20.3, 30.22 item 2). This record settles the decisions it
leaves open — the design pass's C1–C6 and the policies the implementation
needed besides — and says why. It records what was decided, not the code.

ADR 0003, 0004, 0005, 0006, 0007, 0008, 0009 and 0010 stand. No identity,
status rule, issue trigger, availability rule, rounding boundary or schema
changes here, and **no migration**: `bulk_entered` has been a
`valuation_source` value since migration 0004, and everything else a save
writes is an ordinary balance, income entry, audit row or dormancy clear.

A save is a Historical Correction draft of its own family, resolved through
the decisions the ordinary single-row paths already use and applied through
their row writers. Nothing in this record adds a rule those paths do not
already apply; where a batch needs something a single row does not — an order,
one dormancy consequence per account, a limit — it is stated here.

---

## D1. Route and range

**Decision.** The route's `yyyy-mm` is the grid's **first row**, and the rows
run from it through the current month. The first row must be a completed
month: a malformed, current or future month is "not found", exactly as Monthly
treats a month that has not begun. The current month's row is shown and
disabled (15.2).

There is **no cap** on how far back the first row goes. A start control moves
it, by navigating: the address always says what is on screen, and back and
forward work. There is no client-only start that can disagree with the URL.

A link from a completed month `M` opens on `M`. A link from the current month
opens twelve months back — twelve completed months and the current month's
disabled row. The page links back to Monthly at its first row.

**Why.** A grid for "the history before this month" has one natural anchor:
where it starts. Putting it in the path rather than in client state is what
makes a link from an issue, a refresh and the back button all land on the same
rows. A cap would contradict the feature's purpose — reconstructing an
account's history from its oldest statements — and the read is sized by query
families, not by months (D10, §"Read model").

## D2. The per-save limit: 250 operations

**Decision.** One save carries at most **250** changed cells. The limit is a
named constant in the validation package, enforced by the draft schema and
asked again by the resolver. The grid refuses, as one action and with a message
naming the limit, any typing or paste that would take its unsaved operations
past it; the user saves and continues. A save is never split on the client:
one Save is one draft, one Preview, one Confirm and one transaction. The limit
is per save — it never caps the history range or the grid.

**Measured, on the 23.1 worst case.** 50 positions (40 cash accounts, 10
other assets); 48 of them with a `month_end` statement at every one of 360
month ends (17,280 balances); 5 monthly income sources with 1,500 recorded
occurrences. Local PostgreSQL 16 and Node 22 on the development machine; times
are single runs after a warm-up, including everything inside the transaction.

| At the limit | Request body | Preview | Preview response | Confirm (inside the mutex) |
|---|---|---|---|---|
| 250 balance updates spread over 30 years | 47.7 KB | 2.13 s | 3.73 MB (45 KB gzip) | 2.37 s, 770 statements, 500 of them writes |
| 250 new balances on two accounts, 125 months | 28.4 KB | 1.17 s | 2.08 MB | 1.33 s, 520 statements |
| 250 new income occurrences, 5 sources | 31.7 KB | 0.67 s | 0.95 MB | 0.94 s, 524 statements |
| *for comparison:* 500 balance updates spread over 30 years | 95.2 KB | 2.20 s | 5.16 MB | 2.68 s |
| *for comparison:* 100 balance updates spread over 30 years | 19.2 KB | 2.06 s | 1.50 MB | — |

**Why 250.** The table says where a limit bites and where it does not:

- **the request body** is never the constraint: at the limit it is under 5% of
  Next's default one-megabyte server-action body limit, which is not raised;
- **Preview time** is governed by how far the batch reaches, not how many cells
  it has: a hundred cells spread over thirty years cost what two hundred and
  fifty do, because the impact is derived over every month the window covers.
  No limit on cells changes that;
- **the preview's response** grows with the number of months the save's own
  records belong to — each reported with its before and after state — and a
  save has at most one such month per cell. At 250 the worst case stays under
  4 MB; at 500 it passes 5 MB, beyond the 4.5 MB function payload ceiling the
  hosting platform documents;
- **Confirm** holds the per-user write mutex for the window's derivation plus
  the writes. At 250 the writes are a fraction of the whole, so the mutex is
  held for about as long as any long-reaching single correction holds it.

250 also fits the common case whole: a year of month ends for a dozen columns,
or twenty years of one account. The rest is "save, then continue".

## D3. Which columns, in what order

**Decision.**

- **Balances.** One column per cash account and per other asset — the two
  kinds Phase 3 creates — whose window overlaps the months the grid can edit
  (its completed rows), whatever its status: a closed account keeps its column
  for the months it existed. Investment, property and liability positions get
  no column; their phases own them, and a draft naming one is refused.
- **Order.** Cash accounts, then other assets; within each, the user's own
  `sort_order`, then name, then id. Name and id only break ties, so the order
  never changes between a render, the review and a refresh.
- **Income.** One column per income source whose schedule overlaps the months
  the grid can edit, archived ones included (D5), ordered by name and then id.
  No expense or contribution source has a column (15.3, Phase 7).
- **One column model** drives rendering, keyboard movement, paste mapping and
  the draft. None of them computes the columns for itself.

**Why the overlap.** A column for a source whose schedule ended before the
first row, or for an account opened in the current month, would be a column of
disabled cells. The grid's editable months are the completed rows, so that is
the range a column has to overlap to hold anything a person can type.

## D4. What a cell's text means, and what a paste may do

**Decision.**

| The cell was | The text is | The operation |
|---|---|---|
| a stored statement or entry | the same amount, compared exactly as decimals | none |
| a stored statement or entry | another amount | update — the amount alone |
| a stored statement or entry | cleared by hand | clear — a hard delete with its audit image |
| carried, empty, a derived zero, an unrecorded occurrence | an amount, **even the carried one** | create |
| carried, empty, a derived zero, an unrecorded occurrence | blank | none |

Clearing an income cell is 15.3's own rule; clearing a balance cell is this
record's, and it obeys the existing rules — the closing balance of a closed
account still cannot be removed while it stays closed (6.3).

A carried value retyped is a **create** because a carried figure is not a
record: typing it is the first assertion that the month ended at that figure.

**Paste.** Tab-separated text: a tab between fields, CRLF or LF between rows, a
final line break adds no row. A field starting with `"` is quoted as Excel and
Sheets quote it — it runs to its closing quote, `""` is a literal quote, and a
tab or line break inside belongs to the field; an unterminated quote refuses
the paste. The rectangle starts at the focused cell and maps through the column
model, never through the cells that happen to be mounted. A **blank** field
leaves its cell exactly as it was. The paste is judged whole before anything
changes: a non-blank field outside the grid, on the current month's row, on a
cell nobody may edit (a snapshot, a skipped or absent occurrence, an archived
source's missing one, a month outside the account's window) or that is not an
amount the cell accepts refuses the **whole** paste with a message naming that
cell, and so does a paste that would pass the limit.

**Numbers.** The user's locale decides the separators, read from
`Intl.NumberFormat(locale).formatToParts`. Accepted: an optional minus sign,
digits, the locale's decimal separator once, and its grouping separator only
where the locale groups digits; space, no-break space and narrow no-break space
group digits in any locale. Refused, with a reason: currency symbols, percent
signs, accounting brackets, a second decimal separator, and grouping in the
wrong place — so `1,5` is refused in en-US rather than read as fifteen. The
result is a canonical decimal string built from the characters, never through
a JavaScript number, and the draft carries only canonical amounts.
`normalizeMoneyInput` keeps serving the ordinary form fields unchanged.

## D5. Income cells

**Decision.** An income cell is one scheduled occurrence, named by
`(template_id, occurrence_date)`. A recorded entry stays in its occurrence's
row wherever the money landed, with its received date shown beneath it when the
two differ. A skipped occurrence is a disabled "Skipped" cell; Bulk History
never un-skips. An archived source's unrecorded occurrences cannot be created —
archiving withdraws a source from new acceptances (30.10) — while its recorded
ones stay editable and clearable, exactly as on Monthly.

A new occurrence is an ordinary recurring entry: received on its scheduled
date, into tracked cash, on the source's own account or on none — a tracked
leg awaiting attribution, never `external` (§30.9 item 1) — with the source's
kind and currency and no description. An update changes the net and nothing
else. A clear writes no skip and restores no dormancy (8.8): the occurrence is
simply due again.

## D6. The gross a new occurrence inherits

**Decision.** For a created occurrence, take the term for its **scheduled**
date (§30.9 item 4). If the typed net equals the term's net exactly, as a
decimal, the entry takes the term's gross; if it differs, or the term has no
gross, the entry has none.

**Why.** This deliberately differs from accepting a suggestion, which inherits
the term's gross whenever no gross is stated, even when the amount was
overridden. There the user is looking at the suggestion, gross included; in
the grid nobody is. A net that is not the term's net is a different payment,
and the term's gross says nothing about it: a stored gross that does not belong
to its net would be a fact nobody asserted.

## D7. Where "always reviewed" is enforced

The policy is the blueprint's (15.3, 30.22 item 2): every Bulk save goes
through Review, whatever mix of creates, updates and clears it carries. This
records the mechanism.

**Decision.** The preparation step of Historical Correction treats the
`bulk_history` family as review-required **unconditionally**. Every other family
is judged by the classifier exactly as before. The batch's `revision` stays the
truthful aggregate — true when any cell revises stored evidence — and the
review does not depend on it; no update is invented to make a classifier
agree.

There is **no ordinary Bulk write path**: the only write is the existing
Historical Confirm, after a reviewed fingerprint. No server action was added
and the financial-action inventory is unchanged. In the interface, the grid
asks for a review directly rather than attempting a save, and a server answer
of "no review needed" for a Bulk draft is treated as a broken contract —
reported, with nothing saved — never as leave to save some other way.

## D8. A last-day snapshot is handed to Monthly

**Decision.** A month whose last day holds an exact snapshot shows a
non-editable "Snapshot — confirm in Monthly" cell that links to that account's
row in that month. A non-blank paste onto it refuses the paste; a create aimed
at it is the duplicate it is, and an update naming it is refused.

**Why — and why not.** Not because a snapshot cannot be replaced: Monthly's
Accounts editor does replace one when a figure is typed, correcting the row
against the version the edit started from. Nor is "confirmed, not replaced" the
reason; that is the confirm-unchanged batch's own rule. The reason is scope:
this version keeps the grid to **one meaning per cell**. A figure typed over a
snapshot would silently turn an exact snapshot into a `month_end` statement —
either a confirmation or a replacement, depending on the figure — and Monthly
already offers both, side by side, with the snapshot's own date in view.

## D9. Unsaved edits when the grid is read again

**Decision.**

- The grid is keyed on its first row, never on versions.
- Each edit records the **base** it was typed against: a stored row's id,
  version and amount; or that the cell was carried, empty, a derived zero, or
  an unrecorded occurrence.
- When a newer read arrives — after a commit, a changed impact, a refusal, or
  any refresh — every edit whose base still stands is kept. An edit whose cell
  now already holds what it asked for has nothing left to do and is let go
  quietly; that is what a commit leaves behind. Every other edit is **dropped,
  never re-aimed** at a newer version or a changed state, and listed — "N cells
  changed elsewhere and were not kept" — with what the server holds there now.
- Back from Review and a refused save leave the remaining edits in place; the
  cells that were dropped are marked.
- A review the user stepped back from can be reopened only while it is still
  the review of the grid's edits; once a cell changes or is dropped, it is let
  go and Save asks again.
- A dedicated edited flag, set by every change, says whether anything is
  unsaved. While it is set the first row cannot be moved and leaving the page
  asks first.

**Why.** An edit is a statement about a cell as the user saw it. Re-aiming it
at a version they never saw is the silent overwrite optimistic versions exist
to stop (20.3); keeping it as though nothing moved would send a draft the
server must refuse. Dropping it and saying what is there now gives the
decision back to the person with the truth in front of them.

## D10. Review at scale

**Decision.** Presentation only: the consent and the fingerprint are the
preview's, unchanged, and nothing is ever truncated. A Bulk review opens on one
line of counts — balances and income, each added, changed and removed — and the
range of months its records belong to. Below it, one line per account and one
per income source, each folding away every record it holds; an account's line
also states the span of months whose carried balances change, instead of one
sentence per balance, and every dormant episode the save rewrites. A wake is
shown on its account's line whatever cell caused it: an income cell wakes the
account its source pays into, and when that account has no balance in the save
it gets a line of its own — "Savings · no longer dormant" — rather than being
folded away. The months to be recalculated and the remaining
structural consequences are folded the same way. The dialog is the same review
dialog every correction uses, with the same Back, resume and changed-impact
handling.

**Why.** A hundred balances of one account would otherwise read as a hundred
"carries this balance from…" sentences. Grouping is how the aggregate effect
of the batch — the thing 15.3 says is to be seen — stays readable, and folding
rather than cutting keeps every individual record one click away.

## D11. The `first_balance` entry point

**Decision.** `first_balance` keeps its single-balance action — the previous
month's Accounts row — and gains a second: several earlier balances through
Bulk History, opened with its first row twelve months before the month the
account was first tracked.

**Why.** 8.5 names both paths (30.21 item 10). Opening a year before the first
tracked month puts exactly the months that could not be reconciled on screen,
next to the statement the user is about to read them from.

## D12. One participation rule for the null cash leg

**Decision.** A batch judges an unattributed tracked leg from the positions it
already loaded: some **cash** position of the flow's currency participates in
the flow's **month**, by finance's `participatesIn` — the 8.1 bucket, not the
flow's day — and the ordinary `decideTrackedCashLeg` judges the leg from that.
The single-flow path keeps its SQL question. An integration test holds the two
to the same answer at every edge of the window — opening and closing on the
first and last day of the month and one day outside, an open end on either
side, another currency, another kind of position.

**Why.** A batch must not ask the database once per cell, and must not state
the bucket rule a second time. `participatesIn` is the rule's pure statement;
the equivalence test is what stops the two from drifting.

---

## How a save resolves and applies

- **Preview** reads one coherent `REPEATABLE READ READ ONLY` snapshot: no
  mutex, no row lock, no write, no audit, no rate provider.
- **Confirm** takes the per-user write mutex first, then exactly the row locks
  the single-row paths take for these operations, set-wise and in one fixed
  order — the stored balances it revises, then the stored income entries it
  revises, then the sources whose occurrences it claims (§30.8 item 5) — then
  reads what the decisions rest on. Statements grow by family, never by cell.
- **Every cell is decided before anything is written.** Operations are put in
  one canonical order — family, then the cell's date, then its owner — so the
  same batch fingerprints identically whatever order the browser sent it in.
  An update or clear must name a stored row that **is** the cell it names; a
  row moved since the grid showed it is a version conflict, and a row of
  another cell is refused.
- **Apply** writes in canonical order through the families' own row writers —
  one audit entry per row, one request id for the batch (18.1) — with new
  balances `bulk_entered`, then applies the batch's dormancy clears once per
  account. A cell filled by a writer outside the mutex between resolution and
  insert reaches the unique constraint and is answered as the duplicate
  conflict it is, rolling the whole transaction back.
- Conflicts write nothing: a stale version is `CONFLICT_VERSION`; a cell or an
  occurrence filled or skipped elsewhere is `CONFLICT_DUPLICATE`; a batch still
  valid whose impact moved is `impact_changed` with a fresh preview.

## Read model

One application read for the whole grid, in one read-only snapshot: positions
and every balance on or before the last completed month end (no lower bound,
ADR 0004 §3), the sources whose schedule overlaps the range, and the skips and
income entries by **occurrence** date. Each cell states what it is — stored,
carried, a snapshot handoff, a derived zero, empty, outside the window; for
income recorded, open, skipped, archived or absent — derived with the finance
functions the reconciliation uses. The DTO is sparse: a run of equal cells is
one segment.

On the worst-case fixture of D2, with the first row thirty years back: 12
statements, 130 ms, and a 3.5 MB DTO (650 KB gzipped) — 19,082 segments, almost
all of them stored statements, each of which needs its id and version. In the
browser the grid mounts only the rows on screen plus an overscan (22 of 361
rows at the default height), builds its column model in 17 ms, validates and
applies a 250-cell paste in 28 ms, and re-renders only the cells a keystroke
changes. A view of that whole history is not the common case — Monthly's links
open twelve months — and a row-range read is the follow-up if production ever
needs the thirty-year view lighter.

## Known oddity, not changed here

A correction never writes a balance's `source`. So a `confirmed_unchanged`
statement corrected in the grid keeps `confirmed_unchanged`, and a
`bulk_entered` one corrected later in Monthly keeps `bulk_entered`. That is the
existing behaviour of every correction path, and no engine reads the source.

## Out of scope

Standalone Income pages; the known-expense total column (15.3, Phase 7); the
history drawer, undo and restore; correcting `positions.opened_on`, reopening
or correcting a close; un-skipping from the grid; the global minor-unit
hardening; CSV upload, an import framework or background jobs; and
consolidating the three private copies of a template's schedule, of which this
slice exported the suggestions one for its own use.
