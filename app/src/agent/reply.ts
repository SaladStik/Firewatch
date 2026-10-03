/** Turns tool results into one or two sentences. Figures are copied from those results, never invented. */
import type { ExplainFacts, Plan, ToolResult } from "./types";

export const UNKNOWN_REPLY =
  "I can fly to a place or province, focus a region, set the forecast, turn wind, rain, spread, beacons, or bloom on or off, list communities at risk, and go to the largest fire.";

export function explainReply(f: ExplainFacts): string {
  const sim = f.simulation ? " This is a simulation." : "";
  if (f.weatherMissing || f.fwi == null || !f.danger) {
    const why = f.weatherState === "loading" ? "still loading" : f.weatherState === "error" ? "unavailable" : "not loaded";
    return `${f.name}: weather is ${why}, so there is no FWI to report.${sim}`;
  }
  const windLayer = f.windLayer ? ", with wind on" : "";
  const wind = f.windKmh != null
    ? ` Wind is ${Math.round(f.windKmh)} km/h${f.windFrom ? ` from the ${f.windFrom}` : ""}.`
    : "";
  const precip = f.precipMm != null && f.precipMm > 0
    ? ` ${f.precipKind === "snow" ? "Snow" : "Rain"} is ${f.precipMm.toFixed(1)} mm.`
    : "";
  const threat = f.threatReason ? ` ${f.name} is at risk: ${f.threatReason}.` : "";
  const near = f.nearestHotspotKm != null
    ? ` Nearest hotspot is ${f.nearestHotspotKm >= 10 ? Math.round(f.nearestHotspotKm) : +f.nearestHotspotKm.toFixed(1)} km.`
    : "";
  return `${f.dayLabel}${windLayer}: ${f.name} is FWI ${f.fwi.toFixed(1)}, ${f.danger}.${wind}${precip}${threat}${near}${sim}`;
}

export function threatsReply(threats: { name: string; reason: string }[], dayLabel: string, simulation: boolean): string {
  const sim = simulation ? " This is a simulation." : "";
  if (!threats.length) return `No communities are listed at risk for ${dayLabel}, from live fires and weather.${sim}`;
  const shown = threats.slice(0, 6);
  const more = threats.length - shown.length;
  const list = shown.map((t) => `${t.name} (${t.reason})`).join("; ");
  return `${dayLabel}, from live fires and weather: ${list}${more ? `; and ${more} more` : ""}.${sim}`;
}

export function firesReply(fires: { label: string }[], simulation: boolean): string {
  const sim = simulation ? " This is a simulation." : "";
  if (!fires.length) return `No active fires in the loaded data.${sim}`;
  const shown = fires.slice(0, 6);
  const more = fires.length - shown.length;
  const list = shown.map((f) => f.label).join("; ");
  return `Active fires: ${list}${more ? `; and ${more} more` : ""}.${sim}`;
}

export function renderReply(plan: Plan, results: ToolResult[]): string {
  if (plan.reply === "ambiguous") {
    const names = plan.candidates ?? [];
    return names.length ? `Several places match: ${names.join(", ")}. Say the full name.` : "Several places match. Say the full name.";
  }
  if (plan.reply === "unknown") return UNKNOWN_REPLY;
  const explain = results.find((r) => r.facts);
  if (plan.reply === "explain" && explain?.facts) return explainReply(explain.facts);
  const threats = results.find((r) => r.tool === "listThreats");
  if (plan.reply === "threats" && threats?.threats) return threatsReply(threats.threats, threats.dayLabel ?? "Today", !!threats.simulation);
  const fires = results.find((r) => r.tool === "listFires");
  if (plan.reply === "fires" && fires?.fires) return firesReply(fires.fires, !!fires.simulation);
  const lines = results.map((r) => r.summary).filter(Boolean);
  return lines.length ? lines.join(" ") : UNKNOWN_REPLY;
}
