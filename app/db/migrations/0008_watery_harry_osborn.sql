ALTER TABLE "self_mdm_configs" ADD COLUMN "agent_app_id" uuid;
--> statement-breakpoint
-- FK 手寫加（schema/self-mdm.ts 的 agentAppId 故意不寫 .references() 避循環依賴）
ALTER TABLE "self_mdm_configs"
  ADD CONSTRAINT "self_mdm_configs_agent_app_id_apps_id_fk"
  FOREIGN KEY ("agent_app_id") REFERENCES "public"."apps"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;