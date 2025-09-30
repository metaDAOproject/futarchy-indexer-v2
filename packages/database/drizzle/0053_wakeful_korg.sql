ALTER TABLE "v0_6_daos" DROP CONSTRAINT "v0_6_daos_amm_lp_mint_tokens_mint_acct_fk";
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "founded_by" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "founder_url" varchar;--> statement-breakpoint
ALTER TABLE "v0_6_daos" DROP COLUMN IF EXISTS "amm_lp_mint";--> statement-breakpoint
ALTER TABLE "v0_6_daos" DROP COLUMN IF EXISTS "amm_oracle";--> statement-breakpoint
ALTER TABLE "v0_6_daos" DROP COLUMN IF EXISTS "amm_seq_num";