CREATE TABLE "event_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"event_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"matched_endpoint_count" integer DEFAULT 0 NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_log" ADD CONSTRAINT "event_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_log_tenant_idx" ON "event_log" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "event_log_event_id_idx" ON "event_log" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_log_type_created_idx" ON "event_log" USING btree ("event_type","created_at");