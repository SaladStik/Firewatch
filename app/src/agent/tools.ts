/** Runs a plan through the public engine API. No new data fetches. */
import type { Engine } from "../engine";
import { weatherAt } from "../data/openMeteo";
import { snowShare } from "../data/rain";
import { project } from "../geo/projection";
import { app, type Layers } from "../state/app";
import { dayLabel, compassName } from "../ui/weatherFormat";
import { fireList, threatList, threatReasonAt } from "./brief";
import { renderReply } from "./reply";
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
      const fires = fireList().map((f) => ({ label: f.kind === "perimeter" ? `Perimeter ${f.label}` : f.label }));
      return { tool: call.tool, summary: "Listed active fires", fires, simulation: app.get().simulation };
    }
    case "flyToFire": {
      const fires = fireList();
      const perimeter = fires.find((f) => f.kind === "perimeter");
      if (perimeter) {
        engine.flyToLatLng(perimeter.lat, perimeter.lng, 25);
        return { tool: call.tool, summary: `Flew to the largest fire, ${perimeter.label}` };
      }
      const spots = fires.filter((f) => f.kind === "hotspot");
      const here = engine.scene?.targetLatLng();
      const nearest = here
        ? spots.reduce<{ lat: number; lng: number; d: number } | null>((best, h) => {
          const d = kmBetween(here, h);
          return !best || d < best.d ? { lat: h.lat, lng: h.lng, d } : best;
        }, null)
        : spots[0] ? { lat: spots[0].lat, lng: spots[0].lng, d: 0 } : null;
      if (!nearest) return { tool: call.tool, summary: "No active fire to fly to" };
      engine.flyToLatLng(nearest.lat, nearest.lng, 18);
      return { tool: call.tool, summary: "Flew to the nearest hotspot" };
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
      for (const fire of fireList()) {
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
