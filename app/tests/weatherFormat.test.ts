import { test } from "node:test";
import assert from "node:assert/strict";
import { compass, dayLabel } from "../src/ui/weatherFormat.ts";

test("compass maps degrees to 8 points", () => {
  assert.equal(compass(0), "N");
  assert.equal(compass(44), "NE");
  assert.equal(compass(180), "S");
  assert.equal(compass(302), "NW");
  assert.equal(compass(359), "N");
  assert.equal(compass(-90), "W");
});

test("dayLabel: day 0 is Now, missing dates fall back to +Nd", () => {
  assert.equal(dayLabel(0, ["2026-09-30"]), "Now");
  assert.equal(dayLabel(3), "+3d");
  assert.notEqual(dayLabel(1, ["2026-09-30", "2026-10-01"]), "+1d");
});
