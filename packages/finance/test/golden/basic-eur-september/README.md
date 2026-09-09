# Golden fixture — `reconciliation/basic-eur-september`

Blueprint 8.10. The EUR bucket of **September 2026**, a completed month
(`today` is 1 October 2026, and 8.1 requires `today > end(M)` strictly).

Two cash accounts, both EUR, both with statement month-end balances at each end
of the month. They are the two accounts of the `simple-user` fixture and their
31 August balances are the same figures, which is what the README there means by
"Phase 3 extends this same fixture".

## Records

| Record | Value |
|---|---|
| BBVA (checking) month-end balances | 31 Aug 8,055.00 · 30 Sep 7,880.00 |
| Savings month-end balances | 31 Aug 8,509.00 · 30 Sep 8,740.00 |
| Income | 25 Sep net salary 2,100.00 → BBVA |
| Transfer | 5 Sep `cash_transfer` BBVA → Savings 200.00 |
| Transfer | 10 Sep `contribution` BBVA → S&P 500 (EUR) 1,000.00 |
| Liability payment | 1 Sep mortgage 346.00 = interest 111.00 + principal 235.00, from BBVA |
| Expense | 12 Sep insurance 300.00 from BBVA |
| Expense | 20 Sep dinner 80.00, `settlement = third_party` |
| Expense | 22 Sep coffee 50.00, `settlement = untracked_self` |

The mortgage payment is supplied through the engine's `preClassifiedLegs` seam
rather than as a Phase 3 row: Phase 3 has no `liability_payments` table, and the
payment's two parts do not share a role. See the fixture's header comment.

## Roles (7.4)

| Record | Role | Amount |
|---|---|---:|
| Salary | `I` | 2,100.00 |
| Transfer, BBVA leg | `Nout` | 200.00 |
| Transfer, Savings leg | `Nin` | 200.00 |
| Contribution, BBVA leg | `Nout` | 1,000.00 |
| Contribution, S&P 500 leg | `Nin`, **not in this bucket** — the destination is not an included cash account | 1,000.00 |
| Mortgage principal | `Nout` | 235.00 |
| Mortgage interest | `K` | 111.00 |
| Insurance | `K` | 300.00 |
| Dinner (`third_party`) | none | 80.00 |
| Coffee (`untracked_self`) | none | 50.00 |

## The arithmetic, by hand

```
Δ    = (7,880.00 − 8,055.00) + (8,740.00 − 8,509.00)
     = −175.00 + 231.00
     = 56.00

ΣI   = 2,100.00
ΣNin = 200.00
ΣNout= 200.00 + 1,000.00 + 235.00 = 1,435.00
ΣK   = 300.00 + 111.00 = 411.00        (neither untracked expense is in K)

TrackedTotalSpending = 2,100.00 + 200.00 − 1,435.00 − 56.00 = 809.00
Unclassified         = 809.00 − 411.00 = 398.00
```

Cross-check with the equivalent form of 8.2,
`open + I + Nin − Nout − K − close = Unclassified`:

```
(8,055.00 + 8,509.00) + 2,100.00 + 200.00 − 1,435.00 − 411.00 − (7,880.00 + 8,740.00)
= 16,564.00 + 2,100.00 + 200.00 − 1,435.00 − 411.00 − 16,620.00
= 398.00 ✓
```

**Status `reliable`**: every participating account is included, `unclassified ≥ 0`,
and no blocking issue is open.

**Additional spending 50.00** (the coffee) and **paid by others 80.00** (the
dinner) are reported beside the identity and are in none of the sums above.
Total spending as 8.10 presents it is `809.00 + 50.00 = 859.00`; the 80.00 is in
no total at all.

### Per-account residuals

```
BBVA    = −175.00 − (2,100.00 − 200.00 − 1,000.00 − 346.00 − 300.00)
        = −175.00 − 254.00
        = −429.00

Savings = 231.00 − 200.00 = +31.00
```

and `398.00 = 429.00 − 31.00` ✓.

The Savings residual raises the advisory **`possible_missing_interest`**: it is
positive, the account is savings-shaped, and `31.00 < 0.5 % × 8,740.00 = 43.70`.

## Variant — the €31 interest is recorded

```
ΣI                   = 2,100.00 + 31.00 = 2,131.00
TrackedTotalSpending = 2,131.00 + 200.00 − 1,435.00 − 56.00 = 840.00
Unclassified         = 840.00 − 411.00 = 429.00
```

Still `reliable`. The Savings residual becomes `231.00 − (200.00 + 31.00) = 0`,
so `possible_missing_interest` is gone. Total spending as presented is
`840.00 + 50.00 = 890.00`.

## Variant — the salary is forgotten

```
ΣI                   = 0.00
TrackedTotalSpending = 0.00 + 200.00 − 1,435.00 − 56.00 = −1,291.00
Unclassified         = −1,291.00 − 411.00 = −1,702.00
```

`unclassified < 0` → status **`unresolved`** with the blocking issue
`unexplained_inflow` of **1,702.00**. It is 8.5's **variant A** (v2.1.8 30.11),
because the tracked total is negative: cash grew by more than the recorded flows
explain. Here that is exactly the salary nobody entered.

v2.1.7 selected the variants by comparing `ΣK` against the tracked total, which
made this example read as variant B — "known expenses exceed the cash that left".
That comparison is implied by the trigger itself (`unclassified < 0` *is*
`ΣK > total`), so it could only ever produce B; 30.11 replaces it with the sign
of the tracked total, and the amount is unchanged.

Nothing clamps the negative figure to zero and nothing reports it as spending:
`−1,291.00` is what the records say, and saying so is the point of the status.
