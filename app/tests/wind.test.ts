import { test } from "node:test";
import assert from "node:assert/strict";
import { WindField } from "../src/data/wind.ts";
import type { DayWeather, WeatherGrid } from "../src/data/openMeteo.ts";
import { project, setProjection } from "../src/geo/projection.ts";

// Centre the projection on the first grid cell so world (0, 0) is that cell.
setProjection({ lat0: 54.5, lng0: -115, lat1: 49, lat2: 77 });

const day = (wind: number, windFrom: number): DayWeather => ({ temp: 20, rh: 30, wind, windFrom, rainMm: 0, daysSinceRain: 5, ffwi: 20, risk: 0.2 });
/** One row of cells along latitude 54.5, 1.5° apart, starting at -115. */
const grid = (days: DayWeather[][]): WeatherGrid => ({
  lat0: 54.5, lng0: -115, step: 1.5, nLat: 1, nLng: days.length, dates: [], fetchedAt: "",
  cells: days.map((d, i) => ({ lat: 54.5, lng: -115 + i * 1.5, days: d, now: { temp: 0, rh: 0, wind: 0, windFrom: 0 } })),
});
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

test("WindField gives the cell's wind (blowing toward) at a grid point, for the chosen day", () => {
  const f = new WindField([grid([[day(5, 0), day(20, 270)], [day(5, 0), day(20, 270)]])], 1);
  const w = f.at(0, 0)!; // projection centre = first cell
  assert.ok(near(w.kmh, 20) && near(w.vx, 20) && near(w.vz, 0), JSON.stringify(w)); // from west → +X (east)
});

test("WindField interpolates between grid points", () => {
  const f = new WindField([grid([[day(10, 270)], [day(30, 270)]])], 0);
  const mid = project(54.5, -115 + 0.75);
  assert.ok(near(f.at(mid.x, mid.z)!.kmh, 20, 1e-3));
});

test("WindField is null outside every grid and treats missing wind as calm", () => {
  const f = new WindField([grid([[day(NaN, 90)], [day(10, NaN)]])], 0);
  assert.equal(f.at(5000, 5000), null);
  assert.ok(near(f.at(0, 0)!.kmh, 0));
});
