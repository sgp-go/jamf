CREATE TABLE "mdm_windows_bitlocker" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"encryption_id" uuid NOT NULL,
	"recovery_password_enc" text,
	"encryption_method" varchar(32),
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"command_uuid" varchar(64),
	"triggered_by" varchar(32) DEFAULT 'auto' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mdm_windows_bitlocker" ADD CONSTRAINT "mdm_windows_bitlocker_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mdm_windows_bitlocker" ADD CONSTRAINT "mdm_windows_bitlocker_device_id_mdm_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."mdm_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mdm_windows_bitlocker_device_created_idx" ON "mdm_windows_bitlocker" USING btree ("device_id","created_at");--> statement-breakpoint
CREATE INDEX "mdm_windows_bitlocker_tenant_idx" ON "mdm_windows_bitlocker" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mdm_windows_bitlocker_encryption_id_uq" ON "mdm_windows_bitlocker" USING btree ("encryption_id");