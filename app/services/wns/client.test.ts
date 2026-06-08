import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  WnsClient,
  WnsAuthError,
  parseRetryAfter,
  _resetWnsClientForTesting,
} from "./client.ts";

/** 记录注入 sleep 的调用 ms（瞬时 resolve，不真等） */
function recordingSleep() {
  const calls: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    calls.push(ms);
    return Promise.resolve();
  };
  return { calls, sleep };
}

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

// ===== 429/406 限速退避 =====

Deno.test("WnsClient.sendRaw: 429 退避重试后成功", async () => {
  const m = mockFetch([
    () => new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }),
    () => new Response("throttled", { status: 429 }), // send #1
    () => new Response(null, { status: 200 }), // send #2（重试）
  ]);
  const s = recordingSleep();
  try {
    const c = new WnsClient("ms-app://S-1-15-foo", "secret", {
      throttle: { baseBackoffMs: 1000 },
      sleep: s.sleep,
    });
    const r = await c.sendRaw("https://abc.notify.windows.com/?token=xyz");
    assertEquals(r.ok, true);
    assertEquals(r.retries, 1);
    // attempt=1 → backoff = 1000 * 2^0 = 1000
    assertEquals(s.calls, [1000]);
    assertEquals(m.calls.length, 3); // OAuth + 2 send（token 复用）
  } finally {
    m.restore();
  }
});

Deno.test("WnsClient.sendRaw: 429 优先采用 Retry-After header", async () => {
  const m = mockFetch([
    () => new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }),
    () =>
      new Response("throttled", {
        status: 429,
        headers: { "Retry-After": "2" }, // 2 秒
      }),
    () => new Response(null, { status: 200 }),
  ]);
  const s = recordingSleep();
  try {
    const c = new WnsClient("ms-app://S-1-15-foo", "secret", {
      throttle: { baseBackoffMs: 1000 }, // 应被 Retry-After 覆盖
      sleep: s.sleep,
    });
    const r = await c.sendRaw("https://abc.notify.windows.com/?token=xyz");
    assertEquals(r.ok, true);
    assertEquals(s.calls, [2000]); // Retry-After 2s 而非 backoff 1s
  } finally {
    m.restore();
  }
});

Deno.test("WnsClient.sendRaw: 429 重试耗尽返回 throttled=true", async () => {
  const m = mockFetch([
    () => new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }),
    () => new Response("throttled", { status: 429 }),
    () => new Response("throttled", { status: 429 }),
    () => new Response("throttled", { status: 429 }),
  ]);
  const s = recordingSleep();
  try {
    const c = new WnsClient("ms-app://S-1-15-foo", "secret", {
      throttle: { maxRetries: 2, baseBackoffMs: 10 },
      sleep: s.sleep,
    });
    const r = await c.sendRaw("https://abc.notify.windows.com/?token=xyz");
    assertEquals(r.ok, false);
    assertEquals(r.status, 429);
    assertEquals(r.throttled, true);
    assertEquals(r.retries, 2);
    // 退避序列：10*2^0, 10*2^1
    assertEquals(s.calls, [10, 20]);
    assertEquals(m.calls.length, 4); // OAuth + 3 send（初次 + 2 重试）
  } finally {
    m.restore();
  }
});

Deno.test("WnsClient.sendRaw: 406 视为限速重试", async () => {
  const m = mockFetch([
    () => new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }),
    () => new Response("not acceptable", { status: 406 }),
    () => new Response(null, { status: 200 }),
  ]);
  const s = recordingSleep();
  try {
    const c = new WnsClient("ms-app://S-1-15-foo", "secret", {
      throttle: { baseBackoffMs: 5 },
      sleep: s.sleep,
    });
    const r = await c.sendRaw("https://abc.notify.windows.com/?token=xyz");
    assertEquals(r.ok, true);
    assertEquals(r.retries, 1);
  } finally {
    m.restore();
  }
});

Deno.test("WnsClient.sendRaw: 退避封顶 maxBackoffMs", async () => {
  const m = mockFetch([
    () => new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }),
    () => new Response("throttled", { status: 429 }),
    () => new Response("throttled", { status: 429 }),
    () => new Response(null, { status: 200 }),
  ]);
  const s = recordingSleep();
  try {
    const c = new WnsClient("ms-app://S-1-15-foo", "secret", {
      throttle: { maxRetries: 3, baseBackoffMs: 10000, maxBackoffMs: 15000 },
      sleep: s.sleep,
    });
    const r = await c.sendRaw("https://abc.notify.windows.com/?token=xyz");
    assertEquals(r.ok, true);
    // attempt1=10000（<15000）; attempt2=20000→封顶 15000
    assertEquals(s.calls, [10000, 15000]);
  } finally {
    m.restore();
  }
});

// ===== 令牌桶限流 =====

Deno.test("WnsClient.sendRaw: rateLimit 令牌桶超突发后触发等待", async () => {
  const m = mockFetch([
    () => new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }),
    () => new Response(null, { status: 200 }),
    () => new Response(null, { status: 200 }),
  ]);
  // 记录 + 真等（令牌桶 refill 依赖 Date.now 推进，需真实经过时间）
  const calls: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    calls.push(ms);
    return new Promise((r) => setTimeout(r, ms));
  };
  try {
    const c = new WnsClient("ms-app://S-1-15-foo", "secret", {
      rateLimit: { ratePerSec: 1000, burst: 1 }, // 桶容量 1：第 2 次发须等补充
      sleep,
    });
    await c.sendRaw("https://abc.notify.windows.com/?token=xyz");
    await c.sendRaw("https://abc.notify.windows.com/?token=xyz");
    // 第 2 次 acquire 令牌不足 → 至少 sleep 一次
    assertEquals(calls.length >= 1, true);
  } finally {
    m.restore();
  }
});

Deno.test("WnsClient.sendRaw: 默认不限流（rateLimit 未配则无 sleep）", async () => {
  const m = mockFetch([
    () => new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }),
    () => new Response(null, { status: 200 }),
    () => new Response(null, { status: 200 }),
  ]);
  const s = recordingSleep();
  try {
    const c = new WnsClient("ms-app://S-1-15-foo", "secret", { sleep: s.sleep });
    await c.sendRaw("https://abc.notify.windows.com/?token=xyz");
    await c.sendRaw("https://abc.notify.windows.com/?token=xyz");
    assertEquals(s.calls.length, 0); // 无限流、无 429 → 完全不 sleep
  } finally {
    m.restore();
  }
});

// ===== parseRetryAfter =====

Deno.test("parseRetryAfter: delta-seconds 整数", () => {
  assertEquals(parseRetryAfter("5"), 5000);
  assertEquals(parseRetryAfter(" 30 "), 30000);
  assertEquals(parseRetryAfter("0"), 0);
});

Deno.test("parseRetryAfter: HTTP-date 转未来毫秒差", () => {
  const future = new Date(Date.now() + 10000).toUTCString();
  const ms = parseRetryAfter(future);
  assertEquals(ms !== undefined && ms > 5000 && ms <= 10000, true);
  // 过去时间 → 0（不为负）
  const past = new Date(Date.now() - 10000).toUTCString();
  assertEquals(parseRetryAfter(past), 0);
});

Deno.test("parseRetryAfter: 非法值 / null 返 undefined", () => {
  assertEquals(parseRetryAfter("garbage"), undefined);
  assertEquals(parseRetryAfter(null), undefined);
  assertEquals(parseRetryAfter(""), undefined);
});
