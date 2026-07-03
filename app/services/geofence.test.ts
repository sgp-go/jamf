import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { isPointInPolygon } from "./geofence.ts";

// 以「北京 25 度到 40 度、東經 116 到 117」框個矩形 test polygon
// polygon 順序：SW → SE → NE → NW
const RECT_BEIJING = [
  { lat: 39.900, lng: 116.400 },
  { lat: 39.900, lng: 116.500 },
  { lat: 39.950, lng: 116.500 },
  { lat: 39.950, lng: 116.400 },
];

Deno.test("isPointInPolygon: 中心點在內", () => {
  assertEquals(isPointInPolygon(39.925, 116.450, RECT_BEIJING), true);
});

Deno.test("isPointInPolygon: 遠離 polygon 的點在外", () => {
  assertEquals(isPointInPolygon(40.000, 116.450, RECT_BEIJING), false);
  assertEquals(isPointInPolygon(39.925, 116.700, RECT_BEIJING), false);
});

Deno.test("isPointInPolygon: 邊界附近點（略偏內）算 inside", () => {
  assertEquals(isPointInPolygon(39.901, 116.401, RECT_BEIJING), true);
});

Deno.test("isPointInPolygon: 邊界附近點（略偏外）算 outside", () => {
  assertEquals(isPointInPolygon(39.899, 116.450, RECT_BEIJING), false);
  assertEquals(isPointInPolygon(39.925, 116.399, RECT_BEIJING), false);
});

// 非凸多邊形（L 型）驗算法對凹陷處
const L_SHAPE = [
  { lat: 0, lng: 0 },
  { lat: 0, lng: 10 },
  { lat: 5, lng: 10 },
  { lat: 5, lng: 5 },
  { lat: 10, lng: 5 },
  { lat: 10, lng: 0 },
];

Deno.test("isPointInPolygon: 非凸 L 形 — 內凹處(6,6)在外", () => {
  assertEquals(isPointInPolygon(6, 6, L_SHAPE), false);
});

Deno.test("isPointInPolygon: 非凸 L 形 — 左下(2,2)在內", () => {
  assertEquals(isPointInPolygon(2, 2, L_SHAPE), true);
});

Deno.test("isPointInPolygon: 非凸 L 形 — 上臂(2,7)在內", () => {
  assertEquals(isPointInPolygon(2, 7, L_SHAPE), true);
});

Deno.test("isPointInPolygon: 非凸 L 形 — 右臂(7,2)在內", () => {
  assertEquals(isPointInPolygon(7, 2, L_SHAPE), true);
});

Deno.test("isPointInPolygon: 頂點少於 3 個拋錯", () => {
  assertThrows(() => isPointInPolygon(0, 0, [
    { lat: 0, lng: 0 },
    { lat: 1, lng: 1 },
  ]), Error);
  assertThrows(() => isPointInPolygon(0, 0, []), Error);
});

Deno.test("isPointInPolygon: 順逆時針結果一致", () => {
  const reversed = [...RECT_BEIJING].reverse();
  assertEquals(
    isPointInPolygon(39.925, 116.450, RECT_BEIJING),
    isPointInPolygon(39.925, 116.450, reversed),
  );
});
