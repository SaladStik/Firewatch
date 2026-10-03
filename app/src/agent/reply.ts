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

export interface FiresAnswer {
  /** Worst stage, then biggest first. `agency` is who reported it. */
  fires: { label: string; stage: string; agency: string }[];
  simulation: boolean;
  scope?: string;
  /** Unconfirmed satellite heat in the last 24 h. */
  heat?: { hotspots: number; clusters: number; farm: number };
  /** The province's own fire agency, when one province was asked about: it is named even with none. */
  ownAgency?: string;
  /** The question was about hotspots: lead with them. */
  heatFirst?: boolean;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Official fires per reporting agency first; satellite hotspots only as unconfirmed heat. */
export function firesReply({ fires, simulation, scope = "the regions in focus", heat, ownAgency, heatFirst }: FiresAnswer): string {
  const sim = simulation ? " This is a simulation." : "";
  const stages = (list: FiresAnswer["fires"]) => ["out of control", "being held", "under control"]
    .map((st) => [st, list.filter((f) => f.stage === st).length] as const)
    .filter(([, n]) => n)
    .map(([st, n]) => `${n} ${st}`)
    .join(", ");
  const agencies = [...new Set([...(ownAgency ? [ownAgency] : []), ...fires.map((f) => f.agency)])];
  const official = agencies.map((a) => {
    const mine = fires.filter((f) => f.agency === a);
    if (!mine.length) return `${a} reports no active wildfires in ${scope}`;
    if (a.startsWith("demo")) return `the demo scenario adds ${plural(mine.length, "simulated fire")}`;
    if (a.startsWith("Parks Canada")) return `Parks Canada reports ${mine.length} in national parks ${ownAgency ? "there" : `in ${scope}`} (${stages(mine)})`;
    return `${a} reports ${plural(mine.length, "active wildfire")} in ${scope} (${stages(mine)})`;
  });
  const said = official.length ? official.join("; ") : `no active wildfires are reported by the fire agencies in ${scope}`;
  const sentence = said[0].toUpperCase() + said.slice(1);
  const heatText = heat?.hotspots
    ? `${plural(heat.hotspots, "hotspot")} in the last 24 h (${plural(heat.clusters, "cluster")}): unconfirmed heat, not confirmed wildfires${heat.farm ? `, and ${heat.farm} look like farm or controlled burns` : ""}`
    : "no hotspots in the last 24 h";
  if (heatFirst) return `${scope}: satellites detected ${heatText}. Officially, ${said}.${sim}`;
  const shown = fires.slice(0, 2);
  const more = fires.length - shown.length;
  const list = shown.length ? ` Top: ${shown.map((f) => f.label).join("; ")}${more ? `; and ${more} more` : ""}.` : "";
  return `${sentence}.${list}${heat?.hotspots ? ` Satellites also see ${heatText}.` : ""}${sim}`;
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
  if (plan.reply === "fires" && fires?.firesAnswer) return firesReply(fires.firesAnswer);
  const lines = results.map((r) => r.summary).filter(Boolean);
  return lines.length ? lines.join(" ") : UNKNOWN_REPLY;
}
