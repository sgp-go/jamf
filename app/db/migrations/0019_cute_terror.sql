CREATE TABLE "mdm_installed_win32_apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"uninstall_key" varchar(256) NOT NULL,
	"display_name" text NOT NULL,
	"display_version" varchar(64),
	"publisher" text,
	"install_date" varchar(32),
	"estimated_size_kb" bigint,
	"uninstall_string" text,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mdm_installed_win32_apps" ADD CONSTRAINT "mdm_installed_win32_apps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mdm_installed_win32_apps" ADD CONSTRAINT "mdm_installed_win32_apps_device_id_mdm_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."mdm_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mdm_installed_win32_apps_device_key_uq" ON "mdm_installed_win32_apps" USING btree ("device_id","uninstall_key");--> statement-breakpoint
CREATE INDEX "mdm_installed_win32_apps_device_idx" ON "mdm_installed_win32_apps" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "mdm_installed_win32_apps_tenant_idx" ON "mdm_installed_win32_apps" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "mdm_installed_win32_apps_display_name_idx" ON "mdm_installed_win32_apps" USING btree ("display_name");