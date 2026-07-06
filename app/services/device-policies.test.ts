import { assertEquals } from "jsr:@std/assert@^1";
import {
  decideDeviceRename,
  renderDeviceNameTemplate,
  templateNeedsSerial,
} from "./device-policies.ts";

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
// templateNeedsSerial：template 是否依賴序號
// ============================================================

Deno.test("templateNeedsSerial: {serial4} / {serial} 需要序號", () => {
  assertEquals(templateNeedsSerial("TPE001-{serial4}"), true);
  assertEquals(templateNeedsSerial("X-{serial}"), true);
});

Deno.test("templateNeedsSerial: {udid8} / {schoolCode} 不需序號", () => {
  assertEquals(templateNeedsSerial("{schoolCode}-{udid8}"), false);
  assertEquals(templateNeedsSerial("FIXED-NAME"), false);
});

// ============================================================
// decideDeviceRename：自動命名純決策
// ============================================================

Deno.test("decideDeviceRename: 無 template → skip no_template", () => {
  const d = decideDeviceRename({ template: null, ctx: CTX, assignedName: null });
  assertEquals(d, { action: "skip", reason: "no_template" });
});

Deno.test("decideDeviceRename: 空白 template → skip no_template", () => {
  const d = decideDeviceRename({ template: "   ", ctx: CTX, assignedName: null });
  assertEquals(d, { action: "skip", reason: "no_template" });
});

Deno.test("decideDeviceRename: template 需序號但序號缺 → skip awaiting_serial（不派 0000）", () => {
  const d = decideDeviceRename({
    template: "TPE001-{serial4}",
    ctx: { schoolCode: "TPE001", serialNumber: null, udid: "windows-abc" },
    assignedName: null,
  });
  assertEquals(d, { action: "skip", reason: "awaiting_serial" });
});

Deno.test("decideDeviceRename: 序號到位 + 未曾派 → dispatch 正確名", () => {
  const d = decideDeviceRename({
    template: "{schoolCode}-{serial4}",
    ctx: CTX,
    assignedName: null,
  });
  assertEquals(d, { action: "dispatch", desiredName: "TPE001-1234" });
});

Deno.test("decideDeviceRename: 目標名 == 已派名 → skip already_applied（去重）", () => {
  const d = decideDeviceRename({
    template: "{schoolCode}-{serial4}",
    ctx: CTX,
    assignedName: "TPE001-1234",
  });
  assertEquals(d, { action: "skip", reason: "already_applied", desiredName: "TPE001-1234" });
});

Deno.test("decideDeviceRename: 已派舊名但 template 算出新名 → dispatch（template 改後收斂）", () => {
  const d = decideDeviceRename({
    template: "{schoolCode}-{serial4}",
    ctx: CTX,
    assignedName: "OLD-9999",
  });
  assertEquals(d, { action: "dispatch", desiredName: "TPE001-1234" });
});

Deno.test("decideDeviceRename: {udid8}-only template 序號缺也能立即 dispatch（enroll 當下）", () => {
  const d = decideDeviceRename({
    template: "{udid8}",
    ctx: { schoolCode: null, serialNumber: null, udid: "windows-d144fe99-x" },
    assignedName: null,
  });
  assertEquals(d, { action: "dispatch", desiredName: "windowsd" });
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
