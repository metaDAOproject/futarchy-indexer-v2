ALTER TABLE "launch_details" ADD COLUMN "terms_url" text;--> statement-breakpoint
ALTER TABLE "launch_details" ADD COLUMN "investors" jsonb;--> statement-breakpoint
ALTER TABLE "launch_details" ADD COLUMN "is_light" boolean;