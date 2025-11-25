ALTER TABLE "draft_projects" RENAME COLUMN "founder_acct" TO "founder_sol_acct";--> statement-breakpoint
ALTER TABLE "draft_projects" ADD COLUMN "founder_email" varchar(127);--> statement-breakpoint
ALTER TABLE "draft_projects" ADD COLUMN "founder_eth_acct" varchar(44);--> statement-breakpoint
ALTER TABLE "draft_projects" ADD COLUMN "metalex_status" varchar;