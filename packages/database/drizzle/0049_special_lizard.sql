ALTER TABLE "launch_details" ADD COLUMN IF NOT EXISTS "organization_id" bigint;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "launch_details" ADD CONSTRAINT "launch_details_organization_id_organizations_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("organization_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
