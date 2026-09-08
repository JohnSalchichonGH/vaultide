# Golden fixture — `simple-user` (Phase 2 slice)

Blueprint 21.6. Two EUR checking accounts, six completed months of statement
month-end balances, and a current month snapshotted on the 6th. Reporting
currency EUR; today is **2026-09-06**, so August 2026 is the newest completed
month and September is in progress.

Phase 3 extends this same fixture with a salary, inferred spending per month and
the month-to-date variants. Phase 2 asserts the balance-sheet half of it: the
net-worth series, freshness, and the cash month states.

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
