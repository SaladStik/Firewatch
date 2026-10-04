/**
 * What the pitch's overlays show right now. The director (story.ts) sets it; the overlays read it.
 * Every field is a plain value or a stable object, so components can select them one by one.
 */
import type { CrewRoute } from "../dispatch/router";
import type { PriorityParts, Ticket } from "../dispatch/ops311";
import { createStore } from "../state/store";

export interface Story311 {
  ticket: Ticket;
  label: string;
  parts: PriorityParts;
  daysWaiting: number;
  reports: number;
  crew: string;
  crewColor: string;
  route: CrewRoute;
  stops: Ticket[];
  /** Every crew's route, for the day's plan. */
  all: { crew: string; color: string; route: CrewRoute }[];
  open: number;
  /** Its rank among every open ticket (1 = highest priority). */
  rank: number;
  safetyJobs: number;
  fifoSafetyJobs: number;
  source: "live" | "sample";
}

export interface Caption {
  kicker?: string;
  title: string;
  body?: string;
  /** caption: lower left over the map; statement: centred, large; title: the opening / closing card. */
  layout: "caption" | "statement" | "title";
}

export const pitch = createStore({
  step: 0,
  ready: false,
  /** Loading note under the progress bar. */
  prep: "",
  /** Share of the story's map built ahead (0..1), for the loading bar. */
  built: 0,
  caption: null as Caption | null,
  /** A short live line under the caption (e.g. the forecast day while the prediction plays). */
  ticker: "",
  /** 0 none · 1 pin · 2 card with priority · 3 route drawing + crew driving · 4 every crew's route. */
  call: 0,
  story311: null as Story311 | null,
  /** Labelled as a replay whenever the demo scenario's fires are on the map. */
  replay: false,
  /** The question being asked of Firefly, typed out to `shown` characters. */
  ask: null as { q: string; shown: number } | null,
});
