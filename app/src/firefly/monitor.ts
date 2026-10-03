/**
 * Firefly's watch: a small summary of the map after each data refresh, and the alerts worth
 * raising between two summaries (new agency-reported fire, a town entering a projected path, extreme danger
 * tomorrow). Pure; useFireflyAgent builds the Watch and delivers alerts.
 */
import type { MoodName } from "../mascot/firefly";

export interface Watch {
  fires: { id: string; lat: number; lng: number; near: string | null }[];
  threatened: { place: string; reason: string; lat: number; lng: number }[];
  extremeTomorrow: { place: string; lat: number; lng: number }[];
}

export interface Alert {
  kind: "new_fire" | "town_in_path" | "extreme_tomorrow";
  /** Dedupe key for the session. */
  key: string;
  text: string;
  lat: number;
  lng: number;
}

/** A "new" fire must be at least this far from every known fire (km, rough). */
const NEW_FIRE_KM = 10;
const kmBetween = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
  Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 111 * Math.cos((a.lat * Math.PI) / 180));
const inPath = (reason: string) => reason.includes("projected path");

export function diffAlerts(prev: Watch | null, next: Watch): Alert[] {
  if (!prev) return []; // first load: everything is "new"; the briefing covers it
  const out: Alert[] = [];
  for (const f of next.fires) {
    if (prev.fires.some((p) => p.id === f.id || kmBetween(p, f) < NEW_FIRE_KM)) continue;
    out.push({ kind: "new_fire", key: `fire:${f.id}`, lat: f.lat, lng: f.lng, text: `New wildfire reported${f.near ? ` ${f.near}` : ""}.` });
  }
  const wasInPath = new Set(prev.threatened.filter((t) => inPath(t.reason)).map((t) => t.place));
  for (const t of next.threatened) {
    if (!inPath(t.reason) || wasInPath.has(t.place)) continue;
    out.push({ kind: "town_in_path", key: `path:${t.place}`, lat: t.lat, lng: t.lng, text: `${t.place} is now inside a fire's projected path.` });
  }
  const wasExtreme = new Set(prev.extremeTomorrow.map((e) => e.place));
  for (const e of next.extremeTomorrow) {
    if (wasExtreme.has(e.place)) continue;
    out.push({ kind: "extreme_tomorrow", key: `extreme:${e.place}`, lat: e.lat, lng: e.lng, text: `Extreme fire danger forecast tomorrow at ${e.place}.` });
  }
  return out;
}

/** Ambient mood from the situation (speaking/thinking moods override it in useFireflyAgent). */
export function situationMood(w: Watch): MoodName {
  if (w.threatened.some((t) => inPath(t.reason))) return "alert";
  if (w.extremeTomorrow.length) return "worried";
  if (w.threatened.length) return "curious";
  return "idle";
}
