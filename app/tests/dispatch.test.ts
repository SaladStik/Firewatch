import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../src/dispatch/csv.ts";
import { exposures, fuelFromCode, HAND_WEIGHTS, isEscape, loadHistory, planCrews, rankFires } from "../src/dispatch/crews.ts";
import { load311, plan311, priority, typeOf } from "../src/dispatch/ops311.ts";

test("csv: quoted fields, escaped quotes, blank lines", () => {
  const rows = parseCsv('a,b\n1,"x, ""y"""\n\n2,z\r\n');
  assert.deepEqual(rows, [{ a: "1", b: 'x, "y"' }, { a: "2", b: "z" }]);
});

const FIRES = `YEAR,FIRE_NUMBER,FIRE_NAME,CURRENT_SIZE,SIZE_CLASS,LATITUDE,LONGITUDE,GENERAL_CAUSE,FIRE_START_DATE,ASSESSMENT_HECTARES,FIRE_SPREAD_RATE,FIRE_TYPE,TEMPERATURE,RELATIVE_HUMIDITY,WIND_SPEED,FUEL_TYPE
2024,A1,Big Slow,5000,E,56,-115,Lightning,2024-07-01 10:00,900,0,Surface,15,60,3,D1
2024,A2,Small Fast,3000,E,56.2,-115.2,Lightning,2024-07-01 11:00,5,30,Crown,30,15,35,C2
2024,A3,Tiny,0.1,A,55,-114,Resident,2024-07-02 12:00,0.1,0,Surface,10,70,2,O1a
2024,A4,No size,,A,55,-114,Resident,2024-07-02 12:00,0.1,0,Surface,,,,
2025,B1,Mid,40,C,55.5,-113,Lightning,2025-06-01 12:00,20,5,Surface,,,,`;

test("crews: drops rows without size or coordinates and fills missing weather", () => {
  const h = loadHistory(FIRES);
  assert.equal(h.rows, 5);
  assert.equal(h.dropped, 1);
  assert.equal(h.fires.length, 4);
  const b1 = h.fires.find((f) => f.id === "B1")!;
  assert.deepEqual(b1.imputed.sort(), ["fuel", "humidity", "temperature", "wind"]);
  assert.equal(fuelFromCode("C2"), "C-2");
  assert.equal(fuelFromCode("O1a"), "O-1a");
  assert.equal(fuelFromCode("M2"), "M-1");
});

test("crews: a small fast crown fire outranks a big slow one; biggest-first does the opposite", () => {
  const h = loadHistory(FIRES);
  const inp = { fires: h.fires, exposures: exposures(h.fires, [], []) };
  const plan = planCrews(inp, 2, 50, HAND_WEIGHTS);
  assert.equal(plan.picked[0].fire.id, "A2");
  assert.equal(plan.baseline[0].fire.id, "A1");
  // The cut keeps the top of our list; whatever we picked but cut lost its crew.
  assert.equal(plan.cutCrews, 1);
  assert.deepEqual(plan.lostCrew.map((s) => s.fire.id), [plan.picked[1].fire.id]);
  // A2 was 5 ha at assessment and ended at 3,000 ha: an escape we reached; A1 was already 900 ha.
  assert.ok(isEscape(h.fires.find((f) => f.id === "A2")!));
  assert.ok(!isEscape(h.fires.find((f) => f.id === "A1")!));
  assert.equal(plan.grades!.ours.escapesCaught, 1);
});

test("crews: the final size is never used to rank", () => {
  const h = loadHistory(FIRES);
  const inp = { fires: h.fires, exposures: exposures(h.fires, [], []) };
  const before = rankFires(inp, HAND_WEIGHTS).map((s) => s.fire.id);
  const shuffled = h.fires.map((f, i) => ({ ...f, finalHa: (i + 1) * 12345 }));
  const after = rankFires({ fires: shuffled, exposures: exposures(shuffled, [], []) }, HAND_WEIGHTS).map((s) => s.fire.id);
  assert.deepEqual(after, before);
});

test("crews: people in reach raise priority", () => {
  const h = loadHistory(FIRES);
  const town = [{ name: "Town", lat: 55.01, lng: -114.01, pop: 20000 }];
  const lone = rankFires({ fires: h.fires, exposures: exposures(h.fires, [], []) }, HAND_WEIGHTS).find((s) => s.fire.id === "A3")!;
  const near = rankFires({ fires: h.fires, exposures: exposures(h.fires, town, []) }, HAND_WEIGHTS).find((s) => s.fire.id === "A3")!;
  assert.ok(near.score > lone.score);
  assert.match(near.reason, /Town/);
});

const TICKETS = `service_request_id,requested_date,status_description,service_name,comm_name,address,longitude,latitude
1,2026-08-20,Open,WRS - Commercial Collection Services,DOWNTOWN,,-114.06,51.045
2,2026-08-27,Open,Roads - Signs - Traffic and Roadmarking,BELTLINE,,-114.07,51.04
3,2026-08-27,Open,Roads - Pothole Maintenance,BELTLINE,,-114.071,51.041
4,2026-08-26,Closed,Roads - Pothole Maintenance,BELTLINE,,-114.07,51.04
5,2026-08-26,Duplicate (Open),Roads - Pothole Maintenance,BELTLINE,,-114.07,51.04
6,2026-08-21,Open,Roads - Signs - Parking,TUSCANY,,-114.25,51.12
7,2026-08-27,Open,WRS - Waste - Residential,ERLTON,,-114.06,51.03`;

test("311: service types (\"Services\" is not ice), loading counts", () => {
  assert.equal(typeOf("WRS - Commercial Collection Services").safety, 1);
  assert.equal(typeOf("Roads - Snow and Ice Control").safety, 5);
  assert.equal(typeOf("Roads - Signs - Traffic and Roadmarking").safety, 4);
  const l = load311(TICKETS);
  assert.equal(l.open.length, 5);
  assert.equal(l.closed, 1);
  assert.equal(l.duplicates, 1);
  assert.equal(l.all.length, 7);
  assert.equal(l.today, "2026-08-28");
});

test("311: priority beats oldest-first; a sick crew and a hold change the plan", () => {
  const l = load311(TICKETS);
  const p = plan311(l, { roads: 1, waste: 1, perCrew: 1, disruption: "sick" });
  const roadsJob = (a: typeof p.morning) => a.routes.get("R1")?.[0]?.id;
  assert.equal(roadsJob(p.fifo), "6"); // oldest Roads ticket: a parking sign
  assert.equal(roadsJob(p.morning), "2"); // priority: the traffic sign
  // The only Roads crew is sick: its job drops to tomorrow.
  assert.equal(p.noonCrews.length, 1);
  assert.deepEqual(p.dropped.map((x) => x.ticket.id), ["2"]);
  const held = plan311(l, { roads: 1, waste: 1, perCrew: 1, overrides: { "2": "hold" } });
  assert.equal(roadsJob(held.morning), "3");
  const urgent = plan311(l, { roads: 1, waste: 1, perCrew: 1, overrides: { "6": "urgent" } });
  assert.equal(roadsJob(urgent.morning), "6");
});

test("311: the blizzard adds ice calls that go to the front of Roads' queue", () => {
  const l = load311(TICKETS);
  const p = plan311(l, { roads: 1, waste: 1, perCrew: 2, disruption: "blizzard" });
  assert.ok(p.added.length > 0 && p.added.every((t) => t.simulated));
  assert.ok(p.noon!.routes.get("R1")!.every((t) => typeOf(t.service).safety === 5));
});

test("311: weather raises the right types, and each plan keeps its own weather", async () => {
  const { weatherFactor, priorityParts } = await import("../src/dispatch/ops311.ts");
  assert.equal(weatherFactor("ice / snow on the road", { tempC: -5, precipMm: 8, windKmh: 10 }).k, 1.6);
  assert.equal(weatherFactor("pothole", { tempC: 12, precipMm: 0, windKmh: 10 }).k, 1);
  assert.ok(weatherFactor("debris on the road", { tempC: 12, precipMm: 20, windKmh: 10 }).k > 1);
  assert.ok(weatherFactor("missing or damaged sign", { tempC: 12, precipMm: 0, windKmh: 70 }).k > 1);
  const l = load311(TICKETS);
  const dry = { tempC: 17, precipMm: 0, windKmh: 15 };
  const p = plan311(l, { roads: 1, waste: 1, perCrew: 2, disruption: "blizzard", weather: dry });
  const pothole = l.open.find((t) => t.id === "3")!;
  // The 8 a.m. plan scored with the dry forecast; only the blizzard replan has winter weather.
  assert.deepEqual(priorityParts(pothole, p.today, p.ctx).why.filter((w) => /freeze|snow/.test(w)), []);
  assert.ok(priorityParts(pothole, p.today, p.noonCtx).why.includes("freeze-thaw"));
});

test("311: similar reports close together raise each other's priority", async () => {
  const { similarNearby } = await import("../src/dispatch/ops311.ts");
  const l = load311(TICKETS);
  const near = similarNearby(l.open);
  // Ticket 3 (pothole) has no other pothole within 400 m; adding one next to it counts.
  assert.equal(near.get("3"), 0);
  const twin = { ...l.open.find((t) => t.id === "3")!, id: "3b", lat: 51.0412 };
  assert.equal(similarNearby([...l.open, twin]).get("3"), 1);
});

test("router: drives along streets, joins crossing roads, and finds the shortest stop order", async () => {
  const { RoadGraph, routeStops, shortestOrder } = await import("../src/dispatch/router.ts");
  // A 1 km grid of local streets as two lines that cross without sharing a point (like the bake),
  // plus a dead-end stub 10 m short of the east-west street.
  const q = 1e5, o: [number, number] = [51, -114];
  const line = (id: number, kind: number, pts: [number, number][]) => {
    const out = [id, kind];
    let px = 0, py = 0;
    for (const [la, ln] of pts) { const x = Math.round((ln - o[1]) * q), y = Math.round((la - o[0]) * q); out.push(x - px, y - py); px = x; py = y; }
    return out;
  };
  const tile = { o, l: [
    line(1, 8, [[51.00, -114.00], [51.00, -113.97]]),            // east-west
    line(2, 8, [[50.99, -113.985], [51.01, -113.985]]),           // north-south, crosses line 1 mid-segment
    line(3, 8, [[51.0001, -113.975], [51.005, -113.975]]),        // stub ending ~10 m north of line 1
  ] };
  const g = new RoadGraph([tile], q, [-114.01, 50.98, -113.96, 51.02]);
  const r = g.route({ lat: 50.99, lng: -113.985 }, { lat: 51.0, lng: -114.0 })!;
  assert.ok(r, "crossing streets are joined");
  assert.ok(r.km > 1.5 && r.km < 2.4, `goes up the street and along, ${r.km}`); // ~1.1 km north + ~1.05 km west
  assert.ok(g.route({ lat: 51.005, lng: -113.975 }, { lat: 51.0, lng: -114.0 }), "the stub is snapped on");
  const depot = { lat: 51.0, lng: -114.0 };
  const stops = [{ lat: 51.0, lng: -113.97 }, { lat: 51.0, lng: -113.985 }];
  const ord = shortestOrder(g, depot, stops);
  assert.deepEqual(ord, [1, 0]); // the nearer stop first
  assert.ok(routeStops(g, depot, stops, ord).km < routeStops(g, depot, stops).km);
});

test("311: the day is filled strictly by priority, so no waiting ticket outranks a planned one", async () => {
  const { readFileSync } = await import("node:fs");
  const l = load311(readFileSync("public/data/cases/calgary_311_sample.csv", "utf8"));
  // An urgent ticket at the far edge of the city still gets a crew.
  const far = l.open.find((t) => t.community === "RICARDO RANCH") ?? l.open[0];
  for (const opts of [{}, { disruption: "blizzard" as const }, { disruption: "sick" as const }, { overrides: { [far.id]: "urgent" as const } }]) {
    const p = plan311(l, opts);
    for (const [a, ctx] of [[p.morning, p.ctx], [p.noon, p.noonCtx]] as const) {
      if (!a) continue;
      const planned = [...a.routes.values()].flat();
      for (const unit of ["Roads", "WRS"]) {
        const lowest = Math.min(...planned.filter((t) => typeOf(t.service).unit === unit).map((t) => priority(t, p.today, ctx)));
        const outranks = a.waiting.filter((t) => typeOf(t.service).unit === unit && priority(t, p.today, ctx) > lowest);
        assert.deepEqual(outranks.map((t) => t.id), [], `${JSON.stringify(opts)} ${unit}`);
      }
    }
    if ("overrides" in opts) assert.ok(p.morning.routes.size && [...p.morning.routes.values()].flat().some((t) => t.id === far.id));
  }
});
