import { test } from "node:test";
import assert from "node:assert/strict";
import { capacity, decodeTraffic, jamLevel } from "../src/data/traffic.ts";
import { corridorThreats, scoreTraffic } from "../src/data/trafficRisk.ts";
import { EVAC_AT, evacSurges, SIM_CLOSURE_KM, SIM_TRAFFIC_BOOST, surgeTraffic, trafficScenario } from "../src/data/trafficSim.ts";
import type { CommunityThreat } from "../src/data/communityRisk.ts";
import type { DayWeather, WeatherGrid } from "../src/data/openMeteo.ts";
import { project, setProjection, unproject } from "../src/geo/projection.ts";

setProjection({ lat0: 54.5, lng0: -115, lat1: 49, lat2: 77 });

const day = (risk: number): DayWeather => ({
  temp: 20, rh: 30, wind: 0, windNoon: 0, windFrom: 0, rainMm: 0, daysSinceRain: 5,
  ffwi: 30, ffmc: 90, dmc: 30, dc: 200, isi: 8, bui: 40, fwi: 20, danger: "High", risk,
});
const grid = (risk: number): WeatherGrid => ({
  lat0: 54, lng0: -116, step: 1.5, nLat: 2, nLng: 2, dates: [], pastDates: [], fetchedAt: "",
  cells: [0, 1, 2, 3].map((i) => ({
    lat: 54 + Math.floor(i / 2) * 1.5, lng: -116 + (i % 2) * 1.5,
    days: [day(risk)], past: [], now: { temp: 0, rh: 0, wind: 0, windFrom: 0, rain: 0 },
  })),
});

/** A 20 km highway running north from 54.5 N, 115 W, measured at `volume` a day. */
const network = (volume: number, hi = volume) =>
  decodeTraffic({
    source: "Test", attribution: "Test", year: 2025, historyFrom: 2016, toleranceKm: 0.05, maxGapKm: 2, q: 1000,
    highways: [{ n: "63", c: 0, aadt: volume, sadt: volume, cm: 24, lo: volume, hi, km: 20, g: 0 }],
    // 11 points, 0.018° (~2 km) apart.
    points: [[0, 54_500, -115_000, 100, ...Array.from({ length: 10 }, () => [18, 0, 100]).flat()]],
  }, 0);

const threat = (pop: number, score: number, lat = 54.5, lng = -115): CommunityThreat => ({
  place: { name: "Town", lat, lng, pop, region: 0 }, score, reason: "test",
});
const at = (dxKm: number) => { const { x, z } = project(54.5, -115); return unproject(x + dxKm, z); };

const run = (nets: ReturnType<typeof network>[], hotspots: { lat: number; lng: number }[], sim: ReturnType<typeof trafficScenario> | null) =>
  scoreTraffic({
    networks: nets, hotspots, perimeters: [], weather: [grid(0.4)], day: 0,
    date: new Date(Date.UTC(2025, 6, 15)), boost: 1, spread: null, sim,
  });

test("capacity leaves an ordinary day free-flowing, and fails when demand doubles", () => {
  const deerfoot = { aadt: 15_027, hi: 172_440 };
  // The busiest stretch the province measured is not congested on a normal day...
  assert.equal(jamLevel(deerfoot.hi, capacity(deerfoot)), 0);
  // ...but an evacuation on top of it is.
  assert.equal(jamLevel(deerfoot.hi * 2, capacity(deerfoot)), 1);
  // A highway whose peak is its average still gets headroom above it.
  assert.ok(capacity({ aadt: 5_000, hi: 5_000 }) > 5_000);
});

test("congestion stays at zero until the road is near capacity, then comes on fast", () => {
  const cap = 10_000;
  assert.equal(jamLevel(5_000, cap), 0);
  assert.equal(jamLevel(6_000, cap), 0);
  assert.ok(jamLevel(8_000, cap) > 0 && jamLevel(8_000, cap) < 0.3);
  assert.equal(jamLevel(10_000, cap), 1);
  assert.equal(jamLevel(20_000, cap), 1);
  assert.equal(jamLevel(1_000, 0), 0);
});

test("only towns actually told to leave put cars on the road, scaled by the threat", () => {
  assert.equal(evacSurges([threat(50_000, EVAC_AT - 0.01)]).length, 0);
  assert.equal(evacSurges([threat(0, 1)]).length, 0);
  const [s] = evacSurges([threat(50_000, 1)]);
  assert.ok(s && s.vehPerDay > 10_000, String(s?.vehPerDay));
  // Half the threat, half the cars.
  const [half] = evacSurges([threat(50_000, 0.5)]);
  assert.ok(Math.abs(half.vehPerDay - s.vehPerDay * 0.5) < 1);
});

test("surges add up where two towns leave past the same point, and fade out with distance", () => {
  const one = evacSurges([threat(40_000, 1)]);
  const two = evacSurges([threat(40_000, 1), threat(40_000, 1)]);
  const { x, z } = project(54.5, -115);
  assert.ok(Math.abs(surgeTraffic(two, x, z) - 2 * surgeTraffic(one, x, z)) < 1);
  // Falls off away from the town, and is gone beyond the surge radius.
  assert.ok(surgeTraffic(one, x + 30, z) < surgeTraffic(one, x, z));
  assert.equal(surgeTraffic(one, x + 500, z), 0);
});

test("the scenario raises the volume on every corridor, fire or no fire", () => {
  const plain = run([network(8_000)], [at(10)], null).threats[0];
  const boosted = run([network(8_000)], [at(10)], { boost: SIM_TRAFFIC_BOOST, surges: [] }).threats[0];
  assert.ok(plain && boosted);
  assert.ok(Math.abs(boosted.volume / plain.volume - SIM_TRAFFIC_BOOST) < 0.01);
  assert.equal(boosted.surge, 0);
});

test("an evacuation loads the corridor next to the town it is leaving", () => {
  const sim = trafficScenario([threat(60_000, 1)]);
  const t = run([network(8_000)], [at(10)], sim).threats[0];
  assert.ok(t, "expected a corridor");
  assert.ok(t.surge > 5_000, String(t.surge));
  assert.ok(t.volume > 8_000 + t.surge * 0.5, `${t.volume} vs surge ${t.surge}`);
  // 8,000/day of capacity cannot absorb a town of 60,000 leaving.
  assert.equal(t.jam, 1);
});

test("fire on the road closes it, which outranks everything else", () => {
  const sim = trafficScenario([]);
  const t = run([network(8_000)], [at(SIM_CLOSURE_KM - 1)], sim).threats[0];
  assert.ok(t?.closed, "expected a closed corridor");
  assert.equal(t.reason, "closed by fire");
  assert.ok(t.score >= 0.95);
  // Nothing is closed without the scenario, however near the fire.
  assert.equal(run([network(8_000)], [at(SIM_CLOSURE_KM - 1)], null).threats[0].closed, false);
});

test("the field carries every point, whether or not a fire is near it", () => {
  // No fires at all: nothing is listed, but the map still has traffic to draw.
  const { threats, field } = run([network(8_000)], [], null);
  assert.equal(threats.length, 0);
  assert.equal(field.volume.length, 11);
  assert.ok(field.volume.every((v) => v > 0));
  assert.equal(field.routes.length, 1);
  assert.equal(field.routes[0].count, 11);
  assert.ok(field.routes[0].volume > 0);
  assert.equal(field.simulated, false);
  assert.ok(field.closed.every((c) => c === 0));
});

test("the field's route can be driven along, and a closure has an edge on it", () => {
  const sim = trafficScenario([]);
  // Fire beside the far end of the route only.
  const north = unproject(project(54.68, -115).x, project(54.68, -115).z);
  const { field } = run([network(8_000)], [{ lat: north.lat, lng: north.lng }], sim);
  const route = field.routes[0];
  // The length is measured off the projected geometry, not assumed from the nominal spacing.
  const span = field.length(route);
  assert.ok(Math.abs(span - 20) < 0.5, String(span));
  // Driving from one end to the other walks the geometry.
  const start = field.sample(route, 0), end = field.sample(route, span);
  assert.ok(end.z < start.z, "the route runs north");
  assert.ok(Math.abs(field.sample(route, span / 2).z - (start.z + end.z) / 2) < 1);
  // Past the end it clamps rather than running off the array.
  assert.equal(field.sample(route, span + 100).z, end.z);
  // The near end is open and the far end is shut, so a vehicle meets a stop line.
  assert.equal(field.sample(route, 0).closed, false);
  assert.equal(field.sample(route, span).closed, true);
});

test("corridorThreats still returns just the list", () => {
  const list = corridorThreats({
    networks: [network(8_000)], hotspots: [at(10)], perimeters: [], weather: [grid(0.4)],
    day: 0, date: new Date(Date.UTC(2025, 6, 15)), boost: 1, spread: null,
  });
  assert.ok(Array.isArray(list) && list.length === 1);
});
