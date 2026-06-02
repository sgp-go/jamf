/**
 * Windows MDM 壓測模擬器（W5 P0）。
 *
 * 在服務層直接驅動四階段，量化吞吐 / 延遲 / 隊列消化 / webhook 投遞，
 * 找 DB 連線池、SyncML 隊列、webhook 推送的瓶頸。
 *
 * 四階段：
 *   1. enrollment 風暴   — enrollWindowsDevice × N（並發）
 *   2. 命令吞吐          — enqueueWindowsCommand × (N × K)，量 P50/P99 排入延遲
 *   3. 設備 poll 消化    — handleSyncMLRequest 最小 poll，走真實命令通道拉取 + 標 sent
 *   3b. usage 上報風暴   — upsertUsageStats × N，量每日高頻寫入（findFirst 基線 + upsert）
 *   4. webhook 風暴      — publishEvent × W + processDueDeliveries 投到本地 sink
 *
 * 用獨立 throwaway tenant 隔離，結束 CASCADE 清乾淨。
 *
 * 規模參數（env，預設小規模冒煙；真 1000 台手動調大）：
 *   LOAD_DEVICES=30 LOAD_COMMANDS_PER_DEVICE=3 LOAD_CONCURRENCY=16 LOAD_WEBHOOKS=100
 *
 * 跑：deno task load-test
 *
 * ⚠️ 簡化點（真 1000 台前補）：
 *   - 階段 3 只做單輪 poll（拉命令 + 標 sent），未做完整 cmdRef ACK 回灌
 *     （需雙輪往返 + inFlight 對齊，見 [[w4-task17-dummy-run]] / scripts/syncml-ack-sample.xml）
 *   - DB 連線池飽和度未直接探測（觀察 enqueue P99 + 錯誤率間接判斷）
 */

import { db } from "~/db/client.ts";
import { tenants } from "~/db/schema/tenants.ts";
import { selfMdmConfigs } from "~/db/schema/self-mdm.ts";
import { webhookEndpoints } from "~/db/schema/webhooks.ts";
import { eq } from "drizzle-orm";
import { enrollWindowsDevice, getMdmDevice } from "~/services/mdm/devices.ts";
import {
  enqueueWindowsCommand,
  handleSyncMLRequest,
} from "~/services/mdm/windows/command.ts";
import { buildReboot } from "~/services/mdm/windows/csp.ts";
import { upsertUsageStats } from "~/services/agent.ts";
import { publishEvent } from "~/services/webhooks/publisher.ts";
import { processDueDeliveries } from "~/services/webhooks/dispatcher.ts";

// ---- 規模參數 ----
function envInt(name: string, def: number): number {
  const v = parseInt(Deno.env.get(name) ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}
const DEVICES = envInt("LOAD_DEVICES", 30);
const COMMANDS_PER_DEVICE = envInt("LOAD_COMMANDS_PER_DEVICE", 3);
const CONCURRENCY = envInt("LOAD_CONCURRENCY", 16);
const WEBHOOKS = envInt("LOAD_WEBHOOKS", 100);

// ---- 指標工具 ----
interface PhaseMetric {
  name: string;
  count: number;
  errors: number;
  durationMs: number;
  p50?: number;
  p99?: number;
  max?: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/** 並發跑 items，收集每筆延遲 + 錯誤數。 */
async function runPool<T>(
  items: T[],
  worker: (item: T, index: number) => Promise<void>,
  concurrency: number,
): Promise<{ latencies: number[]; errors: number }> {
  const latencies: number[] = [];
  let errors = 0;
  let cursor = 0;
  async function lane() {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      const t0 = performance.now();
      try {
        await worker(items[i], i);
        latencies.push(performance.now() - t0);
      } catch (e) {
        errors++;
        if (errors <= 3) {
          console.error(`  [error] item ${i}:`, e instanceof Error ? e.message : e);
        }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, lane),
  );
  return { latencies, errors };
}

function summarize(
  name: string,
  durationMs: number,
  latencies: number[],
  errors: number,
): PhaseMetric {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    name,
    count: latencies.length,
    errors,
    durationMs,
    p50: percentile(sorted, 0.5),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

// ---- 本地 webhook sink ----
function startSink() {
  let received = 0;
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    async (req) => {
      await req.text();
      received++;
      return new Response("ok", { status: 200 });
    },
  );
  const port = (server.addr as Deno.NetAddr).port;
  return {
    url: `http://127.0.0.1:${port}/sink`,
    get received() {
      return received;
    },
    close: async () => {
      ac.abort();
      await server.finished;
    },
  };
}

// ---- 最小 device poll SyncML（觸發命令拉取，不做完整 ACK）----
function buildPollXml(windowsDeviceId: string, managementUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<SyncML xmlns="SYNCML:SYNCML1.2">
  <SyncHdr>
    <VerDTD>1.2</VerDTD><VerProto>DM/1.2</VerProto>
    <SessionID>1</SessionID><MsgID>1</MsgID>
    <Target><LocURI>${managementUrl}</LocURI></Target>
    <Source><LocURI>${windowsDeviceId}</LocURI></Source>
  </SyncHdr>
  <SyncBody>
    <Alert><CmdID>1</CmdID><Data>1201</Data></Alert>
    <Status><CmdID>2</CmdID><MsgRef>1</MsgRef><CmdRef>0</CmdRef><Cmd>SyncHdr</Cmd><Data>200</Data></Status>
    <Final/>
  </SyncBody>
</SyncML>`;
}

function fmt(n: number): string {
  return n.toFixed(1);
}

function printReport(phases: PhaseMetric[], extra: Record<string, string>) {
  console.log("\n========== 壓測報告 ==========");
  console.log(
    `規模：${DEVICES} 設備 × ${COMMANDS_PER_DEVICE} 命令 = ${DEVICES * COMMANDS_PER_DEVICE} cmd；${WEBHOOKS} webhook；並發 ${CONCURRENCY}\n`,
  );
  console.log(
    "階段".padEnd(20) +
      "成功".padStart(7) +
      "錯誤".padStart(6) +
      "耗時ms".padStart(10) +
      "吞吐/s".padStart(10) +
      "P50ms".padStart(9) +
      "P99ms".padStart(9) +
      "maxMs".padStart(9),
  );
  for (const p of phases) {
    const tput = p.durationMs > 0 ? (p.count / p.durationMs) * 1000 : 0;
    console.log(
      p.name.padEnd(20) +
        String(p.count).padStart(7) +
        String(p.errors).padStart(6) +
        fmt(p.durationMs).padStart(10) +
        fmt(tput).padStart(10) +
        fmt(p.p50 ?? 0).padStart(9) +
        fmt(p.p99 ?? 0).padStart(9) +
        fmt(p.max ?? 0).padStart(9),
    );
  }
  console.log("\n--- 其他指標 ---");
  for (const [k, v] of Object.entries(extra)) {
    console.log(`${k}: ${v}`);
  }
  console.log("==============================\n");
}

async function main() {
  console.log(
    `[load-test] 啟動，規模 ${DEVICES} 設備 / ${COMMANDS_PER_DEVICE} cmd每台 / ${WEBHOOKS} webhook`,
  );
  const rss0 = Deno.memoryUsage().rss;

  // ---- setup：throwaway tenant + self_mdm_config ----
  const stamp = `${performance.now()}`.replace(".", "");
  const [tenant] = await db
    .insert(tenants)
    .values({
      slug: `loadtest-${stamp}`,
      displayName: "load-test",
    })
    .returning({ id: tenants.id });
  const tenantId = tenant.id;
  const managementUrl = "http://127.0.0.1:3000/api/mdm/win/manage";

  const [cfg] = await db
    .insert(selfMdmConfigs)
    .values({
      tenantId,
      publicBaseUrl: managementUrl,
    })
    .returning({ id: selfMdmConfigs.id });

  const phases: PhaseMetric[] = [];
  const sink = startSink();

  try {
    // ---- 階段 1：enrollment 風暴 ----
    const deviceIdxs = Array.from({ length: DEVICES }, (_, i) => i);
    const enrolledUdids: string[] = new Array(DEVICES);
    const enrolledWinIds: string[] = new Array(DEVICES);
    let t0 = performance.now();
    const r1 = await runPool(
      deviceIdxs,
      async (_item, i) => {
        const udid = `lt-${stamp}-${i}`;
        const winId = `lt-win-${stamp}-${i}`;
        await enrollWindowsDevice({
          tenantId,
          selfMdmConfigId: cfg.id,
          udid,
          windowsDeviceId: winId,
          deviceName: `load-${i}`,
          osVersion: "10.0.19045",
        });
        enrolledUdids[i] = udid;
        enrolledWinIds[i] = winId;
      },
      CONCURRENCY,
    );
    phases.push(summarize("1.enroll", performance.now() - t0, r1.latencies, r1.errors));

    // ---- 階段 2：命令吞吐 ----
    const cmdJobs = enrolledUdids.flatMap((udid) =>
      Array.from({ length: COMMANDS_PER_DEVICE }, () => udid)
    );
    t0 = performance.now();
    const r2 = await runPool(
      cmdJobs,
      async (udid) => {
        await enqueueWindowsCommand({
          deviceUdid: udid,
          commandType: "Reboot",
          command: buildReboot(),
        });
      },
      CONCURRENCY,
    );
    phases.push(summarize("2.enqueue", performance.now() - t0, r2.latencies, r2.errors));

    // 等 fire-and-forget triggerWnsPush 收尾（mock 無 channel，極快）
    await new Promise((r) => setTimeout(r, 100));

    // ---- 階段 3：設備 poll 消化 ----
    let drained = 0;
    t0 = performance.now();
    const r3 = await runPool(
      enrolledWinIds,
      async (winId) => {
        const res = await handleSyncMLRequest({
          deviceId: winId,
          bodyXml: buildPollXml(winId, managementUrl),
          managementUrl,
        });
        if (res.status !== 200) {
          throw new Error(`poll 非 200: ${res.status}`);
        }
        // 粗略統計：回應含 Exec（Reboot）即視為拉到命令
        const hits = (res.body.match(/<Exec>/g) ?? []).length;
        drained += hits;
      },
      CONCURRENCY,
    );
    phases.push(summarize("3.poll", performance.now() - t0, r3.latencies, r3.errors));

    // ---- 階段 3b：usage 上報風暴（每日高頻寫入；測單調性基線 findFirst + upsert 組合） ----
    // 8000 台每日上報的最高頻 DB 寫入路徑。upsertUsageStats 每筆先 findFirst 取基線再
    // onConflictDoUpdate，量此「讀基線 + 寫」組合在並發下的吞吐 / P99。
    t0 = performance.now();
    const r3b = await runPool(
      enrolledUdids,
      async (udid) => {
        const device = await getMdmDevice(udid);
        if (!device) throw new Error(`device not found: ${udid}`);
        await upsertUsageStats({
          tenantId,
          deviceId: device.id,
          stats: [{
            date: "2026-06-02",
            totalMinutes: 120,
            pickup: 8,
            maxContinuous: 45,
          }],
        });
      },
      CONCURRENCY,
    );
    phases.push(summarize("3b.usage", performance.now() - t0, r3b.latencies, r3b.errors));

    // ---- 階段 4：webhook 風暴 ----
    await db.insert(webhookEndpoints).values({
      tenantId,
      url: sink.url,
      secret: "loadtest-secret-0123456789",
      eventTypes: [],
      isActive: true,
    });
    t0 = performance.now();
    const whJobs = Array.from({ length: WEBHOOKS }, (_, i) => i);
    const r4 = await runPool(
      whJobs,
      async (i) => {
        await publishEvent({
          tenantId,
          eventType: "command.completed",
          data: { command_id: `lt-cmd-${i}`, status: "acknowledged" },
        });
      },
      CONCURRENCY,
    );
    const publishMs = performance.now() - t0;
    phases.push(summarize("4a.publish", publishMs, r4.latencies, r4.errors));

    // 投遞（scheduler 真路徑）
    const t0d = performance.now();
    let totalProcessed = 0;
    for (let round = 0; round < 20; round++) {
      const { processed } = await processDueDeliveries({ limit: 200 });
      totalProcessed += processed;
      if (processed === 0) break;
    }
    phases.push({
      name: "4b.dispatch",
      count: totalProcessed,
      errors: 0,
      durationMs: performance.now() - t0d,
    });

    const rss1 = Deno.memoryUsage().rss;
    printReport(phases, {
      "命令拉取（poll 命中 Exec 數）": `${drained} / ${DEVICES * COMMANDS_PER_DEVICE} 排入`,
      "webhook sink 實收": `${sink.received} / ${WEBHOOKS}`,
      "RSS 記憶體": `${(rss0 / 1e6).toFixed(0)}MB → ${(rss1 / 1e6).toFixed(0)}MB (Δ${((rss1 - rss0) / 1e6).toFixed(0)}MB)`,
    });

    // 健康判斷
    const enqueueP99 = phases.find((p) => p.name === "2.enqueue")?.p99 ?? 0;
    const totalErrors = phases.reduce((s, p) => s + p.errors, 0);
    if (enqueueP99 > 500) {
      console.warn(`⚠️ 命令排入 P99=${fmt(enqueueP99)}ms 超 500ms 目標`);
    }
    if (totalErrors > 0) {
      console.warn(`⚠️ 共 ${totalErrors} 個錯誤`);
    }
    if (sink.received < WEBHOOKS) {
      console.warn(`⚠️ webhook 投遞缺口：sink 實收 ${sink.received} < ${WEBHOOKS}`);
    }
  } finally {
    await sink.close();
    // CASCADE 清乾淨（tenant 下所有 FK 皆 onDelete cascade）
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    console.log("[load-test] 清理完成，throwaway tenant 已刪除");
  }
}

if (import.meta.main) {
  await main();
}
