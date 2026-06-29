ALTER TABLE "mdm_devices" ADD COLUMN "last_gps_latitude" text;--> statement-breakpoint
ALTER TABLE "mdm_devices" ADD COLUMN "last_gps_longitude" text;--> statement-breakpoint
ALTER TABLE "mdm_devices" ADD COLUMN "last_gps_accuracy_meters" integer;--> statement-breakpoint
ALTER TABLE "mdm_devices" ADD COLUMN "last_gps_at" timestamp with time zone;