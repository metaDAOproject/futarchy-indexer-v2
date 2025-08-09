CREATE TABLE IF NOT EXISTS "v0_1_conversions" (
	"signature" varchar(88) NOT NULL,
	"converter_address" varchar(44) NOT NULL,
	"user" varchar(44) NOT NULL,
	"slot" bigint NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"mint_from" varchar(44) NOT NULL,
	"mint_to" varchar(44) NOT NULL,
	"deposit_amount" numeric(20, 0) NOT NULL,
	"withdraw_amount" numeric(20, 0) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v0_1_converters" (
	"converter_address" varchar(44) PRIMARY KEY NOT NULL,
	"vault_address" varchar(44) NOT NULL,
	"mint_from" varchar(44) NOT NULL,
	"mint_to" varchar(44) NOT NULL,
	"old_amount" numeric(20, 0) NOT NULL,
	"new_amount" numeric(20, 0) NOT NULL,
	"strategy" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_1_conversions" ADD CONSTRAINT "v0_1_conversions_signature_signatures_signature_fk" FOREIGN KEY ("signature") REFERENCES "public"."signatures"("signature") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_1_conversions" ADD CONSTRAINT "v0_1_conversions_converter_address_v0_1_converters_converter_address_fk" FOREIGN KEY ("converter_address") REFERENCES "public"."v0_1_converters"("converter_address") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
