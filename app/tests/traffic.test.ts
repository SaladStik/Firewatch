import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeTraffic, predictVolume, seasonalFactor, trendFactor, type TrafficNetwork } from "../src/data/traffic.ts";
import { setProjection, unproject } from "../src/geo/projection.ts";

setProjection({ lat0: 54.5, lng0: -115, lat1: 49, lat2: 77 });

/** A one-highway file: two sample points 0.02° apart, the second carrying twice the average. */
const file = {
  source: "Test", attribution: "Test", year: 2025, historyFrom: 2016, spacingKm: 2, q: 1000,
  highways: [{ n: "63", c: 0, aadt: 10_000, sadt: 12_000, cm: 24, lo: 2_000, hi: 40_000, km: 400, g: 2 }],
  points: [[0, 54_500, -115_000, 100, 20, 0, 200]],
};

test("decoding restores each point's position and its own volume", () => {
  const net = decodeTraffic(structuredClone(file), 3);
  assert.equal(net.region, 3);
  assert.equal(net.hwy.length, 2);
  // First point absolute, second one delta'd 0.02° north. The arrays are Float32, so
  // compare to that precision rather than exactly.
  assert.ok(Math.abs(net.lat[0] - 54.5) < 1e-5 && Math.abs(net.lng[0] + 115) < 1e-5);
  assert.ok(Math.abs(net.lat[1] - 54.52) < 1e-5, String(net.lat[1]));
  // The stored percentage is of the highway average, so 100 → 10,000 and 200 → 20,000.
  assert.equal(net.aadt[0], 10_000);
  assert.equal(net.aadt[1], 20_000);
  // World coordinates agree with the projection the rest of the app uses.
  const back = unproject(net.x[1], net.z[1]);
  assert.ok(Math.abs(back.lat - 54.52) < 1e-6 && Math.abs(back.lng + 115) < 1e-6);
});

test("the seasonal curve reproduces the measured summer average, and averages out over the year", () => {
  const h = { aadt: 10_000, sadt: 12_000 };
  let summer = 0;
  for (let d = 152; d <= 243; d++) summer += seasonalFactor(h, d);
  // Alberta's summer average is a June-August mean, so that window must return sadt/aadt.
  assert.ok(Math.abs(summer / 92 - 1.2) < 1e-6, String(summer / 92));
  let year = 0;
  for (let d = 1; d <= 365; d++) year += seasonalFactor(h, d);
  assert.ok(Math.abs(year / 365 - 1) < 0.01, String(year / 365));
  // Mid-July is busier than mid-January.
  assert.ok(seasonalFactor(h, 196) > seasonalFactor(h, 15));
});

test("a highway with no summer uplift has no seasonal swing", () => {
  const flat = { aadt: 8_000, sadt: 8_000 };
  assert.equal(seasonalFactor(flat, 196), 1);
  assert.equal(seasonalFactor(flat, 15), 1);
});

test("growth compounds from the measured year and never extrapolates far", () => {
  assert.equal(trendFactor({ growth: 0 }, 2025, 2030), 1);
  assert.ok(Math.abs(trendFactor({ growth: 2 }, 2025, 2027) - 1.02 ** 2) < 1e-12);
  // Older data is carried forward, but only so far: 15 years is the cap.
  assert.equal(trendFactor({ growth: 2 }, 2000, 2100), 1.02 ** 15);
  // A date before the measured year is never projected backwards.
  assert.equal(trendFactor({ growth: 2 }, 2025, 2020), 1);
});

test("a predicted volume combines the point's own count with the season and the trend", () => {
  const net: TrafficNetwork = decodeTraffic(structuredClone(file), 0);
  const midJuly = new Date(Date.UTC(2027, 6, 15));
  const expected = 20_000 * seasonalFactor(net.highways[0], 196) * 1.02 ** 2;
  assert.ok(Math.abs(predictVolume(net, 1, midJuly) - expected) / expected < 0.02, String(predictVolume(net, 1, midJuly)));
  // Winter on the same stretch is quieter than summer.
  assert.ok(predictVolume(net, 1, new Date(Date.UTC(2027, 0, 15))) < predictVolume(net, 1, midJuly));
});
