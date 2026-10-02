import { test } from "node:test";
import assert from "node:assert/strict";
import { daysSinceRain, dryness, fireWeatherRisk, fosbergFFWI } from "../src/data/fosberg.ts";

test("fosbergFFWI matches the teammate's DHT11 station reading", () => {
  // Station showed 32.6 for 22.5 °C, 31 % RH, 15 mph (= 24.14 km/h).
  const v = fosbergFFWI(22.5, 31, 15 * 1.609344);
  assert.ok(Math.abs(v - 32.56) < 0.05, `got ${v}`);
});

test("fosbergFFWI is near zero when cool, humid and calm", () => {
  assert.ok(fosbergFFWI(10, 90, 0) < 2);
});

test("fosbergFFWI caps at 100", () => {
  assert.equal(fosbergFFWI(40, 5, 100), 100);
});

test("fosbergFFWI rises with wind", () => {
  assert.ok(fosbergFFWI(25, 30, 40) > fosbergFFWI(25, 30, 10));
});

test("daysSinceRain counts back to the last wetting-rain day", () => {
  assert.equal(daysSinceRain([0, 0, 5, 0, 0], 4), 2);
  assert.equal(daysSinceRain([0, 0, 5, 0, 0], 2), 0);
  assert.equal(daysSinceRain([0, 1.9, null, 0], 3), 4); // below 2 mm and null don't count
});

test("dryness goes from 0.6 on a rain day to 1.0 after 14 dry days", () => {
  assert.equal(dryness(0), 0.6);
  assert.ok(Math.abs(dryness(7) - 0.8) < 1e-9);
  assert.equal(dryness(14), 1);
  assert.equal(dryness(40), 1);
});

test("fireWeatherRisk = FFWI/100 × dryness, clamped to 1", () => {
  assert.ok(Math.abs(fireWeatherRisk(50, 14) - 0.5) < 1e-9);
  assert.ok(Math.abs(fireWeatherRisk(50, 0) - 0.3) < 1e-9);
  assert.equal(fireWeatherRisk(100, 30), 1);
});

test("fosbergFFWI treats missing inputs as no signal", () => {
  assert.equal(fosbergFFWI(20, NaN, 10), 0);
  assert.equal(fosbergFFWI(20, null as unknown as number, 10), 0);
});
