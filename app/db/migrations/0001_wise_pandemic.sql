CREATE TYPE "public"."school_kind" AS ENUM('school', 'headquarters');--> statement-breakpoint
ALTER TABLE "jamf_instance_school_bindings" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "jamf_instance_school_bindings" CASCADE;--> statement-breakpoint
ALTER TABLE "mdm_devices" ADD COLUMN "jamf_device_id" varchar(32);--> statement-breakpoint
ALTER TABLE "mdm_devices" ADD COLUMN "jamf_management_id" varchar(64);--> statement-breakpoint
ALTER TABLE "mdm_devices" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN "kind" "school_kind" DEFAULT 'school' NOT NULL;--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN "jamf_instance_id" uuid;--> statement-breakpoint
ALTER TABLE "schools" ADD CONSTRAINT "schools_jamf_instance_id_jamf_instances_id_fk" FOREIGN KEY ("jamf_instance_id") REFERENCES "public"."jamf_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mdm_devices_jamf_instance_device_id_uq" ON "mdm_devices" USING btree ("jamf_instance_id","jamf_device_id") WHERE "mdm_devices"."jamf_device_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "schools_tenant_idx" ON "schools" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "schools_tenant_code_uq" ON "schools" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "schools_jamf_instance_uq" ON "schools" USING btree ("jamf_instance_id") WHERE "schools"."jamf_instance_id" IS NOT NULL;