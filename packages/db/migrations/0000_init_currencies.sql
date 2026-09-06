CREATE TABLE "currencies" (
	"code" char(3) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"minor_units" smallint NOT NULL,
	"is_fx_supported" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "currencies_minor_units_range" CHECK ("currencies"."minor_units" BETWEEN 0 AND 8),
	CONSTRAINT "currencies_code_shape" CHECK ("currencies"."code" ~ '^[A-Z]{3}$')
);
