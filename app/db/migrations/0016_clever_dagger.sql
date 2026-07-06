CREATE TYPE "public"."kiosk_app_type" AS ENUM('edge_kiosk', 'uwp');--> statement-breakpoint
CREATE TYPE "public"."kiosk_assignment_scope" AS ENUM('device_group', 'device');--> statement-breakpoint
CREATE TYPE "public"."kiosk_edge_variant" AS ENUM('public_browsing', 'digital_signage');--> statement-breakpoint
CREATE TYPE "public"."kiosk_state_status" AS ENUM('pending', 'active', 'failed', 'removed');--> statement-breakpoint
CREATE TABLE "kiosk_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"scope" "kiosk_assignment_scope" NOT NULL,
	"device_group_id" uuid,
	"device_id" uuid,
	"created_by" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kiosk_device_states" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"profile_id" uuid,
	"status" "kiosk_state_status" DEFAULT 'pending' NOT NULL,
	"applied_version" integer,
	"last_command_id" uuid,
	"error_detail" text,
	"deployed_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kiosk_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"description" text,
	"app_type" "kiosk_app_type" NOT NULL,
	"edge_url" varchar(2048),
	"edge_variant" "kiosk_edge_variant",
	"aumid" text,
	"auto_logon_account" varchar(64) DEFAULT 'student' NOT NULL,
	"breakout_sequence" varchar(64),
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kiosk_assignments" ADD CONSTRAINT "kiosk_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_assignments" ADD CONSTRAINT "kiosk_assignments_profile_id_kiosk_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."kiosk_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_assignments" ADD CONSTRAINT "kiosk_assignments_device_group_id_device_groups_id_fk" FOREIGN KEY ("device_group_id") REFERENCES "public"."device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_assignments" ADD CONSTRAINT "kiosk_assignments_device_id_mdm_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."mdm_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_device_states" ADD CONSTRAINT "kiosk_device_states_device_id_mdm_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."mdm_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_device_states" ADD CONSTRAINT "kiosk_device_states_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_device_states" ADD CONSTRAINT "kiosk_device_states_profile_id_kiosk_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."kiosk_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_profiles" ADD CONSTRAINT "kiosk_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kiosk_assignments_profile_idx" ON "kiosk_assignments" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "kiosk_assignments_device_group_idx" ON "kiosk_assignments" USING btree ("device_group_id");--> statement-breakpoint
CREATE INDEX "kiosk_assignments_device_idx" ON "kiosk_assignments" USING btree ("device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kiosk_assignments_profile_group_uq" ON "kiosk_assignments" USING btree ("profile_id","device_group_id") WHERE "kiosk_assignments"."scope" = 'device_group' AND "kiosk_assignments"."device_group_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "kiosk_assignments_profile_device_uq" ON "kiosk_assignments" USING btree ("profile_id","device_id") WHERE "kiosk_assignments"."scope" = 'device' AND "kiosk_assignments"."device_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "kiosk_device_states_tenant_idx" ON "kiosk_device_states" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "kiosk_device_states_status_idx" ON "kiosk_device_states" USING btree ("status");--> statement-breakpoint
CREATE INDEX "kiosk_profiles_tenant_idx" ON "kiosk_profiles" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kiosk_profiles_tenant_name_uq" ON "kiosk_profiles" USING btree ("tenant_id","name");--> statement-breakpoint
ALTER TABLE "kiosk_profiles" ADD CONSTRAINT "kiosk_profiles_app_type_fields_ck" CHECK (
  (app_type = 'edge_kiosk' AND edge_url IS NOT NULL AND edge_variant IS NOT NULL AND aumid IS NULL)
  OR
  (app_type = 'uwp' AND aumid IS NOT NULL AND edge_url IS NULL AND edge_variant IS NULL)
);--> statement-breakpoint
ALTER TABLE "kiosk_assignments" ADD CONSTRAINT "kiosk_assignments_scope_target_ck" CHECK (
  (scope = 'device_group' AND device_group_id IS NOT NULL AND device_id IS NULL)
  OR
  (scope = 'device' AND device_id IS NOT NULL AND device_group_id IS NULL)
);