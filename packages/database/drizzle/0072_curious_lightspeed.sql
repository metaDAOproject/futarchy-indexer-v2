ALTER TABLE "dao_details" ADD COLUMN "colors" jsonb;--> statement-breakpoint
ALTER TABLE "launch_details" ADD COLUMN "is_active" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "order_id" bigserial;