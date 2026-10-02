import { test } from "node:test";
import assert from "node:assert/strict";
import { bui, dangerClass, fwi, fwiDay, isi, lengthToBreadthFbp, rateOfSpread, riskFromFwi, STARTUP } from "../src/data/cffdrs.ts";

const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;

// Van Wagner & Pickett (1985) / cffdrs reference test: April, from startup values,
// T 17 °C, RH 42 %, wind 25 km/h, no rain → FFMC 87.7, DMC 8.5, DC 19.0, ISI 10.9, BUI 8.5, FWI 10.1.
test("FWI System matches the published reference day", () => {
  const d = fwiDay(STARTUP, 17, 42, 25, 0, 4);
  assert.ok(near(d.ffmc, 87.7, 0.1), `FFMC ${d.ffmc}`);
  assert.ok(near(d.dmc, 8.5, 0.1), `DMC ${d.dmc}`);
  assert.ok(near(d.dc, 19.0, 0.1), `DC ${d.dc}`);
  assert.ok(near(d.isi, 10.9, 0.1), `ISI ${d.isi}`);
  assert.ok(near(d.bui, 8.5, 0.1), `BUI ${d.bui}`);
  assert.ok(near(d.fwi, 10.1, 0.1), `FWI ${d.fwi}`);
});

test("rain lowers the codes; dry heat raises them", () => {
  const wet = fwiDay({ ffmc: 90, dmc: 40, dc: 300 }, 15, 80, 10, 20, 7);
  const dry = fwiDay({ ffmc: 90, dmc: 40, dc: 300 }, 30, 15, 20, 0, 7);
  assert.ok(wet.ffmc < 90 && wet.dmc < 40 && wet.dc < 300);
  assert.ok(dry.ffmc > 90 && dry.dmc > 40 && dry.dc > 300 && dry.fwi > wet.fwi);
});

test("ISI, BUI, FWI are monotonic in their inputs", () => {
  assert.ok(isi(92, 30) > isi(92, 10) && isi(92, 10) > isi(80, 10));
  assert.ok(bui(60, 400) > bui(20, 400));
  assert.ok(fwi(20, 80) > fwi(10, 80));
});

test("danger classes and the map mapping line up", () => {
  assert.equal(dangerClass(3), "Low");
  assert.equal(dangerClass(25), "Very High");
  assert.ok(near(riskFromFwi(10), 0.5, 1e-9) && near(riskFromFwi(20), 0.68, 1e-9) && near(riskFromFwi(30), 0.85, 1e-9));
});

test("FBP: conifer spreads faster than deciduous; cured grass fastest; wind elongates", () => {
  assert.ok(rateOfSpread("C-2", 10, 60) > rateOfSpread("D-1", 10, 60));
  assert.ok(rateOfSpread("O-1b", 10, 60, 95) > rateOfSpread("O-1b", 10, 60, 30));
  assert.ok(lengthToBreadthFbp("C-2", 40) > lengthToBreadthFbp("C-2", 10) && lengthToBreadthFbp("C-2", 0) === 1);
});
