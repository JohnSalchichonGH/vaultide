# Golden fixture — `multi-currency` (Phase 2 slice)

Blueprint 21.6. A EUR account and a USD account, reported in **EUR**. Today is
2026-09-06. Phase 3 and 4 extend it with a USD salary, a EUR→USD conversion with
a spread and fee, and a USD loan paid from EUR cash; Phase 2 asserts the part
that exists now — native values, the derived reporting total, and what happens
when a rate is missing.

## Records

| Position | Currency | 2026-07-31 | 2026-08-31 |
|---|---|---:|---:|
| BBVA checking | EUR | 8,010.00 | 8,055.00 |
| US checking | USD | 2,900.00 | 3,000.00 |

ECB reference rates, `EUR → USD`: 2026-07-31 **1.1571**, 2026-08-27 1.1602,
2026-08-28 1.1588, 2026-08-31 **1.1596**, 2026-09-04 1.1622.

## The conversion, by hand

Stored rates are `EUR → quote` (10.1), so `USD → EUR` is `1 / rate(EUR→USD)`.
Conversion happens at the **as-of date**, not at the valuation's date (10.3).

**At 2026-08-31**

```
USD 3,000.00 ÷ 1.1596 = 2,587.09899966…  EUR
Total net worth = 8,055.00 + 2,587.09899966… = 10,642.09899966… EUR
                → 10,642.10 EUR displayed (half-up, 2 minor units)
```

**At 2026-07-31**

```
USD 2,900.00 ÷ 1.1571 = 2,506.26566416…  EUR
Total net worth = 8,010.00 + 2,506.26566416… = 10,516.26566416… EUR
                → 10,516.27 EUR displayed
```

**At 2026-09-06** — a Sunday. There is no rate for the 6th; the on-or-before
rule (10.2) reaches back to Friday 2026-09-04 at 1.1622, within the ten-day
limit, and the lookup reports `exact: false`. The balances themselves are the
31 August ones, carried:

```
USD 3,000.00 ÷ 1.1622 = 2,581.31130614…  EUR
Total net worth = 8,055.00 + 2,581.31130614… = 10,636.31130614… EUR
```

Both accounts are `carried` at that date, six days old.

## What the Phase 2 tests assert

1. The totals above, to the exact decimal and to the rounded display string.
2. **The native amounts are untouched by conversion**: the USD account still
   reports exactly `USD 3000.00`, and the aggregate's native breakdown is
   `EUR 8,055.00` and `USD 3,000.00` side by side. Changing the reporting
   currency changes no stored or native figure (property 21.2 #5).
3. **The rate is evidence, not decoration**: each converted position carries the
   rate, its date, its publisher, and whether it was the requested day's rate.
4. **A missing rate is missing.** With no stored rates at all (`fxUnavailable`
   — an FX outage, or a currency whose backfill has not run):
   - total net worth is **`partial`**, not wrong;
   - its value is exactly **EUR 8,055.00** — the part that could be established;
   - `missing` names the US checking account with reason `fx_missing`, and
     carries its native `USD 3,000.00`, so the interface can say *what* is not
     in the number;
   - nothing anywhere reports the dollars as zero.
5. **Native data survives the outage**: with rates gone, `valueAt` still returns
   `USD 3,000.00` for the US account. An FX failure is a presentation failure,
   never a data loss (10.5).
