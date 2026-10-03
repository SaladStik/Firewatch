import { test } from "node:test";
import assert from "node:assert/strict";
import { needsModel, planRequest } from "../src/agent/rules.ts";
import { explainReply, renderReply, UNKNOWN_REPLY } from "../src/agent/reply.ts";
import type { Brief, BriefPlace, ExplainFacts, Plan } from "../src/agent/types.ts";
import type { Layers } from "../src/state/app.ts";

const layers = (over: Partial<Layers> = {}): Layers => ({
  risk: true, fires: true, spread: true, traffic: true, beacons: true, wind: false, rain: true, bloom: false, ...over,
});

function place(over: Partial<BriefPlace> & Pick<BriefPlace, "name">): BriefPlace {
  return {
    lat: 51, lng: -114, pop: 10_000, regionId: "alberta", regionIndex: 0, landmark: false, focused: true, ...over,
  };
}

function brief(over: Partial<Brief> = {}): Brief {
  return {
    focusIds: ["alberta"],
    regions: [
      { id: "alberta", name: "Alberta", code: "AB", index: 0 },
      { id: "british-columbia", name: "British Columbia", code: "BC", index: 1 },
    ],
    forecastDay: 0,
    today: "2026-10-02",
    layers: layers(),
    simulation: false,
    dataStatus: { cwfis: "ok", weather: "ok" },
    places: [
      place({ name: "Calgary", pop: 1_300_000, lat: 51.05, lng: -114.07 }),
      place({ name: "Calgary Tower", pop: 0, landmark: true, lat: 51.044, lng: -114.063 }),
      place({ name: "Alberta Beach", pop: 800, lat: 53.68, lng: -114.4 }),
      place({ name: "Fort McMurray", pop: 68_000, lat: 56.73, lng: -111.38 }),
      place({ name: "Fort Saskatchewan", pop: 27_000, lat: 53.72, lng: -113.22 }),
      place({ name: "Fort Chipewyan", pop: 800, lat: 58.71, lng: -111.16 }),
    ],
    fires: [],
    threats: [],
    here: { lat: 54, lng: -115 },
    selected: null,
    ...over,
  };
}

const tools = (text: string, b = brief()) => planRequest(text, b).calls.map((c) => c.tool);

test("an exact place beats a longer name that only contains it, and a big city is viewed from farther out", () => {
  const plan = planRequest("show calgary", brief());
  assert.deepEqual(tools("show calgary"), ["flyToPlace"]);
  const fly = plan.calls[0];
  assert.equal(fly.tool, "flyToPlace");
  if (fly.tool === "flyToPlace") {
    assert.equal(fly.args.name, "Calgary");
    assert.equal(fly.args.dist, 45);
  }
});

test("the same name in two provinces prefers the one already in focus", () => {
  const plan = planRequest("show springfield", brief({
    places: [
      place({ name: "Springfield", regionId: "alberta", regionIndex: 0, focused: false, pop: 900_000 }),
      place({ name: "Springfield", regionId: "british-columbia", regionIndex: 1, focused: true, pop: 100, lat: 50, lng: -120 }),
    ],
    focusIds: ["british-columbia"],
  }));
  const fly = plan.calls.find((c) => c.tool === "flyToPlace");
  assert.ok(fly && fly.tool === "flyToPlace");
  if (fly?.tool === "flyToPlace") assert.equal(fly.args.regionId, "british-columbia");
});

test("a partial name that matches several towns does not fly", () => {
  const plan = planRequest("show fort", brief());
  assert.deepEqual(plan.calls, []);
  assert.equal(plan.reply, "ambiguous");
  assert.ok(plan.candidates?.includes("Fort McMurray"));
  assert.ok(plan.candidates?.includes("Fort Saskatchewan"));
  const text = renderReply(plan, []);
  assert.match(text, /Fort McMurray/);
  assert.match(text, /Say the full name/);
});

test("a province name flies to that province", () => {
  const plan = planRequest("show alberta", brief({ focusIds: ["british-columbia"] }));
  assert.deepEqual(plan.calls.map((c) => c.tool), ["focus", "flyToRegion"]);
  const fly = plan.calls[1];
  assert.equal(fly.tool, "flyToRegion");
  if (fly.tool === "flyToRegion") assert.equal(fly.args.name, "Alberta");
});

function forecastDayOf(text: string, forecastDay = 0): number {
  const call = planRequest(text, brief({ forecastDay })).calls[0];
  assert.equal(call?.tool, "setForecastDay");
  if (call?.tool !== "setForecastDay") return -1;
  return call.args.day;
}

test("forecast phrases become a day index", () => {
  assert.equal(forecastDayOf("today", 2), 0);
  assert.equal(forecastDayOf("tomorrow"), 1);
  assert.equal(forecastDayOf("in 3 days"), 3);
  assert.equal(forecastDayOf("in 9 days"), 7);
  assert.equal(forecastDayOf("monday"), 3);
});

test("just a province replaces focus with that province", () => {
  const plan = planRequest("enable just bc", brief());
  const focus = plan.calls.find((c) => c.tool === "focus");
  assert.ok(focus && focus.tool === "focus");
  if (focus?.tool === "focus") assert.deepEqual(focus.args.ids, ["british-columbia"]);
  assert.ok(plan.calls.some((c) => c.tool === "flyToRegion"));
});

test("layers turn on and off", () => {
  const on = planRequest("turn wind on", brief());
  assert.deepEqual(on.calls[0], { tool: "setLayer", args: { key: "wind", on: true } });
  const off = planRequest("hide the rain", brief());
  assert.deepEqual(off.calls[0], { tool: "setLayer", args: { key: "rain", on: false } });
  // Every layer is reachable by name, including the traffic corridors. Turning one on when
  // it already is asks for nothing, so the corridors start off here.
  assert.deepEqual(planRequest("turn off traffic", brief()).calls[0], { tool: "setLayer", args: { key: "traffic", on: false } });
  const corridors = planRequest("show the corridors", brief({ layers: layers({ traffic: false }) }));
  assert.deepEqual(corridors.calls[0], { tool: "setLayer", args: { key: "traffic", on: true } });
});

test("a place outside focus, a forecast day, a layer, and a risk question stay in that order", () => {
  const plan = planRequest("Show Calgary tomorrow with wind on, and how risky is it?", brief({
    focusIds: ["british-columbia"],
    places: [place({ name: "Calgary", pop: 1_300_000, focused: false, regionId: "alberta" })],
  }));
  assert.deepEqual(plan.calls.map((c) => c.tool), ["focus", "setForecastDay", "setLayer", "flyToPlace", "explain"]);
  assert.equal(plan.reply, "explain");
  const focus = plan.calls[0];
  if (focus.tool === "focus") assert.deepEqual(focus.args.ids, ["british-columbia", "alberta"]);
  const day = plan.calls[1];
  if (day.tool === "setForecastDay") assert.equal(day.args.day, 1);
  const layer = plan.calls[2];
  if (layer.tool === "setLayer") assert.deepEqual(layer.args, { key: "wind", on: true });
});

test("the largest fire is its own flight", () => {
  assert.deepEqual(tools("take me to the largest fire"), ["flyToFire"]);
});

test("an unknown sentence lists what the operator can do and does not guess", () => {
  const plan = planRequest("hello there", brief());
  assert.deepEqual(plan.calls, []);
  assert.equal(plan.reply, "unknown");
  assert.equal(renderReply(plan, []), UNKNOWN_REPLY);
});

test("a reply with no weather does not invent an FWI", () => {
  const facts: ExplainFacts = {
    name: "Calgary",
    dayLabel: "Tomorrow",
    windLayer: true,
    fwi: null,
    danger: null,
    windKmh: null,
    windFrom: null,
    precipMm: null,
    precipKind: null,
    threatReason: null,
    nearestHotspotKm: null,
    weatherMissing: true,
    weatherState: "error",
    simulation: false,
  };
  const text = explainReply(facts);
  assert.match(text, /no FWI/i);
  assert.doesNotMatch(text, /\d/);
});

test("a reply copies the day, the wind layer, the FWI, and the threat reason", () => {
  const plan: Plan = { calls: [], reply: "explain" };
  const text = renderReply(plan, [{
    tool: "explain",
    summary: "Explained Calgary",
    facts: {
      name: "Calgary",
      dayLabel: "Tomorrow",
      windLayer: true,
      fwi: 18.2,
      danger: "High",
      windKmh: 24,
      windFrom: "west",
      precipMm: 0,
      precipKind: "rain",
      threatReason: "fire 18 km W",
      nearestHotspotKm: 18,
      weatherMissing: false,
      weatherState: "ok",
      simulation: true,
    },
  }]);
  assert.match(text, /Tomorrow/);
  assert.match(text, /wind on/);
  assert.match(text, /18\.2/);
  assert.match(text, /High/);
  assert.match(text, /fire 18 km W/);
  assert.match(text, /simulation/i);
});

test("a layer that's already in that state says so instead of the help text", () => {
  const plan = planRequest("turn on traffic", brief());
  assert.equal(plan.reply, "already");
  assert.equal(renderReply(plan, []), "Traffic is already on.");
});

test("accented names don't match plain words, and still match when said", () => {
  const b = brief({ places: [...brief().places, place({ name: "Whatì", pop: 500, lat: 63.1, lng: -117.3, regionId: "northwest-territories", focused: false })] });
  assert.ok(!planRequest("what is that", b).calls.some((c) => c.tool === "flyToPlace"));
  const fly = planRequest("fly to whati", b).calls.find((c) => c.tool === "flyToPlace");
  assert.ok(fly && fly.tool === "flyToPlace" && fly.args.name === "Whatì");
});

test("a hotspot question lists the heat instead of only setting the forecast", () => {
  const plan = planRequest("are there any hotspots today?", brief({ forecastDay: 3 }));
  assert.equal(plan.reply, "fires");
  assert.ok(plan.calls.some((c) => c.tool === "listFires" && c.args.heatFirst));
  assert.deepEqual(tools("turn hotspots off"), ["setLayer"]);
});

test("a risk question about a place is answered, not just flown to", () => {
  for (const q of ["is calgary risky today?", "is calgary safe?", "risk in calgary", "is fort mcmurray at risk"]) {
    const plan = planRequest(q, brief());
    assert.equal(plan.reply, "explain", q);
    assert.ok(plan.calls.some((c) => c.tool === "explain"), q);
  }
});

test("with Firefly available, questions go to him (spoken); map commands stay local", () => {
  const goesToModel = (q: string) => needsModel(q, planRequest(q, brief()));
  for (const q of ["How risky is Calgary?", "is calgary risky today?", "Which communities are at risk?", "Where is the largest fire?", "will it rain in calgary", "calgary?", "active fires in alberta"]) {
    assert.ok(goesToModel(q), q);
  }
  for (const q of ["show me calgary", "focus alberta", "turn wind on", "take me to the largest fire"]) {
    assert.ok(!goesToModel(q), q);
  }
});
