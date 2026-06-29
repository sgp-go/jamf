CREATE TABLE "compliance_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"description" text,
	"min_os_version" varchar(64),
	"max_offline_days" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_compliance_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"compliant" boolean NOT NULL,
	"violations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "compliance_policies" ADD CONSTRAINT "compliance_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_compliance_results" ADD CONSTRAINT "device_compliance_results_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_compliance_results" ADD CONSTRAINT "device_compliance_results_policy_id_compliance_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."compliance_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_compliance_results" ADD CONSTRAINT "device_compliance_results_device_id_mdm_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."mdm_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "compliance_policies_tenant_idx" ON "compliance_policies" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "compliance_policies_active_idx" ON "compliance_policies" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_policies_tenant_name_uq" ON "compliance_policies" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "compliance_results_tenant_policy_evaluated_idx" ON "device_compliance_results" USING btree ("tenant_id","policy_id","evaluated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "compliance_results_device_evaluated_idx" ON "device_compliance_results" USING btree ("device_id","evaluated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "compliance_results_policy_device_evaluated_idx" ON "device_compliance_results" USING btree ("policy_id","device_id","evaluated_at" DESC NULLS LAST);