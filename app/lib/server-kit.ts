import { OpenAPIHono } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { AppError } from "~/lib/errors.ts";
import { validationFailedHook } from "~/lib/openapi-hook.ts";
import type { OpenApiTag, OpenApiTagGroup } from "~/lib/openapi-meta.ts";
import type { Mount } from "~/routes/mount.ts";

const API_VERSION = "0.2.0-alpha";

const DEFAULT_SERVERS = [
  { url: "http://localhost:3000", description: "local dev" },
  { url: "https://api-staging.cogrow.com", description: "staging（部署後填入實際 URL）" },
  { url: "https://api.cogrow.com", description: "production（部署後填入實際 URL）" },
];

/**
 * 建立帶共用中介層（logger / cors）與根資訊路由的 OpenAPIHono 實例。
 * 三個 entry（monolith / control / agent）共用，避免 scaffolding 漂移。
 */
export function createBaseApp(name: string) {
  const app = new OpenAPIHono({ defaultHook: validationFailedHook });

  app.use("*", logger());
  app.use("*", cors());

  app.get("/", (c) =>
    c.json({
      name,
      version: process.env.npm_package_version ?? API_VERSION,
      docs: "/docs",
      openapi: "/openapi.json",
    }),
  );

  return app;
}

/**
 * createBaseApp 回傳的具體型別（含 defaultHook 推導出的 Env=never）。
 * finalizeApp / mountAll 用它以與 createBaseApp 的實例相容。
 */
export type ApiApp = ReturnType<typeof createBaseApp>;

/** 依序把子 app 掛載到對應 basePath。 */
export function mountAll(app: ApiApp, mounts: Mount[]): void {
  for (const m of mounts) {
    app.route(m.basePath, m.app);
  }
}

export interface FinalizeOptions {
  title: string;
  description: string;
  tags?: OpenApiTag[];
  tagGroups?: OpenApiTagGroup[];
  servers?: { url: string; description?: string }[];
}

/**
 * 收尾：註冊 BearerAuth scheme + OpenAPI doc（/openapi.json）+ Scalar /docs +
 * 統一 notFound / onError 信封。掛載完所有 route 後呼叫。
 */
export function finalizeApp(app: ApiApp, opts: FinalizeOptions): void {
  app.openAPIRegistry.registerComponent("securitySchemes", "BearerAuth", {
    type: "http",
    scheme: "bearer",
    description: "Admin 端點需 `Authorization: Bearer <admin_token>`",
  });

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: opts.title,
      version: API_VERSION,
      description: opts.description,
      contact: { name: "CoGrow API Support", email: "support@cogrow.com" },
      license: { name: "Proprietary — © CoGrow" },
    },
    servers: opts.servers ?? DEFAULT_SERVERS,
    ...(opts.tags ? { tags: opts.tags } : {}),
    ...(opts.tagGroups ? { "x-tagGroups": opts.tagGroups } : {}),
  });

  app.get(
    "/docs",
    apiReference({
      spec: { url: "/openapi.json" },
      theme: "purple",
      pageTitle: `${opts.title} Docs`,
    }),
  );

  app.notFound((c) =>
    c.json(
      { ok: false as const, error: { code: "not_found", message: "Route not found" } },
      404,
    ),
  );

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(
        {
          ok: false as const,
          error: { code: err.code, message: err.message, details: err.details },
        },
        err.status,
      );
    }
    console.error("Unhandled error:", err);
    return c.json(
      {
        ok: false as const,
        error: { code: "internal_error", message: "Internal server error" },
      },
      500,
    );
  });
}
