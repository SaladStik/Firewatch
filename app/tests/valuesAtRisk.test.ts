import { test } from "node:test";
import assert from "node:assert/strict";
import { CRITICAL_ASSETS, assetsForRegions } from "../src/data/criticalAssets.ts";
import { nearestFire, valuesAtRisk } from "../src/data/valuesAtRisk.ts";
import type { DayWeather, WeatherGrid } from "../src/data/openMeteo.ts";
import { setProjection } from "../src/geo/projection.ts";

setProjection({ lat0: 54.5, lng0: -115, lat1: 49, lat2: 77 });

const day = (wind: number, windFrom = 270): DayWeather => ({
  temp: 28, rh: 20, wind, windFrom, windNoon: wind, rainMm: 0, daysSinceRain: 10,
  ffwi: 40, ffmc: 92, dmc: 40, dc: 250, isi: 12, bui: 50, fwi: 30, danger: "Very High", risk: 0.8,
});
const grid = (wind: number, windFrom = 270): WeatherGrid => ({
  lat0: 54, lng0: -116, step: 1.5, nLat: 2, nLng: 2, dates: ["2025-07-15"], pastDates: [], fetchedAt: "",
  cells: [0, 1, 2, 3].map((i) => ({
    lat: 54 + Math.floor(i / 2) * 1.5, lng: -116 + (i % 2) * 1.5,
    days: [day(wind, windFrom)], past: [], now: { temp: 28, rh: 20, wind, windFrom, rain: 0 },
  })),
});

test("assetsForRegions only returns the focused province", () => {
  const ab = assetsForRegions(["alberta"]);
  assert.ok(ab.length > 10);
  assert.ok(ab.every((a) => a.regionId === "alberta"));
  assert.equal(assetsForRegions(["yukon"]).length, 0);
});

test("nearestFire prefers a nearby hotspot over the sector itself", () => {
  const focus = nearestFire(56.73, -111.38, [{ lat: 56.72, lng: -111.39, id: "h1", agency: "AB" }], []);
  assert.ok(focus);
  assert.equal(focus.label, "hotspot");
  assert.ok(Math.abs(focus.lat - 56.72) < 0.01);
});

test("nearestFire falls back to the sector when nothing is close", () => {
  const focus = nearestFire(49.0, -110.0, [{ lat: 58.0, lng: -118.0, id: "far", agency: "AB" }], []);
  assert.equal(focus?.label, "this sector");
});

test("valuesAtRisk lists a hospital within 40 km of a Fort McMurray fire", () => {
  const hospital = CRITICAL_ASSETS.find((a) => a.id === "ab-nlrh")!;
  const { items } = valuesAtRisk({
    lat: 56.73,
    lng: -111.38,
    assets: [hospital, { ...hospital, id: "far", lat: 51.0, lng: -114.0, name: "Far hospital" }],
    hotspots: [{ lat: 56.72, lng: -111.39, id: "h1", agency: "AB" }],
    perimeters: [],
    weather: [grid(20, 270)],
    day: 0,
    spread: null,
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].asset.id, "ab-nlrh");
  assert.ok(items[0].km < 40);
  assert.ok(items[0].reason.length > 0);
});

test("valuesAtRisk sorts hospitals ahead of power at similar distance", () => {
  const hospital = CRITICAL_ASSETS.find((a) => a.id === "ab-sl-health")!;
  const power = CRITICAL_ASSETS.find((a) => a.id === "ab-sl-power")!;
  const { items } = valuesAtRisk({
    lat: 55.28,
    lng: -114.77,
    assets: [power, hospital],
    hotspots: [{ lat: 55.28, lng: -114.77, id: "h1", agency: "AB" }],
    perimeters: [],
    weather: [grid(5, 0)],
    day: 0,
    spread: null,
  });
  assert.ok(items.length >= 2);
  // Same fire on top of both — hospital kind order wins when scores are close.
  const kinds = items.map((i) => i.asset.kind);
  assert.ok(kinds.indexOf("hospital") < kinds.indexOf("power"));
});
