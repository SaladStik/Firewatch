/**
 * Rule brain. One message becomes at most five tool calls (the Calgary example is
 * focus, forecast, one layer, fly, explain). A later model implements the same plan().
 */
import type { AgentBrain, Brief, BriefPlace, BriefRegion, Plan, ToolCall } from "./types";
import type { Layers } from "../state/app";

const MAX_CALLS = 5;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const STOP = new Set([
  "show", "me", "the", "a", "an", "to", "fly", "go", "take", "please", "can", "you", "with", "and",
  "how", "risky", "dangerous", "is", "it", "its", "risk", "what", "whats", "where", "tell", "about",
  "focus", "on", "off", "turn", "toggle", "layer", "today", "tomorrow", "forecast", "day", "days",
  "after", "in", "largest", "biggest", "fire", "fires", "community", "communities", "towns", "places",
  "at", "threat", "threats", "threatened", "simulation", "sim", "demo", "scenario", "here", "this",
  "selected", "selection", "province", "map", "explain", "why", "weather", "wind", "rain", "snow",
  "spread", "beacons", "beacon", "bloom", "glow", "only", "just", "for", "of", "next", "week",
  "traffic", "corridor", "corridors", "highway", "highways",
  "air", "quality", "smoke", "aqhi",
  "hotspot", "hotspots", "perimeter", "perimeters", "fwi", "danger", "list", "active", "which",
  "there", "are", "any", "burning", "into", "from", "set", "switch", "hide", "enable", "disable",
  "stop", "end", "open", "zoom", ...WEEKDAYS,
]);

const EXTRA_ALIASES: Record<string, string[]> = {
  "prince-edward-island": ["pei"],
  "newfoundland-and-labrador": ["newfoundland", "labrador"],
  "northwest-territories": ["nwt"],
};

const LAYER_WORDS: { key: keyof Layers; word: string }[] = [
  { key: "wind", word: "wind" },
  { key: "rain", word: "rain" },
  { key: "rain", word: "snow" },
  { key: "spread", word: "spread" },
  { key: "air", word: "air quality" },
  { key: "air", word: "smoke" },
  { key: "air", word: "aqhi" },
  { key: "traffic", word: "traffic" },
  { key: "traffic", word: "corridors" },
  { key: "traffic", word: "corridor" },
  { key: "beacons", word: "beacon" },
  { key: "beacons", word: "beacons" },
  { key: "bloom", word: "bloom" },
  { key: "bloom", word: "glow" },
  { key: "risk", word: "risk layer" },
  { key: "risk", word: "fire risk" },
  { key: "fires", word: "fire layer" },
  { key: "fires", word: "hotspots" },
  { key: "fires", word: "hotspot" },
];

function norm(text: string): string {
  // Strip accents first, so "Whatì" is "whati" rather than "what" (which matched the word "what").
  return text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function hasPhrase(text: string, phrase: string): boolean {
  return ` ${text} `.includes(` ${phrase} `);
}

function placeDistance(p: BriefPlace): number {
  return p.landmark ? 6 : p.pop > 200_000 ? 45 : 18;
}

function pickPlace(places: BriefPlace[]): BriefPlace {
  return [...places].sort((a, b) => Number(b.focused) - Number(a.focused) || b.pop - a.pop)[0];
}

function findNamedPlace(text: string, places: BriefPlace[]): BriefPlace | null {
  let bestLen = 0;
  let best: BriefPlace[] = [];
  for (const p of places) {
    const name = norm(p.name);
    if (name.length < 3 || !hasPhrase(text, name)) continue;
    if (name.length > bestLen) {
      bestLen = name.length;
      best = [p];
    } else if (name.length === bestLen) best.push(p);
  }
  if (!best.length) return null;
  best.sort((a, b) => text.indexOf(norm(a.name)) - text.indexOf(norm(b.name)));
  const first = norm(best[0].name);
  return pickPlace(best.filter((p) => norm(p.name) === first));
}

function matchQuery(query: string, places: BriefPlace[]): { place: BriefPlace } | { names: string[] } | null {
  const q = norm(query);
  if (q.length < 3) return null;
  const hits = places.filter((p) => norm(p.name).includes(q));
  if (!hits.length) return null;
  const exact = hits.filter((p) => norm(p.name) === q);
  const pool = exact.length ? exact : hits;
  const chosen = pickPlace(pool);
  if (exact.length || hits.length === 1) return { place: chosen };
  const names: string[] = [];
  const seen = new Set<string>();
  for (const p of [...pool].sort((a, b) => Number(b.focused) - Number(a.focused) || b.pop - a.pop)) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    names.push(p.name);
    if (names.length === 4) break;
  }
  return { names };
}

function regionAliases(r: BriefRegion): string[] {
  const aliases = [norm(r.name), r.id.replace(/-/g, " ")];
  if (r.code.toLowerCase() !== "on") aliases.push(r.code.toLowerCase());
  for (const extra of EXTRA_ALIASES[r.id] ?? []) aliases.push(extra);
  return [...new Set(aliases.filter((a) => a.length >= 2))];
}

function findRegions(text: string, regions: BriefRegion[]): BriefRegion[] {
  return regions.filter((region) => regionAliases(region).some((alias) => hasPhrase(text, alias)));
}

function findRegion(text: string, regions: BriefRegion[]): { region: BriefRegion; aliasLength: number } | null {
  let best: { region: BriefRegion; aliasLength: number } | null = null;
  for (const region of findRegions(text, regions)) {
    for (const alias of regionAliases(region)) {
      if (!hasPhrase(text, alias)) continue;
      if (!best || alias.length > best.aliasLength) best = { region, aliasLength: alias.length };
    }
  }
  return best;
}

function forecastDay(text: string, todayIso: string): number | null {
  if (/\bday after tomorrow\b/.test(text)) return 2;
  if (/\btomorrow\b/.test(text)) return 1;
  const inN = text.match(/\bin (\d+) days?\b/);
  if (inN) return Math.min(7, Math.max(0, Number(inN[1])));
  const plus = text.match(/\b(?:forecast|day) (\d+)\b/);
  if (plus) return Math.min(7, Math.max(0, Number(plus[1])));
  for (let i = 0; i < WEEKDAYS.length; i++) {
    if (!hasPhrase(text, WEEKDAYS[i])) continue;
    const today = new Date(`${todayIso}T12:00:00`);
    if (Number.isNaN(today.getTime())) return null;
    return Math.min(7, (i - today.getDay() + 7) % 7);
  }
  if (/\btoday\b/.test(text)) return 0;
  return null;
}

function layerOn(text: string, word: string): boolean | null {
  const w = word.replace(/\s+/g, "\\s+");
  if (new RegExp(`(?:^|\\s)(?:show|enable|turn on)\\s+(?:the\\s+)?${w}(?:\\s|$)`).test(text)) return true;
  if (new RegExp(`(?:^|\\s)(?:hide|disable|turn off)\\s+(?:the\\s+)?${w}(?:\\s|$)`).test(text)) return false;
  if (new RegExp(`(?:^|\\s)(?:turn|switch|set)\\s+(?:the\\s+)?${w}\\s+on(?:\\s|$)`).test(text)) return true;
  if (new RegExp(`(?:^|\\s)(?:turn|switch|set)\\s+(?:the\\s+)?${w}\\s+off(?:\\s|$)`).test(text)) return false;
  if (new RegExp(`(?:^|\\s)${w}\\s+on(?:\\s|$)`).test(text)) return true;
  if (new RegExp(`(?:^|\\s)${w}\\s+off(?:\\s|$)`).test(text)) return false;
  return null;
}

function layerChanges(text: string): { key: keyof Layers; on: boolean }[] {
  const out: { key: keyof Layers; on: boolean }[] = [];
  const seen = new Set<keyof Layers>();
  for (const { key, word } of LAYER_WORDS) {
    if (seen.has(key)) continue;
    const on = layerOn(text, word);
    if (on == null) continue;
    seen.add(key);
    out.push({ key, on });
  }
  return out;
}

function simulationChange(text: string): boolean | null {
  if (!/\b(simulation|demo scenario)\b/.test(text)) return null;
  if (/\b(off|stop|end|disable)\b/.test(text)) return false;
  return true;
}

function wantsThreats(text: string): boolean {
  return /\bat risk\b/.test(text) || (/\b(communities|towns)\b/.test(text) && /\b(risk|threatened|danger)\b/.test(text));
}

/** A question about hotspots (not a layer toggle): "any hotspots today?", "how many hotspots". */
function wantsHeat(text: string): boolean {
  return /\b(any|how many|are there|list|what|which|where are)\b.*\b(hotspots?|heat detections?)\b/.test(text);
}

function wantsFireList(text: string): boolean {
  return /\b(active fires|list fires|what fires|which fires|(any|how many|list) (wild)?fires)\b/.test(text) || wantsHeat(text);
}

function wantsLargestFire(text: string): boolean {
  return /\b(largest|biggest) fire\b/.test(text) || /\bfly to (?:the )?fire\b/.test(text);
}

function wantsExplain(text: string): boolean {
  return /\b(how risky|how dangerous|fire danger|fwi|explain|weather)\b/.test(text) || /\bwhat(?:s| is) the risk\b/.test(text);
}

/** Asking about a place's risk in other words: "is calgary risky / safe", "risk in calgary". */
function asksRisk(text: string): boolean {
  return /\b(risky|dangerous|danger|safe|unsafe|risk|at risk|dry|windy)\b/.test(text);
}

function leftoverQuery(text: string): string {
  const kept = text.split(" ").filter((w) => w.length >= 3 && !STOP.has(w));
  return kept.join(" ");
}

function limit(calls: ToolCall[]): ToolCall[] {
  const out = [...calls];
  while (out.length > MAX_CALLS) {
    const layers = out.map((c, i) => (c.tool === "setLayer" ? i : -1)).filter((i) => i >= 0);
    if (layers.length > 1) {
      out.splice(layers[layers.length - 1], 1);
      continue;
    }
    const sim = out.findIndex((c) => c.tool === "setSimulation");
    if (sim >= 0) {
      out.splice(sim, 1);
      continue;
    }
    break;
  }
  return out.slice(0, MAX_CALLS);
}

function unknown(): Plan {
  return { calls: [], reply: "unknown" };
}

export function planRequest(raw: string, brief: Brief): Plan {
  const text = norm(raw);
  if (!text) return unknown();

  const named = findNamedPlace(text, brief.places);
  const regionHit = findRegion(text, brief.regions);
  // A province name is the province. Partial place search runs only when neither matched,
  // so "alberta" does not become every town whose name contains those letters.
  const queried = !named && !regionHit ? matchQuery(leftoverQuery(text), brief.places) : null;
  if (queried && "names" in queried) return { calls: [], reply: "ambiguous", candidates: queried.names };

  const mentioned = named ?? (queried && "place" in queried ? queried.place : null);
  const placeWins = !!mentioned && (!regionHit || norm(mentioned.name).length >= regionHit.aliasLength);
  const place = placeWins ? mentioned : null;
  const region = place ? null : regionHit?.region ?? null;

  const day = forecastDay(text, brief.today);
  const layers = layerChanges(text);
  const sim = simulationChange(text);
  // "is kelowna at risk" is about Kelowna, not the list of every community at risk.
  const aboutPlace = !!place && !/\b(communities|towns|places)\b/.test(text);
  const threats = wantsThreats(text) && !aboutPlace;
  const fires = wantsFireList(text) && !wantsLargestFire(text);
  const toFire = wantsLargestFire(text);
  const explain = wantsExplain(text) || (aboutPlace && !layers.length && !fires && asksRisk(text));

  const calls: ToolCall[] = [];
  const namedRegions = findRegions(text, brief.regions);
  const replaceFocus = /\bfocus\b/.test(text) || /\bonly\b/.test(text) || (/\bjust\b/.test(text) && !!region && !place);
  const focusRegion = place?.regionId || region?.id;
  if (focusRegion && (replaceFocus || !(place ? place.focused : brief.focusIds.includes(focusRegion)))) {
    const ids = replaceFocus
      ? (region && !place ? namedRegions.map((r) => r.id) : [focusRegion])
      : [...new Set([...brief.focusIds, focusRegion])];
    if (ids.length && (replaceFocus || ids.length !== brief.focusIds.length || ids.some((id, i) => id !== brief.focusIds[i]))) {
      calls.push({ tool: "focus", args: { ids } });
    }
  }
  if (day != null && day !== brief.forecastDay) calls.push({ tool: "setForecastDay", args: { day } });
  for (const layer of layers) {
    if (brief.layers[layer.key] !== layer.on) calls.push({ tool: "setLayer", args: layer });
  }
  if (sim != null && sim !== brief.simulation) calls.push({ tool: "setSimulation", args: { on: sim } });
  if (toFire) {
    calls.push({ tool: "flyToFire", args: {} });
  } else if (place) {
    calls.push({
      tool: "flyToPlace",
      args: { name: place.name, lat: place.lat, lng: place.lng, dist: placeDistance(place), regionId: place.regionId },
    });
  } else if (region) {
    calls.push({ tool: "flyToRegion", args: { index: region.index, name: region.name, regionId: region.id } });
  }
  if (threats) calls.push({ tool: "listThreats", args: {} });
  if (fires) calls.push({ tool: "listFires", args: { ...(region ? { regionIndex: region.index } : {}), ...(wantsHeat(text) ? { heatFirst: true } : {}) } });
  if (explain) {
    const aboutHere = /\b(here|this hex|this spot|selection|selected)\b/.test(text);
    const point = place
      ? { name: place.name, lat: place.lat, lng: place.lng, pop: place.pop, regionIndex: place.regionIndex }
      : aboutHere || (!region && !toFire)
        ? brief.selected
          ? { name: brief.selected.name ?? "This hex", lat: brief.selected.lat, lng: brief.selected.lng, pop: 0, regionIndex: -1 }
          : brief.here
            ? { name: brief.here.name ?? "Here", lat: brief.here.lat, lng: brief.here.lng, pop: 0, regionIndex: -1 }
            : null
        : null;
    if (point) calls.push({ tool: "explain", args: point });
  }

  const kept = limit(calls);
  if (!kept.length) return unknown();
  const reply = kept.some((c) => c.tool === "explain")
    ? "explain"
    : kept.some((c) => c.tool === "listThreats")
      ? "threats"
      : kept.some((c) => c.tool === "listFires")
        ? "fires"
        : "done";
  return { calls: kept, reply };
}

/** Starts like a map command ("show me calgary", "focus bc", "turn wind on"). */
const COMMAND = /^(show|fly|go|take|zoom|focus|turn|switch|set|enable|disable|hide|open|just|only|move|center|centre|start|stop|end)\b/;

/**
 * When a model (Firefly) is available, should it answer instead of this plan? Yes when the plan
 * only moves the map for something that isn't a command ("is calgary risky?" must not become
 * "Flew to Calgary"), and for fires near a place (the rule brain lists a whole province).
 */
export function needsModel(raw: string, plan: Plan): boolean {
  const text = norm(raw);
  if (plan.reply === "unknown" || plan.reply === "ambiguous") return true;
  if (plan.reply === "done") return !COMMAND.test(text);
  return plan.reply === "fires" && /\b(near|around|close to|by)\b/.test(text);
}

export const ruleBrain: AgentBrain = { plan: planRequest };
