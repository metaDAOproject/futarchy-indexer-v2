CREATE TABLE IF NOT EXISTS "v0_6_claims" (
	"funding_record_addr" varchar(44) PRIMARY KEY NOT NULL,
	"launch_addr" varchar(44) NOT NULL,
	"funder_addr" varchar(44) NOT NULL,
	"tokens_claimed" numeric(20, 0) NOT NULL,
	"slot" bigint NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v0_6_conditional_swaps" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"signature" varchar(88) NOT NULL,
	"slot" bigint NOT NULL,
	"unix_timestamp" bigint NOT NULL,
	"dao_addr" varchar(44) NOT NULL,
	"proposal_addr" varchar(44) NOT NULL,
	"user_addr" varchar(44) NOT NULL,
	"market" varchar(4) NOT NULL,
	"swap_type" varchar NOT NULL,
	"input_amount" numeric NOT NULL,
	"output_amount" numeric NOT NULL,
	"min_output_amount" numeric NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v0_6_daos" (
	"dao_addr" varchar(44) PRIMARY KEY NOT NULL,
	"amm_addr" varchar(44) NOT NULL,
	"nonce" bigint NOT NULL,
	"dao_creator" varchar(44) NOT NULL,
	"pda_bump" smallint NOT NULL,
	"squads_multisig" varchar(44) NOT NULL,
	"squads_multisig_vault" varchar(44) NOT NULL,
	"base_mint_acct" varchar(44) NOT NULL,
	"quote_mint_acct" varchar(44) NOT NULL,
	"proposal_count" integer NOT NULL,
	"pass_threshold_bps" smallint NOT NULL,
	"seconds_per_proposal" integer NOT NULL,
	"twap_initial_observation" numeric(39, 0) NOT NULL,
	"twap_max_observation_change_per_update" numeric(39, 0) NOT NULL,
	"twap_start_delay_seconds" integer NOT NULL,
	"min_quote_futarchic_liquidity" numeric NOT NULL,
	"min_base_futarchic_liquidity" numeric NOT NULL,
	"base_to_stake" numeric NOT NULL,
	"seq_num" bigint NOT NULL,
	"initial_spending_limit" jsonb,
	"amm_lp_mint" varchar(44) NOT NULL,
	"amm_base_amount" numeric NOT NULL,
	"amm_quote_amount" numeric NOT NULL,
	"amm_oracle" varchar(44) NOT NULL,
	"amm_seq_num" bigint NOT NULL,
	"amm_vault_ata_base" varchar(44) NOT NULL,
	"amm_vault_ata_quote" varchar(44) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v0_6_funding_records" (
	"funding_record_addr" varchar(44) PRIMARY KEY NOT NULL,
	"launch_addr" varchar(44) NOT NULL,
	"funder_addr" varchar(44) NOT NULL,
	"committed_amount" bigint NOT NULL,
	"seq_num" bigint NOT NULL,
	"is_tokens_claimed" boolean DEFAULT false NOT NULL,
	"is_usdc_refunded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at_slot" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v0_6_funds" (
	"funding_record_addr" varchar(44) NOT NULL,
	"launch_addr" varchar(44) NOT NULL,
	"funder_addr" varchar(44) NOT NULL,
	"slot" bigint NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"quote_amount" numeric(20, 0) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "v0_6_funds_funding_record_addr_pk" PRIMARY KEY("funding_record_addr")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v0_6_launches" (
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
	"final_raise_amount" bigint,
	"state" varchar NOT NULL,
	"seq_num" bigint NOT NULL,
	"seconds_for_launch" integer NOT NULL,
	"dao_addr" varchar(44),
	"dao_vault" varchar(44),
	"squads_multisig" varchar(44),
	"performance_package_grantee" varchar(44) NOT NULL,
	"performance_package_token_amount" bigint NOT NULL,
	"months_until_insiders_can_unlock" smallint NOT NULL,
	"pda_bump" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at_slot" bigint DEFAULT 0 NOT NULL,
	"is_hidden" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v0_6_merges" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"signature" varchar(88) NOT NULL,
	"slot" bigint NOT NULL,
	"unix_timestamp" bigint NOT NULL,
	"user_addr" varchar(44) NOT NULL,
	"vault_addr" varchar(44) NOT NULL,
	"amount" numeric NOT NULL,
	"post_user_underlying_balance" numeric NOT NULL,
	"post_vault_underlying_balance" numeric NOT NULL,
	"post_user_conditional_token_balances" jsonb NOT NULL,
	"post_conditional_token_supplies" jsonb NOT NULL,
	"seq_num" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v0_6_proposals" (
	"proposal_addr" varchar(44) PRIMARY KEY NOT NULL,
	"number" integer NOT NULL,
	"proposer" varchar(44) NOT NULL,
	"timestamp_enqueued" bigint NOT NULL,
	"state" varchar NOT NULL,
	"base_vault" varchar(44) NOT NULL,
	"quote_vault" varchar(44) NOT NULL,
	"dao_addr" varchar(44) NOT NULL,
	"pda_bump" smallint NOT NULL,
	"question" varchar(44) NOT NULL,
	"duration_in_seconds" integer NOT NULL,
	"squads_proposal" varchar(44) NOT NULL,
	"pass_base_mint" varchar(44) NOT NULL,
	"pass_quote_mint" varchar(44) NOT NULL,
	"fail_base_mint" varchar(44) NOT NULL,
	"fail_quote_mint" varchar(44) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v0_6_questions" (
	"question_addr" varchar(44) PRIMARY KEY NOT NULL,
	"question_id" text NOT NULL,
	"oracle" varchar(44) NOT NULL,
	"payout_numerators" jsonb NOT NULL,
	"payout_denominator" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v0_6_refunds" (
	"funding_record_addr" varchar(44) PRIMARY KEY NOT NULL,
	"launch_addr" varchar(44) NOT NULL,
	"funder_addr" varchar(44) NOT NULL,
	"slot" bigint NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"quote_amount" numeric(20, 0) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v0_6_splits" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"signature" varchar(88) NOT NULL,
	"slot" bigint NOT NULL,
	"unix_timestamp" bigint NOT NULL,
	"user_addr" varchar(44) NOT NULL,
	"vault_addr" varchar(44) NOT NULL,
	"amount" numeric NOT NULL,
	"post_user_underlying_balance" numeric NOT NULL,
	"post_vault_underlying_balance" numeric NOT NULL,
	"post_user_conditional_token_balances" jsonb NOT NULL,
	"post_conditional_token_supplies" jsonb NOT NULL,
	"seq_num" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v0_6_spot_swaps" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"signature" varchar(88) NOT NULL,
	"slot" bigint NOT NULL,
	"unix_timestamp" bigint NOT NULL,
	"dao_addr" varchar(44) NOT NULL,
	"user_addr" varchar(44) NOT NULL,
	"swap_type" varchar NOT NULL,
	"input_amount" numeric NOT NULL,
	"output_amount" numeric NOT NULL,
	"min_output_amount" numeric NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "launch_details" ADD COLUMN IF NOT EXISTS "is_featured" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "launch_details" ADD COLUMN IF NOT EXISTS "is_permissionless" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "v0_6_daos" ADD COLUMN IF NOT EXISTS "base_mint_acct" varchar(44);
ALTER TABLE "v0_6_daos" ADD COLUMN IF NOT EXISTS "quote_mint_acct" varchar(44); 
ALTER TABLE "v0_6_daos" ADD COLUMN IF NOT EXISTS "organization_id" bigint;
ALTER TABLE "v0_6_daos" DROP CONSTRAINT IF EXISTS "v0_6_daos_base_mint_tokens_mint_acct_fk";
ALTER TABLE "v0_6_daos" DROP CONSTRAINT IF EXISTS "v0_6_daos_quote_mint_tokens_mint_acct_fk";
ALTER TABLE "v0_6_launches" ADD COLUMN IF NOT EXISTS "dao_addr" varchar(44);
ALTER TABLE "v0_6_proposals" ADD COLUMN IF NOT EXISTS "base_vault_addr" varchar(44);
ALTER TABLE "v0_6_proposals" DROP COLUMN "base_vault";
ALTER TABLE "v0_6_proposals" ADD COLUMN IF NOT EXISTS "quote_vault_addr" varchar(44);
ALTER TABLE "v0_6_proposals" DROP COLUMN "quote_vault";
ALTER TABLE "v0_6_proposals" ADD COLUMN IF NOT EXISTS "question_addr" varchar(44);
ALTER TABLE "v0_6_proposals" DROP COLUMN "question";

DO $$ BEGIN
 ALTER TABLE "v0_6_claims" ADD CONSTRAINT "v0_6_claims_funding_record_addr_v0_6_funding_records_funding_record_addr_fk" FOREIGN KEY ("funding_record_addr") REFERENCES "public"."v0_6_funding_records"("funding_record_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_claims" ADD CONSTRAINT "v0_6_claims_launch_addr_v0_6_launches_launch_addr_fk" FOREIGN KEY ("launch_addr") REFERENCES "public"."v0_6_launches"("launch_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_conditional_swaps" ADD CONSTRAINT "v0_6_conditional_swaps_signature_signatures_signature_fk" FOREIGN KEY ("signature") REFERENCES "public"."signatures"("signature") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_conditional_swaps" ADD CONSTRAINT "v0_6_conditional_swaps_dao_addr_v0_6_daos_dao_addr_fk" FOREIGN KEY ("dao_addr") REFERENCES "public"."v0_6_daos"("dao_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_conditional_swaps" ADD CONSTRAINT "v0_6_conditional_swaps_proposal_addr_v0_6_proposals_proposal_addr_fk" FOREIGN KEY ("proposal_addr") REFERENCES "public"."v0_6_proposals"("proposal_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_daos" ADD CONSTRAINT "v0_6_daos_base_mint_acct_tokens_mint_acct_fk" FOREIGN KEY ("base_mint_acct") REFERENCES "public"."tokens"("mint_acct") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_daos" ADD CONSTRAINT "v0_6_daos_quote_mint_acct_tokens_mint_acct_fk" FOREIGN KEY ("quote_mint_acct") REFERENCES "public"."tokens"("mint_acct") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_daos" ADD CONSTRAINT "v0_6_daos_amm_lp_mint_tokens_mint_acct_fk" FOREIGN KEY ("amm_lp_mint") REFERENCES "public"."tokens"("mint_acct") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_daos" ADD CONSTRAINT "v0_6_daos_organization_id_organizations_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("organization_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_funding_records" ADD CONSTRAINT "v0_6_funding_records_launch_addr_v0_6_launches_launch_addr_fk" FOREIGN KEY ("launch_addr") REFERENCES "public"."v0_6_launches"("launch_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_funds" ADD CONSTRAINT "v0_6_funds_funding_record_addr_v0_6_funding_records_funding_record_addr_fk" FOREIGN KEY ("funding_record_addr") REFERENCES "public"."v0_6_funding_records"("funding_record_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_funds" ADD CONSTRAINT "v0_6_funds_launch_addr_v0_6_launches_launch_addr_fk" FOREIGN KEY ("launch_addr") REFERENCES "public"."v0_6_launches"("launch_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_launches" ADD CONSTRAINT "v0_6_launches_base_mint_acct_tokens_mint_acct_fk" FOREIGN KEY ("base_mint_acct") REFERENCES "public"."tokens"("mint_acct") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_launches" ADD CONSTRAINT "v0_6_launches_quote_mint_acct_tokens_mint_acct_fk" FOREIGN KEY ("quote_mint_acct") REFERENCES "public"."tokens"("mint_acct") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_merges" ADD CONSTRAINT "v0_6_merges_signature_signatures_signature_fk" FOREIGN KEY ("signature") REFERENCES "public"."signatures"("signature") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_proposals" ADD CONSTRAINT "v0_6_proposals_dao_addr_v0_6_daos_dao_addr_fk" FOREIGN KEY ("dao_addr") REFERENCES "public"."v0_6_daos"("dao_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_proposals" ADD CONSTRAINT "v0_6_proposals_pass_base_mint_tokens_mint_acct_fk" FOREIGN KEY ("pass_base_mint") REFERENCES "public"."tokens"("mint_acct") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_proposals" ADD CONSTRAINT "v0_6_proposals_pass_quote_mint_tokens_mint_acct_fk" FOREIGN KEY ("pass_quote_mint") REFERENCES "public"."tokens"("mint_acct") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_proposals" ADD CONSTRAINT "v0_6_proposals_fail_base_mint_tokens_mint_acct_fk" FOREIGN KEY ("fail_base_mint") REFERENCES "public"."tokens"("mint_acct") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_proposals" ADD CONSTRAINT "v0_6_proposals_fail_quote_mint_tokens_mint_acct_fk" FOREIGN KEY ("fail_quote_mint") REFERENCES "public"."tokens"("mint_acct") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_refunds" ADD CONSTRAINT "v0_6_refunds_funding_record_addr_v0_6_funding_records_funding_record_addr_fk" FOREIGN KEY ("funding_record_addr") REFERENCES "public"."v0_6_funding_records"("funding_record_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_refunds" ADD CONSTRAINT "v0_6_refunds_launch_addr_v0_6_launches_launch_addr_fk" FOREIGN KEY ("launch_addr") REFERENCES "public"."v0_6_launches"("launch_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_splits" ADD CONSTRAINT "v0_6_splits_signature_signatures_signature_fk" FOREIGN KEY ("signature") REFERENCES "public"."signatures"("signature") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_spot_swaps" ADD CONSTRAINT "v0_6_spot_swaps_signature_signatures_signature_fk" FOREIGN KEY ("signature") REFERENCES "public"."signatures"("signature") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_spot_swaps" ADD CONSTRAINT "v0_6_spot_swaps_dao_addr_v0_6_daos_dao_addr_fk" FOREIGN KEY ("dao_addr") REFERENCES "public"."v0_6_daos"("dao_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_6_conditional_swaps_dao_index" ON "v0_6_conditional_swaps" USING btree ("dao_addr");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_6_conditional_swaps_proposal_index" ON "v0_6_conditional_swaps" USING btree ("proposal_addr");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_6_conditional_swaps_user_index" ON "v0_6_conditional_swaps" USING btree ("user_addr");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_6_conditional_swaps_signature_index" ON "v0_6_conditional_swaps" USING btree ("signature");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_6_merges_vault_index" ON "v0_6_merges" USING btree ("vault_addr");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_6_merges_user_index" ON "v0_6_merges" USING btree ("user_addr");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_6_merges_signature_index" ON "v0_6_merges" USING btree ("signature");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_6_proposals_dao_index" ON "v0_6_proposals" USING btree ("dao_addr");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_6_proposals_proposer_index" ON "v0_6_proposals" USING btree ("proposer");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_6_proposals_question_index" ON "v0_6_proposals" USING btree ("question");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_6_splits_vault_index" ON "v0_6_splits" USING btree ("vault_addr");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_6_splits_user_index" ON "v0_6_splits" USING btree ("user_addr");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_6_splits_signature_index" ON "v0_6_splits" USING btree ("signature");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_6_spot_swaps_dao_index" ON "v0_6_spot_swaps" USING btree ("dao_addr");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_6_spot_swaps_user_index" ON "v0_6_spot_swaps" USING btree ("user_addr");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_6_spot_swaps_signature_index" ON "v0_6_spot_swaps" USING btree ("signature");