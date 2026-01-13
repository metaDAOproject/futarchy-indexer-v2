ALTER TABLE "proposal_details" ADD COLUMN "transaction_index" bigint;--> statement-breakpoint
ALTER TABLE "proposal_details" ADD COLUMN "is_hidden" boolean DEFAULT false NOT NULL;