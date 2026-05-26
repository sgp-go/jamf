import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { commonErrorResponses } from "~/lib/api.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import { resolveAppFile } from "~/services/apps.ts";

/**
 * 公開的 App 安裝包下載端點（給 Windows 設備從 EDA-CSP MsiInstallJob 內 ContentURL 拉取）。
 *
 * 為什麼公開：
 *   - 設備端用 SyncML 拉 .msi 時不帶 Bearer token，靠 SHA-256 FileHash 校驗完整性
 *   - HTTPS + 不可猜的 UUID appId 已提供足夠保護（不公開列舉 + 內容簽名）
 *   - 後續可改成簽名 URL（時效 token），但 MVP 公開即可
 */

const appFileParam = z.object({
  appId: z.string().uuid().openapi({ param: { name: "appId", in: "path" } }),
  filename: z.string().openapi({
    param: { name: "filename", in: "path" },
    description: "供瀏覽器/設備識別用的檔名（內容由 appId 唯一決定）",
  }),
});

const downloadSpec = createRoute({
  method: "get",
  path: "/apps/{appId}/download/{filename}",
  tags: ["Apps"],
  summary: "下載 App 安裝包（公開，靠 SHA-256 hash 驗證完整性）",
  request: { params: appFileParam },
  responses: {
    200: {
      description: "Binary content",
      content: {
        "application/octet-stream": {
          schema: z.string().openapi({ type: "string", format: "binary" }),
        },
      },
    },
    404: commonErrorResponses[404],
  },
});

export const appsApp = new OpenAPIHono({ defaultHook: validationFailedHook });

appsApp.openapi(downloadSpec, async (c) => {
  const { appId } = c.req.valid("param");
  const file = await resolveAppFile(appId);
  const nodeStream = createReadStream(file.path);
  const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  return new Response(webStream, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(file.size),
      "Content-Disposition": `attachment; filename="${file.filename.replace(/"/g, "")}"`,
    },
  });
});
