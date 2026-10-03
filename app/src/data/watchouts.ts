/**
 * Duty watchouts / triggers. Operator-set conditions that light up when met:
 *   - FWI above a threshold at a place (or worst in focus)
 *   - projected path reaches a named town
 *   - RH drops below a threshold by a local clock hour
 */
import { project } from "../geo/projection";
import { growthLookup, type GrowthField } from "../world/fireGrowth";
import { weatherAt, type WeatherGrid } from "./openMeteo";
import type { Place } from "./places";

export type WatchoutKind = "fwi_above" | "path_reaches" | "rh_below_by";

export interface Watchout {
  id: string;
  kind: WatchoutKind;
  enabled: boolean;
  /** Community name (required for path_reaches; optional scope for others). */
  place: string;
  /** FWI threshold (fwi_above). */
  fwi?: number;
  /** RH % threshold (rh_below_by). */
  rh?: number;
  /** Local hour 0–23 by which RH must be below threshold (rh_below_by). */
  hour?: number;
}

export interface WatchoutHit {
  watchoutId: string;
  kind: WatchoutKind;
  key: string;
  text: string;
  lat: number;
  lng: number;
  place: string;
}

const STORAGE_KEY = "firewatch.watchouts";

export function loadWatchouts(): Watchout[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(v)) return defaultWatchouts();
    return v.filter((w) => w && typeof w.id === "string" && typeof w.kind === "string");
  } catch {
    return defaultWatchouts();
  }
}

export function saveWatchouts(list: Watchout[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

/** Seed a few useful defaults the first time. */
export function defaultWatchouts(): Watchout[] {
  return [
    { id: "def-fwi", kind: "fwi_above", enabled: true, place: "", fwi: 20 },
    { id: "def-rh", kind: "rh_below_by", enabled: true, place: "", rh: 25, hour: 14 },
  ];
}

export function newWatchoutId() {
  return `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function findPlace(name: string, places: (Place & { region?: number })[]): (Place & { region?: number }) | null {
  const q = name.trim().toLowerCase();
  if (!q) return null;
  const exact = places.find((p) => !p.landmark && p.name.toLowerCase() === q);
  if (exact) return exact;
  return places.find((p) => !p.landmark && p.name.toLowerCase().includes(q)) ?? null;
}

function localHour(now = Date.now()) {
  return new Date(now).getHours();
}

export interface EvalInputs {
  watchouts: Watchout[];
  places: (Place & { region: number })[];
  weather: WeatherGrid[];
  day: number;
  spread: GrowthField | null;
  focusRegions?: Set<number>;
  now?: number;
}

/**
 * Evaluate enabled watchouts against current map data.
 * path_reaches needs a named place; FWI/RH with empty place scan focused towns (≥5k).
 */
export function evaluateWatchouts(inp: EvalInputs): WatchoutHit[] {
  const now = inp.now ?? Date.now();
  const hour = localHour(now);
  const focus = inp.focusRegions;
  const towns = inp.places.filter((p) => {
    if (p.landmark || p.pop < 5_000) return false;
    if (focus && !focus.has(p.region)) return false;
    return true;
  });
  const dayAt = growthLookup(inp.spread);
  const hits: WatchoutHit[] = [];

  for (const w of inp.watchouts) {
    if (!w.enabled) continue;

    if (w.kind === "path_reaches") {
      const place = findPlace(w.place, inp.places);
      if (!place) continue;
      const { x, z } = project(place.lat, place.lng);
      if (dayAt(x, z) < 0) continue;
      hits.push({
        watchoutId: w.id,
        kind: w.kind,
        key: `path:${place.name}:${inp.day}`,
        text: `${place.name} is in a projected path`,
        lat: place.lat,
        lng: place.lng,
        place: place.name,
      });
      continue;
    }

    const targets = w.place.trim()
      ? (() => { const p = findPlace(w.place, inp.places); return p ? [p] : []; })()
      : towns;

    for (const place of targets) {
      const cell = weatherAt(inp.weather, place.lat, place.lng);
      if (!cell) continue;
      const dayWx = cell.days[inp.day];
      if (!dayWx) continue;

      if (w.kind === "fwi_above") {
        const thr = w.fwi ?? 20;
        if (!(dayWx.fwi >= thr)) continue;
        hits.push({
          watchoutId: w.id,
          kind: w.kind,
          key: `fwi:${place.name}:${inp.day}:${thr}`,
          text: `FWI ${dayWx.fwi.toFixed(0)} ≥ ${thr} at ${place.name}`,
          lat: place.lat,
          lng: place.lng,
          place: place.name,
        });
      }

      if (w.kind === "rh_below_by") {
        const thr = w.rh ?? 25;
        const by = w.hour ?? 14;
        // Before the clock hour on today, don't fire yet; later days use the day's RH.
        if (inp.day === 0 && hour < by) continue;
        const rh = inp.day === 0 && cell.now ? cell.now.rh : dayWx.rh;
        if (!(rh <= thr)) continue;
        hits.push({
          watchoutId: w.id,
          kind: w.kind,
          key: `rh:${place.name}:${inp.day}:${thr}:${by}`,
          text: `RH ${Math.round(rh)}% ≤ ${thr}% by ${by}:00 at ${place.name}`,
          lat: place.lat,
          lng: place.lng,
          place: place.name,
        });
      }
    }
  }

  // Cap noise: one hit per place+kind, worst first for FWI.
  const seen = new Set<string>();
  const out: WatchoutHit[] = [];
  for (const h of hits.sort((a, b) => a.kind.localeCompare(b.kind) || a.place.localeCompare(b.place))) {
    const k = `${h.kind}:${h.place}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(h);
  }
  return out;
}
