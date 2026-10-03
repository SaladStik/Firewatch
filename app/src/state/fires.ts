/**
 * The heat that counts as fire right now (data/firePoints.ts), worked out once per data change and
 * shared: a stable array while hotspots, reported fires and perimeters stay the same, so components
 * can select it with useStore and use it as a memo dependency.
 */
import type { Hotspot } from "../data/cwfis";
import { fireHotspots } from "../data/firePoints";
import type { AppState } from "./app";

let last: { hotspots: unknown; reported: unknown; perimeters: unknown; out: Hotspot[] } | null = null;

export function fireHotspotsOf(s: Pick<AppState, "hotspots" | "reportedFires" | "perimeters">): Hotspot[] {
  if (last && last.hotspots === s.hotspots && last.reported === s.reportedFires && last.perimeters === s.perimeters) return last.out;
  const out = fireHotspots(s.hotspots, s.reportedFires, s.perimeters);
  last = { hotspots: s.hotspots, reported: s.reportedFires, perimeters: s.perimeters, out };
  return out;
}
