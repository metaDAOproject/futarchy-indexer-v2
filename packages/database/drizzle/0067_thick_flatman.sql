CREATE TABLE IF NOT EXISTS "address_risk_assessment_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" varchar(44) NOT NULL,
	"risk" text,
	"address_type" text,
	"cluster" text,
	"risk_reason" text,
	"status" text,
	"address_identifications" jsonb,
	"exposures" jsonb,
	"triggers" jsonb,
	"assessed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "address_risk_assessments" (
	"address" varchar(44) PRIMARY KEY NOT NULL,
	"risk" text,
	"address_type" text,
	"cluster" text,
	"risk_reason" text,
	"status" text,
	"address_identifications" jsonb,
	"exposures" jsonb,
	"triggers" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "risk_history_address_index" ON "address_risk_assessment_history" USING btree ("address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "risk_history_assessed_at_index" ON "address_risk_assessment_history" USING btree ("assessed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "address_risk_index" ON "address_risk_assessments" USING btree ("risk");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "address_type_index" ON "address_risk_assessments" USING btree ("address_type");--> statement-breakpoint
ALTER TABLE "v0_6_conditional_swaps" ADD CONSTRAINT "v0_6_conditional_swaps_signature_unique" UNIQUE("signature");--> statement-breakpoint
ALTER TABLE "v0_6_spot_swaps" ADD CONSTRAINT "v0_6_spot_swaps_signature_unique" UNIQUE("signature");