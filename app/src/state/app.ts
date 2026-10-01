/** App-wide UI state (not persisted, apart from the theme). */
import { initialFocus, REGIONS, WORKSPACE, type Region } from "../config/regions";
import type { Hotspot, Perimeter } from "../data/cwfis";
import type { WeatherGrid } from "../data/openMeteo";
import type { Place } from "../data/places";
import type { WorldStats } from "../render/HexWorld";
import type { HexNodeInfo } from "../world/types";
import type { PointSample } from "../world/WorldClient";
import { createStore } from "./store";

export interface Layers {
  risk: boolean;
  fires: boolean;
  beacons: boolean;
  bloom: boolean;
}

export type Theme = "dark" | "light";
/**
 * Which community labels show. "auto" (default) = major cities from afar, smaller towns
 * appear as you zoom in. The others are fixed: every one, towns ≥ 5k, cities ≥ 50k, none.
 */
export type LabelMode = "auto" | "all" | "some" | "major" | "off";
/** -1 = decided by zoom (see Scene.updateLabels). */
export const LABEL_MIN_POP: Record<LabelMode, number> = { auto: -1, all: 0, some: 5_000, major: 50_000, off: Infinity };

function initialTheme(): Theme {
  try {
    const t = localStorage.getItem("embergrid.theme");
    if (t === "dark" || t === "light") return t;
  } catch { /* storage unavailable */ }
  return "dark";
}

/** A community label, tagged with the workspace region it belongs to. */
export type RegionPlace = Place & { region: number };

export interface AppState {
  theme: Theme;
  /** Workspace regions, in workspace order (index = region index in chunk data). */
  regions: Region[];
  /** Region ids in focus. */
  focus: string[];
  /** Region ids whose data has finished loading. */
  loaded: string[];
  places: RegionPlace[];
  labelMode: LabelMode;
  boot: { stage: string; done: boolean; error?: string };
  stats: (WorldStats & { dist: number; fps: number; vScale: number }) | null;
  hover: HexNodeInfo | null;
  selected: HexNodeInfo | null;
  selectedSample: PointSample | null;
  layers: Layers;
  hotspots: Hotspot[];
  perimeters: Perimeter[];
  weather: WeatherGrid[];
  dataStatus: { cwfis: "loading" | "ok" | "error"; weather: "loading" | "ok" | "error"; at?: string };
  simulation: boolean;
  /** Sectors flagged for patrol this session. */
  flagged: string[];
}

export const app = createStore<AppState>({
  theme: initialTheme(),
  regions: WORKSPACE.regions.map((id) => REGIONS[id]),
  focus: initialFocus(),
  loaded: [],
  places: [],
  labelMode: "auto",
  boot: { stage: "Initialising", done: false },
  stats: null,
  hover: null,
  selected: null,
  selectedSample: null,
  layers: { risk: true, fires: true, beacons: true, bloom: true },
  hotspots: [],
  perimeters: [],
  weather: [],
  dataStatus: { cwfis: "loading", weather: "loading" },
  simulation: false,
  flagged: [],
});

export const regionIndex = (id: string) => app.get().regions.findIndex((r) => r.id === id);
export const focusIndices = () => app.get().focus.map(regionIndex).filter((i) => i >= 0);
