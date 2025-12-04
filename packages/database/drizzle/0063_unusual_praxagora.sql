CREATE TABLE IF NOT EXISTS "v0_6_fee_collections" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"dao_addr" varchar(44) NOT NULL,
	"signature" varchar(88) NOT NULL,
	"slot" bigint NOT NULL,
	"unix_timestamp" bigint NOT NULL,
	"base_token_account" varchar(44) NOT NULL,
	"quote_token_account" varchar(44) NOT NULL,
	"base_fees_collected" bigint NOT NULL,
	"quote_fees_collected" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v0_7_additional_token_claims" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"launch_addr" varchar(44) NOT NULL,
	"additional_tokens_amount" bigint NOT NULL,
	"additional_tokens_recipient" varchar(44) NOT NULL,
	"slot" bigint NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v0_7_claims" (
	"funding_record_addr" varchar(44) PRIMARY KEY NOT NULL,
	"launch_addr" varchar(44) NOT NULL,
	"funder_addr" varchar(44) NOT NULL,
	"tokens_claimed" numeric(20, 0) NOT NULL,
	"slot" bigint NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v0_7_funding_approvals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"funding_record_addr" varchar(44) NOT NULL,
	"launch_addr" varchar(44) NOT NULL,
	"funder_addr" varchar(44) NOT NULL,
	"approved_amount" bigint NOT NULL,
	"total_approved" bigint NOT NULL,
	"slot" bigint NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v0_7_funding_records" (
	"funding_record_addr" varchar(44) PRIMARY KEY NOT NULL,
	"pda_bump" smallint NOT NULL,
	"launch_addr" varchar(44) NOT NULL,
	"funder_addr" varchar(44) NOT NULL,
	"committed_amount" bigint NOT NULL,
	"is_tokens_claimed" boolean NOT NULL,
	"is_usdc_refunded" boolean NOT NULL,
	"approved_amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at_slot" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v0_7_funds" (
	"funding_record_addr" varchar(44) NOT NULL,
	"tx_signature" varchar(88) NOT NULL,
	"launch_addr" varchar(44) NOT NULL,
	"funder_addr" varchar(44) NOT NULL,
	"slot" bigint NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"quote_amount" numeric(20, 0) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "v0_7_funds_funding_record_addr_tx_signature_pk" PRIMARY KEY("funding_record_addr","tx_signature")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v0_7_launches" (
	"launch_addr" varchar(44) PRIMARY KEY NOT NULL,
	"minimum_raise_amount" bigint NOT NULL,
	"monthly_spending_limit_amount" bigint NOT NULL,
	"monthly_spending_limit_members" varchar(44)[],
	"launch_authority" varchar(44) NOT NULL,
	"launch_signer" varchar(44) NOT NULL,
	"launch_signer_pda_bump" smallint NOT NULL,
	"launch_quote_vault" varchar(44) NOT NULL,
	"launch_base_vault" varchar(44) NOT NULL,
	"base_mint_acct" varchar(44) NOT NULL,
	"quote_mint_acct" varchar(44) NOT NULL,
	"unix_timestamp_started" bigint,
	"unix_timestamp_closed" bigint,
	"total_committed_amount" bigint NOT NULL,
	"state" varchar NOT NULL,
	"seq_num" bigint NOT NULL,
	"seconds_for_launch" integer NOT NULL,
	"dao_addr" varchar(44),
	"dao_vault" varchar(44),
	"performance_package_grantee" varchar(44) NOT NULL,
	"performance_package_token_amount" bigint NOT NULL,
	"months_until_insiders_can_unlock" smallint NOT NULL,
	"pda_bump" smallint NOT NULL,
	"team_address" varchar(44) NOT NULL,
	"total_approved_amount" bigint NOT NULL,
	"additional_tokens_amount" bigint NOT NULL,
	"additional_tokens_recipient" varchar(44),
	"additional_tokens_claimed" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at_slot" bigint DEFAULT 0 NOT NULL,
	"is_hidden" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v0_7_refunds" (
	"funding_record_addr" varchar(44) PRIMARY KEY NOT NULL,
	"launch_addr" varchar(44) NOT NULL,
	"funder_addr" varchar(44) NOT NULL,
	"slot" bigint NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"quote_amount" numeric(20, 0) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "v0_6_launches" ADD COLUMN "team_address" varchar(44);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_fee_collections" ADD CONSTRAINT "v0_6_fee_collections_dao_addr_v0_6_daos_dao_addr_fk" FOREIGN KEY ("dao_addr") REFERENCES "public"."v0_6_daos"("dao_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_fee_collections" ADD CONSTRAINT "v0_6_fee_collections_signature_signatures_signature_fk" FOREIGN KEY ("signature") REFERENCES "public"."signatures"("signature") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_7_additional_token_claims" ADD CONSTRAINT "v0_7_additional_token_claims_launch_addr_v0_7_launches_launch_addr_fk" FOREIGN KEY ("launch_addr") REFERENCES "public"."v0_7_launches"("launch_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_7_claims" ADD CONSTRAINT "v0_7_claims_funding_record_addr_v0_7_funding_records_funding_record_addr_fk" FOREIGN KEY ("funding_record_addr") REFERENCES "public"."v0_7_funding_records"("funding_record_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_7_claims" ADD CONSTRAINT "v0_7_claims_launch_addr_v0_7_launches_launch_addr_fk" FOREIGN KEY ("launch_addr") REFERENCES "public"."v0_7_launches"("launch_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_7_funding_approvals" ADD CONSTRAINT "v0_7_funding_approvals_funding_record_addr_v0_7_funding_records_funding_record_addr_fk" FOREIGN KEY ("funding_record_addr") REFERENCES "public"."v0_7_funding_records"("funding_record_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_7_funding_approvals" ADD CONSTRAINT "v0_7_funding_approvals_launch_addr_v0_7_launches_launch_addr_fk" FOREIGN KEY ("launch_addr") REFERENCES "public"."v0_7_launches"("launch_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_7_funding_records" ADD CONSTRAINT "v0_7_funding_records_launch_addr_v0_7_launches_launch_addr_fk" FOREIGN KEY ("launch_addr") REFERENCES "public"."v0_7_launches"("launch_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_7_funds" ADD CONSTRAINT "v0_7_funds_funding_record_addr_v0_7_funding_records_funding_record_addr_fk" FOREIGN KEY ("funding_record_addr") REFERENCES "public"."v0_7_funding_records"("funding_record_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_7_funds" ADD CONSTRAINT "v0_7_funds_tx_signature_signatures_signature_fk" FOREIGN KEY ("tx_signature") REFERENCES "public"."signatures"("signature") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_7_funds" ADD CONSTRAINT "v0_7_funds_launch_addr_v0_7_launches_launch_addr_fk" FOREIGN KEY ("launch_addr") REFERENCES "public"."v0_7_launches"("launch_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_7_launches" ADD CONSTRAINT "v0_7_launches_base_mint_acct_tokens_mint_acct_fk" FOREIGN KEY ("base_mint_acct") REFERENCES "public"."tokens"("mint_acct") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_7_launches" ADD CONSTRAINT "v0_7_launches_quote_mint_acct_tokens_mint_acct_fk" FOREIGN KEY ("quote_mint_acct") REFERENCES "public"."tokens"("mint_acct") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_7_refunds" ADD CONSTRAINT "v0_7_refunds_funding_record_addr_v0_7_funding_records_funding_record_addr_fk" FOREIGN KEY ("funding_record_addr") REFERENCES "public"."v0_7_funding_records"("funding_record_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_7_refunds" ADD CONSTRAINT "v0_7_refunds_launch_addr_v0_7_launches_launch_addr_fk" FOREIGN KEY ("launch_addr") REFERENCES "public"."v0_7_launches"("launch_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_6_fee_collections_dao_index" ON "v0_6_fee_collections" USING btree ("dao_addr");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_6_fee_collections_signature_index" ON "v0_6_fee_collections" USING btree ("signature");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_7_additional_token_claims_launch_index" ON "v0_7_additional_token_claims" USING btree ("launch_addr");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_7_funding_approvals_launch_index" ON "v0_7_funding_approvals" USING btree ("launch_addr");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_7_funding_approvals_funder_index" ON "v0_7_funding_approvals" USING btree ("funder_addr");