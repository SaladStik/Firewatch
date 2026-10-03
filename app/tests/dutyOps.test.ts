import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIncidents, type IncidentStatus } from "../src/data/incidents.ts";
import { evaluateWatchouts, type Watchout } from "../src/data/watchouts.ts";
import type { DayWeather, WeatherGrid } from "../src/data/openMeteo.ts";
import { project, setProjection } from "../src/geo/projection.ts";
import { worldToHex } from "../src/hex/hexMath.ts";
import type { GrowthField } from "../src/world/fireGrowth.ts";

setProjection({ lat0: 54.5, lng0: -115, lat1: 49, lat2: 77 });

const day = (fwi: number, rh = 40): DayWeather => ({
  temp: 28, rh, wind: 20, windNoon: 20, windFrom: 270, rainMm: 0, daysSinceRain: 10,
  ffwi: 40, ffmc: 92, dmc: 40, dc: 250, isi: 12, bui: 50, fwi, danger: "Very High", risk: 0.8,
});
const grid = (fwi: number, rh = 40): WeatherGrid => ({
  lat0: 55, lng0: -115, step: 1.5, nLat: 2, nLng: 2, dates: ["2025-07-15"], pastDates: [], fetchedAt: "",
  cells: [0, 1, 2, 3].map((i) => ({
    lat: 55 + Math.floor(i / 2) * 1.5, lng: -115 + (i % 2) * 1.5,
    days: [day(fwi, rh)], past: [], now: { temp: 28, rh, wind: 20, windFrom: 270, rain: 0 },
  })),
});

const place = (name: string, lat: number, lng: number, pop = 8_000) =>
  ({ name, lat, lng, pop, region: 0 });

test("buildIncidents lists an active perimeter with size and suggested status", () => {
  const now = Date.parse("2025-07-15T12:00:00Z");
  const list = buildIncidents({
    perimeters: [{
      id: "p1",
      firstDate: "2025-07-10T00:00:00Z",
      lastDate: "2025-07-15T00:00:00Z",
      areaHa: 3500,
      hotspotCount: 40,
      rings: [[[-114.8, 55.28], [-114.7, 55.28], [-114.7, 55.35], [-114.8, 55.35], [-114.8, 55.28]]],
      region: 0,
    }],
    hotspots: [],
    places: [place("Slave Lake", 55.28, -114.77)],
    weather: [grid(25)],
    day: 0,
    spread: null,
    growth: {},
    assets: [],
    overrides: {},
    now,
    focusRegions: new Set([0]),
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "sustained");
  assert.ok(list[0].areaHa >= 3000);
  assert.ok(list[0].name.includes("Slave Lake"));
});

test("operator override wins over suggested status", () => {
  const now = Date.parse("2025-07-15T12:00:00Z");
  const overrides: Record<string, IncidentStatus> = { p1: "contained" };
  const list = buildIncidents({
    perimeters: [{
      id: "p1",
      firstDate: "2025-07-10T00:00:00Z",
      lastDate: "2025-07-15T00:00:00Z",
      areaHa: 3500,
      hotspotCount: 40,
      rings: [[[-114.8, 55.28], [-114.7, 55.28], [-114.7, 55.35], [-114.8, 55.35], [-114.8, 55.28]]],
      region: 0,
    }],
    hotspots: [],
    places: [place("Slave Lake", 55.28, -114.77)],
    weather: [grid(25)],
    day: 0,
    spread: null,
    growth: {},
    assets: [],
    overrides,
    now,
    focusRegions: new Set([0]),
  });
  assert.equal(list[0].status, "contained");
  assert.equal(list[0].suggested, "sustained");
});

test("fwi_above watchout fires when FWI exceeds the threshold", () => {
  const watchouts: Watchout[] = [
    { id: "1", kind: "fwi_above", enabled: true, place: "Slave Lake", fwi: 20 },
  ];
  const hits = evaluateWatchouts({
    watchouts,
    places: [place("Slave Lake", 55.28, -114.77)],
    weather: [grid(28)],
    day: 0,
    spread: null,
    focusRegions: new Set([0]),
  });
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /FWI/);
});

test("path_reaches watchout fires when the town is in the growth field", () => {
  const w = project(55.28, -114.77);
  const size = 1;
  const h = worldToHex(w.x, w.z, size);
  const field: GrowthField = { size, cells: [h.q, h.r, 0] };
  const hits = evaluateWatchouts({
    watchouts: [{ id: "1", kind: "path_reaches", enabled: true, place: "Slave Lake" }],
    places: [place("Slave Lake", 55.28, -114.77)],
    weather: [grid(10)],
    day: 0,
    spread: field,
    focusRegions: new Set([0]),
  });
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /projected path/);
});

test("rh_below_by does not fire before the clock hour on today", () => {
  const morning = new Date();
  morning.setHours(10, 0, 0, 0);
  const hits = evaluateWatchouts({
    watchouts: [{ id: "1", kind: "rh_below_by", enabled: true, place: "Slave Lake", rh: 30, hour: 14 }],
    places: [place("Slave Lake", 55.28, -114.77)],
    weather: [grid(10, 20)],
    day: 0,
    spread: null,
    focusRegions: new Set([0]),
    now: morning.getTime(),
  });
  assert.equal(hits.length, 0);
});

test("rh_below_by fires after the clock hour when RH is low", () => {
  const afternoon = new Date();
  afternoon.setHours(15, 0, 0, 0);
  const hits = evaluateWatchouts({
    watchouts: [{ id: "1", kind: "rh_below_by", enabled: true, place: "Slave Lake", rh: 30, hour: 14 }],
    places: [place("Slave Lake", 55.28, -114.77)],
    weather: [grid(10, 20)],
    day: 0,
    spread: null,
    focusRegions: new Set([0]),
    now: afternoon.getTime(),
  });
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /RH/);
});
