DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'v0_6_funds' 
                 AND column_name = 'tx_signature') THEN
    ALTER TABLE "v0_6_funds" ADD COLUMN "tx_signature" TEXT;
  END IF;
END $$;
--> statement-breakpoint

-- Then your existing migrations
ALTER TABLE "v0_6_daos" ALTER COLUMN "min_quote_futarchic_liquidity" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "v0_6_daos" ALTER COLUMN "min_base_futarchic_liquidity" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "v0_6_daos" ALTER COLUMN "base_to_stake" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "v0_6_daos" ALTER COLUMN "amm_base_amount" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "v0_6_daos" ALTER COLUMN "amm_quote_amount" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "v0_6_merges" ALTER COLUMN "slot" SET DATA TYPE numeric;--> statement-breakpoint
ALTER TABLE "v0_6_merges" ALTER COLUMN "amount" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "v0_6_merges" ALTER COLUMN "post_user_underlying_balance" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "v0_6_merges" ALTER COLUMN "post_vault_underlying_balance" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "v0_6_questions" ALTER COLUMN "question_id" SET DATA TYPE jsonb USING question_id::jsonb;--> statement-breakpoint
ALTER TABLE "v0_6_questions" ALTER COLUMN "payout_denominator" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "v0_6_splits" ALTER COLUMN "amount" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "v0_6_splits" ALTER COLUMN "post_user_underlying_balance" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "v0_6_splits" ALTER COLUMN "post_vault_underlying_balance" SET DATA TYPE bigint;--> statement-breakpoint

-- Now the foreign key should work
DO $$ BEGIN
 ALTER TABLE "v0_6_funds" ADD CONSTRAINT "v0_6_funds_tx_signature_signatures_signature_fk" FOREIGN KEY ("tx_signature") REFERENCES "public"."signatures"("signature") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "v0_6_proposals_question_index" ON "v0_6_proposals" USING btree ("question_addr");