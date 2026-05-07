/** 平板管理平臺 API 服務 - Deno + Hono */

import "@std/dotenv/load";
import { Hono } from "@hono/hono";
import { cors } from "@hono/hono/cors";
import { logger } from "@hono/hono/logger";
import devices from "./routes/devices.ts";
import agent from "./routes/agent.ts";
import mdm from "./routes/mdm.ts";
import windowsMdm from "./routes/windows-mdm.ts";

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
      // Windows MDM
      winDiscovery: "/EnrollmentServer/Discovery.svc",
      winPolicy: "/EnrollmentServer/Policy.svc",
      winEnrollment: "/EnrollmentServer/Enrollment.svc",
      winManage: "/api/mdm/win/manage/:deviceId",
      winDevices: "/api/mdm/win/devices",
      winWipe: "/api/mdm/win/devices/:udid/wipe",
      winApps: "/api/mdm/win/devices/:udid/apps",
      winAppInstall: "/api/mdm/win/devices/:udid/apps/install",
      winAppUpdate: "/api/mdm/win/devices/:udid/apps/update",
      winAppUpdateScan: "/api/mdm/win/devices/:udid/apps/update-scan",
      winAppRefresh: "/api/mdm/win/devices/:udid/apps/refresh",
      winAppInstallBulk: "/api/mdm/win/devices/install/bulk",
      winPollConfig: "/api/mdm/win/devices/:udid/poll-config",
      winPushConfig: "/api/mdm/win/devices/:udid/push-config",
      winPush: "/api/mdm/win/devices/:udid/push",
    },
  })
);

// 路由掛載
app.route("/api/devices", devices);
app.route("/api/agent", agent);
app.route("/api/mdm", mdm);
// Windows MDM 內含跨前綴端點（/EnrollmentServer/* 與 /api/mdm/win/*），掛在 root
app.route("/", windowsMdm);

/**
 * GET /test/:filename — 靜態 host data/test/ 下的測試文件（給 MDM HostedInstall 用）
 * 嚴格只允許 basename，防 path traversal；只接受白名單副檔名
 */
const TEST_HOST_DIR = "data/test";
const TEST_ALLOWED_EXT = [".msix", ".msixbundle", ".appx", ".appxbundle", ".cer"];
app.get("/test/:filename", async (c) => {
  const raw = c.req.param("filename");
  // 嚴格 basename：禁 / \ .. 及隱藏文件
  if (
    !raw ||
    raw.includes("/") ||
    raw.includes("\\") ||
    raw.includes("..") ||
    raw.startsWith(".")
  ) {
    return c.text("invalid filename", 400);
  }
  const ext = raw.slice(raw.lastIndexOf(".")).toLowerCase();
  if (!TEST_ALLOWED_EXT.includes(ext)) {
    return c.text("ext not allowed", 400);
  }
  try {
    const path = `${TEST_HOST_DIR}/${raw}`;
    const data = await Deno.readFile(path);
    return new Response(data, {
      status: 200,
      headers: {
        "content-type":
          ext === ".cer"
            ? "application/x-x509-ca-cert"
            : "application/vnd.ms-appx",
        "content-length": String(data.byteLength),
      },
    });
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return c.text("not found", 404);
    throw e;
  }
});

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
