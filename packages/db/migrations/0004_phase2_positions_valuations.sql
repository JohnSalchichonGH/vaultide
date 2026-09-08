CREATE TYPE "public"."position_kind" AS ENUM('cash', 'investment', 'property', 'other_asset', 'liability');--> statement-breakpoint
CREATE TYPE "public"."position_status" AS ENUM('active', 'closed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."cash_account_type" AS ENUM('checking', 'savings', 'cash', 'brokerage_cash', 'other');--> statement-breakpoint
CREATE TYPE "public"."other_asset_type" AS ENUM('vehicle', 'collectible', 'private_equity', 'equipment', 'receivable', 'custom');--> statement-breakpoint
CREATE TYPE "public"."date_precision" AS ENUM('exact', 'month_end');--> statement-breakpoint
CREATE TYPE "public"."valuation_source" AS ENUM('entered', 'confirmed_unchanged', 'accepted_expected', 'purchase', 'imported', 'bulk_entered');--> statement-breakpoint
CREATE TYPE "public"."audit_action" AS ENUM('insert', 'update', 'delete');--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "position_kind" NOT NULL,
	"name" text NOT NULL,
	"currency" char(3) NOT NULL,
	"status" "position_status" DEFAULT 'active' NOT NULL,
	"opened_on" date,
	"closed_on" date,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "positions_id_user_id_key" UNIQUE("id","user_id"),
	CONSTRAINT "positions_id_user_id_kind_key" UNIQUE("id","user_id","kind"),
	CONSTRAINT "positions_dates_ordered" CHECK ("positions"."closed_on" IS NULL OR "positions"."opened_on" IS NULL OR "positions"."closed_on" >= "positions"."opened_on"),
	CONSTRAINT "positions_closed_has_date" CHECK ("positions"."status" <> 'closed' OR "positions"."closed_on" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "positions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cash_accounts" (
	"position_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "position_kind" DEFAULT 'cash' NOT NULL,
	"account_type" "cash_account_type" NOT NULL,
	"institution" text,
	"is_dormant" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_accounts_kind_is_cash" CHECK ("cash_accounts"."kind" = 'cash')
);
--> statement-breakpoint
ALTER TABLE "cash_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "other_assets" (
	"position_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "position_kind" DEFAULT 'other_asset' NOT NULL,
	"asset_type" "other_asset_type" NOT NULL,
	"acquisition_date" date,
	"acquisition_value" numeric(24, 8),
	"include_in_financial_net_worth" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "other_assets_kind_is_other_asset" CHECK ("other_assets"."kind" = 'other_asset'),
	CONSTRAINT "other_assets_acquisition_value_non_negative" CHECK ("other_assets"."acquisition_value" IS NULL OR "other_assets"."acquisition_value" >= 0)
);
--> statement-breakpoint
ALTER TABLE "other_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "position_valuations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"valued_on" date NOT NULL,
	"amount" numeric(24, 8) NOT NULL,
	"source" "valuation_source" DEFAULT 'entered' NOT NULL,
	"date_precision" date_precision DEFAULT 'exact' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "position_valuations_position_date_key" UNIQUE("position_id","valued_on"),
	CONSTRAINT "position_valuations_month_end_shape" CHECK ("position_valuations"."date_precision" <> 'month_end' OR "position_valuations"."valued_on" = (date_trunc('month', "position_valuations"."valued_on") + interval '1 month - 1 day')::date)
);
--> statement-breakpoint
ALTER TABLE "position_valuations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "audit_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"entity_table" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" "audit_action" NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"changed_fields" text[] DEFAULT '{}' NOT NULL,
	"reason" text,
	"request_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_accounts" ADD CONSTRAINT "cash_accounts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_accounts" ADD CONSTRAINT "cash_accounts_position_fk" FOREIGN KEY ("position_id","user_id","kind") REFERENCES "public"."positions"("id","user_id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "other_assets" ADD CONSTRAINT "other_assets_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "other_assets" ADD CONSTRAINT "other_assets_position_fk" FOREIGN KEY ("position_id","user_id","kind") REFERENCES "public"."positions"("id","user_id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_valuations" ADD CONSTRAINT "position_valuations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_valuations" ADD CONSTRAINT "position_valuations_position_fk" FOREIGN KEY ("position_id","user_id") REFERENCES "public"."positions"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_entries" ADD CONSTRAINT "audit_entries_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "positions_user_kind_status_idx" ON "positions" USING btree ("user_id","kind","status");--> statement-breakpoint
CREATE INDEX "cash_accounts_user_idx" ON "cash_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "other_assets_user_idx" ON "other_assets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "position_valuations_position_date_idx" ON "position_valuations" USING btree ("position_id","valued_on" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "position_valuations_user_date_idx" ON "position_valuations" USING btree ("user_id","valued_on");--> statement-breakpoint
CREATE INDEX "audit_entries_lookup_idx" ON "audit_entries" USING btree ("user_id","entity_table","entity_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "positions_user_policy" ON "positions" AS PERMISSIVE FOR ALL TO "app_user" USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "cash_accounts_user_policy" ON "cash_accounts" AS PERMISSIVE FOR ALL TO "app_user" USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "other_assets_user_policy" ON "other_assets" AS PERMISSIVE FOR ALL TO "app_user" USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "position_valuations_user_policy" ON "position_valuations" AS PERMISSIVE FOR ALL TO "app_user" USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "audit_entries_user_policy" ON "audit_entries" AS PERMISSIVE FOR ALL TO "app_user" USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);