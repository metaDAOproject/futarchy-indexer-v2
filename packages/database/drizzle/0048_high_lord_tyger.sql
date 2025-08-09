ALTER TABLE "v0_1_conversions" RENAME TO "v0_1_migrations";--> statement-breakpoint
ALTER TABLE "v0_1_converters" RENAME TO "v0_1_migrators";--> statement-breakpoint
ALTER TABLE "v0_1_migrations" RENAME COLUMN "converter_address" TO "migrator_address";--> statement-breakpoint
ALTER TABLE "v0_1_migrators" RENAME COLUMN "converter_address" TO "migrator_address";--> statement-breakpoint
ALTER TABLE "v0_1_migrations" DROP CONSTRAINT "v0_1_conversions_signature_signatures_signature_fk";
--> statement-breakpoint
ALTER TABLE "v0_1_migrations" DROP CONSTRAINT "v0_1_conversions_converter_address_v0_1_converters_converter_address_fk";
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_1_migrations" ADD CONSTRAINT "v0_1_migrations_signature_signatures_signature_fk" FOREIGN KEY ("signature") REFERENCES "public"."signatures"("signature") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "v0_1_migrations" ADD CONSTRAINT "v0_1_migrations_migrator_address_v0_1_migrators_migrator_address_fk" FOREIGN KEY ("migrator_address") REFERENCES "public"."v0_1_migrators"("migrator_address") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "v0_1_migrators" DROP COLUMN IF EXISTS "vault_address";