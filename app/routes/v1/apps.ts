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
  tags: ["應用下載"],
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
  const total = file.size;
  // Accept-Ranges 必須宣告：EDA-CSP 用 BITS 下載 .msi，BITS 強依賴 HTTP Range
  // 支持；缺它 BITS 會拒絕下載（設備端 HEAD 後不發 GET）。
  const baseHeaders: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Content-Disposition": `attachment; filename="${file.filename.replace(/"/g, "")}"`,
  };

  // HEAD：BITS 下載前探測 Content-Length + Accept-Ranges，不回 body
  if (c.req.method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: { ...baseHeaders, "Content-Length": String(total) },
    });
  }

  // Range 請求（BITS 分塊 / 斷點續傳）→ 206 Partial Content
  const rangeHeader = c.req.header("range");
  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!m || (!m[1] && !m[2])) {
      return new Response("Invalid Range", {
        status: 416,
        headers: { ...baseHeaders, "Content-Range": `bytes */${total}` },
      });
    }
    const start = m[1] ? parseInt(m[1], 10) : 0;
    const end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: { ...baseHeaders, "Content-Range": `bytes */${total}` },
      });
    }
    const chunk = createReadStream(file.path, { start, end });
    return new Response(Readable.toWeb(chunk) as ReadableStream<Uint8Array>, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }

  // 完整下載
  const full = createReadStream(file.path);
  return new Response(Readable.toWeb(full) as ReadableStream<Uint8Array>, {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(total) },
  });
});
