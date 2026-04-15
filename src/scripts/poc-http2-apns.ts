/**
 * PoC：用 Deno.createHttpClient + fetch + client cert 連 APNS
 * Deno 的 fetch 透過 createHttpClient 傳入 cert/key，底層會自動走 HTTP/2 + 長連線
 * 預期：TLS 握手成功，即便 device token 是假的，APNS 會回 400 BadDeviceToken
 */

const cert = Deno.readTextFileSync("certs/apns_cert.pem");
const key = Deno.readTextFileSync("certs/apns_key.pem");

const topic = Deno.env.get("APNS_TOPIC") ?? "com.apple.mgmt.External.FAKE";
const fakeToken = "0".repeat(64);

console.log("[PoC] 建立 HttpClient...");
// @ts-ignore Deno unstable API
const client = Deno.createHttpClient({ cert, key });

console.log("[PoC] 第一次請求（冷啟動，包含 TLS 握手）...");
const t0 = performance.now();
const r1 = await fetch(`https://api.push.apple.com/3/device/${fakeToken}`, {
  method: "POST",
  // @ts-ignore Deno fetch client option
  client,
  headers: {
    "apns-topic": topic,
    "apns-push-type": "mdm",
    "apns-priority": "10",
  },
  body: JSON.stringify({ mdm: "FAKE-PUSH-MAGIC" }),
});
const body1 = await r1.text();
const t1 = performance.now();
console.log(`[PoC] 1st: status=${r1.status}, body=${body1 || "(empty)"}, ${(t1 - t0).toFixed(1)}ms`);

console.log("[PoC] 第二次請求（應重用連線）...");
const t2 = performance.now();
const r2 = await fetch(`https://api.push.apple.com/3/device/${fakeToken}`, {
  method: "POST",
  // @ts-ignore
  client,
  headers: {
    "apns-topic": topic,
    "apns-push-type": "mdm",
    "apns-priority": "10",
  },
  body: JSON.stringify({ mdm: "FAKE-PUSH-MAGIC" }),
});
const body2 = await r2.text();
const t3 = performance.now();
console.log(`[PoC] 2nd: status=${r2.status}, body=${body2 || "(empty)"}, ${(t3 - t2).toFixed(1)}ms`);

console.log(`[PoC] 結論: 1st=${(t1-t0).toFixed(1)}ms vs 2nd=${(t3-t2).toFixed(1)}ms`);
console.log("[PoC] 若 2nd 明顯比 1st 快，代表連線重用成功");

client.close();
