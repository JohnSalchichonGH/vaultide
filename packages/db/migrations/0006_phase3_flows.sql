CREATE TYPE "public"."income_kind" AS ENUM('employment', 'rental', 'interest', 'dividend', 'freelance', 'bonus', 'other', 'external_inflow', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."recurrence_frequency" AS ENUM('monthly', 'quarterly', 'semiannual', 'annual');--> statement-breakpoint
CREATE TYPE "public"."template_kind" AS ENUM('income', 'expense', 'contribution');--> statement-breakpoint
CREATE TYPE "public"."skip_reason" AS ENUM('skipped', 'vacant', 'non_payment', 'other');--> statement-breakpoint
CREATE TYPE "public"."income_settlement" AS ENUM('tracked_cash', 'reinvested', 'external');--> statement-breakpoint
CREATE TYPE "public"."transfer_kind" AS ENUM('cash_transfer', 'contribution', 'withdrawal', 'investment_switch', 'loan_proceeds', 'financed_purchase', 'asset_purchase', 'asset_sale');--> statement-breakpoint
CREATE TYPE "public"."expense_settlement" AS ENUM('tracked_cash', 'untracked_self', 'third_party', 'deducted_from_asset');--> statement-breakpoint
CREATE TABLE "recurring_template_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"amount" numeric(24, 8) NOT NULL,
	"gross_amount" numeric(24, 8),
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "recurring_template_terms_template_effective_key" UNIQUE("template_id","effective_from"),
	CONSTRAINT "recurring_template_terms_amount_non_negative" CHECK ("recurring_template_terms"."amount" >= 0),
	CONSTRAINT "recurring_template_terms_gross_non_negative" CHECK ("recurring_template_terms"."gross_amount" IS NULL OR "recurring_template_terms"."gross_amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "recurring_template_terms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "recurring_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "template_kind" NOT NULL,
	"name" text NOT NULL,
	"counterparty" text,
	"income_kind" "income_kind",
	"category_id" uuid,
	"currency" char(3) NOT NULL,
	"frequency" "recurrence_frequency" NOT NULL,
	"day_of_month" smallint,
	"start_date" date NOT NULL,
	"end_date" date,
	"cash_position_id" uuid,
	"cash_position_kind" "position_kind",
	"property_position_id" uuid,
	"property_position_kind" "position_kind",
	"target_investment_position_id" uuid,
	"target_investment_position_kind" "position_kind",
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "recurring_templates_id_user_id_key" UNIQUE("id","user_id"),
	CONSTRAINT "recurring_templates_income_kind" CHECK (("recurring_templates"."kind" = 'income') = ("recurring_templates"."income_kind" IS NOT NULL)),
	CONSTRAINT "recurring_templates_no_special_income_kind" CHECK ("recurring_templates"."income_kind" IS NULL OR "recurring_templates"."income_kind" NOT IN ('external_inflow', 'adjustment')),
	CONSTRAINT "recurring_templates_expense_has_category" CHECK ("recurring_templates"."kind" <> 'expense' OR "recurring_templates"."category_id" IS NOT NULL),
	CONSTRAINT "recurring_templates_contribution_has_target" CHECK ("recurring_templates"."kind" <> 'contribution' OR "recurring_templates"."target_investment_position_id" IS NOT NULL),
	CONSTRAINT "recurring_templates_day_of_month_range" CHECK ("recurring_templates"."day_of_month" IS NULL OR ("recurring_templates"."day_of_month" BETWEEN 1 AND 31)),
	CONSTRAINT "recurring_templates_dates_ordered" CHECK ("recurring_templates"."end_date" IS NULL OR "recurring_templates"."end_date" >= "recurring_templates"."start_date"),
	CONSTRAINT "recurring_templates_cash_position_shape" CHECK (("recurring_templates"."cash_position_id" IS NULL) = ("recurring_templates"."cash_position_kind" IS NULL) AND ("recurring_templates"."cash_position_kind" IS NULL OR "recurring_templates"."cash_position_kind" = 'cash')),
	CONSTRAINT "recurring_templates_property_position_shape" CHECK (("recurring_templates"."property_position_id" IS NULL) = ("recurring_templates"."property_position_kind" IS NULL) AND ("recurring_templates"."property_position_kind" IS NULL OR "recurring_templates"."property_position_kind" = 'property')),
	CONSTRAINT "recurring_templates_target_investment_position_shape" CHECK (("recurring_templates"."target_investment_position_id" IS NULL) = ("recurring_templates"."target_investment_position_kind" IS NULL) AND ("recurring_templates"."target_investment_position_kind" IS NULL OR "recurring_templates"."target_investment_position_kind" = 'investment'))
);
--> statement-breakpoint
ALTER TABLE "recurring_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "recurring_template_skips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"occurrence_date" date NOT NULL,
	"reason" "skip_reason" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "recurring_template_skips_template_occurrence_key" UNIQUE("template_id","occurrence_date")
);
--> statement-breakpoint
ALTER TABLE "recurring_template_skips" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "income_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"template_id" uuid,
	"occurrence_date" date,
	"kind" "income_kind" NOT NULL,
	"received_on" date NOT NULL,
	"net_amount" numeric(24, 8) NOT NULL,
	"gross_amount" numeric(24, 8),
	"currency" char(3) NOT NULL,
	"settlement" "income_settlement" DEFAULT 'tracked_cash' NOT NULL,
	"cash_position_id" uuid,
	"cash_position_kind" "position_kind",
	"property_position_id" uuid,
	"property_position_kind" "position_kind",
	"investment_position_id" uuid,
	"investment_position_kind" "position_kind",
	"description" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"is_one_off" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "income_entries_net_amount_non_negative" CHECK ("income_entries"."net_amount" >= 0),
	CONSTRAINT "income_entries_gross_amount_non_negative" CHECK ("income_entries"."gross_amount" IS NULL OR "income_entries"."gross_amount" >= 0),
	CONSTRAINT "income_entries_reinvested_is_distribution" CHECK ("income_entries"."settlement" <> 'reinvested' OR ("income_entries"."investment_position_id" IS NOT NULL AND "income_entries"."kind" IN ('dividend', 'interest'))),
	CONSTRAINT "income_entries_settlement_cash_leg" CHECK ("income_entries"."settlement" = 'tracked_cash' OR "income_entries"."cash_position_id" IS NULL),
	CONSTRAINT "income_entries_occurrence_pair" CHECK (("income_entries"."template_id" IS NULL) = ("income_entries"."occurrence_date" IS NULL)),
	CONSTRAINT "income_entries_cash_position_shape" CHECK (("income_entries"."cash_position_id" IS NULL) = ("income_entries"."cash_position_kind" IS NULL) AND ("income_entries"."cash_position_kind" IS NULL OR "income_entries"."cash_position_kind" = 'cash')),
	CONSTRAINT "income_entries_property_position_shape" CHECK (("income_entries"."property_position_id" IS NULL) = ("income_entries"."property_position_kind" IS NULL) AND ("income_entries"."property_position_kind" IS NULL OR "income_entries"."property_position_kind" = 'property')),
	CONSTRAINT "income_entries_investment_position_shape" CHECK (("income_entries"."investment_position_id" IS NULL) = ("income_entries"."investment_position_kind" IS NULL) AND ("income_entries"."investment_position_kind" IS NULL OR "income_entries"."investment_position_kind" = 'investment'))
);
--> statement-breakpoint
ALTER TABLE "income_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "transfer_kind" NOT NULL,
	"occurred_on" date NOT NULL,
	"template_id" uuid,
	"occurrence_date" date,
	"from_position_id" uuid,
	"from_currency" char(3) NOT NULL,
	"from_amount" numeric(24, 8) NOT NULL,
	"to_position_id" uuid,
	"to_currency" char(3) NOT NULL,
	"to_amount" numeric(24, 8) NOT NULL,
	"description" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "transfers_id_user_id_key" UNIQUE("id","user_id"),
	CONSTRAINT "transfers_from_amount_positive" CHECK ("transfers"."from_amount" > 0),
	CONSTRAINT "transfers_to_amount_positive" CHECK ("transfers"."to_amount" > 0),
	CONSTRAINT "transfers_has_an_endpoint" CHECK ("transfers"."from_position_id" IS NOT NULL OR "transfers"."to_position_id" IS NOT NULL),
	CONSTRAINT "transfers_endpoints_differ" CHECK ("transfers"."from_position_id" IS DISTINCT FROM "transfers"."to_position_id"),
	CONSTRAINT "transfers_same_currency_same_amount" CHECK ("transfers"."from_currency" <> "transfers"."to_currency" OR "transfers"."from_amount" = "transfers"."to_amount"),
	CONSTRAINT "transfers_occurrence_pair" CHECK (("transfers"."template_id" IS NULL) = ("transfers"."occurrence_date" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "transfers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "expense_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"template_id" uuid,
	"occurrence_date" date,
	"category_id" uuid NOT NULL,
	"incurred_on" date NOT NULL,
	"amount" numeric(24, 8) NOT NULL,
	"currency" char(3) NOT NULL,
	"settlement" "expense_settlement" DEFAULT 'tracked_cash' NOT NULL,
	"cash_position_id" uuid,
	"cash_position_kind" "position_kind",
	"property_position_id" uuid,
	"property_position_kind" "position_kind",
	"investment_position_id" uuid,
	"investment_position_kind" "position_kind",
	"other_asset_position_id" uuid,
	"other_asset_position_kind" "position_kind",
	"transfer_id" uuid,
	"value_add_estimate" numeric(24, 8),
	"description" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"is_one_off" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "expense_entries_amount_positive" CHECK ("expense_entries"."amount" > 0),
	CONSTRAINT "expense_entries_deducted_from_asset" CHECK ("expense_entries"."settlement" <> 'deducted_from_asset' OR "expense_entries"."investment_position_id" IS NOT NULL),
	CONSTRAINT "expense_entries_settlement_cash_leg" CHECK ("expense_entries"."settlement" = 'tracked_cash' OR "expense_entries"."cash_position_id" IS NULL),
	CONSTRAINT "expense_entries_value_add_needs_asset" CHECK ("expense_entries"."value_add_estimate" IS NULL OR "expense_entries"."property_position_id" IS NOT NULL OR "expense_entries"."other_asset_position_id" IS NOT NULL),
	CONSTRAINT "expense_entries_value_add_non_negative" CHECK ("expense_entries"."value_add_estimate" IS NULL OR "expense_entries"."value_add_estimate" >= 0),
	CONSTRAINT "expense_entries_occurrence_pair" CHECK (("expense_entries"."template_id" IS NULL) = ("expense_entries"."occurrence_date" IS NULL)),
	CONSTRAINT "expense_entries_cash_position_shape" CHECK (("expense_entries"."cash_position_id" IS NULL) = ("expense_entries"."cash_position_kind" IS NULL) AND ("expense_entries"."cash_position_kind" IS NULL OR "expense_entries"."cash_position_kind" = 'cash')),
	CONSTRAINT "expense_entries_property_position_shape" CHECK (("expense_entries"."property_position_id" IS NULL) = ("expense_entries"."property_position_kind" IS NULL) AND ("expense_entries"."property_position_kind" IS NULL OR "expense_entries"."property_position_kind" = 'property')),
	CONSTRAINT "expense_entries_investment_position_shape" CHECK (("expense_entries"."investment_position_id" IS NULL) = ("expense_entries"."investment_position_kind" IS NULL) AND ("expense_entries"."investment_position_kind" IS NULL OR "expense_entries"."investment_position_kind" = 'investment')),
	CONSTRAINT "expense_entries_other_asset_position_shape" CHECK (("expense_entries"."other_asset_position_id" IS NULL) = ("expense_entries"."other_asset_position_kind" IS NULL) AND ("expense_entries"."other_asset_position_kind" IS NULL OR "expense_entries"."other_asset_position_kind" = 'other_asset'))
);
--> statement-breakpoint
ALTER TABLE "expense_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "month_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"month" date NOT NULL,
	"reviewed_at" timestamp with time zone,
	"notes" text,
	"dismissed_issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "month_reviews_user_month_key" UNIQUE("user_id","month"),
	CONSTRAINT "month_reviews_month_is_first_of_month" CHECK ("month_reviews"."month" = date_trunc('month', "month_reviews"."month")::date)
);
--> statement-breakpoint
ALTER TABLE "month_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recurring_template_terms" ADD CONSTRAINT "recurring_template_terms_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_template_terms" ADD CONSTRAINT "recurring_template_terms_template_fk" FOREIGN KEY ("template_id","user_id") REFERENCES "public"."recurring_templates"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_templates" ADD CONSTRAINT "recurring_templates_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_templates" ADD CONSTRAINT "recurring_templates_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_templates" ADD CONSTRAINT "recurring_templates_category_fk" FOREIGN KEY ("category_id","user_id") REFERENCES "public"."categories"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_templates" ADD CONSTRAINT "recurring_templates_cash_position_fk" FOREIGN KEY ("cash_position_id","user_id","cash_position_kind") REFERENCES "public"."positions"("id","user_id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_templates" ADD CONSTRAINT "recurring_templates_property_position_fk" FOREIGN KEY ("property_position_id","user_id","property_position_kind") REFERENCES "public"."positions"("id","user_id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_templates" ADD CONSTRAINT "recurring_templates_target_investment_position_fk" FOREIGN KEY ("target_investment_position_id","user_id","target_investment_position_kind") REFERENCES "public"."positions"("id","user_id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_template_skips" ADD CONSTRAINT "recurring_template_skips_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_template_skips" ADD CONSTRAINT "recurring_template_skips_template_fk" FOREIGN KEY ("template_id","user_id") REFERENCES "public"."recurring_templates"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_entries" ADD CONSTRAINT "income_entries_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_entries" ADD CONSTRAINT "income_entries_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_entries" ADD CONSTRAINT "income_entries_template_fk" FOREIGN KEY ("template_id","user_id") REFERENCES "public"."recurring_templates"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_entries" ADD CONSTRAINT "income_entries_cash_position_fk" FOREIGN KEY ("cash_position_id","user_id","cash_position_kind") REFERENCES "public"."positions"("id","user_id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_entries" ADD CONSTRAINT "income_entries_property_position_fk" FOREIGN KEY ("property_position_id","user_id","property_position_kind") REFERENCES "public"."positions"("id","user_id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_entries" ADD CONSTRAINT "income_entries_investment_position_fk" FOREIGN KEY ("investment_position_id","user_id","investment_position_kind") REFERENCES "public"."positions"("id","user_id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_from_currency_currencies_code_fk" FOREIGN KEY ("from_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_to_currency_currencies_code_fk" FOREIGN KEY ("to_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_template_fk" FOREIGN KEY ("template_id","user_id") REFERENCES "public"."recurring_templates"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_from_position_fk" FOREIGN KEY ("from_position_id","user_id") REFERENCES "public"."positions"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_to_position_fk" FOREIGN KEY ("to_position_id","user_id") REFERENCES "public"."positions"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_template_fk" FOREIGN KEY ("template_id","user_id") REFERENCES "public"."recurring_templates"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_category_fk" FOREIGN KEY ("category_id","user_id") REFERENCES "public"."categories"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_transfer_fk" FOREIGN KEY ("transfer_id","user_id") REFERENCES "public"."transfers"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_cash_position_fk" FOREIGN KEY ("cash_position_id","user_id","cash_position_kind") REFERENCES "public"."positions"("id","user_id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_property_position_fk" FOREIGN KEY ("property_position_id","user_id","property_position_kind") REFERENCES "public"."positions"("id","user_id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_investment_position_fk" FOREIGN KEY ("investment_position_id","user_id","investment_position_kind") REFERENCES "public"."positions"("id","user_id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_entries" ADD CONSTRAINT "expense_entries_other_asset_position_fk" FOREIGN KEY ("other_asset_position_id","user_id","other_asset_position_kind") REFERENCES "public"."positions"("id","user_id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "month_reviews" ADD CONSTRAINT "month_reviews_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recurring_template_terms_template_effective_idx" ON "recurring_template_terms" USING btree ("template_id","effective_from" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "recurring_templates_user_kind_idx" ON "recurring_templates" USING btree ("user_id","kind","archived_at");--> statement-breakpoint
CREATE INDEX "recurring_template_skips_template_occurrence_idx" ON "recurring_template_skips" USING btree ("template_id","occurrence_date");--> statement-breakpoint
CREATE UNIQUE INDEX "income_entries_occurrence_uidx" ON "income_entries" USING btree ("template_id","occurrence_date") WHERE template_id IS NOT NULL AND occurrence_date IS NOT NULL;--> statement-breakpoint
CREATE INDEX "income_entries_user_received_idx" ON "income_entries" USING btree ("user_id","received_on");--> statement-breakpoint
CREATE INDEX "income_entries_investment_received_idx" ON "income_entries" USING btree ("investment_position_id","received_on");--> statement-breakpoint
CREATE INDEX "income_entries_property_received_idx" ON "income_entries" USING btree ("property_position_id","received_on");--> statement-breakpoint
CREATE INDEX "income_entries_tags_idx" ON "income_entries" USING gin ("tags");--> statement-breakpoint
CREATE UNIQUE INDEX "transfers_occurrence_uidx" ON "transfers" USING btree ("template_id","occurrence_date") WHERE template_id IS NOT NULL AND occurrence_date IS NOT NULL;--> statement-breakpoint
CREATE INDEX "transfers_user_occurred_idx" ON "transfers" USING btree ("user_id","occurred_on");--> statement-breakpoint
CREATE INDEX "transfers_from_occurred_idx" ON "transfers" USING btree ("from_position_id","occurred_on");--> statement-breakpoint
CREATE INDEX "transfers_to_occurred_idx" ON "transfers" USING btree ("to_position_id","occurred_on");--> statement-breakpoint
CREATE UNIQUE INDEX "expense_entries_occurrence_uidx" ON "expense_entries" USING btree ("template_id","occurrence_date") WHERE template_id IS NOT NULL AND occurrence_date IS NOT NULL;--> statement-breakpoint
CREATE INDEX "expense_entries_user_incurred_idx" ON "expense_entries" USING btree ("user_id","incurred_on");--> statement-breakpoint
CREATE INDEX "expense_entries_category_idx" ON "expense_entries" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "expense_entries_property_incurred_idx" ON "expense_entries" USING btree ("property_position_id","incurred_on");--> statement-breakpoint
CREATE INDEX "expense_entries_transfer_idx" ON "expense_entries" USING btree ("transfer_id");--> statement-breakpoint
CREATE INDEX "expense_entries_tags_idx" ON "expense_entries" USING gin ("tags");--> statement-breakpoint
CREATE POLICY "recurring_template_terms_user_policy" ON "recurring_template_terms" AS PERMISSIVE FOR ALL TO "app_user" USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "recurring_templates_user_policy" ON "recurring_templates" AS PERMISSIVE FOR ALL TO "app_user" USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "recurring_template_skips_user_policy" ON "recurring_template_skips" AS PERMISSIVE FOR ALL TO "app_user" USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "income_entries_user_policy" ON "income_entries" AS PERMISSIVE FOR ALL TO "app_user" USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "transfers_user_policy" ON "transfers" AS PERMISSIVE FOR ALL TO "app_user" USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "expense_entries_user_policy" ON "expense_entries" AS PERMISSIVE FOR ALL TO "app_user" USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "month_reviews_user_policy" ON "month_reviews" AS PERMISSIVE FOR ALL TO "app_user" USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);