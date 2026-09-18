-- The dormant anchor (blueprint 6.2, 8.8, v2.1.17 30.20; ADR 0007).
--
-- `is_dormant` is present-tense: it says an account is dormant now and nothing
-- about when that became true, so an engine reading it could carry a past month
-- at zero that had never been at zero. `dormant_from` dates the **current**
-- dormant episode — the `valued_on` of the zero balance that justified it — and
-- a structural zero is permitted only on or after it.
--
-- drizzle-kit generated the column and the CHECK. The backfill between them is
-- written by hand, because the CHECK cannot be added until every existing row
-- satisfies it.

ALTER TABLE "cash_accounts" ADD COLUMN "dormant_from" date;--> statement-breakpoint

-- Existing dormant accounts, judged exactly as marking them dormant again would
-- judge them (30.20 item 9): the latest valuation must be exactly zero, and no
-- attributed flow — income, expense (a transfer fee is one), either side of a
-- transfer — may be dated after it. A flow dated the same day is already
-- reflected in that balance (8.1), hence the strict comparison. The anchor is
-- that valuation's date: never a timestamp, and no earlier episode is
-- reconstructed.
UPDATE "cash_accounts" AS c
   SET "dormant_from" = latest."valued_on"
  FROM (
    SELECT DISTINCT ON ("position_id") "position_id", "valued_on", "amount"
      FROM "position_valuations"
     ORDER BY "position_id", "valued_on" DESC
  ) AS latest
 WHERE c."is_dormant"
   AND latest."position_id" = c."position_id"
   AND latest."amount" = 0
   AND NOT EXISTS (
     SELECT 1 FROM "income_entries" AS i
      WHERE i."cash_position_id" = c."position_id" AND i."received_on" > latest."valued_on")
   AND NOT EXISTS (
     SELECT 1 FROM "expense_entries" AS e
      WHERE e."cash_position_id" = c."position_id" AND e."incurred_on" > latest."valued_on")
   AND NOT EXISTS (
     SELECT 1 FROM "transfers" AS t
      WHERE (t."from_position_id" = c."position_id" OR t."to_position_id" = c."position_id")
        AND t."occurred_on" > latest."valued_on");--> statement-breakpoint

-- Every other dormant account has no evidence to anchor on — no valuation, a
-- non-zero latest one, or a zero that money has since moved past — so it is
-- woken rather than given a date nobody observed. It asks for a balance again,
-- and the user may mark it dormant once it has one.
UPDATE "cash_accounts"
   SET "is_dormant" = false
 WHERE "is_dormant" AND "dormant_from" IS NULL;--> statement-breakpoint

ALTER TABLE "cash_accounts" ADD CONSTRAINT "cash_accounts_dormant_anchor" CHECK ("cash_accounts"."is_dormant" = ("cash_accounts"."dormant_from" IS NOT NULL));
