import { assertEquals, assertMatch } from "jsr:@std/assert@^1";
import {
  buildLapsAdmxInstall,
  buildLapsClear,
  buildLapsRotation,
} from "~/services/mdm/windows/csp.ts";

// generateLapsPassword 在 laps.ts 中，但 laps.ts 頂層 import db client（需 DATABASE_URL）。
// 為避免非 DB 測試需要環境變數，用 dynamic import 延遲載入。
async function importLaps() {
  return await import("~/services/laps.ts");
}

// ── generateLapsPassword（需 env-file 跑）──────────────────────────────────

const hasDb = !!Deno.env.get("DATABASE_URL");

Deno.test({
  name: "generateLapsPassword: 預設長度 20",
  ignore: !hasDb,
  fn: async () => {
    const { generateLapsPassword } = await importLaps();
    assertEquals(generateLapsPassword().length, 20);
  },
});

Deno.test({
  name: "generateLapsPassword: 自訂長度",
  ignore: !hasDb,
  fn: async () => {
    const { generateLapsPassword } = await importLaps();
    assertEquals(generateLapsPassword(32).length, 32);
  },
});

Deno.test({
  name: "generateLapsPassword: 包含大寫、小寫、數字、符號",
  ignore: !hasDb,
  fn: async () => {
    const { generateLapsPassword } = await importLaps();
    const pwd = generateLapsPassword(40);
    assertMatch(pwd, /[A-Z]/);
    assertMatch(pwd, /[a-z]/);
    assertMatch(pwd, /[0-9]/);
    assertMatch(pwd, /[^A-Za-z0-9]/);
  },
});

Deno.test({
  name: "generateLapsPassword: 不包含 shell 危險字元",
  ignore: !hasDb,
  fn: async () => {
    const { generateLapsPassword } = await importLaps();
    for (let i = 0; i < 20; i++) {
      const pwd = generateLapsPassword();
      assertEquals(pwd.includes('"'), false);
      assertEquals(pwd.includes("'"), false);
      assertEquals(pwd.includes("`"), false);
      assertEquals(pwd.includes("\\"), false);
    }
  },
});

Deno.test({
  name: "generateLapsPassword: 每次呼叫結果不同",
  ignore: !hasDb,
  fn: async () => {
    const { generateLapsPassword } = await importLaps();
    const a = generateLapsPassword();
    const b = generateLapsPassword();
    assertEquals(a !== b, true);
  },
});

// ── CSP Builder: buildLapsAdmxInstall ────────────────────────────────────────

Deno.test("buildLapsAdmxInstall: verb=Add, target 含 LapsPolicy", () => {
  const cmd = buildLapsAdmxInstall();
  assertEquals(cmd.verb, "Add");
  assertEquals(cmd.format, "chr");
  assertMatch(cmd.target, /ADMXInstall\/CoGrowMDM\/Policy\/LapsPolicy$/);
  assertMatch(cmd.data!, /policyDefinitions/);
  assertMatch(cmd.data!, /LapsRotation/);
});

// ── CSP Builder: buildLapsRotation ───────────────────────────────────────────

Deno.test("buildLapsRotation: 產出正確 XML 片段", () => {
  const cmds = buildLapsRotation({
    newPassword: "Test!Pass123",
    adminAccount: "CogrowAdmin",
    rotationId: "aaaabbbb-cccc-dddd-eeee-ffffffffffff",
  });
  assertEquals(cmds.length, 1);
  assertEquals(cmds[0].verb, "Replace");
  assertMatch(cmds[0].target, /CoGrowMDM~Policy~CoGrowLaps\/LapsRotation$/);
  assertMatch(cmds[0].data!, /<enabled\/>/);
  assertMatch(cmds[0].data!, /id="NewPassword" value="Test!Pass123"/);
  assertMatch(cmds[0].data!, /id="AdminAccount" value="CogrowAdmin"/);
  assertMatch(cmds[0].data!, /id="RotationId" value="aaaabbbb-cccc-dddd-eeee-ffffffffffff"/);
});

Deno.test("buildLapsRotation: escapeAttr 處理特殊字元", () => {
  const cmds = buildLapsRotation({
    newPassword: '<script>alert("xss")</script>',
    adminAccount: "Admin&User",
    rotationId: "test-id",
  });
  const data = cmds[0].data!;
  assertEquals(data.includes("<script>"), false);
  assertMatch(data, /&lt;script/);
  assertMatch(data, /&quot;xss&quot;/);
  assertMatch(data, /Admin&amp;User/);
});

// ── CSP Builder: buildLapsClear ──────────────────────────────────────────────

Deno.test("buildLapsClear: 產出 disabled 片段", () => {
  const cmds = buildLapsClear();
  assertEquals(cmds.length, 1);
  assertEquals(cmds[0].verb, "Replace");
  assertEquals(cmds[0].data, "<disabled/>");
});

// ── buildLapsPendingActions（純函數，需 env-file 跑因 laps.ts 頂層 import db）──

Deno.test({
  name: "buildLapsPendingActions: 無 pending → 空陣列",
  ignore: !hasDb,
  fn: async () => {
    const { buildLapsPendingActions } = await importLaps();
    assertEquals(buildLapsPendingActions(null), []);
  },
});

Deno.test({
  name: "buildLapsPendingActions: pending → laps_rotation_pending 告知 action（不含密碼）",
  ignore: !hasDb,
  fn: async () => {
    const { buildLapsPendingActions } = await importLaps();
    const actions = buildLapsPendingActions({
      rotationId: "aaaabbbb-cccc-dddd-eeee-ffffffffffff",
      adminAccount: "Administrator",
    });
    assertEquals(actions.length, 1);
    assertEquals(actions[0].type, "laps_rotation_pending");
    assertEquals(actions[0].priority, 100);
    assertEquals(actions[0].data.rotationId, "aaaabbbb-cccc-dddd-eeee-ffffffffffff");
    assertEquals(actions[0].data.adminAccount, "Administrator");
    // 安全：action 不得攜帶密碼（密碼僅走 MDM CSP 通道）
    assertEquals("password" in actions[0].data, false);
    assertEquals("passwordEnc" in actions[0].data, false);
  },
});
