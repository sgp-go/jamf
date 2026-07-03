ALTER TABLE "mdm_windows_laps" ADD COLUMN "account_type" varchar(16) DEFAULT 'admin' NOT NULL;--> statement-breakpoint
ALTER TABLE "mdm_windows_laps" ADD COLUMN "require_change_on_first_logon" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "self_mdm_configs" ADD COLUMN "admin_account_name" varchar(64) DEFAULT 'ITAdmin' NOT NULL;--> statement-breakpoint
CREATE INDEX "mdm_windows_laps_device_account_idx" ON "mdm_windows_laps" USING btree ("device_id","admin_account","created_at");