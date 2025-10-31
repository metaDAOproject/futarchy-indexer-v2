CREATE TABLE IF NOT EXISTS "futarchy_markets" (
	"dao_addr" varchar(44) NOT NULL,
	"proposal_addr" varchar(44),
	"market_type" varchar NOT NULL,
	"base_mint" varchar(44) NOT NULL,
	"quote_mint" varchar(44) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "futarchy_markets_dao_addr_proposal_addr_market_type_pk" PRIMARY KEY("dao_addr","proposal_addr","market_type")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "futarchy_prices" (
	"dao_addr" varchar(44) NOT NULL,
	"proposal_addr" varchar(44),
	"market_type" varchar NOT NULL,
	"slot" numeric NOT NULL,
	"base_reserves" numeric NOT NULL,
	"quote_reserves" numeric NOT NULL,
	"price" numeric(40, 20) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "futarchy_prices_dao_addr_proposal_addr_market_type_slot_pk" PRIMARY KEY("dao_addr","proposal_addr","market_type","slot")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "futarchy_twaps" (
	"dao_addr" varchar(44) NOT NULL,
	"proposal_addr" varchar(44),
	"market_type" varchar NOT NULL,
	"slot" numeric NOT NULL,
	"aggregator" numeric(40, 0) NOT NULL,
	"last_observation" numeric(40, 0) NOT NULL,
	"last_price" numeric(40, 0) NOT NULL,
	"twap_value" numeric(40, 20) NOT NULL,
	"time_elapsed_seconds" numeric NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "futarchy_twaps_dao_addr_proposal_addr_market_type_slot_pk" PRIMARY KEY("dao_addr","proposal_addr","market_type","slot")
);
--> statement-breakpoint
ALTER TABLE "v0_6_proposals" ADD COLUMN "launched_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "futarchy_markets" ADD CONSTRAINT "futarchy_markets_dao_addr_v0_6_daos_dao_addr_fk" FOREIGN KEY ("dao_addr") REFERENCES "public"."v0_6_daos"("dao_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "futarchy_markets" ADD CONSTRAINT "futarchy_markets_proposal_addr_v0_6_proposals_proposal_addr_fk" FOREIGN KEY ("proposal_addr") REFERENCES "public"."v0_6_proposals"("proposal_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "futarchy_markets" ADD CONSTRAINT "futarchy_markets_base_mint_tokens_mint_acct_fk" FOREIGN KEY ("base_mint") REFERENCES "public"."tokens"("mint_acct") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "futarchy_markets" ADD CONSTRAINT "futarchy_markets_quote_mint_tokens_mint_acct_fk" FOREIGN KEY ("quote_mint") REFERENCES "public"."tokens"("mint_acct") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "futarchy_prices" ADD CONSTRAINT "futarchy_prices_dao_addr_v0_6_daos_dao_addr_fk" FOREIGN KEY ("dao_addr") REFERENCES "public"."v0_6_daos"("dao_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "futarchy_prices" ADD CONSTRAINT "futarchy_prices_proposal_addr_v0_6_proposals_proposal_addr_fk" FOREIGN KEY ("proposal_addr") REFERENCES "public"."v0_6_proposals"("proposal_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "futarchy_twaps" ADD CONSTRAINT "futarchy_twaps_dao_addr_v0_6_daos_dao_addr_fk" FOREIGN KEY ("dao_addr") REFERENCES "public"."v0_6_daos"("dao_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "futarchy_twaps" ADD CONSTRAINT "futarchy_twaps_proposal_addr_v0_6_proposals_proposal_addr_fk" FOREIGN KEY ("proposal_addr") REFERENCES "public"."v0_6_proposals"("proposal_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "v0_6_launches" DROP COLUMN IF EXISTS "squads_multisig";