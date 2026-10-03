import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeTraffic } from "../src/data/traffic.ts";
import { BUSY_VOLUME, corridorThreats, exposure, QUIET_VOLUME } from "../src/data/trafficRisk.ts";
import type { DayWeather, WeatherGrid } from "../src/data/openMeteo.ts";
import { project, setProjection, unproject } from "../src/geo/projection.ts";

setProjection({ lat0: 54.5, lng0: -115, lat1: 49, lat2: 77 });

const day = (risk: number): DayWeather => ({
  temp: 20, rh: 30, wind: 0, windNoon: 0, windFrom: 0, rainMm: 0, daysSinceRain: 5,
  ffwi: 30, ffmc: 90, dmc: 30, dc: 200, isi: 8, bui: 40, fwi: 20, danger: "High", risk,
});
const grid = (risk: number): WeatherGrid => ({
  lat0: 54, lng0: -116, step: 1.5, nLat: 2, nLng: 2, dates: [], pastDates: [], fetchedAt: "",
  cells: [0, 1, 2, 3].map((i) => ({
    lat: 54 + Math.floor(i / 2) * 1.5, lng: -116 + (i % 2) * 1.5,
    days: [day(risk)], past: [], now: { temp: 0, rh: 0, wind: 0, windFrom: 0, rain: 0 },
  })),
});

/** One highway whose single sample point sits at 54.5 N, 115 W, carrying `volume` a day. */
const network = (n: string, volume: number) =>
  decodeTraffic({
    source: "Test", attribution: "Test", year: 2025, historyFrom: 2016, toleranceKm: 0.05, maxGapKm: 2, q: 1000,
    highways: [{ n, c: 0, aadt: volume, sadt: volume, cm: 24, lo: volume, hi: volume, km: 100, g: 0 }],
    points: [[0, 54_500, -115_000, 100, 10, 0, 100]],
  }, 0);

/** A point `dxKm` east of the highway. */
const at = (dxKm: number) => { const { x, z } = project(54.5, -115); return unproject(x + dxKm, z); };

const run = (nets: ReturnType<typeof network>[], hotspots: { lat: number; lng: number }[], risk = 0.4) =>
  corridorThreats({
    networks: nets, hotspots, perimeters: [], weather: [grid(risk)], day: 0,
    date: new Date(Date.UTC(2025, 6, 15)), boost: 1, spread: null,
  });

test("exposure spans the volume range and saturates at both ends", () => {
  assert.equal(exposure(QUIET_VOLUME), 0);
  assert.equal(exposure(0), 0);
  assert.equal(exposure(BUSY_VOLUME), 1);
  assert.equal(exposure(BUSY_VOLUME * 10), 1);
  assert.ok(exposure(5_000) > exposure(1_500));
});

test("no fires lists no corridors, however busy the road", () => {
  assert.equal(run([network("2", 100_000)], []).length, 0);
});

test("a nearby fire lists the corridor with its distance and direction; a far one doesn't", () => {
  const [near] = run([network("63", 20_000)], [at(10)]); // 10 km east
  assert.ok(near, "expected a corridor");
  assert.equal(near.highway.n, "63");
  assert.ok(/^fire 10 km E$/.test(near.reason), near.reason);
  assert.ok(Math.abs(near.nearKm - 10) < 0.5, String(near.nearKm));
  assert.equal(run([network("63", 20_000)], [at(80)]).length, 0);
});

test("at the same distance, the busier highway scores higher", () => {
  const [busy] = run([network("2", 40_000)], [at(10)]);
  const [quiet] = run([network("881", 700)], [at(10)]);
  assert.ok(busy && quiet, "expected both corridors");
  assert.ok(busy.score > quiet.score, `${busy.score} vs ${quiet.score}`);
});

test("dry weather alone never lists a road", () => {
  // The same weather that would list a town on fire danger alone (communityRisk.ts).
  assert.equal(run([network("2", 100_000)], [], 0.95).length, 0);
});

test("a long highway is one entry, reported at its closest approach to the fire", () => {
  // Two points on one highway: the fire sits beside the second.
  const net = decodeTraffic({
    source: "Test", attribution: "Test", year: 2025, historyFrom: 2016, toleranceKm: 0.05, maxGapKm: 2, q: 1000,
    highways: [{ n: "40", c: 0, aadt: 5_000, sadt: 5_000, cm: 10, lo: 5_000, hi: 5_000, km: 200, g: 0 }],
    points: [[0, 54_500, -115_000, 100, 500, 0, 100]], // second point 0.5° north
  }, 0);
  const north = unproject(project(55, -115).x, project(55, -115).z);
  const list = run([net], [{ lat: north.lat, lng: north.lng }]);
  assert.equal(list.length, 1);
  assert.ok(list[0].lat > 54.9, `reported at ${list[0].lat}`);
});

test("volumes are predicted for the day being scored, not just the measured average", () => {
  const net = decodeTraffic({
    source: "Test", attribution: "Test", year: 2025, historyFrom: 2016, toleranceKm: 0.05, maxGapKm: 2, q: 1000,
    highways: [{ n: "63", c: 0, aadt: 10_000, sadt: 14_000, cm: 24, lo: 10_000, hi: 10_000, km: 100, g: 0 }],
    points: [[0, 54_500, -115_000, 100, 10, 0, 100]],
  }, 0);
  const common = { networks: [net], hotspots: [at(8)], perimeters: [], weather: [grid(0.4)], day: 0, boost: 1, spread: null };
  const [summer] = corridorThreats({ ...common, date: new Date(Date.UTC(2025, 6, 15)) });
  const [winter] = corridorThreats({ ...common, date: new Date(Date.UTC(2025, 0, 15)) });
  assert.ok(summer && winter, "expected a corridor on both dates");
  assert.ok(summer.volume > winter.volume, `${summer.volume} vs ${winter.volume}`);
  // Clamped to the measured range, the summer figure still reads as the published summer average.
  assert.ok(Math.abs(summer.volume - 14_000) / 14_000 < 0.05, String(summer.volume));
});
