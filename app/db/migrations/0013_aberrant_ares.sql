CREATE TABLE "device_geofence_assignments" (
	"device_id" uuid NOT NULL,
	"geofence_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_geofence_assignments_device_id_geofence_id_pk" PRIMARY KEY("device_id","geofence_id")
);
--> statement-breakpoint
CREATE TABLE "device_geofence_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"geofence_id" uuid NOT NULL,
	"status" varchar(16) NOT NULL,
	"last_latitude" text NOT NULL,
	"last_longitude" text NOT NULL,
	"last_transition_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geofences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"description" text,
	"polygon" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_geofence_assignments" ADD CONSTRAINT "device_geofence_assignments_device_id_mdm_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."mdm_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_geofence_assignments" ADD CONSTRAINT "device_geofence_assignments_geofence_id_geofences_id_fk" FOREIGN KEY ("geofence_id") REFERENCES "public"."geofences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_geofence_states" ADD CONSTRAINT "device_geofence_states_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_geofence_states" ADD CONSTRAINT "device_geofence_states_device_id_mdm_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."mdm_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_geofence_states" ADD CONSTRAINT "device_geofence_states_geofence_id_geofences_id_fk" FOREIGN KEY ("geofence_id") REFERENCES "public"."geofences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geofences" ADD CONSTRAINT "geofences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_geofence_assignments_geofence_idx" ON "device_geofence_assignments" USING btree ("geofence_id");--> statement-breakpoint
CREATE UNIQUE INDEX "device_geofence_states_device_geofence_uq" ON "device_geofence_states" USING btree ("device_id","geofence_id");--> statement-breakpoint
CREATE INDEX "device_geofence_states_tenant_idx" ON "device_geofence_states" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "device_geofence_states_status_idx" ON "device_geofence_states" USING btree ("status");--> statement-breakpoint
CREATE INDEX "geofences_tenant_idx" ON "geofences" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "geofences_active_idx" ON "geofences" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "geofences_tenant_name_uq" ON "geofences" USING btree ("tenant_id","name");