CREATE TABLE IF NOT EXISTS "v0_6_amm_positions" (
	"amm_position_addr" varchar(44) PRIMARY KEY NOT NULL,
	"dao_addr" varchar(44) NOT NULL,
	"position_authority" varchar(44) NOT NULL,
	"liquidity" numeric(40, 0) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at_slot" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v0_6_liquidity_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"amm_position_addr" varchar(44) NOT NULL,
	"dao_addr" varchar(44) NOT NULL,
	"tx_signature" varchar(88) NOT NULL,
	"event_type" varchar(20) NOT NULL,
	"base_amount" bigint NOT NULL,
	"quote_amount" bigint NOT NULL,
	"liquidity_delta" numeric(40, 0) NOT NULL,
	"slot" bigint NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "v0_6_liquidity_events_tx_signature_unique" UNIQUE("tx_signature")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v0_6_performance_package_unlocks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"performance_package_addr" varchar(44) NOT NULL,
	"tx_signature" varchar(88) NOT NULL,
	"token_amount" bigint NOT NULL,
	"recipient" varchar(44) NOT NULL,
	"twap_price" numeric(40, 0) NOT NULL,
	"slot" bigint NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "v0_6_pp_unlocks_tx_signature_unique" UNIQUE("tx_signature")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v0_6_performance_packages" (
	"performance_package_addr" varchar(44) PRIMARY KEY NOT NULL,
	"launch_addr" varchar(44),
	"dao_addr" varchar(44),
	"recipient" varchar(44) NOT NULL,
	"token_mint" varchar(44) NOT NULL,
	"performance_package_authority" varchar(44) NOT NULL,
	"performance_package_token_vault" varchar(44) NOT NULL,
	"total_token_amount" bigint NOT NULL,
	"already_unlocked_amount" bigint NOT NULL,
	"min_unlock_timestamp" bigint NOT NULL,
	"twap_length_seconds" integer NOT NULL,
	"state" varchar(20) NOT NULL,
	"tranches" jsonb NOT NULL,
	"seq_num" bigint NOT NULL,
	"pda_bump" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at_slot" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v0_7_bid_wall_fee_collections" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"bid_wall_addr" varchar(44) NOT NULL,
	"tx_signature" varchar(88) NOT NULL,
	"fees_collected" bigint NOT NULL,
	"slot" bigint NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "v0_7_bid_wall_fee_collections_tx_signature_unique" UNIQUE("tx_signature")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v0_7_bid_wall_sales" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"bid_wall_addr" varchar(44) NOT NULL,
	"tx_signature" varchar(88) NOT NULL,
	"user" varchar(44) NOT NULL,
	"amount_in" bigint NOT NULL,
	"amount_out" bigint NOT NULL,
	"fee" bigint NOT NULL,
	"slot" bigint NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "v0_7_bid_wall_sales_tx_signature_unique" UNIQUE("tx_signature")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v0_7_bid_walls" (
	"bid_wall_addr" varchar(44) PRIMARY KEY NOT NULL,
	"nonce" bigint NOT NULL,
	"created_timestamp" bigint NOT NULL,
	"initial_amm_quote_reserves" bigint NOT NULL,
	"quote_amount" bigint NOT NULL,
	"fees_collected" bigint NOT NULL,
	"base_bought_amount" bigint NOT NULL,
	"seq_num" bigint NOT NULL,
	"creator" varchar(44) NOT NULL,
	"authority" varchar(44) NOT NULL,
	"dao_treasury" varchar(44) NOT NULL,
	"base_mint" varchar(44) NOT NULL,
	"fee_recipient" varchar(44) NOT NULL,
	"duration_seconds" integer NOT NULL,
	"pda_bump" smallint NOT NULL,
	"is_closed" boolean DEFAULT false NOT NULL,
	"is_canceled" boolean DEFAULT false NOT NULL,
	"updated_at_slot" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "v0_6_fee_collections_signature_index";--> statement-breakpoint
ALTER TABLE "v0_6_daos" ADD COLUMN "team_sponsored_pass_threshold_bps" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "v0_6_daos" ADD COLUMN "team_address" varchar(44) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "v0_6_proposals" ADD COLUMN "is_team_sponsored" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "v0_7_launches" ADD COLUMN "unix_timestamp_completed" bigint;--> statement-breakpoint
ALTER TABLE "v0_7_launches" ADD COLUMN "is_performance_package_initialized" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_amm_positions" ADD CONSTRAINT "v0_6_amm_positions_dao_addr_v0_6_daos_dao_addr_fk" FOREIGN KEY ("dao_addr") REFERENCES "public"."v0_6_daos"("dao_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_liquidity_events" ADD CONSTRAINT "v0_6_liquidity_events_amm_position_addr_v0_6_amm_positions_amm_position_addr_fk" FOREIGN KEY ("amm_position_addr") REFERENCES "public"."v0_6_amm_positions"("amm_position_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_liquidity_events" ADD CONSTRAINT "v0_6_liquidity_events_dao_addr_v0_6_daos_dao_addr_fk" FOREIGN KEY ("dao_addr") REFERENCES "public"."v0_6_daos"("dao_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_performance_package_unlocks" ADD CONSTRAINT "v0_6_performance_package_unlocks_performance_package_addr_v0_6_performance_packages_performance_package_addr_fk" FOREIGN KEY ("performance_package_addr") REFERENCES "public"."v0_6_performance_packages"("performance_package_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_performance_packages" ADD CONSTRAINT "v0_6_performance_packages_token_mint_tokens_mint_acct_fk" FOREIGN KEY ("token_mint") REFERENCES "public"."tokens"("mint_acct") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_7_bid_wall_fee_collections" ADD CONSTRAINT "v0_7_bid_wall_fee_collections_bid_wall_addr_v0_7_bid_walls_bid_wall_addr_fk" FOREIGN KEY ("bid_wall_addr") REFERENCES "public"."v0_7_bid_walls"("bid_wall_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_7_bid_wall_sales" ADD CONSTRAINT "v0_7_bid_wall_sales_bid_wall_addr_v0_7_bid_walls_bid_wall_addr_fk" FOREIGN KEY ("bid_wall_addr") REFERENCES "public"."v0_7_bid_walls"("bid_wall_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_7_bid_walls" ADD CONSTRAINT "v0_7_bid_walls_base_mint_tokens_mint_acct_fk" FOREIGN KEY ("base_mint") REFERENCES "public"."tokens"("mint_acct") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_6_amm_positions_dao_index" ON "v0_6_amm_positions" USING btree ("dao_addr");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_6_amm_positions_authority_index" ON "v0_6_amm_positions" USING btree ("position_authority");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_6_liquidity_events_position_index" ON "v0_6_liquidity_events" USING btree ("amm_position_addr");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_6_liquidity_events_dao_index" ON "v0_6_liquidity_events" USING btree ("dao_addr");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_6_pp_unlocks_package_index" ON "v0_6_performance_package_unlocks" USING btree ("performance_package_addr");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_6_performance_packages_recipient_index" ON "v0_6_performance_packages" USING btree ("recipient");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_6_performance_packages_token_mint_index" ON "v0_6_performance_packages" USING btree ("token_mint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_7_bid_wall_fee_collections_bid_wall_index" ON "v0_7_bid_wall_fee_collections" USING btree ("bid_wall_addr");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_7_bid_wall_sales_bid_wall_index" ON "v0_7_bid_wall_sales" USING btree ("bid_wall_addr");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_7_bid_wall_sales_user_index" ON "v0_7_bid_wall_sales" USING btree ("user");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_7_bid_walls_creator_index" ON "v0_7_bid_walls" USING btree ("creator");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v0_7_bid_walls_base_mint_index" ON "v0_7_bid_walls" USING btree ("base_mint");--> statement-breakpoint
ALTER TABLE "v0_6_fee_collections" ADD CONSTRAINT "v0_6_fee_collections_signature_unique" UNIQUE("signature");