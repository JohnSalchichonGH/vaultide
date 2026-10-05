# Golden fixture — `simple-user`

Blueprint 21.6. Two EUR checking accounts, six completed months of statement
month-end balances, and a current month snapshotted on the 6th. Reporting
currency EUR; today is **2026-09-06**, so August 2026 is the newest completed
month and September is in progress.

Phase 2 asserts the balance-sheet half of it: the net-worth series, freshness,
and the cash month states. Phase 3 adds a salary, the inferred spending and
savings of each completed month, and the month-to-date variants, on top of the
same balances; see [Phase 3](#phase-3) below. Nothing Phase 2 asserts changes.

## Balances

| Month end | BBVA checking | Savings | Total net worth |
|---|---:|---:|---:|
| 2026-03-31 | 7,200.00 | 8,000.00 | **15,200.00** |
| 2026-04-30 | 7,450.00 | 8,100.00 | **15,550.00** |
| 2026-05-31 | 7,610.00 | 8,200.00 | **15,810.00** |
| 2026-06-30 | 7,905.00 | 8,300.00 | **16,205.00** |
| 2026-07-31 | 8,010.00 | 8,400.00 | **16,410.00** |
| 2026-08-31 | 8,055.00 | 8,509.00 | **16,564.00** |
| 2026-09-06 *(snapshot, provisional)* | 8,120.00 | 8,509.00 | **16,629.00** |

Every total is the plain sum of the two columns; both accounts are EUR, so no
rate is involved and no conversion can be unavailable. Both positions are cash,
so `netWorthSign` is `+1` for each and financial net worth equals total net
worth throughout — there are no other assets to include or exclude.

The 31 August row is the opening balance sheet of the worked example in
blueprint 12.7 (`NW(31 Aug)` there is 8,055 + 8,509 + investments + property −
mortgage; the two cash accounts are these).

## What the Phase 2 tests assert

1. **Series.** Twelve completed month ends plus a provisional point. The six
   months above carry the totals above; the four months before March 2026 are
   *before tracking started* — the first valuation is 31 March — so those points
   are `available` with a total of exactly **0.00** and no missing entries: the
   positions were not part of the balance sheet then (12.3), which is different
   from being unknown.
2. **The provisional point** is dated 2026-09-06, not 2026-09-30. September is
   not over; its point is "where things stand", drawn hollow (15.4), and is
   never a month-end value.
3. **Freshness at 2026-08-31** is `exact` for both accounts, and the values come
   from `month_end` valuations.
4. **Freshness at 2026-09-06** is `exact` for both — they were snapshotted that
   day. At 2026-09-05 it is `carried`, one day old, from the 31 August balance.
5. **Cash month states for August 2026** are `open = month_end` (July's
   statement balance) and `close = month_end` (August's), so both accounts are
   *included*.
6. **Cash month state for March 2026** is `open = first_balance`: the accounts
   existed before Vaultide did, and March is the first month with a statement
   balance. That month is excluded from reconciliation rather than being read as
   a month of activity (8.1, R5).
7. **September 2026 cannot be closed** on 2026-09-06 (`isMonthClosable` is
   false); its `close` state is `carried`, because the 6 September snapshot is
   an ordinary snapshot and only a statement month-end balance closes a month.

## Phase 3

Blueprint 8.2, 8.6, 12.5; 25 Phase 3, "Acceptance". The balances above stay
exactly as they are. Phase 3 adds records on top of them, and reads the month
on **2026-09-08** rather than the 6th, because its current month has one
balance dated the 8th. Phase 2's data does not get that balance: on the 6th it
could not exist.

### The records Phase 3 adds

| Record | Value |
|---|---|
| Salary | 2,100.00 net into BBVA on the **1st** of every month, March to September 2026; one monthly income source, every occurrence accepted |
| BBVA snapshot | 8 Sep 2026: 8,050.00 (the current month only) |

Both accounts are checking accounts, so `possible_missing_interest` never
applies, and there is no expense, transfer or untracked spending anywhere.

**Why the 1st.** The 6 September snapshots above have BBVA at 8,120.00, 65.00
above its August statement, with Savings unchanged. Something has to explain a
rise of 65 by the 6th, and the salary is the fixture's only income. Paid on the
25th, as in 8.10, it would leave September's month to date with
`unclassified = 0 − 65 < 0`: `unresolved`, not `provisional`.

### Inferred spending per completed month (8.2)

No transfers and no known expenses, so `ΣNin = ΣNout = ΣK = 0` and

```
TrackedTotalSpending = ΣI + ΣNin − ΣNout − Δ = 2,100.00 − Δ
Unclassified         = TrackedTotalSpending − ΣK = TrackedTotalSpending
```

| Month | Δ BBVA | Δ Savings | Δ | Tracked total spending | Status |
|---|---:|---:|---:|---:|---|
| March | — | — | — | — | `unavailable` |
| April | 7,450 − 7,200 = 250 | 8,100 − 8,000 = 100 | 350 | 2,100 − 350 = **1,750.00** | `reliable` |
| May | 7,610 − 7,450 = 160 | 8,200 − 8,100 = 100 | 260 | 2,100 − 260 = **1,840.00** | `reliable` |
| June | 7,905 − 7,610 = 295 | 8,300 − 8,200 = 100 | 395 | 2,100 − 395 = **1,705.00** | `reliable` |
| July | 8,010 − 7,905 = 105 | 8,400 − 8,300 = 100 | 205 | 2,100 − 205 = **1,895.00** | `reliable` |
| August | 8,055 − 8,010 = 45 | 8,509 − 8,400 = 109 | 154 | 2,100 − 154 = **1,946.00** | `reliable` |

**March** is the month both accounts were first tracked: their first balances
are March's statements, so each is excluded as `first_balance` (8.1, R5), and
with both excluded nothing is left to reconcile. There is no Δ and no spending
figure, not a zero. March's salary was paid into BBVA, so it leaves the bucket
with that account: `ΣI = 0`.

April to August are `reliable`: both ends of both accounts are statements,
every unclassified figure is positive, and each month's salary occurrence is
resolved by its own accepted flow, so no issue of any kind is raised.

### Saved from income and the savings rate (12.5)

Every income is salary, so `ExternalIncome = 2,100.00`. Nothing is known, so
the whole tracked total is consumption, and there are no non-consumption costs
and no additional spending:

```
Consumption              = 0 + Unclassified = 2,100.00 − Δ
TrackedSavingsFromIncome = ExternalIncome − Consumption = Δ
PersonalSavings          = TrackedSavingsFromIncome − 0 = Δ
SavingsRate              = Δ / 2,100.00
TotalSpending            = TrackedTotalSpending + 0 = 2,100.00 − Δ
```

| Month | Saved from income | Savings rate (exact) | Shown |
|---|---:|---|---:|
| April | 350.00 | 350 / 2,100 = 0.1666… | **16.67 %** |
| May | 260.00 | 260 / 2,100 = 0.1238… | **12.38 %** |
| June | 395.00 | 395 / 2,100 = 0.1880… | **18.81 %** |
| July | 205.00 | 205 / 2,100 = 0.0976… | **9.76 %** |
| August | 154.00 | 154 / 2,100 = 0.0733… | **7.33 %** |

The rate stays an exact ratio in the engine; it is rounded to two places only
where it is shown (7.3). The count-additional-spending setting changes nothing
here, because there is no additional spending to count. March has no savings
figure: its bucket is `unavailable`.

### The current month: both accounts on the 6th, BBVA again on the 8th (8.6)

Today is the 8th. BBVA has snapshots on the 6th (8,120.00) and the 8th
(8,050.00); Savings has one on the 6th (8,509.00).

The latest September day on which **both** accounts have a snapshot is the 6th,
so `D = 2026-09-06`, and BBVA's balance on the 8th takes no part:

```
Δ     = (8,120.00 − 8,055.00) + (8,509.00 − 8,509.00) = 65.00
ΣI    = 2,100.00            (the 1 September salary; ≤ D)
TrackedTotalSpending = 2,100.00 − 65.00 = 2,035.00
Unclassified         = 2,035.00
```

Status **`provisional`**, through 6 Sep, with the advisory
**`mtd_newer_balances`** naming BBVA alone. Using the 8th's balance instead would
have given `Δ = −5.00`; 8.6 never pairs a balance from one date with flows cut
off at another.

Saved from income through the 6th is `2,100.00 − 2,035.00 = 65.00`, a
provisional rate of `65 / 2,100 = 0.0309…`, shown as **3.10 %**.

### The variant: BBVA only on the 6th, Savings only on the 3rd

As 8.6 and 21.1 put it: BBVA was snapshotted only on the 6th (8,120.00) and
Savings only on the 3rd (8,509.00). No September day has both, so there is no
`D` and no month-to-date interval at all. The month is **`unavailable`** with
the blocking issue **`mtd_no_common_date`**, and no figure of any kind exists —
not even the salary's `ΣI`, because without `D` there is no interval to sum it
over.
