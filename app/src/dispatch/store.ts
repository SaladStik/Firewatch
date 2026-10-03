/**
 * Dispatch state: the hackathon cases inside FIRE//WATCH.
 *  - Wildfire crews (Case 3): live fires, or the Alberta 2023–2025 table (the demo scenario).
 *  - Calgary 311 (Case 1): the Open Calgary ticket sample, crews, one disruption.
 * Panel, map pins, Firefly and the engine's demo fires all read from here.
 */
import { createStore } from "../state/store";
import type { CrewPlan, HistoryLoad, Learned, RankInput } from "./crews";
import type { Disruption, Load311, Override, Plan311 } from "./ops311";
import type { CrewRoute } from "./router";

export type DispatchTab = "crews" | "311";
export type CrewSource = "history" | "live";

export interface DispatchState {
  open: boolean;
  tab: DispatchTab;
  status: "idle" | "loading" | "learning" | "ready" | "error";
  error: string;

  // Wildfire crews
  source: CrewSource;
  crews: number;
  cutPct: number;
  /** 0 = all seasons. */
  year: number;
  history: HistoryLoad | null;
  historyInput: RankInput | null;
  learned: Learned | null;
  /** Use the learned weights (round 2) or the hand weights (round 1). */
  useLearned: boolean;
  plan: CrewPlan | null;
  /** Show the plan after the cut (fewer crews) on the map and list. */
  showCut: boolean;

  // Calgary 311
  roads: number;
  waste: number;
  perCrew: number;
  disruption: Disruption;
  load311: Load311 | null;
  plan311: Plan311 | null;
  /** 311 view: the 8 a.m. plan or the noon replan. */
  at: "morning" | "noon";
  /** The full ticket list is open. */
  ticketsOpen: boolean;
  /** Dispatcher overrides by ticket id. */
  overrides: Record<string, Override>;

  // The work queue: what the dispatcher has decided, and where they are.
  /** Fire key ("year:id") → sent a crew / skipped. */
  decided: Record<string, "sent" | "skipped">;
  cursor: number;
  /** 311 crews the dispatcher has sent out. */
  dispatched: Record<string, true>;
  cursor311: number;

  // Route planner (311 crews).
  /** "idle" until Dispatch's 311 tab first needs routes; the street network then loads once. */
  roadStatus: "idle" | "loading" | "ready" | "error";
  /** Each crew's driving route for the plan on screen (8 a.m. or noon). */
  routes: Record<string, CrewRoute>;
  /** Stop orders the dispatcher switched to "shortest" (indexes into the crew's jobs), by crew. */
  routeOrder: Record<string, number[]>;
  /** Map: only the crew in the queue, or every crew's route. */
  showAllRoutes: boolean;
}

export const dispatch = createStore<DispatchState>({
  open: false,
  tab: "crews",
  status: "idle",
  error: "",
  source: "history",
  crews: 40,
  cutPct: 20,
  year: 0,
  history: null,
  historyInput: null,
  learned: null,
  useLearned: true,
  plan: null,
  showCut: true,
  roads: 5,
  waste: 3,
  perCrew: 5,
  disruption: "blizzard",
  load311: null,
  plan311: null,
  at: "morning",
  ticketsOpen: false,
  overrides: {},
  decided: {},
  cursor: 0,
  dispatched: {},
  cursor311: 0,
  roadStatus: "idle",
  routes: {},
  routeOrder: {},
  showAllRoutes: false,
});
