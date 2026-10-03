import { test } from "node:test";
import assert from "node:assert/strict";
import { firesReply } from "../src/agent/reply.ts";
import { spreadSources } from "../src/data/fireSpread.ts";
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

test("the quick fire answer splits official fires by agency and calls hotspots unconfirmed heat", () => {
  const heat = { hotspots: 38, clusters: 8, farm: 4 };
  const pc = (label: string, stage: string) => ({ label, stage, agency: "Parks Canada (national parks)" });
  const ab = firesReply({ fires: [pc("WB16", "out of control"), pc("WB8", "under control"), pc("WB6", "under control")], simulation: false, scope: "Alberta", heat, ownAgency: "Alberta Wildfire" });
  assert.equal(ab, "Alberta Wildfire reports no active wildfires in Alberta; Parks Canada reports 3 in national parks there (1 out of control, 2 under control). Top: WB16; WB8; and 1 more. Satellites also see 38 hotspots in the last 24 h (8 clusters): unconfirmed heat, not confirmed wildfires, and 4 look like farm or controlled burns.");
  const none = firesReply({ fires: [], simulation: false, scope: "Alberta", ownAgency: "Alberta Wildfire" });
  assert.match(none, /^Alberta Wildfire reports no active wildfires in Alberta\.$/);
  const hot = firesReply({ fires: [], simulation: false, scope: "Alberta", heat, ownAgency: "Alberta Wildfire", heatFirst: true });
  assert.match(hot, /^Alberta: satellites detected 38 hotspots in the last 24 h \(8 clusters\): unconfirmed heat/);
});

test("only out-of-control and being-held official fires are projected", () => {
  const fire = (stage: string, lat: number) => ({ lat, lng: -115, sizeHa: 500, stage });
  const src = spreadSources([fire("out_of_control", 55), fire("being_held", 56), fire("under_control", 57)], []);
  assert.deepEqual(src.map((s) => Math.round(s.lat)), [55, 56]);
  assert.ok(src.every((s) => s.kind === "reported" && s.r0 > 1));
});