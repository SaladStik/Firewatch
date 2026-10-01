import { useMemo } from "react";
import { app } from "../state/app";
import { useStore } from "../state/store";

/** Workspace indices of the regions in focus. */
export function useFocusIndices(): Set<number> {
  const regions = useStore(app, (s) => s.regions);
  const focus = useStore(app, (s) => s.focus);
  return useMemo(() => new Set(focus.map((id) => regions.findIndex((r) => r.id === id)).filter((i) => i >= 0)), [regions, focus]);
}

/** Region objects in focus. */
export function useFocusRegions() {
  const regions = useStore(app, (s) => s.regions);
  const focus = useStore(app, (s) => s.focus);
  return useMemo(() => regions.filter((r) => focus.includes(r.id)), [regions, focus]);
}
