import { assertEquals, assertThrows, assertMatch } from "jsr:@std/assert@^1";
import {
  buildUpdatePolicy,
  buildUpdateApprove,
  buildUpdateInstallableQuery,
  buildUpdateInstalledQuery,
  buildUpdatePendingRebootQuery,
} from "./csp-update.ts";

Deno.test("buildUpdatePolicy: 空輸入回傳空陣列", () => {
  assertEquals(buildUpdatePolicy({}), []);
});

Deno.test("buildUpdatePolicy: autoUpdate=4 對應 AllowAutoUpdate int", () => {
  const cmds = buildUpdatePolicy({ autoUpdate: 4 });
  assertEquals(cmds.length, 1);
  assertEquals(cmds[0].verb, "Replace");
  assertEquals(
    cmds[0].target,
    "./Device/Vendor/MSFT/Policy/Config/Update/AllowAutoUpdate",
  );
  assertEquals(cmds[0].format, "int");
  assertEquals(cmds[0].data, "4");
});

Deno.test("buildUpdatePolicy: scheduledDay + scheduledHour 配對", () => {
  const cmds = buildUpdatePolicy({ scheduledDay: 3, scheduledHour: 14 });
  assertEquals(cmds.length, 2);
  assertEquals(
    cmds[0].target,
    "./Device/Vendor/MSFT/Policy/Config/Update/ScheduledInstallDay",
  );
  assertEquals(cmds[0].data, "3");
  assertEquals(
    cmds[1].target,
    "./Device/Vendor/MSFT/Policy/Config/Update/ScheduledInstallTime",
  );
  assertEquals(cmds[1].data, "14");
});

Deno.test("buildUpdatePolicy: ActiveHours start/end/max 三個都寫", () => {
  const cmds = buildUpdatePolicy({
    activeHoursStart: 9,
    activeHoursEnd: 17,
    activeHoursMaxRange: 12,
  });
  assertEquals(cmds.length, 3);
  assertEquals(
    cmds.map((c) => c.target),
    [
      "./Device/Vendor/MSFT/Policy/Config/Update/ActiveHoursStart",
      "./Device/Vendor/MSFT/Policy/Config/Update/ActiveHoursEnd",
      "./Device/Vendor/MSFT/Policy/Config/Update/ActiveHoursMaxRange",
    ],
  );
  assertEquals(cmds.map((c) => c.data), ["9", "17", "12"]);
});

Deno.test("buildUpdatePolicy: scheduledHour 越界拋錯", () => {
  assertThrows(() => buildUpdatePolicy({ scheduledHour: 24 }), Error);
  assertThrows(() => buildUpdatePolicy({ scheduledHour: -1 }), Error);
});

Deno.test("buildUpdatePolicy: activeHoursMaxRange 越界 (<8 / >18) 拋錯", () => {
  assertThrows(() => buildUpdatePolicy({ activeHoursMaxRange: 7 }), Error);
  assertThrows(() => buildUpdatePolicy({ activeHoursMaxRange: 19 }), Error);
});

Deno.test("buildUpdatePolicy: defer Quality/Feature 各自 30/365 上限", () => {
  const ok = buildUpdatePolicy({ deferQualityDays: 30, deferFeatureDays: 365 });
  assertEquals(ok.length, 2);
  assertEquals(ok[0].data, "30");
  assertEquals(ok[1].data, "365");
  assertThrows(() => buildUpdatePolicy({ deferQualityDays: 31 }), Error);
  assertThrows(() => buildUpdatePolicy({ deferFeatureDays: 366 }), Error);
});

Deno.test("buildUpdatePolicy: pauseQuality/pauseFeature bool→0/1", () => {
  const cmds = buildUpdatePolicy({ pauseQuality: true, pauseFeature: false });
  assertEquals(cmds.length, 2);
  assertEquals(
    cmds[0].target,
    "./Device/Vendor/MSFT/Policy/Config/Update/PauseQualityUpdates",
  );
  assertEquals(cmds[0].data, "1");
  assertEquals(
    cmds[1].target,
    "./Device/Vendor/MSFT/Policy/Config/Update/PauseFeatureUpdates",
  );
  assertEquals(cmds[1].data, "0");
});

Deno.test("buildUpdateApprove: 合法 GUID → Add ApprovedUpdates 路徑 + ISO date", () => {
  const guid = "12345678-1234-1234-1234-123456789abc";
  const cmd = buildUpdateApprove(guid);
  assertEquals(cmd.verb, "Add");
  assertEquals(
    cmd.target,
    `./Device/Vendor/MSFT/Update/ApprovedUpdates/${guid}`,
  );
  assertEquals(cmd.format, "chr");
  // data 應為 ISO 日期前綴（YYYY-MM-DD）
  assertMatch(cmd.data ?? "", /^\d{4}-\d{2}-\d{2}$/);
});

Deno.test("buildUpdateApprove: 非 GUID 拋錯", () => {
  assertThrows(() => buildUpdateApprove("not-a-guid"), Error);
  assertThrows(() => buildUpdateApprove("12345"), Error);
});

Deno.test("buildUpdateInstallableQuery: Get ./Device/Vendor/MSFT/Update/InstallableUpdates", () => {
  const cmd = buildUpdateInstallableQuery();
  assertEquals(cmd.verb, "Get");
  assertEquals(cmd.target, "./Device/Vendor/MSFT/Update/InstallableUpdates");
});

Deno.test("buildUpdateInstalledQuery: Get ./Device/Vendor/MSFT/Update/InstalledUpdates", () => {
  const cmd = buildUpdateInstalledQuery();
  assertEquals(cmd.verb, "Get");
  assertEquals(cmd.target, "./Device/Vendor/MSFT/Update/InstalledUpdates");
});

Deno.test("buildUpdatePendingRebootQuery: Get PendingRebootUpdates", () => {
  const cmd = buildUpdatePendingRebootQuery();
  assertEquals(cmd.verb, "Get");
  assertEquals(cmd.target, "./Device/Vendor/MSFT/Update/PendingRebootUpdates");
});
