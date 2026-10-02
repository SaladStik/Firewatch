import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyGrowth, growthCalibration, modelRadialKm, reachScale, type FireHistory } from "../src/data/fireHistory.ts";
import type { DayWeather } from "../src/data/openMeteo.ts";
import { setProjection } from "../src/geo/projection.ts";

setProjection({ lat0: 54.5, lng0: -115, lat1: 49, lat2: 77 });

const wx = (risk: number, wind = 15): DayWeather => ({ temp: 25, rh: 25, wind, windFrom: 270, rainMm: 0, daysSinceRain: 6, ffwi: 40, risk });
const dates = ["2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"];
const hist = (growthKm: number[]): FireHistory => ({ id: "f", lastDate: "2026-10-01", days: dates.map((date, i) => ({ date, areaHa: 0, growthKm: growthKm[i] ?? 0 })) });

test("dailyGrowth scales to the perimeter's area and fills quiet days", () => {
  // 3 new cells on day 1, none on day 2, 1 new on day 3 (repeats of a cell don't count twice).
  const pts = [
    { rep_date: "2026-09-01T10:00:00Z", lat: 55.0, lon: -115.0 },
    { rep_date: "2026-09-01T11:00:00Z", lat: 55.0, lon: -114.99 },
    { rep_date: "2026-09-01T12:00:00Z", lat: 55.0, lon: -114.98 },
    { rep_date: "2026-09-01T13:00:00Z", lat: 55.0, lon: -115.0 },
    { rep_date: "2026-09-03T10:00:00Z", lat: 55.01, lon: -115.0 },
  ];
  const d = dailyGrowth(pts, 400);
  assert.deepEqual(d.map((x) => x.date), ["2026-09-01", "2026-09-02", "2026-09-03"]);
  assert.equal(Math.round(d[2].areaHa), 400);
  assert.equal(d[1].growthKm, 0);
  assert.ok(d[0].growthKm > 0 && d[2].growthKm > 0);
});

test("a fire growing faster than the model gets k > 1; a stalled one k < 1", () => {
  const past = dates.map(() => wx(0.5));
  const model = modelRadialKm(wx(0.5)); // km/day the model expects
  const fast = growthCalibration(hist(dates.map(() => model * 3)), past, dates);
  const stalled = growthCalibration(hist([model, model, model, model, 0, 0, 0].slice(0, 6).map((g, i) => (i < 4 ? model : 0))), past, dates);
  assert.ok(fast.k > 2, `fast k=${fast.k}`);
  assert.ok(stalled.k < 1, `stalled k=${stalled.k}`);
  assert.ok(fast.observedKmDay > fast.modelKmDay);
});

test("little history barely moves k (confidence)", () => {
  const past = dates.map(() => wx(0.5));
  const oneDay = growthCalibration(hist([0, 0, 0, 0, 0, 5]), past, dates);
  assert.ok(oneDay.confidence < 0.5 && oneDay.k < 2, `k=${oneDay.k} conf=${oneDay.confidence}`);
});

test("reach scale is gentle and bounded", () => {
  assert.equal(reachScale(1), 1);
  assert.equal(reachScale(100), 1.6);
  assert.equal(reachScale(0.01), 0.6);
});
