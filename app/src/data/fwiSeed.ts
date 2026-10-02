/**
 * Official FWI moisture codes (FFMC / DMC / DC) near a point, used to seed the FWI System per
 * weather cell (data/openMeteo.ts). Shared by the browser engine and the data server so both
 * compute fire danger the same way. Validated against CWFIS: scripts/validate-fwi.ts.
 *
 *  - CWFIS fire weather stations (observed): an inverse-distance blend of the SEED_K nearest
 *    within MAX_KM is used as today's codes outright.
 *  - Only CWFIS hotspot codes nearby: fires burn where it's driest, so those run dry for the
 *    area around them; openMeteo.ts keeps FFMC local and averages the slow codes.
 */
import { project } from "../geo/projection";
import type { FwiCodes } from "./cffdrs";
import type { FwiStation, Hotspot } from "./cwfis";
import type { FwiSeed } from "./openMeteo";

/** Weather cells further than this from any official point spin up the FWI codes on their own. */
export const MAX_KM = 400;
/** Official FWI points blended per weather cell. */
export const SEED_K = 4;

type Pt = { x: number; z: number; ffmc: number; dmc: number; dc: number };

function blend(list: Pt[], x: number, z: number): FwiCodes | null {
  const near = list.map((s) => ({ s, d: Math.max(1, Math.hypot(s.x - x, s.z - z)) }))
    .filter((q) => q.d < MAX_KM).sort((a, b) => a.d - b.d).slice(0, SEED_K);
  if (!near.length) return null;
  // Weight 1/d²: the closest point dominates.
  const w = near.map((q) => 1 / (q.d * q.d)), W = w.reduce((t, v) => t + v, 0);
  const mix = (k: "ffmc" | "dmc" | "dc") => near.reduce((t, q, i) => t + q.s[k] * w[i], 0) / W;
  return { ffmc: mix("ffmc"), dmc: mix("dmc"), dc: mix("dc") };
}

/** Build the seed lookup from today's stations and hotspots (projection must be set). */
export function makeFwiSeed(stations: FwiStation[], hotspots: Hotspot[]): FwiSeed {
  const st: Pt[] = stations.map((s) => ({ ...s, ...project(s.lat, s.lng) }));
  const fires: Pt[] = hotspots
    .filter((h) => [h.ffmc, h.dmc, h.dc].every((v) => Number.isFinite(v)))
    .map((h) => ({ ffmc: h.ffmc!, dmc: h.dmc!, dc: h.dc!, ...project(h.lat, h.lng) }));
  // Stations first (most accurate); fire hotspot codes only where there's no station in reach.
  return (lat, lng) => {
    const p = project(lat, lng);
    const s = blend(st, p.x, p.z);
    if (s) return { codes: s, source: "station" };
    const f = blend(fires, p.x, p.z);
    return f ? { codes: f, source: "fire" } : null;
  };
}
