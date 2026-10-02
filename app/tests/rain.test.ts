import { test } from "node:test";
import assert from "node:assert/strict";
import { blobDamping, blobRain, dayIntensity, nowIntensity, rainDamping, RainField, snowShare } from "../src/data/rain.ts";
import { growthSources } from "../src/data/fireSpread.ts";
import { growthLookup, simulateGrowth } from "../src/world/fireGrowth.ts";
import { LandClass } from "../src/geo/landClass.ts";
import type { DayWeather, WeatherGrid } from "../src/data/openMeteo.ts";
import { setProjection } from "../src/geo/projection.ts";

setProjection({ lat0: 54.5, lng0: -115, lat1: 49, lat2: 77 });

const day = (rainMm: number, risk = 0.6, temp = 25): DayWeather => ({ temp, rh: 20, wind: 20, windFrom: 270, rainMm, daysSinceRain: 10, ffwi: 50, risk });
const grid = (d: DayWeather[], nowRain = 0, nowTemp = 20): WeatherGrid => ({
  lat0: 54.5, lng0: -115, step: 1.5, nLat: 2, nLng: 2, dates: [], fetchedAt: "",
  cells: [0, 1, 2, 3].map((i) => ({ lat: 54.5 + Math.floor(i / 2) * 1.5, lng: -115 + (i % 2) * 1.5, days: d, now: { temp: nowTemp, rh: 30, wind: 10, windFrom: 270, rain: nowRain } })),
});

test("rain damping: none below 1 mm, stronger with more rain", () => {
  assert.equal(rainDamping(0), 1);
  assert.equal(rainDamping(0.5), 1);
  assert.ok(rainDamping(5) < 0.5 && rainDamping(15) < rainDamping(5));
  assert.equal(rainDamping(NaN), 1);
});

test("rain intensity from daily totals and live rates", () => {
  assert.equal(dayIntensity(0.5), 0);
  assert.equal(dayIntensity(30), 1);
  assert.equal(nowIntensity(0), 0);
  assert.ok(nowIntensity(1) > 0 && nowIntensity(10) === 1);
});

test("demo storm: full at the centre, gone at its radius, and it damps risk", () => {
  const b = [{ x: 0, z: 0, r: 50, intensity: 1 }];
  assert.equal(blobRain(b, 0, 0), 1);
  assert.equal(blobRain(b, 50, 0), 0);
  assert.ok(blobRain(b, 25, 0) > 0 && blobRain(b, 25, 0) < 1);
  assert.ok(Math.abs(blobDamping(1) - 0.15) < 1e-9);
});

test("RainField: today uses live rain; forecast days use the daily total; storms add on top", () => {
  assert.ok(new RainField([grid([day(0), day(0)], 2)], 0).at(0, 0) > 0); // raining now
  assert.equal(new RainField([grid([day(0), day(0)], 0)], 0).at(0, 0), 0); // dry now and today
  assert.ok(new RainField([grid([day(0), day(20)])], 1).at(0, 0) > 0.9); // wet tomorrow
  const dry = new RainField([grid([day(0)])], 0, [{ x: 0, z: 0, r: 40, intensity: 1 }]);
  assert.ok(dry.any && dry.at(0, 0) === 1);
});

test("snow: precipitation falls as snow at or below freezing, rain above 2 °C, mixed between", () => {
  assert.equal(snowShare(-5), 1);
  assert.equal(snowShare(0), 1);
  assert.equal(snowShare(1), 0.5);
  assert.equal(snowShare(3), 0);
  assert.equal(snowShare(NaN), 0);
  // Today by the live temperature; forecast days by the day's high. Demo storms stay rain.
  assert.equal(new RainField([grid([day(0), day(0)], 2, -4)], 0).snowAt(0, 0), 1);
  assert.equal(new RainField([grid([day(0), day(0)], 2, 12)], 0).snowAt(0, 0), 0);
  assert.equal(new RainField([grid([day(0), day(20, 0.6, -6)])], 1).snowAt(0, 0), 1);
  assert.equal(new RainField([grid([day(0)], 2, -4)], 0, [{ x: 0, z: 0, r: 40, intensity: 1 }]).snowAt(0, 0), 0);
});

test("a demo storm over a fire slows its projected growth", () => {
  const fire = [{ x: 0, z: 0, r0: 0.5, k: 1, lat: 54.5, lng: -115, kind: "hotspots" as const }];
  const wx = [grid([{ ...day(0), ffmc: 92, isi: 12, bui: 70 }])];
  const dry = growthSources(fire, wx, 0)[0].days[0];
  const wet = growthSources(fire, wx, 0, 1, () => [{ x: 0, z: 0, r: 60, intensity: 1 }])[0].days[0];
  assert.ok(wet.factor < dry.factor * 0.3, `${wet.factor} vs ${dry.factor}`);
  const reach = (d: typeof dry) => {
    const look = growthLookup(simulateGrowth([{ x: 0, z: 0, r0: 0.5, k: 1, days: [d] }], 0, 0.3, () => LandClass.Forest, () => 500));
    let far = 0;
    for (let x = 0; x < 50; x += 0.1) if (look(x, 0) >= 0) far = x;
    return far;
  };
  assert.ok(reach(wet) < reach(dry), `${reach(wet)} < ${reach(dry)}`);
});
