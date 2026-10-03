/** Contract shared by the rule brain and any later model. Tools and the panel only see this. */
import type { Layers } from "../state/app";

export interface BriefPlace {
  name: string;
  lat: number;
  lng: number;
  pop: number;
  regionId: string;
  regionIndex: number;
  landmark: boolean;
  focused: boolean;
}

export interface BriefRegion {
  id: string;
  name: string;
  code: string;
  index: number;
}

export interface BriefFire {
  id: string;
  kind: "perimeter" | "hotspot";
  lat: number;
  lng: number;
  areaHa: number | null;
  label: string;
}

export interface BriefThreat {
  name: string;
  reason: string;
  lat: number;
  lng: number;
}

export interface BriefPoint {
  lat: number;
  lng: number;
  name?: string;
}

export interface Brief {
  focusIds: string[];
  regions: BriefRegion[];
  forecastDay: number;
  /** ISO date of forecast day 0. Weekday phrases are counted from this. */
  today: string;
  layers: Layers;
  simulation: boolean;
  dataStatus: { cwfis: "loading" | "ok" | "error"; weather: "loading" | "ok" | "error" };
  places: BriefPlace[];
  fires: BriefFire[];
  threats: BriefThreat[];
  here: BriefPoint | null;
  selected: BriefPoint | null;
}

export type ToolName =
  | "focus"
  | "flyToPlace"
  | "flyToRegion"
  | "setLayer"
  | "setForecastDay"
  | "setSimulation"
  | "listThreats"
  | "listFires"
  | "flyToFire"
  | "explain";

export type ToolCall =
  | { tool: "focus"; args: { ids: string[] } }
  | { tool: "flyToPlace"; args: { name: string; lat: number; lng: number; dist: number; regionId: string } }
  | { tool: "flyToRegion"; args: { index: number; name: string; regionId: string } }
  | { tool: "setLayer"; args: { key: keyof Layers; on: boolean } }
  | { tool: "setForecastDay"; args: { day: number } }
  | { tool: "setSimulation"; args: { on: boolean } }
  | { tool: "listThreats"; args: Record<string, never> }
  | { tool: "listFires"; args: { regionIndex?: number } }
  | { tool: "flyToFire"; args: Record<string, never> }
  | { tool: "explain"; args: { name: string; lat: number; lng: number; pop: number; regionIndex: number } };

export type ReplyKind = "done" | "threats" | "fires" | "explain" | "ambiguous" | "unknown";

export interface Plan {
  calls: ToolCall[];
  reply: ReplyKind;
  /** Place names to offer when a query matches several towns and none exactly. */
  candidates?: string[];
}

export interface AgentBrain {
  plan(text: string, brief: Brief): Plan;
}

export interface ExplainFacts {
  name: string;
  dayLabel: string;
  windLayer: boolean;
  fwi: number | null;
  danger: string | null;
  windKmh: number | null;
  windFrom: string | null;
  precipMm: number | null;
  precipKind: "rain" | "snow" | null;
  threatReason: string | null;
  nearestHotspotKm: number | null;
  weatherMissing: boolean;
  weatherState: "loading" | "ok" | "error";
  simulation: boolean;
}

export interface ToolResult {
  tool: ToolName;
  summary: string;
  facts?: ExplainFacts;
  threats?: { name: string; reason: string }[];
  /** Agency-reported fires (worst stage first), where they were counted, and unconfirmed satellite heat. */
  fires?: { label: string; stage: string }[];
  fireScope?: string;
  heat?: { clusters: number; farm: number };
  dayLabel?: string;
  simulation?: boolean;
}
