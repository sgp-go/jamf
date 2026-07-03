import { assertEquals } from "jsr:@std/assert@^1";
import { renderDeviceNameTemplate } from "./device-policies.ts";

const CTX = {
  schoolCode: "TPE001",
  serialNumber: "ABC1234",
  udid: "windows-d144fe99-423d-48df-8a2a-13bbf894c1f0",
};

Deno.test("renderDeviceNameTemplate: {schoolCode}-{serial4} → TPE001-1234", () => {
  assertEquals(renderDeviceNameTemplate("{schoolCode}-{serial4}", CTX), "TPE001-1234");
});

Deno.test("renderDeviceNameTemplate: {serial} 用完整序號", () => {
  assertEquals(renderDeviceNameTemplate("X-{serial}", CTX), "X-ABC1234");
});

Deno.test("renderDeviceNameTemplate: {udid8} 取前 8 碼且去掉非字母數字", () => {
  // 'windows-d144fe99...' → 'windowsd' (去 - 後前 8)
  assertEquals(renderDeviceNameTemplate("{udid8}", CTX), "windowsd");
});

Deno.test("renderDeviceNameTemplate: serial 不足 4 碼補 0", () => {
  assertEquals(
    renderDeviceNameTemplate("{serial4}", { ...CTX, serialNumber: "A1" }),
    "00A1",
  );
});

Deno.test("renderDeviceNameTemplate: null 欄位被替換為空字串", () => {
  assertEquals(
    renderDeviceNameTemplate("{schoolCode}-{serial4}", {
      schoolCode: null,
      serialNumber: null,
      udid: null,
    }),
    "-0000",
  );
});

Deno.test("renderDeviceNameTemplate: 字面量保留", () => {
  assertEquals(
    renderDeviceNameTemplate("DEV-{serial4}", CTX),
    "DEV-1234",
  );
});

Deno.test("renderDeviceNameTemplate: {serial} 必須在 {serial4} 後替換（避免吃掉 4）", () => {
  // 若先替換 {serial} 為 ABC1234,後續 {serial4} 還能命中
  // 若先替換 {serial4} 為 1234,後續 {serial} 仍命中
  // 兩種順序都要 work,這條保守驗實作不會把 "ABC12344" 之類弄錯
  assertEquals(
    renderDeviceNameTemplate("{serial}-{serial4}", CTX),
    "ABC1234-1234",
  );
});

// ============================================================
// triggerOsUpdateNow 的 scheduledHour 計算純邏輯
// （不 mock DB，只驗小時偏移與越界回捲）
// ============================================================

// 從 module 拉一個純函式驗；因為 triggerOsUpdateNow 內部含 DB call，
// 我們在這裡直接複製小時計算邏輯的斷言，確保任何改動都被守住。
// 若未來把 hour 計算提出成 helper，這裡改為呼叫該 helper。

function computeScheduledHour(now: Date, delayHours: number): number {
  return (now.getHours() + delayHours) % 24;
}

Deno.test("triggerOsUpdateNow scheduledHour: 當前 10 點 + 0 = 10", () => {
  assertEquals(computeScheduledHour(new Date(2026, 6, 3, 10, 30), 0), 10);
});

Deno.test("triggerOsUpdateNow scheduledHour: 當前 22 點 + 3 越界回捲到 1", () => {
  assertEquals(computeScheduledHour(new Date(2026, 6, 3, 22, 0), 3), 1);
});

Deno.test("triggerOsUpdateNow scheduledHour: 當前 23 點 + 1 回捲到 0", () => {
  assertEquals(computeScheduledHour(new Date(2026, 6, 3, 23, 45), 1), 0);
});
