/**
 * 驗證：生產路徑 ApnsClient 的長連線重用
 * 用假 token 連續推送 5 次，觀察第一次 vs 後續的延遲差距
 */

import { apnsClient } from "../mdm/apns-client.ts";

const fakeToken = "0".repeat(64);
const topic = "com.apple.mgmt.External.FAKE";

console.log("[驗證] 5 次連續 push（假 token，預期 BadDeviceToken）");
console.log("第一次應較慢（TLS 握手），後續應共用連線");

const times: number[] = [];
for (let i = 0; i < 5; i++) {
  const t0 = performance.now();
  const r = await apnsClient.push({
    pushToken: fakeToken,
    pushMagic: "FAKE",
    topic,
  });
  const dt = performance.now() - t0;
  times.push(dt);
  console.log(
    `  #${i + 1}: ${dt.toFixed(1)}ms, status=${r.statusCode}, reason=${r.reason}`
  );
}

console.log("\n[並發] Promise.allSettled 10 個 push");
const t0 = performance.now();
const results = await Promise.allSettled(
  Array.from({ length: 10 }, () =>
    apnsClient.push({ pushToken: fakeToken, pushMagic: "FAKE", topic })
  )
);
const total = performance.now() - t0;
const success = results.filter(
  (r) => r.status === "fulfilled" && r.value.statusCode === 400
).length;
console.log(`  10 個併發 push 完成: ${total.toFixed(1)}ms, 成功往返=${success}/10`);
console.log(`  平均每個 ${(total / 10).toFixed(1)}ms`);

apnsClient.close();
