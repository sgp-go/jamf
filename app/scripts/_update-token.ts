import { eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { mdmDevices } from "~/db/schema/devices.ts";

// 恢復 task 57：真機驗證中 config 被 NeverOverwrite bug 清空、原 token 丟失，
// 設備已重裝並寫入新 token；此處把 backend DB 的 token hash 同步為新 token 的 sha256，
// 讓 agent 上報鑑權通過。一次性腳本，跑完刪。
const r = await db.update(mdmDevices)
  .set({ agentTokenHash: "58f2294c6f4b1da1b172c62a85bfe1afab3c260beae3d8c2ffc7fe292319fb74" })
  .where(eq(mdmDevices.id, "62c833ca-36dd-4508-85c1-d6e6c31e3c9b"))
  .returning({ id: mdmDevices.id, hash: mdmDevices.agentTokenHash });
console.log("UPDATED=" + JSON.stringify(r));
