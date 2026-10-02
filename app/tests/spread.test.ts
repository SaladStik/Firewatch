import { test } from "node:test";
import assert from "node:assert/strict";
import { downwind, MAX_REACH_SCALE, spreadInfluence, SPREAD_BASE_KM, SPREAD_MAX_KM } from "../src/world/spread.ts";

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test("wind FROM the north pushes fire south (+Z)", () => {
  const w = downwind(0, 20);
  assert.ok(near(w.dx, 0) && near(w.dz, 1), JSON.stringify(w));
});

test("wind FROM the west pushes fire east (+X)", () => {
  const w = downwind(270, 20);
  assert.ok(near(w.dx, 1) && near(w.dz, 0), JSON.stringify(w));
});

test("stretch grows with wind speed and saturates", () => {
  assert.equal(downwind(0, 0).stretch, 0);
  assert.ok(downwind(0, 20).stretch > 0);
  assert.equal(downwind(0, 40).stretch, downwind(0, 200).stretch);
});

test("calm air: plain circle of SPREAD_BASE_KM", () => {
  const calm = downwind(0, 0);
  assert.ok(near(spreadInfluence(15, 0, calm), 0.5));
  assert.ok(near(spreadInfluence(0, -15, calm), 0.5));
  assert.equal(spreadInfluence(SPREAD_BASE_KM + 1, 0, calm), 0);
});

test("strong west wind reaches further east than west", () => {
  const w = downwind(270, 40);
  assert.ok(spreadInfluence(40, 0, w) > 0); // 40 km downwind still affected
  assert.equal(spreadInfluence(-40, 0, w), 0); // 40 km upwind is not
  // SPREAD_MAX_KM is the search radius: the furthest a fire at the largest growth scale reaches.
  assert.ok(spreadInfluence(SPREAD_MAX_KM - 0.1, 0, { ...w, scale: MAX_REACH_SCALE }) > 0);
  assert.equal(spreadInfluence(SPREAD_MAX_KM + 0.1, 0, { ...w, scale: MAX_REACH_SCALE }), 0);
});

test("the hotspot's own cell has full influence", () => {
  assert.equal(spreadInfluence(0, 0, downwind(90, 30)), 1);
});
