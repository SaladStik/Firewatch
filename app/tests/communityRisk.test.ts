import { test } from "node:test";
import assert from "node:assert/strict";
import { communityThreats } from "../src/data/communityRisk.ts";
import type { DayWeather, WeatherGrid } from "../src/data/openMeteo.ts";
import { project, setProjection, unproject } from "../src/geo/projection.ts";

setProjection({ lat0: 54.5, lng0: -115, lat1: 49, lat2: 77 });

const day = (risk: number): DayWeather => ({ temp: 20, rh: 30, wind: 0, windFrom: 0, rainMm: 0, daysSinceRain: 5, ffwi: 30, risk });
const grid = (risk: number): WeatherGrid => ({
  lat0: 54, lng0: -116, step: 1.5, nLat: 2, nLng: 2, dates: [], fetchedAt: "",
  cells: [0, 1, 2, 3].map((i) => ({ lat: 54 + Math.floor(i / 2) * 1.5, lng: -116 + (i % 2) * 1.5, days: [day(risk)], now: { temp: 0, rh: 0, wind: 0, windFrom: 0, rain: 0 } })),
});
const town = { name: "Town", lat: 54.5, lng: -115, pop: 5000, region: 0 };
const at = (dxKm: number) => { const { x, z } = project(54.5, -115); return unproject(x + dxKm, z); };
const run = (risk: number, hotspots: { lat: number; lng: number }[]) =>
  communityThreats({ places: [town], hotspots, perimeters: [], weather: [grid(risk)], day: 0, boost: 1, spread: [] });

test("a quiet day lists nobody, even with moderate fire weather", () => {
  assert.equal(run(0.45, []).length, 0);
});

test("high fire weather alone lists a town", () => {
  const [t] = run(0.75, []);
  assert.equal(t?.reason, "high fire weather");
});

test("a nearby fire lists a town with its distance and direction; a far one doesn't", () => {
  const [near] = run(0.3, [at(10)]); // 10 km east of town
  assert.ok(near && /^fire 10 km E$/.test(near.reason), near?.reason);
  assert.equal(run(0.3, [at(80)]).length, 0);
});
