/**
 * Geofence service（PRD §6 地理圍欄）
 *
 * 職責：
 *   1. point-in-polygon 算法（Ray casting，純 JS，不依賴 PostGIS）
 *   2. `checkGeofencesForDevice`：GPS 上報時 hook，對比 state 差異，發生 transition
 *      就 upsert state + publish webhook `device.geofence_enter` / `.geofence_exit`
 *
 * 為什麼不用 PostGIS：
 *   - 部署複雜度 vs 一台設備幾個 geofence 的算力需求不成比例
 *   - Ray casting O(n) 對 100 頂點也是微秒級
 *   - 學校規模一台設備通常 1-2 個 geofence，一次上報幾個算子跑完
 *
 * 座標約定：
 *   - lat / lng 使用 WGS84 度數（Agent Windows.Devices.Geolocation 原生格式）
 *   - polygon 頂點順序不敏感（順時針 / 逆時針皆可）
 *   - 首尾不必相同（算法自動閉合）
 */
import { and, eq } from "drizzle-orm";
import { db } from "~/db/client.ts";
import {
  deviceGeofenceAssignments,
  deviceGeofenceStates,
  geofences,
  GEOFENCE_STATUS,
  type GeofencePoint,
  type GeofenceStatus,
} from "~/db/schema/geofences.ts";
import { publishEvent } from "~/services/webhooks/index.ts";

// ============================================================
// point-in-polygon（Ray casting）
// ============================================================

/**
 * 判斷 (lat, lng) 是否在 polygon 內。
 *
 * Ray casting 算法：從點向 +x 方向發射水平射線，計算與多邊形邊的交點數；
 * 奇數 = inside，偶數 = outside。邊界情況（點在邊上）返 true（傾向 inside）。
 *
 * @param polygon 至少 3 個頂點；< 3 拋錯
 */
export function isPointInPolygon(
  lat: number,
  lng: number,
  polygon: GeofencePoint[],
): boolean {
  if (!Array.isArray(polygon) || polygon.length < 3) {
    throw new Error("isPointInPolygon: polygon 至少需 3 個頂點");
  }
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i, i++) {
    const xi = polygon[i].lng;
    const yi = polygon[i].lat;
    const xj = polygon[j].lng;
    const yj = polygon[j].lat;

    // 水平射線與 (i→j) 邊是否相交
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// ============================================================
// GPS 上報 hook
// ============================================================

interface GeofenceTransition {
  geofenceId: string;
  geofenceName: string;
  from: GeofenceStatus | null; // null = 首次落表（沒有前值）
  to: GeofenceStatus;
}

/**
 * Agent GPS 上報後呼叫。查該設備所有 active geofence assignment，
 * 對每個算 point-in-polygon → 對比舊 state → 有 transition 就 upsert + webhook。
 *
 * fire-and-forget 語意：呼叫者 `void checkGeofencesForDevice(...)`，任何錯誤不
 * 阻塞 GPS 上報主鏈路（webhook 漏了在死信隊列裡）。
 *
 * 回傳 transitions 供測試觀察；生產 caller 忽略即可。
 */
export async function checkGeofencesForDevice(input: {
  tenantId: string;
  deviceId: string;
  latitude: number;
  longitude: number;
  now?: Date;
}): Promise<GeofenceTransition[]> {
  const now = input.now ?? new Date();

  // 1. 取設備關聯的所有 active geofence
  const assigned = await db
    .select({
      id: geofences.id,
      name: geofences.name,
      polygon: geofences.polygon,
    })
    .from(deviceGeofenceAssignments)
    .innerJoin(
      geofences,
      and(
        eq(deviceGeofenceAssignments.geofenceId, geofences.id),
        eq(geofences.tenantId, input.tenantId),
        eq(geofences.isActive, true),
      ),
    )
    .where(eq(deviceGeofenceAssignments.deviceId, input.deviceId));

  if (assigned.length === 0) return [];

  const transitions: GeofenceTransition[] = [];

  for (const gf of assigned) {
    const nowInside = isPointInPolygon(input.latitude, input.longitude, gf.polygon);
    const nextStatus: GeofenceStatus = nowInside
      ? GEOFENCE_STATUS.INSIDE
      : GEOFENCE_STATUS.OUTSIDE;

    const [prev] = await db
      .select({ status: deviceGeofenceStates.status })
      .from(deviceGeofenceStates)
      .where(
        and(
          eq(deviceGeofenceStates.deviceId, input.deviceId),
          eq(deviceGeofenceStates.geofenceId, gf.id),
        ),
      )
      .limit(1);

    const prevStatus = (prev?.status ?? null) as GeofenceStatus | null;
    const changed = prevStatus !== nextStatus;

    if (prevStatus === null) {
      // 首次落表：不發 webhook（避免每次 assign 就發一次「outside」，噪音大）；
      // 只有真的 transition 才發。落 state 讓後續有基準對比。
      await db.insert(deviceGeofenceStates).values({
        tenantId: input.tenantId,
        deviceId: input.deviceId,
        geofenceId: gf.id,
        status: nextStatus,
        lastLatitude: String(input.latitude),
        lastLongitude: String(input.longitude),
        lastTransitionAt: now,
        lastCheckedAt: now,
      });
      transitions.push({
        geofenceId: gf.id,
        geofenceName: gf.name,
        from: null,
        to: nextStatus,
      });
      continue;
    }

    if (changed) {
      await db
        .update(deviceGeofenceStates)
        .set({
          status: nextStatus,
          lastLatitude: String(input.latitude),
          lastLongitude: String(input.longitude),
          lastTransitionAt: now,
          lastCheckedAt: now,
        })
        .where(
          and(
            eq(deviceGeofenceStates.deviceId, input.deviceId),
            eq(deviceGeofenceStates.geofenceId, gf.id),
          ),
        );

      const eventType =
        nextStatus === GEOFENCE_STATUS.INSIDE
          ? "device.geofence_enter"
          : "device.geofence_exit";

      void publishEvent({
        tenantId: input.tenantId,
        eventType,
        occurredAt: now,
        data: {
          device_id: input.deviceId,
          geofence_id: gf.id,
          geofence_name: gf.name,
          latitude: input.latitude,
          longitude: input.longitude,
          from_status: prevStatus,
          to_status: nextStatus,
        },
      }).catch((err) => {
        console.error(
          `[geofence] publishEvent failed device=${input.deviceId} geofence=${gf.id}`,
          err,
        );
      });

      transitions.push({
        geofenceId: gf.id,
        geofenceName: gf.name,
        from: prevStatus,
        to: nextStatus,
      });
    } else {
      // 狀態未變，只更新 lastCheckedAt（幫助判斷「多久沒動」）
      await db
        .update(deviceGeofenceStates)
        .set({ lastCheckedAt: now })
        .where(
          and(
            eq(deviceGeofenceStates.deviceId, input.deviceId),
            eq(deviceGeofenceStates.geofenceId, gf.id),
          ),
        );
    }
  }

  return transitions;
}
