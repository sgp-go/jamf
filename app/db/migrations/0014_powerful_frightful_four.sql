CREATE TYPE "public"."firewall_action" AS ENUM('allow', 'block');--> statement-breakpoint
CREATE TYPE "public"."firewall_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."firewall_protocol" AS ENUM('tcp', 'udp', 'any');--> statement-breakpoint
CREATE TABLE "mdm_device_firewall_state" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"applied_rule_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rule_set_hash" varchar(64),
	"enforce_enabled_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mdm_firewall_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"device_group_id" uuid,
	"name" varchar(64) NOT NULL,
	"description" text,
	"direction" "firewall_direction" NOT NULL,
	"action" "firewall_action" NOT NULL,
	"protocol" "firewall_protocol" DEFAULT 'any' NOT NULL,
	"local_port_ranges" varchar(256),
	"remote_port_ranges" varchar(256),
	"local_address_ranges" varchar(512),
	"remote_address_ranges" varchar(512),
	"app_file_path" text,
	"app_package_family_name" text,
	"profiles" integer DEFAULT 7 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mdm_device_firewall_state" ADD CONSTRAINT "mdm_device_firewall_state_device_id_mdm_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."mdm_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mdm_device_firewall_state" ADD CONSTRAINT "mdm_device_firewall_state_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mdm_firewall_rules" ADD CONSTRAINT "mdm_firewall_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mdm_firewall_rules" ADD CONSTRAINT "mdm_firewall_rules_device_group_id_device_groups_id_fk" FOREIGN KEY ("device_group_id") REFERENCES "public"."device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mdm_device_firewall_state_tenant_idx" ON "mdm_device_firewall_state" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "mdm_firewall_rules_tenant_idx" ON "mdm_firewall_rules" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "mdm_firewall_rules_tenant_group_idx" ON "mdm_firewall_rules" USING btree ("tenant_id","device_group_id");