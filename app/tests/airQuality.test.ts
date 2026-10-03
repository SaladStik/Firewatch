import { test } from "node:test";
import assert from "node:assert/strict";
import { airAt, airLevel, airThreats } from "../src/data/airQuality.ts";
import type { DayWeather, WeatherGrid } from "../src/data/openMeteo.ts";
import { setProjection } from "../src/geo/projection.ts";

setProjection({ lat0: 54.5, lng0: -115, lat1: 49, lat2: 77 });

const day = (wind: number, windFrom = 270): DayWeather => ({
  temp: 28, rh: 20, wind, windNoon: wind, windFrom, rainMm: 0, daysSinceRain: 10,
  ffwi: 40, ffmc: 92, dmc: 40, dc: 250, isi: 12, bui: 50, fwi: 30, danger: "Very High", risk: 0.8,
});
const grid = (wind: number, windFrom = 270): WeatherGrid => ({
  lat0: 54, lng0: -116, step: 1.5, nLat: 2, nLng: 2, dates: ["2025-07-15"], pastDates: [], fetchedAt: "",
  cells: [0, 1, 2, 3].map((i) => ({
    lat: 54 + Math.floor(i / 2) * 1.5, lng: -116 + (i % 2) * 1.5,
    days: [day(wind, windFrom)], past: [], now: { temp: 28, rh: 20, wind, windFrom, rain: 0 },
  })),
});

const place = (name: string, lat: number, lng: number, pop = 5_000) =>
  ({ name, lat, lng, pop, region: 0 });

test("airLevel bands match smoke score thresholds", () => {
  assert.equal(airLevel(0.05).level, "Good");
  assert.equal(airLevel(0.3).level, "Moderate");
  assert.equal(airLevel(0.55).level, "High");
  assert.equal(airLevel(0.7).level, "Very High");
  assert.equal(airLevel(0.9).level, "Extreme");
  assert.ok(airLevel(0.5).aqhi >= 5);
});

test("airAt reports the clicked coordinates and a clear reading far from fire", () => {
  const reading = airAt(56.0, -110.0, {
    hotspots: [{ lat: 54.5, lng: -115.0, frp: 50 }],
    perimeters: [],
    weather: [grid(10, 0)],
    day: 0,
    spread: null,
  });
  assert.equal(reading.lat, 56.0);
  assert.equal(reading.lng, -110.0);
  assert.equal(reading.advisory, false);
  assert.equal(reading.reason, "clear");
});

test("a town downwind of a hot fire gets a smoke advisory", () => {
  // Wind from west (270) blows smoke east. Town is east of the fire.
  const threats = airThreats({
    places: [place("Smoke Town", 54.5, -114.7)],
    hotspots: [{ lat: 54.5, lng: -115.0, frp: 120 }],
    perimeters: [],
    weather: [grid(25, 270)],
    day: 0,
    spread: null,
  });
  assert.ok(threats.length >= 1);
  assert.match(threats[0].reason, /smoke/i);
  assert.ok(threats[0].score >= 0.28);
});

test("a far-away town with no fire is not listed", () => {
  const threats = airThreats({
    places: [place("Safe Town", 56.0, -110.0)],
    hotspots: [{ lat: 54.5, lng: -115.0, frp: 50 }],
    perimeters: [],
    weather: [grid(10, 0)],
    day: 0,
    spread: null,
  });
  assert.equal(threats.length, 0);
});

test("dry weather alone never triggers an air-quality alert", () => {
  const threats = airThreats({
    places: [place("Dry Town", 54.5, -115.0)],
    hotspots: [],
    perimeters: [],
    weather: [grid(5, 0)],
    day: 0,
    spread: null,
  });
  assert.equal(threats.length, 0);
});
