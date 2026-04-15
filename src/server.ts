/** 平板管理平臺 API 服務 - Deno + Hono */

import "@std/dotenv/load";
import { Hono } from "@hono/hono";
import { cors } from "@hono/hono/cors";
import { logger } from "@hono/hono/logger";
import devices from "./routes/devices.ts";
import agent from "./routes/agent.ts";
import mdm from "./routes/mdm.ts";

const app = new Hono();

// 中介軟體
app.use("*", logger());
app.use("*", cors());

// 健康檢查
app.get("/", (c) =>
  c.json({
    name: "Jamf Tablet Management API",
    version: "0.1.0",
    endpoints: {
      devices: "/api/devices",
      deviceDetail: "/api/devices/:id",
      deviceCommand: "/api/devices/:id/command",
      agentReport: "/api/agent/report",
      agentReports: "/api/agent/reports/:deviceId",
      agentLatest: "/api/agent/latest/:deviceId",
      agentUsage: "/api/agent/usage",
      agentUsageQuery: "/api/agent/usage/:deviceId",
      mdmCheckin: "/api/mdm/checkin",
      mdmCommand: "/api/mdm/command",
      mdmDevices: "/api/mdm/devices",
      mdmDepDevices: "/api/mdm/dep/devices",
      mdmMigration: "/api/mdm/migration/status",
    },
  })
);

// 路由掛載
app.route("/api/devices", devices);
app.route("/api/agent", agent);
app.route("/api/mdm", mdm);

// 404
app.notFound((c) => c.json({ error: "Not Found" }, 404));

// 錯誤處理
app.onError((err, c) => {
  console.error("Server error:", err);
  // 如果是 Jamf API 錯誤，回傳上游的完整錯誤資訊
  if (err.name === "JamfRequestError") {
    const jamfErr = err as import("./jamf/client.ts").JamfRequestError;
    return c.json(
      { error: err.message, upstream: jamfErr.body },
      jamfErr.status as 400
    );
  }
  return c.json({ error: err.message }, 500);
});

const port = Number(Deno.env.get("PORT") ?? 3000);
console.log(`🚀 Server running on http://localhost:${port}`);
Deno.serve({ port }, app.fetch);
