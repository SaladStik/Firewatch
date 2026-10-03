import { test } from "node:test";
import assert from "node:assert/strict";
import {
  distanceOf, headingOf, ORBIT_PER_S, PAN_PER_S, polarOf, stepCamera, TILT_PER_S, ZOOM_PER_S,
  type CameraLimits, type CameraKeyInput, type CameraPose,
} from "../src/render/cameraKeys.ts";

const LIMITS: CameraLimits = { minDist: 2.5, maxDist: 9000, minPolar: 0.15, maxPolar: 1.2 };

/** Camera 100 km south of the target and tilted, i.e. looking north. +Z is south. */
function pose(over: Partial<CameraPose> = {}): CameraPose {
  const phi = 0.7, r = 100;
  return {
    tx: 0, ty: 0, tz: 0,
    cx: 0, cy: r * Math.cos(phi), cz: r * Math.sin(phi),
    ...over,
  };
}
const keys = (over: Partial<CameraKeyInput> = {}): CameraKeyInput => ({ fwd: 0, side: 0, zoom: 0, mod: false, dt: 1, ...over });
const step = (p: CameraPose, over: Partial<CameraKeyInput> = {}) => stepCamera(p, keys(over), LIMITS);

test("no keys and no time change nothing", () => {
  const p = pose();
  assert.deepEqual(step(p), p);
  assert.deepEqual(stepCamera(p, keys({ fwd: 1, dt: 0 }), LIMITS), p);
});

test("the input pose is never mutated", () => {
  const p = pose();
  const copy = { ...p };
  step(p, { fwd: 1 });
  assert.deepEqual(p, copy);
});

test("forward drives the way the camera faces, back the other way", () => {
  const p = pose();
  // Looking north from the south, so forward is north: -Z.
  const fwd = step(p, { fwd: 1 });
  assert.ok(fwd.tz < 0, `expected north, got ${fwd.tz}`);
  assert.ok(Math.abs(fwd.tx) < 1e-9, "no sideways drift");
  assert.ok(step(p, { fwd: -1 }).tz > 0, "back goes south");
  // Speed is a fraction of the camera distance, so the feel holds at every zoom.
  assert.ok(Math.abs(-fwd.tz - PAN_PER_S * 100) < 1e-6, String(fwd.tz));
});

test("right drives east when facing north, and the camera comes along", () => {
  const p = pose();
  const right = step(p, { side: 1 });
  assert.ok(right.tx > 0, `expected east, got ${right.tx}`);
  assert.ok(Math.abs(right.tz) < 1e-9);
  assert.ok(step(p, { side: -1 }).tx < 0, "left goes west");
  // Panning moves target and camera together, so the view angle is untouched.
  assert.ok(Math.abs(right.cx - right.tx) < 1e-9);
  assert.ok(Math.abs(polarOf(right) - polarOf(p)) < 1e-9);
  assert.ok(Math.abs(distanceOf(right) - distanceOf(p)) < 1e-6);
});

test("panning is proportional to the time step", () => {
  const p = pose();
  const one = step(p, { fwd: 1, dt: 1 });
  const half = step(p, { fwd: 1, dt: 0.5 });
  assert.ok(Math.abs(one.tz / half.tz - 2) < 1e-9, `${one.tz} vs ${half.tz}`);
});

test("with a modifier, right turns the compass clockwise and left anticlockwise", () => {
  const p = pose();
  assert.ok(Math.abs(headingOf(p)) < 1e-9, "starts facing north");
  const right = step(p, { side: 1, mod: true });
  assert.ok(Math.abs(headingOf(right) - (ORBIT_PER_S * 180) / Math.PI) < 1e-6, String(headingOf(right)));
  assert.ok(headingOf(step(p, { side: -1, mod: true })) < 0, "left goes anticlockwise");
  // Orbiting keeps the distance and the tilt.
  assert.ok(Math.abs(distanceOf(right) - 100) < 1e-6);
  assert.ok(Math.abs(polarOf(right) - polarOf(p)) < 1e-9);
  // ...and it orbits rather than panning: the target stays put.
  assert.ok(Math.abs(right.tx) < 1e-9 && Math.abs(right.tz) < 1e-9);
});

test("with a modifier, up lifts towards a bird's-eye view and down drops to the horizon", () => {
  const p = pose();
  const up = step(p, { fwd: 1, mod: true, dt: 0.5 });
  const down = step(p, { fwd: -1, mod: true, dt: 0.5 });
  assert.ok(polarOf(up) < polarOf(p), "up reduces the angle from overhead");
  assert.ok(polarOf(down) > polarOf(p), "down increases it");
  assert.ok(Math.abs(polarOf(up) - (0.7 - TILT_PER_S * 0.5)) < 1e-9, String(polarOf(up)));
  // Tilting keeps the distance and the heading.
  assert.ok(Math.abs(distanceOf(up) - 100) < 1e-6);
  assert.ok(Math.abs(headingOf(up)) < 1e-6);
});

test("tilt stops at the same limits the mouse has", () => {
  // Hold up for a long time: it pins at straight-down, never past it.
  let p = pose();
  for (let i = 0; i < 60; i++) p = stepCamera(p, keys({ fwd: 1, mod: true, dt: 0.1 }), LIMITS);
  assert.ok(Math.abs(polarOf(p) - LIMITS.minPolar) < 1e-9, String(polarOf(p)));
  let q = pose();
  for (let i = 0; i < 60; i++) q = stepCamera(q, keys({ fwd: -1, mod: true, dt: 0.1 }), LIMITS);
  assert.ok(Math.abs(polarOf(q) - LIMITS.maxPolar) < 1e-9, String(polarOf(q)));
});

test("zoom moves along the view line, and stops at the limits", () => {
  const p = pose();
  const inward = step(p, { zoom: -1 });
  assert.ok(Math.abs(distanceOf(inward) - 100 / ZOOM_PER_S) < 1e-6, String(distanceOf(inward)));
  assert.ok(distanceOf(step(p, { zoom: 1 })) > 100, "minus zooms out");
  // Zooming keeps where you are looking and from which way.
  assert.ok(Math.abs(headingOf(inward)) < 1e-9);
  assert.ok(Math.abs(polarOf(inward) - polarOf(p)) < 1e-9);
  assert.ok(Math.abs(inward.tx) < 1e-9 && Math.abs(inward.tz) < 1e-9);

  let close = pose();
  for (let i = 0; i < 200; i++) close = stepCamera(close, keys({ zoom: -1, dt: 0.1 }), LIMITS);
  assert.ok(Math.abs(distanceOf(close) - LIMITS.minDist) < 1e-6, String(distanceOf(close)));
  let far = pose();
  for (let i = 0; i < 400; i++) far = stepCamera(far, keys({ zoom: 1, dt: 0.1 }), LIMITS);
  assert.ok(Math.abs(distanceOf(far) - LIMITS.maxDist) < 1e-6, String(distanceOf(far)));
});

test("zoom and pan on the same frame pan at the new distance", () => {
  const p = pose();
  const both = step(p, { zoom: -1, fwd: 1 });
  // Zoom is applied first, so the pan uses the closer distance rather than the old one.
  assert.ok(Math.abs(-both.tz - PAN_PER_S * (100 / ZOOM_PER_S)) < 1e-6, String(both.tz));
});

test("panning holds its direction after the view has been turned", () => {
  // Turn a quarter circle, then go forward: it should follow the new facing, not the old.
  let p = pose();
  const quarter = Math.PI / 2 / ORBIT_PER_S;
  p = stepCamera(p, keys({ side: 1, mod: true, dt: quarter }), LIMITS);
  assert.ok(Math.abs(headingOf(p) - 90) < 1e-6, String(headingOf(p)));
  const fwd = stepCamera(p, keys({ fwd: 1 }), LIMITS);
  // Facing west now, so forward is -X.
  assert.ok(fwd.tx < 0 && Math.abs(fwd.tz) < 1e-6, `${fwd.tx}, ${fwd.tz}`);
});

test("a target above sea level keeps its height while panning", () => {
  const p = pose({ ty: 2, cy: 2 + 100 * Math.cos(0.7) });
  const fwd = step(p, { fwd: 1 });
  assert.equal(fwd.ty, 2);
  assert.ok(Math.abs(distanceOf(fwd) - 100) < 1e-6);
});
