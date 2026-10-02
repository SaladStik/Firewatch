import { test } from "node:test";
import assert from "node:assert/strict";
import { growthLookup, rateAtAngle, simulateGrowth, type GrowthDay } from "../src/world/fireGrowth.ts";
import { LandClass } from "../src/geo/landClass.ts";

const day = (wind: number, windFrom = 270): GrowthDay => ({ ffmc: 91, isi: 0, bui: 60, wind, windFrom, curing: 80, factor: 1 });
// ISI follows wind like the FWI System does (fine fuel moisture fixed by FFMC 91).
const withIsi = (d: GrowthDay): GrowthDay => ({ ...d, isi: 0.208 * Math.exp(0.05039 * d.wind) * 91.9 * Math.exp(-0.1386 * ((147.2 * 10) / 150.5)) * (1 + ((147.2 * 10) / 150.5) ** 5.31 / 4.93e7) });
const forest = () => LandClass.Forest;
const flat = () => 500;
const src = (days: GrowthDay[]) => [{ x: 0, z: 0, r0: 0.5, k: 1, days: days.map(withIsi) }];
const extent = (f: ReturnType<typeof simulateGrowth>, dirX: number, dirZ: number) => {
  const look = growthLookup(f);
  // Furthest projected hex along the direction (the existing fire itself isn't part of the projection).
  let far = 0;
  for (let d = 0; d < 300; d += 0.1) if (look(dirX * d, dirZ * d) >= 0) far = d;
  return far;
};

test("the FBP ellipse: head rate ahead, back rate behind", () => {
  assert.ok(Math.abs(rateAtAngle(10, 2, 3, 1) - 10) < 1e-9);
  assert.ok(Math.abs(rateAtAngle(10, 2, 3, -1) - 2) < 1e-9);
  // Sideways from the ignition point (the ellipse is offset downwind, so this can be below the back rate).
  const flank = rateAtAngle(10, 2, 3, 0);
  assert.ok(flank > 0 && flank < 10);
});

test("calm air spreads in every direction through fuel", () => {
  const f = simulateGrowth(src([day(0)]), 0, 0.3, forest, flat);
  const e = extent(f, 1, 0), w = extent(f, -1, 0), n = extent(f, 0, -1);
  assert.ok(e > 0.5 && w > 0.5 && n > 0.5, `${e} ${w} ${n}`);
  assert.ok(Math.abs(e - w) < 1, `roughly round: ${e} vs ${w}`);
});

test("wind pushes the head downwind; the back still creeps", () => {
  const f = simulateGrowth(src([day(30, 270)]), 0, 0.3, forest, flat); // from the west → runs east
  const east = extent(f, 1, 0), west = extent(f, -1, 0);
  assert.ok(east > west * 2, `east ${east} vs west ${west}`);
});

test("water is a fire break", () => {
  const land = (x: number) => (x > 1.5 && x < 3 ? LandClass.Water : LandClass.Forest);
  const f = simulateGrowth(src([day(30, 270), day(30, 270), day(30, 270)]), 2, 0.3, land, flat);
  const look = growthLookup(f);
  assert.equal(look(2.2, 0), -1); // the lake itself never burns
  assert.equal(look(5, 0), -1); // and nothing beyond it (it can't jump: no spotting)
  assert.ok(look(1, 0) >= 0);
});

test("forest spreads further than shrub in the same weather", () => {
  const fr = extent(simulateGrowth(src([day(20)]), 0, 0.3, forest, flat), 1, 0);
  const sh = extent(simulateGrowth(src([day(20)]), 0, 0.3, () => LandClass.Shrub, flat), 1, 0);
  assert.ok(fr > sh, `forest ${fr} vs shrub ${sh}`);
});
