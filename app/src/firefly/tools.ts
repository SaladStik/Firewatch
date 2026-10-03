/**
 * ElevenLabs client tools: the agent calls these by name (definitions in AGENT.md — keep both in
 * sync). Each returns a compact JSON string; errors come back as {"error": …} so the agent can
 * recover instead of hanging.
 */
import { simulatedHotspots } from "../data/hazards";
import type { Engine } from "../engine";
import { NODE_STATUSES, NODE_TYPES } from "../hex/nodeTypes";
import { project } from "../geo/projection";
import { app, focusIndices, type Layers } from "../state/app";
import { activeFires, briefing, explainAt, findPlace, fireList, placeReport, townsInPath, type FactsSnapshot } from "./facts";
import { flyFireflyTo, fireflyController } from "./mascot";
import { crewPlanFacts, plan311Facts } from "../dispatch/agent";
import { openDispatch } from "../dispatch/controller";
import { dispatch } from "../dispatch/store";
import { askData, doDispatch } from "./knowledge";

export function snapshot(): FactsSnapshot {
  const s = app.get();
  const sim = s.simulation ? s.regions.flatMap((r) => simulatedHotspots(r.demoSites)) : [];
  return {
    places: s.places, hotspots: [...s.hotspots, ...sim], perimeters: s.perimeters, weather: s.weather,
    forecastDay: s.forecastDay, simulation: s.simulation, spread: s.spread, fireGrowth: s.fireGrowth,
    focus: new Set(focusIndices()), regionNames: s.regions.map((r) => r.name), now: Date.now(),
  };
}

const json = (v: unknown) => JSON.stringify(v);
const fail = (msg: string) => json({ error: msg });
const LAYERS: (keyof Layers)[] = ["risk", "fires", "spread", "air", "traffic", "beacons", "wind", "rain", "bloom"];
const NOTE = "Projected spread is a scenario model, not an official forecast.";

type Params = Record<string, unknown>;

/** Province name or code ("bc", "British Columbia"). "on" is not Ontario — that word is too common. */
function matchRegions(raw: string): { id: string; name: string }[] | string {
  const text = ` ${raw.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()} `;
  if (text.trim().length < 2) return "Name a province, for example BC or British Columbia.";
  const hits = app.get().regions.filter((r) => {
    const aliases = [r.name, r.id.replace(/-/g, " "), r.code].map((a) => a.toLowerCase()).filter((a) => a !== "on" && a.length >= 2);
    return aliases.some((a) => text.includes(` ${a} `));
  });
  return hits.length ? hits.map((r) => ({ id: r.id, name: r.name })) : "Unknown region. Use a province name or code, for example BC.";
}

function locate(s: FactsSnapshot, p: Params): { lat: number; lng: number; label: string; fire: boolean } | string {
  if (typeof p.fire_id === "string" && p.fire_id) {
    const f = activeFires(s).find((x) => x.fid === p.fire_id);
    return f ? { lat: f.lat, lng: f.lng, label: `fire ${f.fid}`, fire: true } : `No active fire with id ${p.fire_id}. Call list_fires for ids.`;
  }
  if (typeof p.place === "string" && p.place) {
    const r = findPlace(s.places, p.place);
    return r.place ? { lat: r.place.lat, lng: r.place.lng, label: r.place.name, fire: false } : `Unknown place "${p.place}". Did you mean: ${r.suggestions.join(", ")}?`;
  }
  return "Give a place or a fire_id.";
}

/** What's on screen right now, for the model's system prompt (so it knows the context without a tool call). */
export function llmContext(): string {
  const s = app.get(), d = dispatch.get();
  const date = s.weather[0]?.dates[s.forecastDay];
  return [
    `Map day: ${s.forecastDay === 0 ? "today" : `+${s.forecastDay} days`}${date ? ` (${date})` : ""}. Demo scenario: ${s.simulation ? "on" : "off"}.`,
    `Dispatch panel: ${d.open ? `open on ${d.tab === "311" ? "Calgary 311" : "wildfire crews"}` : "closed"}. Wildfire list: ${d.source === "history" ? "Alberta 2023–2025 fires" : "live fires"}, ${d.crews} crews, cut ${d.cutPct}%. 311 queue: ${d.source311}.`,
    s.selected ? `Selected hex: ${s.selected.lat.toFixed(3)}, ${s.selected.lng.toFixed(3)}.` : "",
  ].filter(Boolean).join(" ");
}

export function makeTools(engine: Engine) {
  const guard = (fn: (p: Params) => Promise<string> | string) => async (p: Params = {}) => {
    try { fireflyController().setMood("thinking"); return await fn(p ?? {}); } catch (e) { return fail(String(e)); }
  };
  const show = (lat: number, lng: number, dist: number) => {
    engine.flyToLatLng(lat, lng, dist);
    return flyFireflyTo(engine, lat, lng);
  };

  return {
    get_briefing: guard(() => json(briefing(snapshot()))),

    get_place_report: guard((p) => {
      const s = snapshot();
      const r = findPlace(s.places, String(p.place ?? ""));
      if (!r.place) return fail(`Unknown place. Did you mean: ${r.suggestions.join(", ")}?`);
      void show(r.place.lat, r.place.lng, 30);
      return json(placeReport(s, r.place));
    }),

    list_fires: guard(() => {
      const fires = fireList(snapshot());
      return fires.length ? json(fires) : json({ result: "No active fires right now." });
    }),

    get_fire_details: guard(async (p) => {
      const fire = activeFires(snapshot()).find((x) => x.fid === p.fire_id);
      if (!fire) return fail(`No active fire with id ${String(p.fire_id)}. Call list_fires for ids.`);
      const days = Math.min(7, Math.max(1, Math.round(Number(p.days ?? 3)) || 3));
      await engine.setForecastDay(days);
      const s = snapshot();
      const f = fireList(s).find((x) => x.fire_id === p.fire_id);
      void show(fire.lat, fire.lng, 60);
      // Towns reached by any fire's projection, kept to those plausibly from this one (≤ 150 km).
      const w = project(fire.lat, fire.lng);
      const towns = townsInPath(s)
        .filter((t) => { const q = project(t.lat, t.lng); return Math.hypot(q.x - w.x, q.z - w.z) < 150; })
        .slice(0, 8)
        .map(({ place, population, day }) => ({ place, population, day }));
      return json({ ...f, horizonDays: days, communitiesInProjectedPath: towns, note: NOTE });
    }),

    explain_location: guard((p) => {
      const s = snapshot();
      let lat: number, lng: number;
      if (typeof p.place === "string" && p.place) {
        const r = findPlace(s.places, p.place);
        if (!r.place) return fail(`Unknown place. Did you mean: ${r.suggestions.join(", ")}?`);
        ({ lat, lng } = r.place);
      } else {
        const sel = app.get().selected;
        if (!sel) return fail("Nothing is selected. Ask the user to click a hex, or give a place.");
        ({ lat, lng } = sel);
      }
      const w = project(lat, lng);
      const n = engine.scene.world.nodeAt(w.x, w.z);
      const hex = n ? { landLabel: NODE_TYPES[n.land]?.label ?? "unknown", fuel: NODE_TYPES[n.land]?.fuel ?? 0, statusLabel: NODE_STATUSES[n.status]?.label ?? "", risk: n.risk } : null;
      return json(explainAt(s, lat, lng, hex));
    }),

    // Case 3: rank fires for N crews (live, or Alberta 2023–2025), beat biggest-first, cut and report who lost a crew.
    plan_crews: guard(async (p) => {
      const source = p.source === "history" || p.source === "live" ? p.source : app.get().hotspots.length ? "live" : "history";
      const facts = await crewPlanFacts({
        crews: Number(p.crews) || undefined,
        cutPct: p.cut_percent !== undefined ? Number(p.cut_percent) : undefined,
        source,
        year: p.year !== undefined ? Number(p.year) || 0 : undefined,
      });
      return json({ ...facts, note: source === "live" ? NOTE : "Historical replay: these fires burned in 2023–2025." });
    }),

    // Case 1: Calgary 311 crews for the day, one disruption at noon, replan.
    plan_311: guard(async (p) => {
      const d = String(p.disruption ?? "");
      return json(await plan311Facts({
        roads: p.roads_crews !== undefined ? Number(p.roads_crews) : undefined,
        waste: p.waste_crews !== undefined ? Number(p.waste_crews) : undefined,
        jobsPerCrew: p.jobs_per_crew !== undefined ? Number(p.jobs_per_crew) : undefined,
        disruption: d === "blizzard" || d === "sick" || d === "none" ? d : undefined,
      }));
    }),

    // Any question about the app's data: air quality, highways, values at risk, live aircraft, the
    // fleet, the wildfire queue or one fire, 311 tickets / crews / the week's schedule, methodology, sources.
    ask_data: guard(async (p) => json(await askData(engine, p))),

    // Work the dispatch queues: dispatch / skip fires, set crews and the fleet, dispatch 311 crews,
    // mark tickets urgent or held, change 311 crews or the disruption, re-route a crew, pick a day.
    do_dispatch: guard(async (p) => json(await doDispatch(engine, p))),

    open_dispatch: guard((p) => {
      openDispatch(p.tab === "311" ? "311" : "crews");
      return json({ ok: true, tab: p.tab === "311" ? "Calgary 311" : "Wildfire crews" });
    }),

    fly_to: guard(async (p) => {
      const at = locate(snapshot(), p);
      if (typeof at === "string") return fail(at);
      void show(at.lat, at.lng, at.fire ? 60 : 30); // answer now; the camera and Firefly keep flying
      return json({ ok: true, showing: at.label });
    }),

    set_forecast_day: guard(async (p) => {
      const day = Math.min(7, Math.max(0, Math.round(Number(p.day)) || 0));
      await engine.setForecastDay(day);
      return json({ ok: true, date: app.get().weather[0]?.dates[day] ?? `+${day}d` });
    }),

    set_layer: guard((p) => {
      const layer = String(p.layer) as keyof Layers;
      if (!LAYERS.includes(layer)) return fail(`Unknown layer. Use one of: ${LAYERS.join(", ")}`);
      const on = p.on === true || p.on === "true";
      engine.setLayer(layer, on);
      return json({ ok: true, layer, on });
    }),

    set_regions: guard((p) => {
      const raw = String(p.regions ?? p.region ?? "");
      const matched = matchRegions(raw);
      if (typeof matched === "string") return fail(matched);
      const mode = p.mode === "add" || p.mode === "remove" ? p.mode : "only";
      const current = app.get().focus;
      const picked = matched.map((r) => r.id);
      const ids = mode === "add"
        ? [...new Set([...current, ...picked])]
        : mode === "remove"
          ? current.filter((id) => !picked.includes(id))
          : picked;
      if (!ids.length) return fail("At least one region has to stay in focus.");
      engine.setFocus(ids);
      if (mode !== "remove" && matched.length === 1) {
        const index = app.get().regions.findIndex((r) => r.id === matched[0].id);
        if (index >= 0) engine.scene.flyToRegion(index);
      }
      const names = ids.map((id) => app.get().regions.find((r) => r.id === id)?.name ?? id);
      return json({ ok: true, focus: names });
    }),

    flag_patrol: guard((p) => {
      const at = locate(snapshot(), p);
      if (typeof at === "string") return fail(at);
      const w = project(at.lat, at.lng);
      const n = engine.scene.world.nodeAt(w.x, w.z);
      if (!n) return fail("That spot isn't loaded on the map yet. Fly there first.");
      engine.flag(n);
      return json({ ok: true, flagged: at.label });
    }),

    set_demo_mode: guard((p) => {
      const on = p.on === true || p.on === "true";
      engine.setSimulation(on);
      return json({ ok: true, demo: on, note: "Demo scenario data is simulated and labelled SIMULATION." });
    }),
  };
}
