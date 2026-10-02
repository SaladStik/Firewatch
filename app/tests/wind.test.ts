import { test } from "node:test";
import assert from "node:assert/strict";
import { windVectors } from "../src/data/wind.ts";
import type { DayWeather, WeatherGrid } from "../src/data/openMeteo.ts";

const day = (wind: number, windFrom: number): DayWeather => ({ temp: 20, rh: 30, wind, windFrom, rainMm: 0, daysSinceRain: 5, ffwi: 20, risk: 0.2 });
const grid = (days: DayWeather[][]): WeatherGrid => ({
  lat0: 54.5, lng0: -115, step: 1.5, nLat: 1, nLng: days.length, dates: [], fetchedAt: "",
  cells: days.map((d, i) => ({ lat: 54.5, lng: -115 + i * 1.5, days: d, now: { temp: 0, rh: 0, wind: 0, windFrom: 0 } })),
});

test("windVectors points downwind for the chosen day", () => {
  const [v] = windVectors([grid([[day(5, 0), day(20, 270)]])], 1);
  assert.equal(v.kmh, 20);
  assert.ok(Math.abs(v.dx - 1) < 1e-9 && Math.abs(v.dz) < 1e-9, JSON.stringify(v)); // from west → blows east (+X)
  assert.ok(Math.abs(v.x) < 1e-9 && Math.abs(v.z) < 1e-9); // projection centre
});

test("windVectors skips cells with missing wind", () => {
  const vs = windVectors([grid([[day(NaN, 90)], [day(10, NaN)], [day(10, 90)]])], 0);
  assert.equal(vs.length, 1);
  assert.equal(vs[0].kmh, 10);
});
