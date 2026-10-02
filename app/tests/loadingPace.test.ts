import { test } from "node:test";
import assert from "node:assert/strict";
import { paceStep } from "../src/ui/loading/LoadingScreen.tsx";

const run = (t: (time: number) => number, seconds: number, dt = 1 / 60) => {
  let s = 0, v = 0;
  const out: { time: number; s: number; v: number; t: number }[] = [];
  for (let time = 0; time < seconds; time += dt) {
    const tt = t(time);
    ({ s, v } = paceStep(s, v, tt, dt));
    out.push({ time, s, v, t: tt });
  }
  return out;
};

test("a jump in progress becomes a speed-limited glide, not a jump", () => {
  const r = run(() => 0.6, 3);
  for (let i = 1; i < r.length; i++) assert.ok(r[i].s - r[i - 1].s <= (1 / 3.2) / 60 + 1e-9);
  assert.ok(r.at(-1)!.s > 0.5);
});

test("a stall slows it down smoothly; it keeps creeping but never runs ahead or finishes early", () => {
  const r = run((time) => (time < 1 ? time * 0.4 : 0.4), 20);
  const after = r.filter((x) => x.time > 1);
  for (let i = 1; i < after.length; i++) {
    assert.ok(after[i].s >= after[i - 1].s - 1e-12, "never goes backwards");
    assert.ok(after[i].s <= 0.4 + 0.025 + 1e-9, "never more than LEAD ahead");
    assert.ok(Math.abs(after[i].v - after[i - 1].v) < 0.01, "speed changes gradually (no dead stop)");
  }
  // Still moving a little a few seconds into the stall (creeping), and well short of done.
  const at = (sec: number) => after.find((x) => x.time > sec)!;
  assert.ok(at(4).s - at(3).s > 0, "creeps during a stall");
  assert.ok(r.at(-1)!.s < 0.99);
});

test("once loading is done it reaches 100% promptly", () => {
  const r = run((time) => (time < 0.5 ? 0.9 : 1), 6);
  assert.equal(r.at(-1)!.s, 1);
});
