/**
 * Firefly's side of Dispatch: the same crew and 311 plans the panel shows, as compact facts for the
 * ElevenLabs agent's tools and as one-paragraph answers for local Ask (works with no agent at all).
 * Every call also opens the panel on that plan, so what Firefly says is on screen.
 */
import { label, type CrewPlan, type Scored } from "./crews";
import { calgarySnowForecast, flyTo, loadCases, openDispatch, plan311Now, recomputeCrews, recomputeFleet, setCrewOptions } from "./controller";
import { KIND } from "./fleet";
import { dutyBriefing } from "./crews";
import { supervisor8am, supervisorNoon, typeOf, type Disruption } from "./ops311";
import { dispatch, type CrewSource } from "./store";

const r1 = (v: number) => Math.round(v * 10) / 10;

const fireFact = (s: Scored, rank: number) => ({
  rank, fire: label(s), year: s.fire.year, lat: r1(s.fire.lat), lng: r1(s.fire.lng), sizeHa: r1(s.fire.sizeHa),
  spreadMMin: r1(s.ros), crown: s.fire.crown, peopleNearby: Math.round(s.exposure.people), reason: s.reason,
});

/** Rank fires for crews (live fires, or the Alberta 2023–2025 table), cut, and report. */
export async function crewPlanFacts(opts: { crews?: number; cutPct?: number; source?: CrewSource; year?: number }) {
  await loadCases();
  const d = dispatch.get();
  const source: CrewSource = opts.source ?? d.source;
  setCrewOptions({
    source,
    crews: Math.min(120, Math.max(1, Math.round(opts.crews ?? d.crews))),
    cutPct: Math.min(90, Math.max(0, Math.round(opts.cutPct ?? d.cutPct))),
    ...(opts.year !== undefined ? { year: opts.year } : {}),
  });
  if (source === "history") await loadCases().then(() => recomputeCrews());
  openDispatch("crews");
  await recomputeFleet();
  const plan = dispatch.get().plan;
  const sent = (s: Scored) => dispatch.get().fleetDispatch.find((x) => x.fire === s)?.assignments.map((a) => ({
    resource: `${KIND[a.resource.kind].label} ${a.resource.id}`, from: a.resource.base.name, etaMin: Math.round(a.eta),
    ...(a.dropsPerHour ? { dropsPerHour: r1(a.dropsPerHour) } : {}), why: a.why,
  })) ?? [];
  if (!plan) return { result: source === "live" ? "No active fires in the regions in focus. Offer the Alberta 2023–2025 season instead (source history)." : "Case data is still loading." };
  const learned = dispatch.get().learned;
  const first = plan.pickedCut[0];
  if (first) flyTo(first.fire.lat, first.fire.lng, source === "history" ? 300 : 60);
  return {
    source: source === "history" ? "Alberta historical wildfires 2023–2025 (Government of Alberta)" : "live CWFIS fires",
    crews: plan.crews, crewsAfterCut: plan.cutCrews,
    top: plan.pickedCut.slice(0, 5).map((s, i) => ({ ...fireFact(s, i + 1), dispatched: sent(s) })),
    lostCrew: plan.lostCrew.map((s) => fireFact(s, plan.picked.indexOf(s) + 1)),
    skippedVsBiggestFirst: plan.skippedVsBaseline.slice(0, 5).map((s) => ({ fire: label(s), sizeHa: r1(s.fire.sizeHa), spreadMMin: r1(s.ros) })),
    vsBiggestFirst: plan.grades ? {
      escapesReached: { ours: plan.grades.ours.escapesCaught, biggestFirst: plan.grades.baseline.escapesCaught, oursAfterCut: plan.grades.cut.escapesCaught, biggestFirstAfterCut: plan.grades.baselineCut.escapesCaught, total: plan.grades.ours.escapesTotal },
      note: "Escape = at most 200 ha when assessed, past 200 ha at the end. Graded from final sizes the ranking never saw.",
    } : null,
    improvementRound: learned && source === "history" ? { heldOutEscapes: learned.heldOut, kept: learned.kept, weights: plan.weights } : null,
    dutyOfficer: dutyBriefing(plan, { live: source === "live" }),
  };
}

/** Plan Calgary 311 crews for the day, with one disruption at noon. */
export async function plan311Facts(opts: { roads?: number; waste?: number; jobsPerCrew?: number; disruption?: Disruption }) {
  await loadCases();
  const d = dispatch.get();
  dispatch.set({
    roads: Math.min(10, Math.max(1, Math.round(opts.roads ?? d.roads))),
    waste: Math.min(8, Math.max(0, Math.round(opts.waste ?? d.waste))),
    perCrew: Math.min(12, Math.max(1, Math.round(opts.jobsPerCrew ?? d.perCrew))),
    disruption: opts.disruption ?? d.disruption,
    at: (opts.disruption ?? d.disruption) === "none" ? "morning" : "noon",
  });
  const p = await plan311Now();
  openDispatch("311");
  flyTo(51.045, -114.06, 22);
  const snow = calgarySnowForecast();
  return {
    planningDay: p.today,
    openTickets: dispatch.get().load311?.open.length,
    crews: p.crews.map((c) => c.id),
    vsOldestFirst: { safetyJobs: { plan: p.scores.morning.safetyJobs, oldestFirst: p.scores.fifo.safetyJobs }, drivingKm: { plan: Math.round(p.scores.morning.km), oldestFirst: Math.round(p.scores.fifo.km) } },
    disruption: p.disruption,
    replan: p.noon ? { changedCrew: p.moved.length, toTomorrow: p.dropped.length, newJobs: p.newJobs.length, droppedTypes: [...new Set(p.dropped.map((x) => typeOf(x.ticket.service).label))] } : null,
    forecast: snow ? `Our forecast shows ${snow.mm.toFixed(1)} mm of snow in Calgary ${snow.day === 0 ? "today" : snow.day === 1 ? "tomorrow" : "in 2 days"}.` : "No snow in Calgary's forecast for the next two days.",
    supervisor8am: supervisor8am(p),
    supervisorNoon: supervisorNoon(p),
  };
}

// ------------------------------------------------------------ local Ask (no model needed)
const words = (t: string) => t.toLowerCase();

/** "I have 30 crews", "40 crews and cut 25%", "rank fires for crews", "who lost a crew". */
function crewIntent(text: string) {
  const t = words(text);
  if (!/\bcrews?\b|next crew|lost a crew|biggest first|largest first|duty officer/.test(t)) return null;
  if (/\b311\b|pothole|ticket|calgary/.test(t)) return null;
  const n = t.match(/(\d{1,3})\s*(?:ground |fire ?|wildfire )?crews?\b/) ?? t.match(/\bcrews?\s*(?:to|=|:|at|of)\s*(\d{1,3})\b/);
  const cut = t.match(/(?:cut|drop|lose|fewer|reduce\w*)[^\d]{0,12}(\d{1,2})\s*%|(\d{1,2})\s*%\s*(?:cut|fewer|less)/);
  const source: CrewSource | undefined = /history|2023|2024|2025|past|season|historical|demo/.test(t) ? "history" : /\blive\b|today|now|current/.test(t) ? "live" : undefined;
  // One season only when exactly one year is named ("2023 to 2025" means all of them).
  const years = [...new Set(t.match(/\b(2023|2024|2025)\b/g) ?? [])];
  const range = /20\d\d\s*(?:to|through|thru|and|-|–)\s*20\d\d/.test(t);
  const year = years.length === 1 && !range ? [years[0], years[0]] : null;
  return { crews: n ? Number(n[1]) : undefined, cutPct: cut ? Number(cut[1] ?? cut[2]) : undefined, source, year: year ? Number(year[1]) : range ? 0 : undefined };
}

function ops311Intent(text: string) {
  const t = words(text);
  if (!/\b311\b|pothole|work order|tickets?\b|snow plow|plough|plow/.test(t)) return null;
  const roads = t.match(/(\d{1,2})\s*roads?/), waste = t.match(/(\d{1,2})\s*(?:waste|wrs|garbage)/), jobs = t.match(/(\d{1,2})\s*jobs/);
  const disruption: Disruption | undefined = /blizzard|snow storm|snowstorm|\bsnow\b|ice/.test(t) ? "blizzard" : /sick|calls? in|crew down|lose a crew|missing crew/.test(t) ? "sick" : /no disruption|normal day/.test(t) ? "none" : undefined;
  return { roads: roads ? Number(roads[1]) : undefined, waste: waste ? Number(waste[1]) : undefined, jobsPerCrew: jobs ? Number(jobs[1]) : undefined, disruption };
}

const crewReply = (plan: CrewPlan, live: boolean) => {
  const g = plan.grades;
  const top = plan.pickedCut.slice(0, 3).map(label).join(", ");
  const vs = g ? ` Against biggest-first that reaches ${g.ours.escapesCaught} fires that later escaped instead of ${g.baseline.escapesCaught}, and ${g.cut.escapesCaught} vs ${g.baselineCut.escapesCaught} after the cut.` : "";
  const lost = plan.lostCrew.length ? ` Cutting to ${plan.cutCrews} crew${plan.cutCrews === 1 ? "" : "s"}, ${plan.lostCrew.length === 1 ? "1 fire loses its crew" : `${plan.lostCrew.length} fires lose theirs`}: ${plan.lostCrew.slice(0, 6).map(label).join(", ")}${plan.lostCrew.length > 6 ? " and more" : ""}.` : "";
  return `${plan.crews} crew${plan.crews === 1 ? "" : "s"}${live ? " on today's fires" : " on Alberta's 2023–2025 fires"}: first ${top}.${vs}${lost} The full list and the duty-officer note are in Dispatch.`;
};

/** Whether a typed Ask is a crew-allocation or 311 question (answered here, not by the model). */
export const isDispatchQuestion = (text: string) => !!(ops311Intent(text) || crewIntent(text));

/** A Dispatch answer for a typed Ask, or null when the question isn't about crews or 311. */
export async function answerDispatch(text: string): Promise<string | null> {
  const ops = ops311Intent(text);
  if (ops) {
    const f = await plan311Facts(ops);
    const r = f.replan;
    const jobs = (n: number, verb: [string, string]) => `${n} job${n === 1 ? "" : "s"} ${n === 1 ? verb[0] : verb[1]}`;
    const noon = r ? ` At noon, the ${f.disruption === "blizzard" ? "blizzard" : "sick crew"} replan: ${jobs(r.changedCrew, ["changes", "change"])} crew, ${jobs(r.toTomorrow, ["waits", "wait"])} until tomorrow, ${r.newJobs} new.` : "";
    return `Calgary 311, ${f.crews.length} crews: ${f.vsOldestFirst.safetyJobs.plan} safety jobs today instead of ${f.vsOldestFirst.safetyJobs.oldestFirst} with oldest-first, and ${f.vsOldestFirst.drivingKm.plan} km of driving instead of ${f.vsOldestFirst.drivingKm.oldestFirst}.${noon} ${f.forecast}`;
  }
  const crews = crewIntent(text);
  if (crews) {
    // Keep the list the panel is on (the case seasons by default) unless the question names one.
    const live = (crews.source ?? dispatch.get().source) === "live";
    await crewPlanFacts({ ...crews, source: live ? "live" : "history" });
    const plan = dispatch.get().plan;
    if (!plan) return live ? "There are no active fires in focus right now. Ask me to rank the 2023 to 2025 seasons instead." : "The case data is still loading.";
    return crewReply(plan, live);
  }
  return null;
}
