ALTER TABLE "draft_projects" RENAME COLUMN "project_image_url" TO "project_icon_image_url";--> statement-breakpoint
ALTER TABLE "draft_projects" ADD COLUMN "project_header_image_url" varchar(1023);