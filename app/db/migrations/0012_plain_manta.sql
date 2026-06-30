ALTER TYPE "public"."app_kind" ADD VALUE 'winget' BEFORE 'ipa_custom';--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "winget_id" varchar(256);--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "winget_source" varchar(64);--> statement-breakpoint
CREATE INDEX "apps_winget_id_idx" ON "apps" USING btree ("winget_id");--> statement-breakpoint
CREATE UNIQUE INDEX "apps_tenant_winget_id_uq" ON "apps" USING btree ("tenant_id","winget_id") WHERE "apps"."winget_id" IS NOT NULL;