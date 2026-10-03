import { test } from "node:test";
import assert from "node:assert/strict";
import { firesReply } from "../src/agent/reply.ts";
import type { Hotspot } from "../src/data/cwfis.ts";
import { toReportedFire, type ReportedFire } from "../src/data/reportedFires.ts";
import { activeFires, briefing, crewRanking, fireList, type FactsSnapshot } from "../src/firefly/facts.ts";
import { setProjection } from "../src/geo/projection.ts";

setProjection({ lat0: 54.5, lng0: -115, lat1: 49, lat2: 77 });

const item = (o: Record<string, unknown> = {}) => ({
  national_fire_id: "2026_SK_25", agency_fire_id: "25", agency_code: "SK", fire_year: 2026, stage_of_control: "out_of_control",
  status_date: "2026-10-02T15:34:00", fire_size: 120, national_fire_cause: "natural", response_type: "full_response",
  fire_was_prescribed: 0, latitude: 55, longitude: -106, ...o,
});

test("toReportedFire keeps this season's unextinguished wildfires only", () => {
  assert.equal(toReportedFire(item(), 2026)?.stage, "out_of_control");
  assert.equal(toReportedFire(item({ fire_year: 2020 }), 2026), null, "stale record");
  assert.equal(toReportedFire(item({ fire_was_prescribed: 1 }), 2026), null, "prescribed burn");
  assert.equal(toReportedFire(item({ stage_of_control: "extinguished" }), 2026), null);
});

const hotspot = (lat: number, lng: number, fuel: string, frp: number, agency = "AB"): Hotspot =>
  ({ id: `${lat},${lng}`, lat, lng, time: new Date().toISOString(), frp, fwi: 7, hfi: 0, fuel, sensor: "VIIRS", agency });

const snap = (o: Partial<FactsSnapshot>): FactsSnapshot => ({
  places: [{ name: "Vegreville", lat: 53.5, lng: -112.05, pop: 5700, region: 0 }, { name: "Prince Albert", lat: 53.2, lng: -105.75, pop: 37000, region: 1 }],
  hotspots: [], perimeters: [], reported: [], reportedOk: true, weather: [], forecastDay: 0, simulation: false,
  spread: null, fireGrowth: {}, focus: new Set([0, 1]), regionNames: ["Alberta", "Saskatchewan"], now: Date.now(), ...o,
});

test("farm hotspots are heat detections, not active fires", () => {
  const s = snap({ hotspots: [hotspot(53.6, -112.1, "farm", 3.6), hotspot(53.61, -112.1, "farm", 5)] });
  assert.equal(activeFires(s).length, 0);
  const b = briefing(s);
  assert.equal(b.officialWildfires.total, 0);
  assert.equal(b.heatDetections.clusters, 1);
  assert.equal(b.heatDetections.likelyFarmOrControlledBurns, 1);
  assert.match(b.heatDetections.note, /unconfirmed/);
  assert.deepEqual(crewRanking(s, 3), []);
});

test("official fires are counted per stage and region; heat at them isn't flagged as farm", () => {
  const reported: ReportedFire[] = [
    { ...toReportedFire(item({ latitude: 53.3, longitude: -105.8 }), 2026)!, region: 1 },
    { ...toReportedFire(item({ national_fire_id: "2026_SK_26", stage_of_control: "under_control", fire_size: 10, latitude: 53.4, longitude: -105.5 }), 2026)!, region: 1 },
  ];
  const s = snap({ reported, hotspots: [hotspot(53.3, -105.8, "farm", 4, "SK")] });
  const b = briefing(s);
  assert.equal(b.officialWildfires.outOfControl.count, 1);
  assert.equal(b.officialWildfires.underControl.hectares, 10);
  assert.deepEqual(b.officialWildfires.byRegion.map((r) => r.outOfControl.count), [0, 1]);
  const list = fireList(s);
  assert.equal(list.officialFires[0].stage, "out of control");
  assert.equal(list.heatDetectionsTotal, 0, "heat at an official fire is folded into it");
  assert.equal(crewRanking(s, 1)[0].fire_id, "2026_SK_25");
});

test("demo fires count as simulated out-of-control fires", () => {
  const s = snap({ simulation: true, hotspots: [hotspot(53.6, -112.1, "C2", 120, "SIMULATION")] });
  const fires = activeFires(s);
  assert.equal(fires.length, 1);
  assert.ok(fires[0].simulated);
  assert.equal(briefing(s).officialWildfires.total, 0);
});

test("the rule brain's fire reply counts official fires and calls hotspots unconfirmed heat", () => {
  const none = firesReply([], false, "Alberta", { clusters: 8, farm: 4 });
  assert.match(none, /No active wildfires reported by the fire agencies in Alberta/);
  assert.match(none, /8 hotspot clusters: unconfirmed heat/);
  assert.match(none, /4 look like farm or controlled burns/);
  const some = firesReply([{ label: "WB16", stage: "out of control" }, { label: "WB8", stage: "under control" }], false, "Alberta");
  assert.match(some, /^2 active wildfires reported in Alberta \(1 out of control, 1 under control\): WB16; WB8\.$/);
});
