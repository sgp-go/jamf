/**
 * Dummy device CLI（W4 task 17 dangerous-paths 預備）
 *
 * 直接 DB insert / delete 假設備，繞過 enroll 流程，避免危險端點（Wipe / Lock /
 * DELETE 解纳管 / OMA-DM webhook 全鏈）誤觸真機 task 57。
 *
 * Dummy 識別：enrollmentType="dummy"。命令 enqueue 端仍會把 row 寫進
 * mdm_commands，但 APNS / WNS push 對假 udid / pushToken 失敗在所難免——
 * 我們只在乎「server 路徑能跑到 enqueue + 返回正確 status」，不期待真送達。
 *
 * 用法：
 *   deno run -A --env-file=.env scripts/dummy-device.ts create \
 *     --tenant 00000000-0000-0000-0000-000000000000 \
 *     --platform windows \
 *     --name "DUMMY-WIN-01"
 *
 *   deno run -A --env-file=.env scripts/dummy-device.ts list \
 *     --tenant 00000000-0000-0000-0000-000000000000
 *
 *   deno run -A --env-file=.env scripts/dummy-device.ts delete \
 *     --id <device-uuid>
 *
 *   deno run -A --env-file=.env scripts/dummy-device.ts clear \
 *     --tenant 00000000-0000-0000-0000-000000000000
 *     (刪掉 tenant 下所有 enrollmentType="dummy" 設備)
 */
import { parseArgs } from "jsr:@std/cli@^1/parse-args";
import { and, eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import { mdmDevices } from "~/db/schema/devices.ts";

interface ParsedArgs {
  _: (string | number)[];
  tenant?: string;
  platform?: string;
  name?: string;
  id?: string;
  help?: boolean;
}

function usage(): void {
  console.log(`Usage:
  dummy-device.ts create --tenant <uuid> --platform <apple|windows> [--name <name>]
  dummy-device.ts list   --tenant <uuid>
  dummy-device.ts delete --id <uuid>
  dummy-device.ts clear  --tenant <uuid>
`);
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    string: ["tenant", "platform", "name", "id"],
    boolean: ["help"],
    alias: { h: "help" },
  }) as ParsedArgs;

  const action = args._[0];
  if (args.help || !action) {
    usage();
    return;
  }

  switch (action) {
    case "create":
      await create(args);
      break;
    case "list":
      await list(args);
      break;
    case "delete":
      await del(args);
      break;
    case "clear":
      await clear(args);
      break;
    default:
      console.error(`Unknown action: ${action}`);
      usage();
      Deno.exit(2);
  }
}

async function create(args: ParsedArgs): Promise<void> {
  if (!args.tenant) throw new Error("--tenant required");
  if (!args.platform || !["apple", "windows"].includes(args.platform)) {
    throw new Error("--platform must be apple|windows");
  }

  const platform = args.platform as "apple" | "windows";
  const ts = Date.now();
  const name = args.name ?? `DUMMY-${platform.toUpperCase()}-${ts}`;
  const fakeUdid =
    platform === "apple"
      ? `DUMMY-APPLE-${ts}` // Apple UDID 通常 40 char hex；用 prefix 標明
      : `DUMMY-WIN-${ts}`;
  const fakeSerial = `DMY${ts.toString().slice(-9)}`;

  const [row] = await db
    .insert(mdmDevices)
    .values({
      tenantId: args.tenant,
      platform,
      udid: fakeUdid,
      serialNumber: fakeSerial,
      deviceName: name,
      model: "DUMMY",
      osVersion: platform === "apple" ? "17.0" : "10.0.19045.0",
      enrollmentType: "dummy",
      enrollmentStatus: "enrolled",
      selfMdmManaged: true,
      lastSeenAt: new Date(),
    })
    .returning();

  console.log("Created dummy device:");
  console.log(JSON.stringify(row, null, 2));
}

async function list(args: ParsedArgs): Promise<void> {
  if (!args.tenant) throw new Error("--tenant required");
  const rows = await db
    .select({
      id: mdmDevices.id,
      platform: mdmDevices.platform,
      deviceName: mdmDevices.deviceName,
      udid: mdmDevices.udid,
      serialNumber: mdmDevices.serialNumber,
      enrollmentType: mdmDevices.enrollmentType,
      createdAt: mdmDevices.createdAt,
    })
    .from(mdmDevices)
    .where(
      and(
        eq(mdmDevices.tenantId, args.tenant),
        eq(mdmDevices.enrollmentType, "dummy"),
      ),
    );

  if (rows.length === 0) {
    console.log("(no dummy devices)");
    return;
  }
  console.log(`${rows.length} dummy device(s):`);
  for (const r of rows) {
    console.log(`  ${r.id}  ${r.platform.padEnd(7)}  ${r.deviceName}  udid=${r.udid}`);
  }
}

async function del(args: ParsedArgs): Promise<void> {
  if (!args.id) throw new Error("--id required");

  // 安全閥：不允許刪非 dummy device
  const existing = await db.query.mdmDevices.findFirst({
    where: eq(mdmDevices.id, args.id),
    columns: { id: true, enrollmentType: true, deviceName: true },
  });
  if (!existing) {
    console.error(`Device ${args.id} not found`);
    Deno.exit(1);
  }
  if (existing.enrollmentType !== "dummy") {
    console.error(
      `Device ${args.id} (${existing.deviceName}) is NOT dummy (enrollmentType=${existing.enrollmentType}); refusing to delete via dummy CLI`,
    );
    Deno.exit(1);
  }

  await db.delete(mdmDevices).where(eq(mdmDevices.id, args.id));
  console.log(`Deleted dummy device ${args.id}`);
}

async function clear(args: ParsedArgs): Promise<void> {
  if (!args.tenant) throw new Error("--tenant required");

  const rows = await db
    .delete(mdmDevices)
    .where(
      and(
        eq(mdmDevices.tenantId, args.tenant),
        eq(mdmDevices.enrollmentType, "dummy"),
      ),
    )
    .returning({ id: mdmDevices.id });

  console.log(`Deleted ${rows.length} dummy device(s)`);
}

main()
  .then(() => Deno.exit(0)) // postgres-js pool keeps connections alive; force exit
  .catch((err) => {
    console.error(err);
    Deno.exit(1);
  });
