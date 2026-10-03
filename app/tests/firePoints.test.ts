import { test } from "node:test";
import assert from "node:assert/strict";
import { setProjection } from "../src/geo/projection.ts";
import { PROJECTION } from "../src/config/regions.ts";
import { fireHotspots, heatClusters } from "../src/data/firePoints.ts";
import type { Hotspot } from "../src/data/cwfis.ts";

setProjection(PROJECTION);

const hs = (id: string, lat: number, lng: number, over: Partial<Hotspot> = {}): Hotspot => ({
  id, lat, lng, time: "2026-10-03T12:00:00Z", frp: 5, fwi: 10, hfi: 100, fuel: "farm", sensor: "VIIRS", agency: "AB", region: 0, ...over,
});
const reported = (id: string, lat: number, lng: number, stage: "out_of_control" | "being_held" | "under_control" = "out_of_control", sizeHa = 100) =>
  ({ id, lat, lng, sizeHa, stage, agency: "AB", statusDate: "2026-10-02T10:00:00" });

test("a weak farmland cluster with no reported fire is a farm burn and doesn't count as fire", () => {
  const farm = [hs("a", 50.2, -113.3), hs("b", 50.201, -113.301)];
  const c = heatClusters(farm, [], []);
  assert.equal(c.length, 1);
  assert.ok(c[0].likelyFarmOrControlledBurn);
  assert.deepEqual(fireHotspots(farm, [], []), []);
});

test("the same heat next to a reported fire counts", () => {
  const farm = [hs("a", 50.2, -113.3), hs("b", 50.201, -113.301)];
  const kept = fireHotspots(farm, [reported("F1", 50.21, -113.31)], []);
  assert.deepEqual(kept.map((h) => h.id).sort(), ["a", "b"]);
});

test("strong heat or forest heat counts even without a report", () => {
  assert.equal(fireHotspots([hs("a", 55, -115, { frp: 80 })], [], []).length, 1);
  assert.equal(fireHotspots([hs("a", 55, -115, { fuel: "C2" })], [], []).length, 1);
});

test("a burning reported fire no satellite saw becomes a fire point; under-control ones don't", () => {
  const pts = fireHotspots([], [reported("F1", 56, -116), reported("F2", 57, -117, "under_control")], []);
  assert.deepEqual(pts.map((h) => h.id), ["reported-F1"]);
  assert.equal(pts[0].sensor, "agency report");
});

test("demo hotspots always pass through", () => {
  const pts = fireHotspots([hs("s", 50.2, -113.3, { agency: "SIMULATION" })], [], []);
  assert.deepEqual(pts.map((h) => h.id), ["s"]);
});
