/**
 * The pitch, step by step: from one Calgary 311 call to wildfires across Canada.
 *
 * Each step sets the whole state it needs (layers, demo replay, focus, forecast day, storm, camera,
 * overlays), so the presenter can go forward, back or jump anywhere. A click mid-step cancels it:
 * every wait checks it's still the current step.
 *
 * Smoothness rules: the map is rescored (forecast day, storm, replay, focus) while the camera is
 * still or right after it lands, never in the middle of a long flight; zooms run on a log scale
 * (Scene.cinematic); overlays only fade and move.
 */
import { loadCases, plan311Now, recomputeCrews, recomputeFleet, setSource311 } from "../dispatch/controller";
import { crewColor } from "../dispatch/colors";
import { label, type Scored } from "../dispatch/crews";
import { daysWaiting, priorityParts, typeOf, type Ticket } from "../dispatch/ops311";
import { dispatch } from "../dispatch/store";
import { dayIntensity, snowShare } from "../data/rain";
import type { Engine } from "../engine";
import { project } from "../geo/projection";
import { app, regionIndex, type Layers } from "../state/app";
import { pitch, type Caption, type Story311 } from "./store";

class Cancelled extends Error {}
let current = 0;

interface Ctx { e: Engine; id: number; wait: (ms: number) => Promise<void> }
/** `caption` is a function when its words come from the data. */
interface Step { caption: Caption | (() => Caption); enter: (c: Ctx) => Promise<void> }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const fmt = (n: number) => Math.round(n).toLocaleString("en-CA");

// ------------------------------------------------------------ world state
export const BASE_LAYERS: Layers = { risk: true, fires: true, spread: false, air: false, traffic: false, beacons: false, wind: false, rain: false, bloom: false };
type Storm = { lat: number; lng: number; fromDay: number; rKm?: number } | null;
let stormNow: Storm = null;

/** Set layers, replay, focus, day and storm; rescore the map once, only if something changed. */
async function world(e: Engine, w: { layers?: Partial<Layers>; sim?: boolean; focus?: string[]; day?: number; storm?: Storm }) {
  const s = app.get();
  let rescore = e.setLayers({ ...BASE_LAYERS, ...w.layers });
  const sim = w.sim ?? false;
  if (s.simulation !== sim) { app.set({ simulation: sim }); rescore = true; }
  pitch.set({ replay: sim });
  const storm = w.storm ?? null;
  if (JSON.stringify(storm) !== JSON.stringify(stormNow)) { stormNow = storm; await e.setStoryStorm(storm, false); rescore = true; }
  const day = w.day ?? 0;
  if (s.forecastDay !== day) { app.set({ forecastDay: day }); rescore = true; }
  const focus = w.focus ?? ["alberta"];
  if (focus.join() !== s.focus.join()) e.setFocus(focus);
  if (rescore) await e.pushHazards();
}

/** Camera to a lat/lng (cinematic). */
function shot(e: Engine, lat: number, lng: number, dist: number, o: { heading?: number; tilt?: number; duration?: number } = {}) {
  const w = project(lat, lng);
  return e.scene.cinematic({ x: w.x, z: w.z, dist, ...o });
}

function shotRegion(e: Engine, ids: string[], o: { heading?: number; tilt?: number; duration?: number; zoom?: number } = {}) {
  const b = e.scene.boundsOf(ids.map(regionIndex).filter((i) => i >= 0));
  if (!b) return Promise.resolve();
  return e.scene.cinematic({ x: b.x, z: b.z, dist: b.dist * (o.zoom ?? 1), heading: o.heading, tilt: o.tilt, duration: o.duration });
}

// ------------------------------------------------------------ how much of the map exists
/**
 * The story starts small: only Calgary exists, a model of a city in the dark. Each zoom out
 * reveals more: Alberta, a spotlight on the snow, then all of Canada. The circle eases with the
 * camera (Scene.setReveal), so pulling back is what uncovers the map.
 */
type Reveal = { kind: "calgary" } | { kind: "alberta" } | { kind: "spot"; lat: number; lng: number; km: number } | { kind: "all" };
let revealNow = "";
const CITY_KM = 24;

function reveal(e: Engine, r: Reveal, duration: number) {
  const key = JSON.stringify(r);
  if (key === revealNow) return;
  revealNow = key;
  if (r.kind === "all") { e.scene.setReveal(0, 0, 0, duration); e.scene.setBorderOpacity(1, duration); return; }
  if (r.kind === "calgary") {
    const w = project(CALGARY.lat, CALGARY.lng);
    e.scene.setReveal(w.x, w.z, CITY_KM, duration);
    e.scene.setBorderOpacity(0, duration * 0.6);
    return;
  }
  if (r.kind === "spot") {
    const w = project(r.lat, r.lng);
    e.scene.setReveal(w.x, w.z, r.km, duration);
    e.scene.setBorderOpacity(0.6, duration);
    return;
  }
  const b = e.scene.boundsOf([regionIndex("alberta")]);
  if (!b) return;
  // boundsOf's dist is the province's longer side × 1.1: a circle of ~0.62 of it covers it.
  e.scene.setReveal(b.x, b.z, b.dist * 0.62, duration);
  e.scene.setBorderOpacity(1, duration);
}

/** The workspace region whose box holds a point (the smallest, where boxes overlap). */
function regionAt(lat: number, lng: number): string | undefined {
  return app.get().regions
    .filter((r) => lng >= r.bbox[0] && lat >= r.bbox[1] && lng <= r.bbox[2] && lat <= r.bbox[3])
    .sort((a, b) => (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]) - (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]))[0]?.id;
}

// ------------------------------------------------------------ the story's data (prepared once)
let fire: Scored | null = null;
let topFires: Scored[] = [];
let snow: { lat: number; lng: number; day: number; mm: number; temp: number; near: string } | null = null;
let weatherAll: Promise<void> | null = null;

async function build311(): Promise<Story311 | null> {
  pitch.set({ prep: "Planning Calgary's 311 crews" });
  let plan = await plan311Now(60_000).catch(() => null);
  if (!plan) { setSource311("sample"); plan = await plan311Now(60_000).catch(() => null); }
  if (!plan) return null;
  // Routes need the street network (loaded in the planner's worker): wait for them.
  pitch.set({ prep: "Routing crews on Calgary's streets" });
  for (let i = 0; i < 80 && !Object.keys(dispatch.get().routes).length; i++) await sleep(250);
  const d = dispatch.get(), p = d.plan311!, load = d.load311!;
  // The day's highest-priority job: work is chosen strictly by priority, so it's the city's #1.
  let best: { t: Ticket; crew: string; total: number } | null = null;
  p.morning.routes.forEach((jobs, crew) => jobs.forEach((t) => {
    const total = priorityParts(t, p.today, p.ctx).total;
    if (d.routes[crew] && (!best || total > best.total)) best = { t, crew, total };
  }));
  if (!best) return null;
  const { t, crew, total: top } = best as { t: Ticket; crew: string; total: number };
  // Its honest rank among every open ticket (once, behind the loading screen).
  let rank = 1;
  for (const o of load.open) if (o.id !== t.id && priorityParts(o, p.today, p.ctx).total > top) rank++;
  const crewIndex = p.crews.findIndex((c) => c.id === crew);
  return {
    ticket: t, label: typeOf(t.service).label, parts: priorityParts(t, p.today, p.ctx), daysWaiting: daysWaiting(t, p.today), reports: (t.duplicates ?? 0) + 1,
    crew, crewColor: crewColor(crewIndex), route: d.routes[crew], stops: p.morning.routes.get(crew) ?? [],
    all: p.crews.flatMap((c, i) => (d.routes[c.id] ? [{ crew: c.id, color: crewColor(i), route: d.routes[c.id] }] : [])),
    open: load.open.length, rank, safetyJobs: p.scores.morning.safetyJobs, fifoSafetyJobs: p.scores.fifo.safetyJobs, source: load.source,
  };
}

/** The heaviest snow in the forecast (≥ 2 mm, at or below freezing), in Alberta or BC if there is any. */
function findSnow() {
  const s = app.get();
  let best: typeof snow = null, bestScore = 0;
  for (const g of s.weather) for (const c of g.cells) for (let day = 0; day <= 4; day++) {
    const d = c.days[day];
    if (!d || d.rainMm < 2 || snowShare(d.temp) < 1) continue;
    const west = c.lng < -110 && c.lat < 60;
    const score = dayIntensity(d.rainMm) + (west ? 1 : 0);
    if (score > bestScore) { bestScore = score; best = { lat: c.lat, lng: c.lng, day, mm: d.rainMm, temp: d.temp, near: "" }; }
  }
  if (best) {
    const b = best;
    const town = s.places.filter((p) => !p.landmark && p.pop >= 300)
      .map((p) => ({ p, km: Math.hypot((p.lat - b.lat) * 111, (p.lng - b.lng) * 111 * Math.cos((b.lat * Math.PI) / 180)) }))
      .sort((x, y) => x.km - y.km)[0];
    b.near = town && town.km < 120 ? `near ${town.p.name}` : "";
  }
  return best;
}

/** Everything the steps need, while the loading screen is up. */
export async function prepare(e: Engine) {
  pitch.set({ prep: "Loading Alberta's 2023–2025 fire seasons" });
  await loadCases();
  if (!dispatch.get().plan) recomputeCrews();
  for (let i = 0; i < 40 && !dispatch.get().plan; i++) await sleep(250);
  await recomputeFleet();
  const plan = dispatch.get().plan;
  topFires = plan?.pickedCut.slice(0, 6) ?? [];
  fire = topFires[0] ?? null;
  pitch.set({ story311: await build311().catch(() => null) });
  // Every province's weather, quietly, for the snow and the reveal of Canada.
  weatherAll = e.prefetchWeather(app.get().regions.map((r) => r.id)).catch(() => {});
  await world(e, {});
  // Open on the model of Calgary (behind the loading screen, so the first frame is already it).
  reveal(e, { kind: "calgary" }, 0);
  await shot(e, CALGARY.lat, CALGARY.lng, OPEN_DIST, { heading: -25, tilt: 56, duration: 0.05 });
  await sleep(1500); // let its hexes build before the curtain lifts
  pitch.set({ prep: "", ready: true });
}

// ------------------------------------------------------------ steps
const CALGARY = { lat: 51.045, lng: -114.06 };
/** The opening: Calgary at the L5 zoom (32–76 km), a model of the city. */
const OPEN_DIST = 58;

function routeBox(st: Story311) {
  const pts = st.route.legs.flatMap((l) => l.path).map((q) => project(q.lat, q.lng));
  const xs = pts.map((q) => q.x), zs = pts.map((q) => q.z);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
  return { x: (Math.max(...xs) + Math.min(...xs)) / 2, z: (Math.max(...zs) + Math.min(...zs)) / 2, dist: Math.max(4, span * 1.9) };
}

const story = () => pitch.get().story311;
const fireLabel = () => (fire ? label(fire) : "the fire");

export const STEPS: Step[] = [
  {
    caption: { layout: "title", title: "FIRE//WATCH", body: "One map, from the first 311 call to the last wildfire." },
    async enter({ e }) {
      pitch.set({ call: 0 });
      reveal(e, { kind: "calgary" }, 2.5);
      await world(e, {});
      await shot(e, CALGARY.lat, CALGARY.lng, OPEN_DIST, { heading: -25, tilt: 56, duration: 3 });
      e.scene.setOrbit(2.4);
    },
  },
  {
    caption: () => {
      const st = story();
      return { layout: "caption", kicker: "Calgary · 311", title: "A call comes in.", body: st ? `${cap(st.label)} in ${titleCase(st.ticket.community)}${st.reports > 1 ? `, reported ${st.reports} times` : ""}.` : "" };
    },
    async enter({ e, wait }) {
      const st = story();
      pitch.set({ call: 0 });
      reveal(e, { kind: "calgary" }, 2);
      await world(e, {});
      if (!st) return;
      // Down to street level (L6): the city's blocks, then the call.
      await shot(e, st.ticket.lat, st.ticket.lng, 1.6, { heading: 25, tilt: 60, duration: 3.6 });
      e.scene.setOrbit(0.8);
      await wait(150);
      pitch.set({ call: 1 });
    },
  },
  {
    caption: () => ({ layout: "caption", kicker: "Priority", title: "Why it jumps the queue.", body: `Scored against all ${fmt(story()?.open ?? 0)} open tickets: safety, today's weather, how long it's waited against the city's own norm, and repeat reports.` }),
    async enter({ e }) {
      const st = story();
      reveal(e, { kind: "calgary" }, 2);
      await world(e, {});
      if (!st) return;
      pitch.set({ call: 2 });
      await shot(e, st.ticket.lat, st.ticket.lng, 1.4, { heading: 55, tilt: 55, duration: 2.6 });
      e.scene.setOrbit(0.8);
    },
  },
  {
    caption: () => {
      const st = story();
      return { layout: "caption", kicker: "Dispatch", title: `Crew ${st?.crew ?? ""} is on its way.`, body: st ? `${st.route.km.toFixed(1)} km, ${Math.round(st.route.minutes)} min of driving on real streets, ${st.stops.length} stops in order.` : "" };
    },
    async enter({ e }) {
      const st = story();
      reveal(e, { kind: "calgary" }, 2);
      await world(e, {});
      if (!st) return;
      pitch.set({ call: 2 });
      const b = routeBox(st);
      await e.scene.cinematic({ ...b, heading: 10, tilt: 48, duration: 2.6 });
      pitch.set({ call: 3 });
      e.scene.setOrbit(0.6);
    },
  },
  {
    caption: () => ({ layout: "caption", kicker: "Today's plan", title: `${story()?.safetyJobs ?? 0} safety jobs today. Oldest-first gets ${story()?.fifoSafetyJobs ?? 0}.`, body: "Every crew, every stop. What gets done goes strictly by priority; driving only decides which crew." }),
    async enter({ e }) {
      reveal(e, { kind: "calgary" }, 2);
      await world(e, {});
      pitch.set({ call: 4 });
      await shot(e, CALGARY.lat, CALGARY.lng, 40, { heading: 0, tilt: 48, duration: 2.8 });
      e.scene.setOrbit(0.6);
    },
  },
  {
    caption: { layout: "statement", title: "But it's not just Calgary." },
    async enter({ e }) {
      pitch.set({ call: 0 });
      await world(e, {});
      // Zoom out, and Alberta appears around the city.
      reveal(e, { kind: "alberta" }, 4.2);
      await shotRegion(e, ["alberta"], { heading: 0, tilt: 30, duration: 4.2, zoom: 0.95 });
    },
  },
  {
    caption: { layout: "caption", kicker: "Wildfire", title: "We're all affected by wildfires.", body: "Replaying Alberta's 2023–2025 seasons. Every fire is ranked for crews by its size, its spread for that fuel and weather, and the people in reach." },
    async enter({ e }) {
      pitch.set({ call: 0 });
      dispatch.set({ open: false, decided: {} });
      reveal(e, { kind: "alberta" }, 2);
      await shotRegion(e, ["alberta"], { heading: 0, tilt: 34, duration: 1.6, zoom: 0.9 });
      await world(e, { sim: true, layers: { spread: true, beacons: true } });
      e.scene.setOrbit(0.5);
    },
  },
  {
    caption: () => {
      const g = dispatch.get().plan?.grades;
      return { layout: "caption", kicker: "Dispatch", title: "Crews and aircraft, from 12 bases.", body: `Skimmers scoop the nearest lake, tankers reload at base, crews drive or fly in.${g ? ` Our ranking reaches ${g.ours.escapesCaught} fires that later escaped; biggest-first reaches ${g.baseline.escapesCaught}.` : ""}` };
    },
    async enter({ e }) {
      reveal(e, { kind: "alberta" }, 2);
      await world(e, { sim: true, layers: { spread: true, beacons: true } });
      const decided: Record<string, "sent"> = {};
      for (const f of topFires) decided[`${f.fire.year}:${f.fire.id}`] = "sent";
      dispatch.set({ open: true, tab: "crews", simulate: true, showLiveAircraft: false, decided, cursor: 0 });
      const c = topFires.length ? topFires.reduce((a, f) => ({ lat: a.lat + f.fire.lat / topFires.length, lng: a.lng + f.fire.lng / topFires.length }), { lat: 0, lng: 0 }) : CALGARY;
      await shot(e, c.lat, c.lng, 520, { heading: 0, tilt: 42, duration: 3 });
      e.scene.setOrbit(0.4);
    },
  },
  {
    caption: () => ({ layout: "caption", kicker: fireLabel(), title: "One fire.", body: fire ? `${fmt(fire.fire.sizeHa)} ha, spreading ${fire.ros.toFixed(1)} m/min${fire.fire.crown ? ", crowning" : ""}.${fire.exposure.nearest ? ` ${Math.round(fire.exposure.nearest.km)} km ${fire.exposure.nearest.dir} of ${fire.exposure.nearest.name}.` : ""}` : "" }),
    async enter({ e }) {
      if (!fire) return;
      reveal(e, { kind: "alberta" }, 2);
      await world(e, { sim: true, layers: { spread: true, beacons: true } });
      await shot(e, fire.fire.lat, fire.fire.lng, 60, { heading: 30, tilt: 52, duration: 3.2 });
      e.scene.setOrbit(0.7);
    },
  },
  {
    caption: { layout: "caption", kicker: "Prediction", title: "Where it could go.", body: "Projected day by day over the real fuel map, with each day's forecast wind. A scenario, not an official forecast." },
    async enter({ e, wait }) {
      if (!fire) return;
      reveal(e, { kind: "alberta" }, 2);
      await world(e, { sim: true, layers: { spread: true, beacons: true } });
      e.scene.setOrbit(0.7);
      for (const day of [1, 2, 3]) {
        await wait(day === 1 ? 600 : 1700);
        pitch.set({ ticker: `${day === 1 ? "Tomorrow" : `Day ${day}`}${app.get().weather[0]?.dates[day] ? ` · ${new Date(`${app.get().weather[0].dates[day]}T12:00:00`).toLocaleDateString("en-CA", { weekday: "long", month: "short", day: "numeric" })}` : ""}` });
        await world(e, { sim: true, layers: { spread: true, beacons: true }, day });
      }
    },
  },
  {
    caption: { layout: "caption", kicker: "Weather", title: "Then the rain comes.", body: "Rain soaks the fuel: the risk cools and the projected growth stalls." },
    async enter({ e, wait }) {
      if (!fire) return;
      reveal(e, { kind: "alberta" }, 2);
      await world(e, { sim: true, layers: { spread: true, beacons: true, rain: true }, day: 3 });
      e.scene.setOrbit(0.7);
      await wait(900);
      // The storm settles over the fire from tomorrow: day 3's projection is rescored with it.
      await world(e, { sim: true, layers: { spread: true, beacons: true, rain: true }, day: 3, storm: { lat: fire.fire.lat, lng: fire.fire.lng, fromDay: 1, rKm: 70 } });
    },
  },
  {
    caption: { layout: "caption", kicker: "Weather", title: "And snow where it's freezing.", body: "" },
    async enter({ e }) {
      await weatherAll;
      snow ??= findSnow();
      if (!snow) {
        pitch.set({ caption: { layout: "caption", kicker: "Weather", title: "And snow where it's freezing.", body: "No snow in the forecast this week: the map shows it wherever precipitation falls at or below 0 °C." } });
        return;
      }
      const sn = snow;
      pitch.set({ caption: { layout: "caption", kicker: "Weather", title: "And snow where it's freezing.", body: `${Math.round(sn.mm)} mm forecast ${sn.near}, high of ${Math.round(sn.temp)} °C. Snow damps fire just like rain.`.replace("  ", " ") } });
      // A spotlight on the snow: the circle travels with the camera, then comes back to Alberta.
      reveal(e, { kind: "spot", lat: sn.lat, lng: sn.lng, km: 170 }, 3.6);
      await shot(e, sn.lat, sn.lng, 140, { heading: -20, tilt: 50, duration: 3.6 });
      await world(e, { sim: true, layers: { spread: true, beacons: true, rain: true }, day: sn.day, storm: stormNow, focus: [...new Set(["alberta", regionAt(sn.lat, sn.lng) ?? "alberta"])] });
      e.scene.setOrbit(0.8);
    },
  },
  {
    caption: { layout: "caption", kicker: "Weather", title: "And the wind drives every path.", body: "Live wind today and the forecast wind for every day ahead push each projection." },
    async enter({ e }) {
      reveal(e, { kind: "alberta" }, 3.2);
      await shotRegion(e, ["alberta"], { heading: 0, tilt: 40, duration: 3.2, zoom: 0.7 });
      await world(e, { sim: true, layers: { spread: true, beacons: true, rain: true, wind: true }, day: 0, storm: null });
      e.scene.setOrbit(0.5);
    },
  },
  {
    caption: { layout: "statement", title: "But wildfires don't always start in Alberta." },
    async enter({ e }) {
      // The real data from here on: no replay, today. Rescored now, while the camera barely moves.
      dispatch.set({ open: false, decided: {} });
      reveal(e, { kind: "alberta" }, 2);
      await world(e, { layers: { wind: true, beacons: true } });
      await shotRegion(e, ["alberta"], { heading: 0, tilt: 30, duration: 3, zoom: 1.25 });
      await weatherAll;
    },
  },
  {
    caption: { layout: "caption", kicker: "Canada", title: "Every province. Every territory. Live.", body: "" },
    async enter({ e, wait }) {
      const all = app.get().regions.map((r) => r.id);
      await world(e, { layers: { wind: true, beacons: true }, focus: all });
      // The big zoom out: the circle opens to everything as the camera pulls back to Canada.
      reveal(e, { kind: "all" }, 5);
      await wait(250);
      const s = app.get();
      const active = s.reportedFires.filter((f) => f.stage !== "under_control").length;
      const heat = s.hotspots.filter((h) => h.agency !== "SIMULATION").length;
      pitch.set({ caption: { layout: "caption", kicker: "Canada", title: "Every province. Every territory. Live.", body: `${fmt(active)} wildfires reported by the fire agencies right now, ${fmt(heat)} satellite hotspots, and the weather for all of it.` } });
      await shotRegion(e, all, { heading: 0, tilt: 26, duration: 5, zoom: 0.8 });
      e.scene.setOrbit(0.35);
    },
  },
  {
    caption: { layout: "title", title: "FIRE//WATCH", body: "Dispatch · Prediction · Weather · All of Canada. Open data, one map." },
    async enter({ e }) {
      e.scene.setOrbit(0.5);
    },
  },
];

// ------------------------------------------------------------ playback
/** Go to step `n`: its caption at once, then its moves. A newer go() cancels this one. */
export function go(e: Engine, n: number) {
  const i = Math.max(0, Math.min(STEPS.length - 1, n));
  const id = ++current;
  const st = STEPS[i];
  pitch.set({ step: i, caption: typeof st.caption === "function" ? st.caption() : st.caption, ticker: "" });
  const wait = (ms: number) => new Promise<void>((ok, fail) => setTimeout(() => (id === current ? ok() : fail(new Cancelled())), ms));
  void st.enter({ e, id, wait }).catch((err) => { if (!(err instanceof Cancelled)) console.warn("[pitch]", err); });
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const titleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
