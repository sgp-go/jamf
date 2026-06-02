import { assertEquals } from "jsr:@std/assert@^1";
import {
  type CommandEventInput,
  type CommandEventPublisher,
  commandStatusToEvent,
  isInternalCommandType,
  publishCommandEvent,
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

// ---- publishCommandEvent 整合行為（注入 fake publisher 斷言推送） ----

interface Captured {
  tenantId: string;
  eventType: string;
  data: Record<string, unknown>;
}

function makeFakePublisher(opts?: { reject?: boolean }) {
  const calls: Captured[] = [];
  const publish: CommandEventPublisher = (o) => {
    calls.push({ tenantId: o.tenantId, eventType: o.eventType, data: o.data });
    return opts?.reject
      ? Promise.reject(new Error("boom"))
      : Promise.resolve({ deliveryIds: [], matched: 0 });
  };
  return { calls, publish };
}

const baseInput: CommandEventInput = {
  tenantId: "t1",
  deviceId: "d1",
  commandUuid: "c1",
  commandType: "RemoteWipe",
  status: "queued",
  platform: "windows",
  cspPath: null,
};

Deno.test("publishCommandEvent: 業務命令正常推送，payload 正確", () => {
  const { calls, publish } = makeFakePublisher();
  publishCommandEvent(baseInput, publish);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].eventType, "command.queued");
  assertEquals(calls[0].tenantId, "t1");
  assertEquals(calls[0].data.command_id, "c1");
  assertEquals(calls[0].data.device_id, "d1");
  assertEquals(calls[0].data.command_type, "RemoteWipe");
  assertEquals(calls[0].data.status, "queued");
  assertEquals(calls[0].data.platform, "windows");
});

Deno.test("publishCommandEvent: 內部命令跳過（不推送）", () => {
  const { calls, publish } = makeFakePublisher();
  publishCommandEvent({ ...baseInput, commandType: "PushSetPfn" }, publish);
  assertEquals(calls.length, 0);
});

Deno.test("publishCommandEvent: 非終態狀態跳過（not_now → null event）", () => {
  const { calls, publish } = makeFakePublisher();
  publishCommandEvent({ ...baseInput, status: "not_now" }, publish);
  assertEquals(calls.length, 0);
});

Deno.test("publishCommandEvent: publisher reject 不拋出（fire-and-forget 吞掉）", async () => {
  const { calls, publish } = makeFakePublisher({ reject: true });
  publishCommandEvent(baseInput, publish); // 同步調用不應拋
  assertEquals(calls.length, 1);
  // 等 microtask 讓 .catch 執行；若 catch 沒吞，Deno 會因 unhandled rejection fail 此測試
  await Promise.resolve();
  await Promise.resolve();
});
