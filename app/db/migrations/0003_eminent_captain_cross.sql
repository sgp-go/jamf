CREATE TABLE "mdm_windows_apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"package_family_name" text NOT NULL,
	"display_name" text,
	"version" text,
	"install_state" varchar(32),
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mdm_windows_apps" ADD CONSTRAINT "mdm_windows_apps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mdm_windows_apps" ADD CONSTRAINT "mdm_windows_apps_device_id_mdm_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."mdm_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mdm_windows_apps_device_pfn_uq" ON "mdm_windows_apps" USING btree ("device_id","package_family_name");--> statement-breakpoint
CREATE INDEX "mdm_windows_apps_device_idx" ON "mdm_windows_apps" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "mdm_windows_apps_tenant_idx" ON "mdm_windows_apps" USING btree ("tenant_id");