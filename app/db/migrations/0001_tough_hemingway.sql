CREATE TYPE "public"."app_assignment_scope" AS ENUM('device_group', 'device');--> statement-breakpoint
CREATE TYPE "public"."app_assignment_status" AS ENUM('pending', 'installing', 'installed', 'failed', 'removed');--> statement-breakpoint
CREATE TYPE "public"."app_kind" AS ENUM('msi', 'exe', 'msix', 'ipa_custom', 'mobileconfig');--> statement-breakpoint
CREATE TYPE "public"."custom_app_authorization_status" AS ENUM('not_requested', 'pending', 'authorized', 'removed');--> statement-breakpoint
CREATE TYPE "public"."profile_assignment_scope" AS ENUM('device_group', 'device');--> statement-breakpoint
CREATE TYPE "public"."profile_assignment_status" AS ENUM('pending', 'applied', 'failed', 'removed');--> statement-breakpoint
CREATE TYPE "public"."profile_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."webhook_delivery_status" AS ENUM('pending', 'delivered', 'failed', 'dead');--> statement-breakpoint
CREATE TABLE "app_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"scope" "app_assignment_scope" NOT NULL,
	"device_group_id" uuid,
	"device_id" uuid,
	"status" "app_assignment_status" DEFAULT 'pending' NOT NULL,
	"last_command_id" uuid,
	"error_message" text,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"installed_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"platform" "device_platform" NOT NULL,
	"kind" "app_kind" NOT NULL,
	"display_name" text NOT NULL,
	"bundle_id" varchar(256),
	"version" varchar(64) NOT NULL,
	"file_url" text,
	"file_hash" varchar(128),
	"file_size_bytes" bigint,
	"signed_by" text,
	"install_args" text,
	"i_tunes_store_id" bigint,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_app_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"asm_instance_id" uuid NOT NULL,
	"status" "custom_app_authorization_status" DEFAULT 'not_requested' NOT NULL,
	"authorized_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"action" varchar(64) NOT NULL,
	"resource_type" varchar(32) NOT NULL,
	"resource_id" text,
	"payload" jsonb,
	"request_id" varchar(64),
	"ip" varchar(64),
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"scope" "profile_assignment_scope" NOT NULL,
	"device_group_id" uuid,
	"device_id" uuid,
	"status" "profile_assignment_status" DEFAULT 'pending' NOT NULL,
	"applied_version" integer,
	"last_command_id" uuid,
	"error_message" text,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"platform" "device_platform" NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"payload" jsonb NOT NULL,
	"status" "profile_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"event_id" uuid NOT NULL,
	"delivery_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "webhook_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"response_status" integer,
	"response_body" text,
	"response_headers" jsonb,
	"error_message" text,
	"last_attempt_at" timestamp with time zone,
	"next_retry_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"event_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "asm_instances" ADD COLUMN "organization_id" varchar(64);--> statement-breakpoint
ALTER TABLE "app_assignments" ADD CONSTRAINT "app_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_assignments" ADD CONSTRAINT "app_assignments_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_assignments" ADD CONSTRAINT "app_assignments_device_group_id_device_groups_id_fk" FOREIGN KEY ("device_group_id") REFERENCES "public"."device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_assignments" ADD CONSTRAINT "app_assignments_device_id_mdm_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."mdm_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_app_authorizations" ADD CONSTRAINT "custom_app_authorizations_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_app_authorizations" ADD CONSTRAINT "custom_app_authorizations_asm_instance_id_asm_instances_id_fk" FOREIGN KEY ("asm_instance_id") REFERENCES "public"."asm_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_assignments" ADD CONSTRAINT "profile_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_assignments" ADD CONSTRAINT "profile_assignments_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_assignments" ADD CONSTRAINT "profile_assignments_device_group_id_device_groups_id_fk" FOREIGN KEY ("device_group_id") REFERENCES "public"."device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_assignments" ADD CONSTRAINT "profile_assignments_device_id_mdm_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."mdm_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_assignments_app_idx" ON "app_assignments" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "app_assignments_device_group_idx" ON "app_assignments" USING btree ("device_group_id");--> statement-breakpoint
CREATE INDEX "app_assignments_device_idx" ON "app_assignments" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "app_assignments_status_idx" ON "app_assignments" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "app_assignments_app_group_uq" ON "app_assignments" USING btree ("app_id","device_group_id") WHERE "app_assignments"."scope" = 'device_group' AND "app_assignments"."device_group_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "app_assignments_app_device_uq" ON "app_assignments" USING btree ("app_id","device_id") WHERE "app_assignments"."scope" = 'device' AND "app_assignments"."device_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "apps_tenant_idx" ON "apps" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "apps_platform_kind_idx" ON "apps" USING btree ("platform","kind");--> statement-breakpoint
CREATE INDEX "apps_bundle_id_idx" ON "apps" USING btree ("bundle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "apps_tenant_bundle_version_uq" ON "apps" USING btree ("tenant_id","bundle_id","version") WHERE "apps"."bundle_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "custom_app_auth_app_idx" ON "custom_app_authorizations" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "custom_app_auth_asm_idx" ON "custom_app_authorizations" USING btree ("asm_instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_app_auth_app_asm_uq" ON "custom_app_authorizations" USING btree ("app_id","asm_instance_id");--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_time_idx" ON "audit_logs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_resource_idx" ON "audit_logs" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "profile_assignments_profile_idx" ON "profile_assignments" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "profile_assignments_device_group_idx" ON "profile_assignments" USING btree ("device_group_id");--> statement-breakpoint
CREATE INDEX "profile_assignments_device_idx" ON "profile_assignments" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "profile_assignments_status_idx" ON "profile_assignments" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_assignments_profile_group_uq" ON "profile_assignments" USING btree ("profile_id","device_group_id") WHERE "profile_assignments"."scope" = 'device_group' AND "profile_assignments"."device_group_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "profile_assignments_profile_device_uq" ON "profile_assignments" USING btree ("profile_id","device_id") WHERE "profile_assignments"."scope" = 'device' AND "profile_assignments"."device_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "profiles_tenant_idx" ON "profiles" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "profiles_platform_status_idx" ON "profiles" USING btree ("platform","status");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_endpoint_status_idx" ON "webhook_deliveries" USING btree ("endpoint_id","status");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_retry_idx" ON "webhook_deliveries" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_tenant_idx" ON "webhook_deliveries" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_delivery_id_uq" ON "webhook_deliveries" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_event_id_idx" ON "webhook_deliveries" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_tenant_idx" ON "webhook_endpoints" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_active_idx" ON "webhook_endpoints" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "asm_instances_org_id_uq" ON "asm_instances" USING btree ("organization_id") WHERE "asm_instances"."organization_id" IS NOT NULL;