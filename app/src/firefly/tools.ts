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
import { activeFires, briefing, crewRanking, explainAt, findPlace, fireList, placeReport, townsInPath, type FactsSnapshot } from "./facts";
import { flyFireflyTo, fireflyController } from "./mascot";

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
const LAYERS: (keyof Layers)[] = ["risk", "fires", "spread", "beacons", "wind", "rain"];
const NOTE = "Projected spread is a scenario model, not an official forecast.";

type Params = Record<string, unknown>;

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

    plan_crews: guard((p) => {
      const crews = Math.min(10, Math.max(1, Math.round(Number(p.crews ?? 1)) || 1));
      const ranked = crewRanking(snapshot(), crews);
      if (!ranked.length) return json({ result: "No active fires right now." });
      return json({ crews, picks: ranked, note: NOTE });
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
