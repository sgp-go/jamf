import { assertEquals } from "jsr:@std/assert@^1";
import {
  commandStatusToEvent,
  isInternalCommandType,
} from "./command-events.ts";

Deno.test("commandStatusToEvent: queued → command.queued", () => {
  assertEquals(commandStatusToEvent("queued"), "command.queued");
});

Deno.test("commandStatusToEvent: sent → command.sent", () => {
  assertEquals(commandStatusToEvent("sent"), "command.sent");
});

Deno.test("commandStatusToEvent: acknowledged → command.completed（非 acknowledged 事件）", () => {
  // Windows SyncML Status 200 = 命令完成，故映射 completed 而非 acknowledged
  assertEquals(commandStatusToEvent("acknowledged"), "command.completed");
});

Deno.test("commandStatusToEvent: error → command.failed", () => {
  assertEquals(commandStatusToEvent("error"), "command.failed");
});

Deno.test("commandStatusToEvent: 非終態狀態不上報（返回 null）", () => {
  assertEquals(commandStatusToEvent("not_now"), null);
  assertEquals(commandStatusToEvent("idle"), null);
  assertEquals(commandStatusToEvent("expired"), null);
});

Deno.test("isInternalCommandType: WNS / Poll 工具命令為內部命令", () => {
  assertEquals(isInternalCommandType("PushSetPfn"), true);
  assertEquals(isInternalCommandType("PushGetChannelUri"), true);
  assertEquals(isInternalCommandType("PollConfig"), true);
  assertEquals(isInternalCommandType("PollConfigReset"), true);
});

Deno.test("isInternalCommandType: 業務命令非內部命令", () => {
  assertEquals(isInternalCommandType("RemoteWipe"), false);
  assertEquals(isInternalCommandType("Reboot"), false);
  assertEquals(isInternalCommandType("msi_install"), false);
  assertEquals(isInternalCommandType("msi_status_query"), false);
  assertEquals(isInternalCommandType(""), false);
});
