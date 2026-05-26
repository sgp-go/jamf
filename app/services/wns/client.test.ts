import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  WnsClient,
  WnsAuthError,
  _resetWnsClientForTesting,
} from "./client.ts";

/** Mock fetch helper：替換 globalThis.fetch，回傳指定序列的 Response */
function mockFetch(handlers: ((req: Request) => Response | Promise<Response>)[]) {
  const original = globalThis.fetch;
  let i = 0;
  const calls: Request[] = [];
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req.clone());
    if (i >= handlers.length) {
      throw new Error(`mockFetch: 第 ${i + 1} 次呼叫超出預設 handlers (${handlers.length})`);
    }
    const handler = handlers[i++];
    return await handler(req);
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

Deno.test("WnsClient: constructor 缺凭据抛 WnsAuthError", () => {
  let err: unknown;
  try {
    new WnsClient("", "secret");
  } catch (e) {
    err = e;
  }
  assertEquals(err instanceof WnsAuthError, true);
});

Deno.test("WnsClient.sendRaw: invalid channelUri 拋錯（不是 *.notify.windows.com）", async () => {
  const c = new WnsClient("ms-app://S-1-15-foo", "secret");
  await assertRejects(
    () => c.sendRaw("https://evil.example.com/abc"),
    Error,
    "invalid channelUri"
  );
});

Deno.test("WnsClient.sendRaw: 200 成功回 ok=true 並重用 token cache", async () => {
  const m = mockFetch([
    // 第 1 次：OAuth
    () =>
      new Response(JSON.stringify({ access_token: "tok-1", token_type: "bearer" }), {
        status: 200,
      }),
    // 第 2 次：send
    () => new Response(null, { status: 200, headers: { "X-WNS-Status": "received" } }),
    // 第 3 次：（第二輪 send 應該重用 token，不再 OAuth）
    () => new Response(null, { status: 200, headers: { "X-WNS-Status": "received" } }),
  ]);
  try {
    const c = new WnsClient("ms-app://S-1-15-foo", "secret");
    const r1 = await c.sendRaw("https://abc.notify.windows.com/?token=xyz");
    assertEquals(r1.ok, true);
    assertEquals(r1.status, 200);
    assertEquals(r1.wnsStatus, "received");

    const r2 = await c.sendRaw("https://abc.notify.windows.com/?token=xyz");
    assertEquals(r2.ok, true);
    // 共 3 個 fetch（OAuth + 兩次 send），驗證 token 被 cache
    assertEquals(m.calls.length, 3);
    // 第一個是 OAuth
    assertEquals(m.calls[0].url.startsWith("https://login.live.com/"), true);
    // 第二、三個是 send
    assertEquals(m.calls[1].url.includes("notify.windows.com"), true);
    assertEquals(m.calls[2].url.includes("notify.windows.com"), true);
  } finally {
    m.restore();
  }
});

Deno.test("WnsClient.sendRaw: 401 觸發 refresh token + retry once", async () => {
  const m = mockFetch([
    // OAuth #1
    () => new Response(JSON.stringify({ access_token: "tok-old" }), { status: 200 }),
    // send #1 → 401
    () => new Response("invalid token", { status: 401 }),
    // OAuth #2 (refresh)
    () => new Response(JSON.stringify({ access_token: "tok-new" }), { status: 200 }),
    // send #2 → 200
    () => new Response(null, { status: 200 }),
  ]);
  try {
    const c = new WnsClient("ms-app://S-1-15-foo", "secret");
    const r = await c.sendRaw("https://abc.notify.windows.com/?token=xyz");
    assertEquals(r.ok, true);
    // 第 2 次 send 應該帶新 token
    const sendReq2 = m.calls[3];
    assertEquals(sendReq2.headers.get("Authorization"), "Bearer tok-new");
  } finally {
    m.restore();
  }
});

Deno.test("WnsClient.sendRaw: 410 channel expired", async () => {
  const m = mockFetch([
    () => new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }),
    () =>
      new Response("channel expired", {
        status: 410,
        headers: { "X-WNS-Status": "channelthrottled" },
      }),
  ]);
  try {
    const c = new WnsClient("ms-app://S-1-15-foo", "secret");
    const r = await c.sendRaw("https://abc.notify.windows.com/?token=xyz");
    assertEquals(r.ok, false);
    assertEquals(r.status, 410);
    assertEquals(r.channelExpired, true);
  } finally {
    m.restore();
  }
});

Deno.test("WnsClient.getToken: OAuth 失敗拋 WnsAuthError", async () => {
  const m = mockFetch([
    () => new Response("bad client", { status: 400 }),
  ]);
  try {
    _resetWnsClientForTesting();
    const c = new WnsClient("ms-app://S-1-15-foo", "secret");
    await assertRejects(
      () => c.sendRaw("https://abc.notify.windows.com/?token=xyz"),
      WnsAuthError
    );
  } finally {
    m.restore();
  }
});

Deno.test("WnsClient.sendRaw: 請求頭含正確的 X-WNS-Type 和 Content-Type", async () => {
  const m = mockFetch([
    () => new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }),
    (req) => {
      assertEquals(req.headers.get("X-WNS-Type"), "wns/raw");
      assertEquals(req.headers.get("Content-Type"), "application/octet-stream");
      assertEquals(req.headers.get("Authorization"), "Bearer tok");
      return new Response(null, { status: 200 });
    },
  ]);
  try {
    const c = new WnsClient("ms-app://S-1-15-foo", "secret");
    await c.sendRaw(
      "https://abc.notify.windows.com/?token=xyz",
      new Uint8Array([1, 2, 3])
    );
  } finally {
    m.restore();
  }
});
