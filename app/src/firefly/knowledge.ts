/**
 * Everything the app knows, for Firefly: one question tool (ask_data) over every data set, and one
 * action tool (do_dispatch) that can work both dispatch queues. Same functions serve the ElevenLabs
 * agent's client tools and the typed Ask (no model needed). Every answer is compact JSON built from
 * the app's own state, so Firefly never has to guess.
 */
import { assetsForRegions } from "../data/criticalAssets";
import { simulatedHotspots } from "../data/hazards";
import { valuesAtRisk } from "../data/valuesAtRisk";
import { BASES, KIND } from "../dispatch/fleet";
import { dutyBriefing, label, type Scored } from "../dispatch/crews";
import {
  fleetNow, flyTo, loadCases, openDispatch, openTickets, plan311Now, recompute311, recomputeCrews, recomputeFleet, set311Options, setCrewOptions,
  setFleetOptions, setOverride, setShortestOrder, setSource311, pollAircraft,
} from "../dispatch/controller";
import { daysWaiting, priorityParts, typeOf, type Ticket } from "../dispatch/ops311";
import { dispatch } from "../dispatch/store";
import type { Engine } from "../engine";
import { app, focusIndices } from "../state/app";
import { DATA_TOPICS, DISPATCH_ACTIONS } from "./topics";
import { fireHotspotsOf } from "../state/fires";

export { DATA_TOPICS, DISPATCH_ACTIONS };

type P = Record<string, unknown>;
const r1 = (v: number) => Math.round(v * 10) / 10;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));
const num = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v));
const title = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());


// ------------------------------------------------------------ helpers
const fireKey = (s: Scored) => `${s.fire.year}:${s.fire.id}`;

function findFire(id: string): { s: Scored; rank: number } | null {
  const plan = dispatch.get().plan;
  if (!plan || !id) return null;
  const q = id.toLowerCase();
  // Our short agency number ("WB16"), the national id list_fires gives ("2026_PC_2026WB16"), or the label.
  const i = plan.ranked.findIndex((s) => {
    const id = s.fire.id.toLowerCase();
    return id === q || (id.length >= 3 && q.endsWith(id)) || label(s).toLowerCase().includes(q);
  });
  return i >= 0 ? { s: plan.ranked[i], rank: i + 1 } : null;
}

function assignmentsOf(s: Scored) {
  const fd = dispatch.get().fleetDispatch.find((x) => x.fire === s);
  return {
    resources: fd?.assignments.map((a) => ({
      resource: `${KIND[a.resource.kind].label} ${a.resource.id}`, from: a.resource.base.name, etaMin: Math.round(a.eta),
      ...(a.dropsPerHour ? { dropsPerHour: r1(a.dropsPerHour) } : {}), ...(a.lake ? { lakeKm: r1(a.lake.km) } : {}), why: a.why,
    })) ?? [],
    unmet: fd?.unmet ?? [],
  };
}

function fireFacts(s: Scored, rank: number) {
  const plan = dispatch.get().plan!;
  const crewed = plan.pickedCut.includes(s), lost = plan.lostCrew.includes(s);
  return {
    fire: label(s), year: s.fire.year, rank, crewedAfterCut: crewed, lostCrewInCut: lost,
    sizeHa: r1(s.fire.sizeHa), spreadMMin: r1(s.ros), crown: s.fire.crown, fuel: s.fire.fuelCode,
    weather: { tempC: Math.round(s.fire.tempC), rh: Math.round(s.fire.rh), windKmh: Math.round(s.fire.windKmh) },
    nearest: s.exposure.nearest ? `${Math.round(s.exposure.nearest.km)} km ${s.exposure.nearest.dir} of ${s.exposure.nearest.name}` : null,
    peopleWithin30km: Math.round(s.exposure.people), criticalSites: s.exposure.sites.slice(0, 4).map((x) => `${x.name} (${Math.round(x.km)} km)`),
    reason: s.reason, decision: dispatch.get().decided[fireKey(s)] ?? "not yet", ...assignmentsOf(s),
    ...(s.fire.finalHa != null ? { finalHaAfterwards: Math.round(s.fire.finalHa) } : {}),
  };
}

function ticketView(t: Ticket) {
  const d = dispatch.get(), p = d.plan311;
  if (!p) return null;
  const noon = d.at === "noon" && p.noon;
  const ctx = noon ? p.noonCtx : p.ctx, view = noon ? p.noon! : p.morning;
  let at: string | null = null;
  view.routes.forEach((jobs, crew) => { const i = jobs.findIndex((j) => j.id === t.id); if (i >= 0) at = `${crew} stop ${i + 1}`; });
  const pp = priorityParts(t, p.today, ctx);
  return {
    id: t.id, type: typeOf(t.service).label, unit: typeOf(t.service).unit, community: title(t.community), received: t.date, daysWaiting: daysWaiting(t, p.today), status: t.status,
    priority: pp.total, breakdown: { severity: pp.safety, weatherAndPlace: pp.impact, waiting: pp.waiting, moreReports: pp.nearby, history: pp.history, urgent: pp.urgent },
    why: pp.why, plannedAs: at ?? "waiting", override: d.overrides[t.id] ?? null, locationIsCommunityCentre: !!t.approx,
  };
}

/** A 311 plan on hand (throws with the reason when there can't be one). */
async function ensure311() {
  if (!dispatch.get().plan311 || !dispatch.get().load311) await plan311Now();
}
async function ensureCrews() {
  await loadCases();
  if (!dispatch.get().plan) recomputeCrews();
  await recomputeFleet();
}

// ------------------------------------------------------------ questions
export async function askData(engine: Engine, p: P): Promise<unknown> {
  const topic = str(p.topic);
  const s = app.get();
  switch (topic) {
    case "air_quality": {
      if (!s.layers.air) engine.setLayer("air", true);
      const list = app.get().airThreats.slice(0, 10).map((a) => ({ place: a.place.name, aqhi: a.aqhi, level: a.level, reason: a.reason }));
      return { day: s.forecastDay, advisories: list, note: "Smoke estimate from fires, wind and projected spread (an AQHI-style band, not a measured reading)." };
    }
    case "highways": {
      if (!s.layers.traffic) engine.setLayer("traffic", true);
      return {
        day: s.forecastDay,
        corridors: app.get().trafficThreats.slice(0, 8).map((c) => ({ highway: c.highway.n, vehiclesPerDay: Math.round(c.volume), jam: r1(c.jam), closed: c.closed, reason: c.reason, at: `${c.lat.toFixed(2)}, ${c.lng.toFixed(2)}` })),
      };
    }
    case "values_at_risk": {
      let lat: number | undefined, lng: number | undefined, what = "";
      const f = findFire(str(p.fire_id));
      if (f) { lat = f.s.fire.lat; lng = f.s.fire.lng; what = label(f.s); }
      else if (s.selected) { ({ lat, lng } = s.selected); what = "the selected spot"; }
      const placeName = str(p.place);
      if (placeName) { const pl = s.places.find((x) => x.name.toLowerCase() === placeName.toLowerCase()); if (pl) { lat = pl.lat; lng = pl.lng; what = pl.name; } }
      if (lat === undefined || lng === undefined) return { error: "Give a fire_id or a place (or select a hex)." };
      const regions = s.regions.filter((_, i) => focusIndices().includes(i));
      const fires = fireHotspotsOf(s);
      const hot = s.simulation ? [...fires, ...regions.flatMap((r) => simulatedHotspots(r.demoSites))] : fires;
      const r = valuesAtRisk({ lat, lng, assets: assetsForRegions(regions.map((x) => x.id)), hotspots: hot, perimeters: s.perimeters, weather: s.weather, day: s.forecastDay, spread: s.spread, growth: s.fireGrowth });
      return { around: what, fire: r.focus.label, assets: r.items.slice(0, 10).map((v) => ({ name: v.asset.name, kind: v.asset.kind, km: r1(v.km), direction: v.dir, reason: v.reason })) };
    }
    case "aircraft": {
      const d = dispatch.get();
      if (d.aircraftStatus === "idle") await pollAircraft();
      const dd = dispatch.get();
      return {
        status: dd.aircraftStatus, fetchedAt: dd.aircraftAt,
        live: dd.liveAircraft.map((a) => ({ reg: a.reg, callsign: a.callsign, type: a.name, altFt: a.altFt, speedKt: Math.round(a.gsKt), track: Math.round(a.track), at: `${a.lat.toFixed(2)}, ${a.lng.toFixed(2)}` })),
        note: dd.aircraftStatus === "no-server" ? "Live aircraft need the data server (adsb.lol blocks web pages)." : "Real firefighting aircraft in the air now, from ADS-B (adsb.lol). Helicopters and bird dogs aren't identifiable by type.",
      };
    }
    case "fleet": {
      await ensureCrews();
      const fd = dispatch.get().fleetDispatch, used = new Map<string, string>();
      fd.forEach((x) => x.assignments.forEach((a) => used.set(a.resource.id, label(x.fire))));
      const d = dispatch.get(), plan = d.plan;
      return {
        bases: BASES.map((b) => b.name),
        kinds: Object.fromEntries(Object.entries(KIND).map(([k, v]) => [k, `${v.label}: ${v.note}, ${v.speedKmh} km/h, ${v.getawayMin} min getaway`])),
        groundCrewsAfterCut: plan?.cutCrews, airtankers: d.airtankers, skimmers: d.skimmers,
        assigned: [...used].slice(0, 40).map(([r, f]) => `${r} → ${f}`),
        resources: fleetNow().map((r) => ({ id: r.id, kind: KIND[r.kind].label, base: r.base.name, assignedTo: used.get(r.id) ?? null })),
        note: "Bases are Alberta Wildfire's airtanker bases; how many of each resource is at each base is illustrative.",
      };
    }
    case "wildfire_queue": {
      await ensureCrews();
      const d = dispatch.get(), plan = d.plan;
      if (!plan) return { result: "No crew plan yet." };
      const list = plan.pickedCut;
      const cur = list[Math.min(d.cursor, list.length - 1)];
      return {
        source: d.source === "history" ? "Alberta wildfires 2023–2025" : "live fires", crews: plan.crews, crewsAfterCut: plan.cutCrews,
        decided: list.filter((x) => d.decided[fireKey(x)]).length, total: list.length,
        nextUp: cur ? fireFacts(cur, plan.ranked.indexOf(cur) + 1) : null,
        list: list.slice(0, 12).map((x, i) => ({ rank: i + 1, fire: label(x), decision: d.decided[fireKey(x)] ?? "not yet" })),
        lostCrewInCut: plan.lostCrew.map(label),
        skippedVsBiggestFirst: plan.skippedVsBaseline.slice(0, 5).map((x) => ({ fire: label(x), sizeHa: r1(x.fire.sizeHa), spreadMMin: r1(x.ros), peopleWithin30km: Math.round(x.exposure.people) })),
        dutyOfficer: dutyBriefing(plan, { live: d.source === "live" }),
        ...(plan.grades ? { vsBiggestFirst: { ours: plan.grades.ours.escapesCaught, biggestFirst: plan.grades.baseline.escapesCaught, oursAfterCut: plan.grades.cut.escapesCaught, biggestFirstAfterCut: plan.grades.baselineCut.escapesCaught, escapesTotal: plan.grades.ours.escapesTotal } } : {}),
      };
    }
    case "fire": {
      await ensureCrews();
      const f = findFire(str(p.fire_id));
      if (!f) return { error: `No fire ${str(p.fire_id)} on the list. Ask for the wildfire_queue for ids.` };
      flyTo(f.s.fire.lat, f.s.fire.lng, 60);
      return fireFacts(f.s, f.rank);
    }
    case "tickets": {
      await ensure311();
      const d = dispatch.get(), plan = d.plan311, load = d.load311;
      if (!plan || !load) return { result: "311 plan is still loading." };
      const q = str(p.query).toLowerCase(), comm = str(p.community).toLowerCase(), unit = str(p.unit);
      const ctx = d.at === "noon" && plan.noon ? plan.noonCtx : plan.ctx;
      const hits = load.open.filter((t) => (!comm || t.community.toLowerCase().includes(comm)) && (!unit || typeOf(t.service).unit === unit) && (!q || `${t.service} ${typeOf(t.service).label} ${t.community} ${t.id}`.toLowerCase().includes(q)));
      const sorted = hits.map((t) => ({ t, pr: priorityParts(t, plan.today, ctx).total })).sort((a, b) => b.pr - a.pr);
      const limit = Math.min(15, Math.max(1, num(p.limit) ?? 8));
      if (comm || q) openTickets(true);
      return { source: load.source, matching: hits.length, top: sorted.slice(0, limit).map(({ t }) => ticketView(t)) };
    }
    case "ticket": {
      await ensure311();
      const id = str(p.ticket_id), load = dispatch.get().load311;
      const t = load?.all.find((x) => x.id === id) ?? load?.open.find((x) => x.id === id);
      if (!t) return { error: `No ticket ${id} in the ${load?.source ?? ""} set.` };
      flyTo(t.lat, t.lng, 2.5);
      return ticketView(t);
    }
    case "crews_311": {
      await ensure311();
      const d = dispatch.get(), plan = d.plan311;
      if (!plan) return { result: "311 plan is still loading." };
      const view = d.at === "noon" && plan.noon ? plan.noon : plan.morning;
      const crews = d.at === "noon" && plan.noon ? plan.noonCrews : plan.crews;
      return {
        day: plan.today, at: d.at,
        crews: crews.map((c) => ({
          crew: c.id, unit: c.unit, dispatched: !!d.dispatched[c.id],
          route: d.routes[c.id] ? { km: r1(d.routes[c.id].km), minutes: Math.round(d.routes[c.id].minutes) } : null,
          stops: (view.routes.get(c.id) ?? []).map((t) => `${typeOf(t.service).label}, ${title(t.community)}`),
        })),
        vsOldestFirst: { safetyJobs: plan.scores.morning.safetyJobs, oldestFirst: plan.scores.fifo.safetyJobs },
      };
    }
    case "schedule_311": {
      await ensure311();
      return { week: dispatch.get().schedule311.map((x) => ({ date: x.date, jobs: x.jobs, safetyJobs: x.safetyJobs, openThatMorning: x.open, weather: x.weather ? `${Math.round(x.weather.tempC)} °C, ${x.weather.precipMm.toFixed(0)} mm` : null })), note: "Each day works what the days before it left, with that day's forecast." };
    }
    case "methodology":
      return {
        wildfire: "priority = size × spread × people × crown. Spread is the faster of observed and the FBP rate for the fuel and weather; people are towns and critical sites within 30 km. Baseline: biggest fire first. Graded on fires still under 200 ha when assessed that grew past 200 ha. Weights learned on two seasons, tested on the third.",
        dispatch: "Small fires (≤ 10 ha) get a helitack crew, bigger ones a unit crew (flown in beyond 100 km); fires spreading ≥ 15 m/min or crowning also get a skimmer group if a lake is within 30 km, else an air tanker group. Nearest free resource of each kind.",
        calgary311: "priority = severity × impact (weather today/tomorrow, community: schools, seniors, hospitals, crosswalks, hills, density, industrial) + waiting (vs the city's own time to close) + more reports + history. Year-old or stale-ice tickets are 'verify first'. What gets done is strictly by priority; driving only decides which crew. Open Calgary publishes community centres, not addresses.",
      };
    case "data_sources":
      return {
        sources: [
          "CWFIS (Natural Resources Canada): satellite hotspots, fire perimeters, fire weather stations, hotspot archive",
          "Open-Meteo: weather and forecast (the Canadian FWI System is computed from it)",
          "Government of Alberta: historical wildfires 2023–2025; highway traffic volumes",
          "Open Calgary: live 311 queue, a year of 311 history, community populations and boundaries",
          "OpenStreetMap: roads, rivers, towns, buildings, schools, hospitals, crossings, transit stops",
          "ESA WorldCover (land cover) and AWS Terrain Tiles (elevation)",
          "adsb.lol: live firefighting aircraft (ADS-B)",
        ],
      };
    default:
      return { error: `Unknown topic. Use one of: ${DATA_TOPICS.join(", ")}` };
  }
}

// ------------------------------------------------------------ actions
export async function doDispatch(engine: Engine, p: P): Promise<unknown> {
  const action = str(p.action);
  switch (action) {
    case "dispatch_fire": case "skip_fire": case "next_fire": {
      await ensureCrews();
      openDispatch("crews");
      const d = dispatch.get(), plan = d.plan;
      if (!plan) return { error: "No crew plan yet." };
      const list = plan.pickedCut;
      let s = list[Math.min(d.cursor, list.length - 1)];
      const id = str(p.fire_id);
      if (id) { const f = findFire(id); if (!f) return { error: `No fire ${id} on the list.` }; s = f.s; }
      if (!s) return { error: "The list is empty." };
      if (action === "next_fire") {
        const i = list.findIndex((x) => !d.decided[fireKey(x)]);
        if (i < 0) return { result: "Every fire on the list has been decided." };
        s = list[i];
        dispatch.set({ cursor: i });
        flyTo(s.fire.lat, s.fire.lng, 40);
        return { nextUp: fireFacts(s, plan.ranked.indexOf(s) + 1) };
      }
      if (!list.includes(s)) return { error: `${label(s)} isn't on the crew list after the cut (rank ${plan.ranked.indexOf(s) + 1}).` };
      dispatch.set({ decided: { ...d.decided, [fireKey(s)]: action === "dispatch_fire" ? "sent" : "skipped" } });
      const next = list.findIndex((x) => !dispatch.get().decided[fireKey(x)]);
      if (next >= 0) dispatch.set({ cursor: next });
      flyTo(s.fire.lat, s.fire.lng, 60);
      return { ok: true, fire: label(s), decision: action === "dispatch_fire" ? "dispatched" : "skipped", ...(action === "dispatch_fire" ? assignmentsOf(s) : {}), nextUp: next >= 0 ? label(list[next]) : null };
    }
    case "set_crews": {
      await loadCases();
      const src = str(p.source);
      setCrewOptions({
        ...(num(p.crews) !== undefined ? { crews: Math.min(120, Math.max(1, Math.round(num(p.crews)!))) } : {}),
        ...(num(p.cut_percent) !== undefined ? { cutPct: Math.min(90, Math.max(0, Math.round(num(p.cut_percent)!))) } : {}),
        ...(src === "live" || src === "history" ? { source: src } : {}),
        ...(num(p.year) !== undefined ? { year: num(p.year)! } : {}),
      });
      setFleetOptions({
        ...(num(p.airtankers) !== undefined ? { airtankers: Math.min(20, Math.max(0, Math.round(num(p.airtankers)!))) } : {}),
        ...(num(p.skimmers) !== undefined ? { skimmers: Math.min(10, Math.max(0, Math.round(num(p.skimmers)!))) } : {}),
      });
      // Rank with the new settings now (setCrewOptions re-learns the weights in the background).
      await loadCases();
      recomputeCrews();
      await recomputeFleet();
      openDispatch("crews");
      const d = dispatch.get(), plan = d.plan;
      return {
        ok: true, ...(plan ? { crewsAfterCut: plan.cutCrews, firstFires: plan.pickedCut.slice(0, 3).map(label), lostCrewInCut: plan.lostCrew.map(label) } : {}), crews: d.crews, cutPercent: d.cutPct, airtankers: d.airtankers, skimmers: d.skimmers, source: d.source };
    }
    case "dispatch_crew_311": case "next_crew_311": {
      await ensure311();
      openDispatch("311");
      const d = dispatch.get(), plan = d.plan311!;
      const crews = d.at === "noon" && plan.noon ? plan.noonCrews : plan.crews;
      if (action === "next_crew_311") {
        const i = crews.findIndex((c) => !d.dispatched[c.id]);
        if (i < 0) return { result: "Every crew has been dispatched." };
        dispatch.set({ cursor311: i });
        return { nextUp: crews[i].id };
      }
      const id = str(p.crew).toUpperCase() || crews[Math.min(d.cursor311, crews.length - 1)]?.id;
      if (!crews.some((c) => c.id === id)) return { error: `No crew ${id}. Crews: ${crews.map((c) => c.id).join(", ")}` };
      dispatch.set({ dispatched: { ...d.dispatched, [id]: true } });
      const next = crews.findIndex((c) => !dispatch.get().dispatched[c.id]);
      if (next >= 0) dispatch.set({ cursor311: next });
      const r = d.routes[id];
      return { ok: true, dispatched: id, route: r ? { km: r1(r.km), minutes: Math.round(r.minutes) } : null, nextUp: next >= 0 ? crews[next].id : null };
    }
    case "ticket_urgent": case "ticket_hold": case "ticket_clear": {
      await ensure311();
      const id = str(p.ticket_id);
      if (!dispatch.get().load311?.open.some((t) => t.id === id)) return { error: `No open ticket ${id}.` };
      setOverride(id, action === "ticket_urgent" ? "urgent" : action === "ticket_hold" ? "hold" : null);
      await recompute311();
      const t = dispatch.get().load311!.open.find((x) => x.id === id)!;
      return { ok: true, ticket: ticketView(t) };
    }
    case "set_311": {
      const src = str(p.source), dis = str(p.disruption);
      if (src === "live" || src === "sample") setSource311(src);
      set311Options({
        ...(num(p.roads_crews) !== undefined ? { roads: Math.min(10, Math.max(1, Math.round(num(p.roads_crews)!))) } : {}),
        ...(num(p.waste_crews) !== undefined ? { waste: Math.min(8, Math.max(0, Math.round(num(p.waste_crews)!))) } : {}),
        ...(num(p.jobs_per_crew) !== undefined ? { perCrew: Math.min(12, Math.max(1, Math.round(num(p.jobs_per_crew)!))) } : {}),
        ...(dis === "none" || dis === "blizzard" || dis === "sick" ? { disruption: dis } : {}),
      });
      openDispatch("311");
      await recompute311();
      const d = dispatch.get();
      return { ok: true, source: d.source311, roads: d.roads, waste: d.waste, jobsPerCrew: d.perCrew, disruption: d.disruption };
    }
    case "shortest_route": {
      await ensure311();
      const crew = str(p.crew).toUpperCase();
      const saved = await setShortestOrder(crew, p.on !== false && p.on !== "false");
      const r = dispatch.get().routes[crew];
      return { ok: true, crew, minutesSaved: Math.round(saved), route: r ? { km: r1(r.km), minutes: Math.round(r.minutes) } : null };
    }
    case "show_tickets":
      openDispatch("311");
      openTickets(true);
      return { ok: true };
    case "show_day": {
      const day = Math.min(7, Math.max(0, Math.round(num(p.day) ?? 0)));
      await engine.setForecastDay(day);
      return { ok: true, day, date: app.get().weather[0]?.dates[day] ?? `+${day}d` };
    }
    default:
      return { error: `Unknown action. Use one of: ${DISPATCH_ACTIONS.join(", ")}` };
  }
}
