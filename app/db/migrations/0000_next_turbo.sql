CREATE TYPE "public"."mdm_command_status" AS ENUM('queued', 'sent', 'acknowledged', 'error', 'not_now', 'idle', 'expired');--> statement-breakpoint
CREATE TYPE "public"."mdm_enrollment_status" AS ENUM('pending', 'enrolled', 'unenrolled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."device_platform" AS ENUM('apple', 'windows');--> statement-breakpoint
CREATE TABLE "agent_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"serial_number" varchar(64),
	"battery_level" integer,
	"storage_available_mb" integer,
	"storage_total_mb" integer,
	"network_type" varchar(32),
	"network_ssid" text,
	"screen_brightness" real,
	"os_version" text,
	"app_version" text,
	"extra_data" jsonb,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_usage_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"session_id" text,
	"date" varchar(10) NOT NULL,
	"total_minutes" integer DEFAULT 0 NOT NULL,
	"pickup" integer DEFAULT 0 NOT NULL,
	"max_continuous" integer DEFAULT 0 NOT NULL,
	"time_stats" jsonb,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asm_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"org_name" text,
	"org_email" text,
	"org_address" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dep_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asm_instance_id" uuid NOT NULL,
	"serial_number" varchar(64) NOT NULL,
	"model" text,
	"description" text,
	"color" text,
	"device_family" text,
	"os" text,
	"profile_uuid" varchar(64),
	"profile_status" varchar(32) DEFAULT 'empty',
	"extra" jsonb,
	"dep_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dep_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asm_instance_id" uuid NOT NULL,
	"server_name" text,
	"consumer_key" text NOT NULL,
	"consumer_secret_enc" text NOT NULL,
	"access_token" text NOT NULL,
	"access_secret_enc" text NOT NULL,
	"token_expiry" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mdm_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"command_uuid" varchar(64) NOT NULL,
	"platform" "device_platform" DEFAULT 'apple' NOT NULL,
	"command_type" varchar(64) NOT NULL,
	"status" "mdm_command_status" DEFAULT 'queued' NOT NULL,
	"request_payload" jsonb NOT NULL,
	"response_payload" jsonb,
	"error_chain" jsonb,
	"csp_path" text,
	"syncml_verb" varchar(16),
	"syncml_data" text,
	"syncml_format" varchar(16),
	"session_msg_id" varchar(32),
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"responded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mdm_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"school_id" uuid,
	"jamf_instance_id" uuid,
	"asm_instance_id" uuid,
	"self_mdm_config_id" uuid,
	"platform" "device_platform" DEFAULT 'apple' NOT NULL,
	"udid" varchar(64),
	"serial_number" varchar(64),
	"device_name" text,
	"model" text,
	"os_version" text,
	"push_token" text,
	"push_magic" text,
	"unlock_token" text,
	"topic" text,
	"windows_device_id" text,
	"windows_hardware_id" text,
	"wns_channel_uri" text,
	"wns_channel_expiry" timestamp with time zone,
	"management_session_state" jsonb,
	"lost_mode_enabled" boolean DEFAULT false NOT NULL,
	"lost_mode_message" text,
	"lost_mode_phone" text,
	"lost_mode_footnote" text,
	"lost_mode_enabled_at" timestamp with time zone,
	"self_mdm_managed" boolean DEFAULT false NOT NULL,
	"enrollment_type" varchar(32) DEFAULT 'dep',
	"enrollment_status" "mdm_enrollment_status" DEFAULT 'pending' NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now(),
	"last_seen_at" timestamp with time zone,
	"device_info" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mdm_migrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"device_id" uuid,
	"serial_number" varchar(64) NOT NULL,
	"jamf_device_id" text,
	"jamf_management_id" text,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "jamf_instance_school_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jamf_instance_id" uuid NOT NULL,
	"school_id" uuid NOT NULL,
	"jamf_site_id" integer,
	"jamf_building_id" integer,
	"extra" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jamf_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"base_url" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_enc" text NOT NULL,
	"app_lock_group_id" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jamf_token_cache" (
	"jamf_instance_id" uuid PRIMARY KEY NOT NULL,
	"access_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mdm_device_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"self_mdm_config_id" uuid NOT NULL,
	"device_udid" varchar(64),
	"cert_serial" text,
	"subject" text,
	"not_before" timestamp with time zone,
	"not_after" timestamp with time zone,
	"certificate_pem" text NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "self_mdm_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"public_base_url" text NOT NULL,
	"apns_topic" text,
	"apns_cert_pem" text,
	"apns_key_pem_enc" text,
	"ca_cert_pem" text,
	"ca_key_pem_enc" text,
	"vendor_cert_pem" text,
	"vendor_key_pem_enc" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "self_mdm_configs_tenantId_unique" UNIQUE("tenant_id")
);
--> statement-breakpoint
CREATE TABLE "schools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" varchar(64) NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"display_name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "agent_reports" ADD CONSTRAINT "agent_reports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_reports" ADD CONSTRAINT "agent_reports_device_id_mdm_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."mdm_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_usage_stats" ADD CONSTRAINT "device_usage_stats_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_usage_stats" ADD CONSTRAINT "device_usage_stats_device_id_mdm_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."mdm_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asm_instances" ADD CONSTRAINT "asm_instances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dep_devices" ADD CONSTRAINT "dep_devices_asm_instance_id_asm_instances_id_fk" FOREIGN KEY ("asm_instance_id") REFERENCES "public"."asm_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dep_tokens" ADD CONSTRAINT "dep_tokens_asm_instance_id_asm_instances_id_fk" FOREIGN KEY ("asm_instance_id") REFERENCES "public"."asm_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mdm_commands" ADD CONSTRAINT "mdm_commands_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mdm_commands" ADD CONSTRAINT "mdm_commands_device_id_mdm_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."mdm_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mdm_devices" ADD CONSTRAINT "mdm_devices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mdm_devices" ADD CONSTRAINT "mdm_devices_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mdm_devices" ADD CONSTRAINT "mdm_devices_jamf_instance_id_jamf_instances_id_fk" FOREIGN KEY ("jamf_instance_id") REFERENCES "public"."jamf_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mdm_devices" ADD CONSTRAINT "mdm_devices_asm_instance_id_asm_instances_id_fk" FOREIGN KEY ("asm_instance_id") REFERENCES "public"."asm_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mdm_devices" ADD CONSTRAINT "mdm_devices_self_mdm_config_id_self_mdm_configs_id_fk" FOREIGN KEY ("self_mdm_config_id") REFERENCES "public"."self_mdm_configs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mdm_migrations" ADD CONSTRAINT "mdm_migrations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mdm_migrations" ADD CONSTRAINT "mdm_migrations_device_id_mdm_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."mdm_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jamf_instance_school_bindings" ADD CONSTRAINT "jamf_instance_school_bindings_jamf_instance_id_jamf_instances_id_fk" FOREIGN KEY ("jamf_instance_id") REFERENCES "public"."jamf_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jamf_instances" ADD CONSTRAINT "jamf_instances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jamf_token_cache" ADD CONSTRAINT "jamf_token_cache_jamf_instance_id_jamf_instances_id_fk" FOREIGN KEY ("jamf_instance_id") REFERENCES "public"."jamf_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mdm_device_certificates" ADD CONSTRAINT "mdm_device_certificates_self_mdm_config_id_self_mdm_configs_id_fk" FOREIGN KEY ("self_mdm_config_id") REFERENCES "public"."self_mdm_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_mdm_configs" ADD CONSTRAINT "self_mdm_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schools" ADD CONSTRAINT "schools_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_reports_device_time_idx" ON "agent_reports" USING btree ("device_id","reported_at");--> statement-breakpoint
CREATE INDEX "agent_reports_tenant_idx" ON "agent_reports" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "device_usage_device_date_uq" ON "device_usage_stats" USING btree ("device_id","date");--> statement-breakpoint
CREATE INDEX "device_usage_tenant_date_idx" ON "device_usage_stats" USING btree ("tenant_id","date");--> statement-breakpoint
CREATE INDEX "asm_instances_tenant_idx" ON "asm_instances" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dep_devices_asm_serial_uq" ON "dep_devices" USING btree ("asm_instance_id","serial_number");--> statement-breakpoint
CREATE INDEX "dep_devices_serial_idx" ON "dep_devices" USING btree ("serial_number");--> statement-breakpoint
CREATE INDEX "dep_tokens_asm_idx" ON "dep_tokens" USING btree ("asm_instance_id");--> statement-breakpoint
CREATE INDEX "dep_tokens_expiry_idx" ON "dep_tokens" USING btree ("token_expiry");--> statement-breakpoint
CREATE UNIQUE INDEX "dep_tokens_active_per_asm_uq" ON "dep_tokens" USING btree ("asm_instance_id") WHERE "dep_tokens"."is_active" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "mdm_commands_uuid_uq" ON "mdm_commands" USING btree ("command_uuid");--> statement-breakpoint
CREATE INDEX "mdm_commands_device_idx" ON "mdm_commands" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "mdm_commands_status_idx" ON "mdm_commands" USING btree ("status");--> statement-breakpoint
CREATE INDEX "mdm_commands_tenant_idx" ON "mdm_commands" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "mdm_devices_tenant_idx" ON "mdm_devices" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "mdm_devices_school_idx" ON "mdm_devices" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "mdm_devices_jamf_idx" ON "mdm_devices" USING btree ("jamf_instance_id");--> statement-breakpoint
CREATE INDEX "mdm_devices_platform_idx" ON "mdm_devices" USING btree ("platform");--> statement-breakpoint
CREATE UNIQUE INDEX "mdm_devices_tenant_udid_uq" ON "mdm_devices" USING btree ("tenant_id","udid") WHERE "mdm_devices"."udid" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mdm_devices_tenant_serial_uq" ON "mdm_devices" USING btree ("tenant_id","serial_number") WHERE "mdm_devices"."serial_number" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mdm_devices_windows_device_id_uq" ON "mdm_devices" USING btree ("windows_device_id") WHERE "mdm_devices"."windows_device_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "mdm_migrations_tenant_idx" ON "mdm_migrations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "mdm_migrations_serial_idx" ON "mdm_migrations" USING btree ("serial_number");--> statement-breakpoint
CREATE UNIQUE INDEX "jamf_binding_instance_school_uq" ON "jamf_instance_school_bindings" USING btree ("jamf_instance_id","school_id");--> statement-breakpoint
CREATE INDEX "jamf_binding_school_idx" ON "jamf_instance_school_bindings" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "jamf_instances_tenant_idx" ON "jamf_instances" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jamf_instances_tenant_baseurl_uq" ON "jamf_instances" USING btree ("tenant_id","base_url");--> statement-breakpoint
CREATE INDEX "jamf_token_cache_expiry_idx" ON "jamf_token_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "mdm_device_certs_udid_idx" ON "mdm_device_certificates" USING btree ("device_udid");--> statement-breakpoint
CREATE INDEX "mdm_device_certs_serial_idx" ON "mdm_device_certificates" USING btree ("cert_serial");