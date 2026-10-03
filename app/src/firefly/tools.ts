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
import { activeFires, briefing, crewRanking, explainAt, findPlace, fireList, fireView, HEAT_NOTE, heatDetections, heatView, ownProjection, placeReport, riskZones, spreadHeading, townsInPath, windByDay, type FactsSnapshot } from "./facts";
import { flyFireflyTo, fireflyController } from "./mascot";

export function snapshot(): FactsSnapshot {
  const s = app.get();
  const sim = s.simulation ? s.regions.flatMap((r) => simulatedHotspots(r.demoSites)) : [];
  return {
    places: s.places, hotspots: [...s.hotspots, ...sim], perimeters: s.perimeters, weather: s.weather,
    reported: s.reportedFires, reportedOk: s.dataStatus.reported !== "error",
    forecastDay: s.forecastDay, simulation: s.simulation, spread: s.spread, fireGrowth: s.fireGrowth,
    focus: new Set(focusIndices()), regionNames: s.regions.map((r) => r.name), regionCodes: s.regions.map((r) => r.code), now: Date.now(),
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

/** An official fire or a heat detection by id (list_fires gives both). */
function findFire(s: FactsSnapshot, id: unknown) {
  const fire = activeFires(s).find((x) => x.fid === id);
  if (fire) return { fire, heat: undefined };
  const heat = heatDetections(s).find((x) => x.fid === id);
  return heat ? { fire: undefined, heat } : null;
}

function locate(s: FactsSnapshot, p: Params): { lat: number; lng: number; label: string; fire: boolean } | string {
  if (typeof p.fire_id === "string" && p.fire_id) {
    const f = findFire(s, p.fire_id);
    if (!f) return `No active fire or heat detection with id ${p.fire_id}. Call list_fires for ids.`;
    const at = f.fire ?? f.heat!;
    return { lat: at.lat, lng: at.lng, label: f.fire ? `fire ${f.fire.name}` : `heat detection ${f.heat!.fid}`, fire: true };
  }
  if (typeof p.place === "string" && p.place) {
    const r = findPlace(s.places, p.place);
    return r.place ? { lat: r.place.lat, lng: r.place.lng, label: r.place.name, fire: false } : `Unknown place "${p.place}". Did you mean: ${r.suggestions.join(", ")}?`;
  }
  return "Give a place or a fire_id.";
}

/** Most samples per risk scan (≈ 25 ms in the worker). */
const SCAN_SAMPLES = 15000;

export function makeTools(engine: Engine) {
  /** Zones from the last find_risk_areas, so fly_to can show "zone 2". */
  let lastZones: ReturnType<typeof riskZones> = [];
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
      const list = fireList(snapshot());
      if (!list.officialTotal && !list.heatDetectionsTotal) return json({ result: "No active wildfires reported and no satellite heat detections right now." });
      return json(list);
    }),

    get_fire_details: guard(async (p) => {
      const found = findFire(snapshot(), p.fire_id);
      if (!found) return fail(`No active fire or heat detection with id ${String(p.fire_id)}. Call list_fires for ids.`);
      const days = Math.min(7, Math.max(1, Math.round(Number(p.days ?? 3)) || 3));
      await engine.setForecastDay(days);
      const s = snapshot();
      const fire = found.fire ?? found.heat!;
      const f = found.fire ? fireView(s, found.fire) : { ...heatView(s, found.heat!), heatNote: HEAT_NOTE };
      void show(fire.lat, fire.lng, 60);
      // Towns in a projected path that belongs to this fire (not a neighbour's), within 150 km.
      const w = project(fire.lat, fire.lng);
      const own = ownProjection(s, w);
      const towns = (own ? townsInPath(s) : [])
        .filter((t) => { const q = project(t.lat, t.lng); return Math.hypot(q.x - w.x, q.z - w.z) < 150 && own!(q.x, q.z); })
        .slice(0, 8)
        .map(({ place, population, day }) => ({ place, population, day }));
      return json({
        ...f, horizonDays: days, communitiesInProjectedPath: towns,
        projectedSpread: spreadHeading(s, fire)
          ?? (found.heat ? "none: heat detections are unconfirmed, so they aren't projected"
            : found.fire!.stage === "under_control" ? "none: under-control fires aren't projected"
            : !app.get().layers.spread ? "none: the projected spread layer is off" : "none: the model doesn't reach new ground by this day"),
        windAtFireByDay: windByDay(s, fire.lat, fire.lng, days),
        note: `${NOTE} The projection adds up each day's noon wind (and runs faster uphill), while the wind layer shows only the selected day's wind (today: the live wind), so the spread can lean away from the wind on screen when the wind shifts during the week.`,
      });
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
      if (!ranked.length) return json({ result: "No active wildfires reported by the fire agencies right now. Satellite heat detections are unconfirmed, so they aren't ranked for crews." });
      return json({ crews, picks: ranked, note: NOTE });
    }),

    find_risk_areas: guard(async (p) => {
      if (p.day !== undefined && p.day !== null && p.day !== "") {
        await engine.setForecastDay(Math.min(7, Math.max(0, Math.round(Number(p.day)) || 0)));
      }
      const s = snapshot();
      const pts = s.places.filter((pl) => s.focus.has(pl.region)).map((pl) => project(pl.lat, pl.lng));
      if (!pts.length) return fail("No regions are in focus.");
      const pad = 40;
      const x0 = Math.min(...pts.map((q) => q.x)) - pad, x1 = Math.max(...pts.map((q) => q.x)) + pad;
      const z0 = Math.min(...pts.map((q) => q.z)) - pad, z1 = Math.max(...pts.map((q) => q.z)) + pad;
      const step = Math.max(3, Math.sqrt(((x1 - x0) * (z1 - z0)) / SCAN_SAMPLES));
      const nx = Math.ceil((x1 - x0) / step) + 1, nz = Math.ceil((z1 - z0) / step) + 1;
      const scan = await engine.riskScan(x0, z0, step, nx, nz);
      lastZones = riskZones(s, { x0, z0, step, nx, nz, risk: scan.risk });
      const date = s.weather[0]?.dates[s.forecastDay] ?? `+${s.forecastDay}d`;
      if (!lastZones.length) return json({ date, result: "No High or Extreme danger areas on the map for this day." });
      const top = lastZones[0];
      void show(top.lat, top.lng, Math.min(250, Math.max(40, top.acrossKm * 1.3)));
      return json({ date, zones: lastZones, showing: "zone 1", note: "Zones are unnamed areas of the risk layer; describe them by the nearest town." });
    }),

    fly_to: guard(async (p) => {
      const zone = Number(p.zone);
      if (zone >= 1) {
        const z = lastZones[zone - 1];
        if (!z) return fail("No such zone. Call find_risk_areas first.");
        void show(z.lat, z.lng, Math.min(250, Math.max(40, z.acrossKm * 1.3)));
        return json({ ok: true, showing: `danger zone ${zone} ${z.near ?? ""}`.trim() });
      }
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
