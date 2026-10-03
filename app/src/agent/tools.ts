/** Runs a plan through the public engine API. No new data fetches. */
import type { Engine } from "../engine";
import { weatherAt } from "../data/openMeteo";
import { snowShare } from "../data/rain";
import { project } from "../geo/projection";
import { app, type Layers } from "../state/app";
import { dayLabel, compassName } from "../ui/weatherFormat";
import { activeFires, agencyName, fireView, heatDetections, rankedFires } from "../firefly/facts";
import { snapshot } from "../firefly/tools";
import { buildBrief, fireList as briefFires, threatList, threatReasonAt } from "./brief";
import { renderReply } from "./reply";
import { ruleBrain } from "./rules";
import type { Plan, ToolCall, ToolResult } from "./types";

const LAYER_LABEL: Record<keyof Layers, string> = {
  risk: "Fire risk",
  fires: "Fires",
  spread: "Projected spread",
  air: "Air quality",
  traffic: "Traffic corridors",
  beacons: "Beacons",
  wind: "Wind",
  rain: "Rain and snow",
  bloom: "Highlight glow",
};

function forecastName(day: number): string {
  if (day === 0) return "Today";
  if (day === 1) return "Tomorrow";
  return dayLabel(day, app.get().weather[0]?.dates);
}

function kmBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const p = project(a.lat, a.lng);
  const q = project(b.lat, b.lng);
  return Math.hypot(p.x - q.x, p.z - q.z);
}

function ensureFocus(engine: Engine, regionId: string) {
  if (!regionId) return;
  const focus = app.get().focus;
  if (!focus.includes(regionId)) engine.setFocus([...focus, regionId]);
}

function runCall(engine: Engine, call: ToolCall): ToolResult {
  switch (call.tool) {
    case "focus": {
      engine.setFocus(call.args.ids);
      const names = call.args.ids.map((id) => app.get().regions.find((r) => r.id === id)?.name ?? id);
      return { tool: call.tool, summary: `Focus: ${names.join(", ")}` };
    }
    case "flyToPlace": {
      ensureFocus(engine, call.args.regionId);
      engine.flyToLatLng(call.args.lat, call.args.lng, call.args.dist);
      return { tool: call.tool, summary: `Flew to ${call.args.name}` };
    }
    case "flyToRegion": {
      ensureFocus(engine, call.args.regionId);
      engine.scene.flyToRegion(call.args.index);
      return { tool: call.tool, summary: `Flew to ${call.args.name}` };
    }
    case "setLayer": {
      engine.setLayer(call.args.key, call.args.on);
      return { tool: call.tool, summary: `${LAYER_LABEL[call.args.key]} ${call.args.on ? "on" : "off"}` };
    }
    case "setForecastDay": {
      const day = Math.min(7, Math.max(0, Math.round(call.args.day)));
      engine.setForecastDay(day);
      return { tool: call.tool, summary: `Forecast: ${forecastName(day).toLowerCase()}` };
    }
    case "setSimulation": {
      engine.setSimulation(call.args.on);
      return { tool: call.tool, summary: call.args.on ? "Simulation on" : "Simulation off" };
    }
    case "listThreats": {
      const threats = threatList();
      return {
        tool: call.tool,
        summary: "Listed communities at risk",
        threats,
        dayLabel: forecastName(app.get().forecastDay),
        simulation: false,
      };
    }
    case "listFires": {
      // Agency-reported fires (Firefly's facts), in the province asked about or the ones in focus.
      const s = snapshot();
      const idx = call.args.regionIndex;
      if (idx != null && idx >= 0) s.focus = new Set([idx]);
      const regions = [...s.focus];
      const scope = regions.map((i) => s.regionNames[i]).filter(Boolean).join(", ") || "the regions in focus";
      const heat = heatDetections(s).filter((h) => h.kind === "hotspots" && !h.officialFire);
      const hotspots = s.hotspots.filter((h) => h.agency !== "SIMULATION" && h.region != null && s.focus.has(h.region)).length;
      return {
        tool: call.tool, summary: "Listed active fires",
        firesAnswer: {
          simulation: s.simulation, scope, heatFirst: call.args.heatFirst,
          // One province: name its own agency even when it reports none (a park's fires are Parks Canada's).
          ownAgency: regions.length === 1 && s.regionCodes?.[regions[0]] ? agencyName(s.regionCodes[regions[0]]) : undefined,
          fires: rankedFires(s).map((x) => fireView(s, x)).map((f) => ({
            stage: f.stage, agency: f.reportedBy,
            label: `${f.name}, ${f.stage}, ${f.hectares.toLocaleString("en-CA")} ha${f.near ? `, ${f.near}` : ""}`,
          })),
          heat: { hotspots, clusters: heat.length, farm: heat.filter((h) => h.likelyFarmOrControlledBurn).length },
        },
      };
    }
    case "flyToFire": {
      const biggest = activeFires(snapshot()).sort((a, b) => b.sizeHa - a.sizeHa)[0];
      if (!biggest) return { tool: call.tool, summary: "No active wildfire reported by the fire agencies to fly to" };
      engine.flyToLatLng(biggest.lat, biggest.lng, 25);
      return { tool: call.tool, summary: `Flew to the largest reported fire, ${biggest.name} (${Math.round(biggest.sizeHa).toLocaleString("en-CA")} ha)` };
    }
    case "explain": {
      const s = app.get();
      const { name, lat, lng, pop, regionIndex } = call.args;
      const cell = weatherAt(s.weather, lat, lng);
      const wx = cell?.days[s.forecastDay];
      const scored = wx && Number.isFinite(wx.fwi) ? wx : null;
      if (engine.scene) {
        const w = project(lat, lng);
        const node = engine.scene.world.nodeAt(w.x, w.z);
        if (node) engine.scene.select(node);
      }
      let nearest: number | null = null;
      for (const fire of briefFires()) {
        if (fire.kind !== "hotspot") continue;
        const d = kmBetween({ lat, lng }, fire);
        if (nearest == null || d < nearest) nearest = d;
      }
      const reason = regionIndex >= 0 ? threatReasonAt({ name, lat, lng, pop, region: regionIndex }) : null;
      return {
        tool: call.tool,
        summary: "",
        facts: {
          name,
          dayLabel: forecastName(s.forecastDay),
          windLayer: s.layers.wind,
          fwi: scored ? scored.fwi : null,
          danger: scored ? scored.danger : null,
          windKmh: scored && Number.isFinite(scored.wind) ? scored.wind : null,
          windFrom: scored && Number.isFinite(scored.windFrom) ? compassName(scored.windFrom).toLowerCase() : null,
          precipMm: scored && Number.isFinite(scored.rainMm) ? scored.rainMm : null,
          precipKind: scored ? (snowShare(scored.temp) >= 0.5 ? "snow" : "rain") : null,
          threatReason: reason,
          nearestHotspotKm: nearest,
          weatherMissing: !scored,
          weatherState: s.dataStatus.weather,
          simulation: s.simulation,
        },
      };
    }
  }
}

export function runPlan(engine: Engine, plan: Plan): { results: ToolResult[]; reply: string } {
  const results = plan.calls.map((call) => runCall(engine, call));
  return { results, reply: renderReply(plan, results) };
}

/**
 * A map answer from data already loaded, or null when the question needs the model.
 * `handOffAmbiguous`: return null instead of "Several places match…" (the model can ask better).
 */
export function answerLocally(engine: Engine, text: string, handOffAmbiguous = false): { reply: string; threats: boolean } | null {
  const plan = ruleBrain.plan(text, buildBrief(engine));
  if (plan.reply === "unknown" || (handOffAmbiguous && plan.reply === "ambiguous")) return null;
  try {
    if (plan.calls.length && plan.reply !== "ambiguous") {
      return { reply: runPlan(engine, plan).reply, threats: plan.reply === "threats" };
    }
    return { reply: renderReply(plan, []), threats: false };
  } catch (err) {
    return { reply: err instanceof Error ? err.message : "That did not run.", threats: false };
  }
}
