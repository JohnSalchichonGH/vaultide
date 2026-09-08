# Golden fixture — `complex-user` (Phase 2 slice)

Blueprint 21.6. The full fixture carries flows, a loan, spans and issues; three
of its features exist in Phase 2 and are what this slice asserts: **a car
excluded from financial net worth, a dormant account, and an account closed
mid-month**. Reporting currency EUR, everything EUR, today 2026-09-06.

## The balance sheet at 2026-08-31

| Position | Kind | In financial NW | Value | Why that value |
|---|---|---|---:|---|
| BBVA checking | cash | yes | 8,055.00 | August statement balance |
| Old bank | cash (dormant) | yes | 0.00 | last balance 30 Jun 0.00, carried; dormant accounts carry at zero (R22) |
| Closed savings | cash | yes | 0.00 | closed 2026-08-20 with a final zero valuation; contributes nothing after `closed_on` (12.1, M6) |
| Artwork | other asset | **yes** | 5,000.00 | valued 31 Aug |
| Car | other asset | **no** | 20,000.00 | valued 31 Aug, `include_in_financial_net_worth = false` |

```
Total net worth      = 8,055.00 + 0.00 + 0.00 + 5,000.00 + 20,000.00 = 33,055.00
Financial net worth  = 8,055.00 + 0.00 + 0.00 + 5,000.00             = 13,055.00
Difference                                                           = 20,000.00
```

The difference is exactly the excluded car — which is invariant 21.2 #20:
financial net worth equals total net worth minus the excluded other assets, at
every date.

## Toggling the preference

With the car's `include_in_financial_net_worth` set to **true**:

```
Total net worth      = 33,055.00   (unchanged — nothing a user switches can move it)
Financial net worth  = 33,055.00   (now equal to the total)
```

That asymmetry is the whole design (F21, R18): the preference exists on other
assets only, it moves a figure *into* the headline metric, and it can never take
a tracked asset out of total net worth. A liability has no such flag at all, so
nobody can "exclude" a mortgage from their net worth.

## An asset nobody has valued

The `positionsWithUnvaluedAsset` variant adds a coin collection with no
valuation on record. It is tracked, so it is part of the balance sheet, and its
value is **unknown**:

```
Total net worth      = 33,055.00, availability: partial
                       missing: Coin collection — reason "no_valuation"
Financial net worth  = 13,055.00, availability: partial   (the coins are included in the metric)
```

Not 33,055.00 marked complete, and not 33,055.00 with the coins silently counted
as zero. The number shown is what could be established, and the result says
exactly what is not inside it.
