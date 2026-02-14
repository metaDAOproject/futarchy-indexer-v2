CREATE TABLE IF NOT EXISTS "v0_6_stakes" (
	"stake_addr" varchar(44) NOT NULL,
	"proposal_addr" varchar(44) NOT NULL,
	"tx_signature" varchar(88) NOT NULL,
	"staker_addr" varchar(44) NOT NULL,
	"amount" numeric,
	"slot" bigint NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "v0_6_stakes_proposal_addr_tx_signature_pk" PRIMARY KEY("proposal_addr","tx_signature")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "v0_6_staking_record" (
	"stake_addr" varchar(44) PRIMARY KEY NOT NULL,
	"proposal_addr" varchar(44) NOT NULL,
	"staker_addr" varchar(44) NOT NULL,
	"total_staked" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at_slot" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_stakes" ADD CONSTRAINT "v0_6_stakes_stake_addr_v0_6_staking_record_stake_addr_fk" FOREIGN KEY ("stake_addr") REFERENCES "public"."v0_6_staking_record"("stake_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_stakes" ADD CONSTRAINT "v0_6_stakes_proposal_addr_v0_6_proposals_proposal_addr_fk" FOREIGN KEY ("proposal_addr") REFERENCES "public"."v0_6_proposals"("proposal_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_stakes" ADD CONSTRAINT "v0_6_stakes_tx_signature_signatures_signature_fk" FOREIGN KEY ("tx_signature") REFERENCES "public"."signatures"("signature") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_6_staking_record" ADD CONSTRAINT "v0_6_staking_record_proposal_addr_v0_6_proposals_proposal_addr_fk" FOREIGN KEY ("proposal_addr") REFERENCES "public"."v0_6_proposals"("proposal_addr") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN 
	ALTER TABLE "v0_6_stakes" ADD COLUMN "type" varchar(10) NOT NULL;
END $$;