ALTER TABLE "mdm_devices" ADD COLUMN "agent_token_hash" varchar(128);--> statement-breakpoint
ALTER TABLE "mdm_devices" ADD COLUMN "agent_token_issued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mdm_devices" ADD COLUMN "agent_installed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mdm_devices" ADD COLUMN "agent_app_id" uuid;