/**
 * Typed Ask without the model: recognises questions and commands about the data and the dispatch
 * queues, runs them through the same ask_data / do_dispatch functions the voice agent uses, and
 * answers in a sentence or two. Anything it doesn't recognise goes on to the agent.
 */
import type { Engine } from "../engine";
import { askData, doDispatch } from "./knowledge";

type R = Record<string, unknown> & { error?: string };
const TICKET = /\b(\d{2}-\d{8})\b/;
const FIRE = /\b([A-Z]{3}\d{3})\b/i;
const CREW = /\b([RW]\d{1,2})\b/i;
const list = (xs: string[], n = 5) => (xs.length > n ? `${xs.slice(0, n).join("; ")}; and ${xs.length - n} more` : xs.join("; "));

/** An answer, or null when this isn't a data / dispatch question (the agent takes it). */
export async function answerKnowledge(engine: Engine, raw: string): Promise<string | null> {
  const text = raw.trim(), t = text.toLowerCase();
  const ticket = text.match(TICKET)?.[1], fire = text.match(FIRE)?.[1]?.toUpperCase(), crew = text.match(CREW)?.[1]?.toUpperCase();
  const run = async (fn: typeof askData, p: Record<string, unknown>) => (await fn(engine, p)) as R;

  // ---- actions
  if (ticket && /\burgent\b/.test(t)) return say(await run(doDispatch, { action: "ticket_urgent", ticket_id: ticket }), (r) => `Ticket ${ticket} is marked urgent: priority ${(r.ticket as R).priority}, ${(r.ticket as R).plannedAs}.`);
  if (ticket && /\bhold\b/.test(t)) return say(await run(doDispatch, { action: "ticket_hold", ticket_id: ticket }), () => `Ticket ${ticket} is on hold: it stays out of today's plan.`);
  if (ticket && /\b(clear|unmark|remove the (hold|urgent))\b/.test(t)) return say(await run(doDispatch, { action: "ticket_clear", ticket_id: ticket }), () => `Ticket ${ticket} is back to its normal priority.`);
  if (/\b(skip)\b/.test(t) && (fire || /\bfire\b/.test(t))) return say(await run(doDispatch, { action: "skip_fire", fire_id: fire ?? "" }), (r) => `Skipped ${r.fire}.${r.nextUp ? ` Next up: ${r.nextUp}.` : ""}`);
  if (/\b(dispatch|send)\b/.test(t) && (fire || /\b(this|next|the) fire\b/.test(t))) {
    return say(await run(doDispatch, { action: "dispatch_fire", fire_id: fire ?? "" }), (r) => `Dispatched to ${r.fire}: ${list(((r.resources as R[]) ?? []).map((x) => `${x.resource} from ${x.from}, ETA ${x.etaMin} min`), 3) || "no resources free"}.${r.nextUp ? ` Next up: ${r.nextUp}.` : ""}`);
  }
  if (/\b(dispatch|send)\b/.test(t) && (crew || /\b(this|next|the)( 311)? crew\b/.test(t)) && /\b(311|crew|r\d|w\d)\b/.test(t)) {
    return say(await run(doDispatch, { action: "dispatch_crew_311", crew: crew ?? "" }), (r) => `Crew ${r.dispatched} is dispatched${r.route ? `: ${(r.route as R).km} km, ${(r.route as R).minutes} min of driving` : ""}.${r.nextUp ? ` Next: ${r.nextUp}.` : ""}`);
  }
  if (crew && /\b(shortest|optimi[sz]e|re-?route|reorder)\b/.test(t)) return say(await run(doDispatch, { action: "shortest_route", crew }), (r) => `Crew ${crew}'s stops are in the shortest order${Number(r.minutesSaved) > 0 ? `, saving ${r.minutesSaved} min` : ""}${r.route ? `: ${(r.route as R).km} km, ${(r.route as R).minutes} min` : ""}.`);
  if (/\b(what'?s|who'?s) next\b|\bnext fire\b/.test(t)) return say(await run(doDispatch, { action: "next_fire" }), (r) => r.result ? String(r.result) : `Next up: ${(r.nextUp as R).fire}, rank ${(r.nextUp as R).rank}: ${(r.nextUp as R).reason}.`);

  // ---- questions
  if (ticket) return say(await run(askData, { topic: "ticket", ticket_id: ticket }), (r) => `Ticket ${ticket}: ${r.type} in ${r.community}, priority ${r.priority} (${(r.why as string[]).slice(1, 4).join("; ") || "severity only"}). ${r.plannedAs === "waiting" ? "It's waiting." : `Planned as ${r.plannedAs}.`}`);
  if (fire) return say(await run(askData, { topic: "fire", fire_id: fire }), (r) => `${r.fire} is rank ${r.rank}${r.crewedAfterCut ? "" : r.lostCrewInCut ? ", and it lost its crew in the cut" : ", below the crew line"}: ${r.reason}. ${(r.resources as R[]).length ? `Going: ${list((r.resources as R[]).map((x) => `${x.resource} from ${x.from} (ETA ${x.etaMin} min)`), 3)}.` : ""}`);
  if (/\b(aircraft|planes?|air ?tankers?|water ?bombers?|skimmers?)\b/.test(t) && /\b(where|live|real|flying|airborne|in the air|now)\b/.test(t)) {
    return say(await run(askData, { topic: "aircraft" }), (r) => (r.live as R[]).length ? `${(r.live as R[]).length} firefighting aircraft in the air: ${list((r.live as R[]).map((a) => `${a.reg || a.callsign} (${a.type}) at ${a.altFt ?? 0} ft`))}.` : String(r.note).startsWith("Live aircraft need") ? String(r.note) : "None of the skimmer or air tanker fleet is in the air right now (ADS-B, adsb.lol).");
  }
  if (/\b(smoke|air quality|aqhi)\b/.test(t)) return say(await run(askData, { topic: "air_quality" }), (r) => (r.advisories as R[]).length ? `Smoke advisories: ${list((r.advisories as R[]).map((a) => `${a.place} ${a.level} (AQHI ${a.aqhi}, ${a.reason})`))}.` : "No smoke advisories for that day.");
  if (/\b(highways?|traffic|roads? (at risk|closed))\b/.test(t)) return say(await run(askData, { topic: "highways" }), (r) => (r.corridors as R[]).length ? `Highways at risk: ${list((r.corridors as R[]).map((c) => `Hwy ${c.highway} (${c.reason}${c.closed ? ", closed" : ""})`))}.` : "No highway corridors at risk that day.");
  if (/\b(values at risk|critical (sites|infrastructure)|schools?|hospitals?)\b/.test(t) && /\b(near|around|at risk)\b/.test(t)) {
    const place = text.match(/\b(?:near|around)\s+([A-Z][\w'. -]+)/)?.[1]?.trim();
    return say(await run(askData, { topic: "values_at_risk", place: place ?? "" }), (r) => (r.assets as R[]).length ? `Near ${r.around}: ${list((r.assets as R[]).map((a) => `${a.name} ${a.km} km ${a.direction} (${a.reason})`))}.` : `Nothing critical within reach of ${r.around}.`);
  }
  if (/\b(tickets?|potholes?|work orders?)\b/.test(t) && /\b(in|at|for)\s+[a-z]/.test(t)) {
    const community = text.match(/\b(?:in|at|for)\s+([A-Za-z][\w'/ -]+?)(?:\?|$|\.)/)?.[1]?.trim() ?? "";
    const q = /pothole/.test(t) ? "pothole" : /sign/.test(t) ? "sign" : /ice|snow/.test(t) ? "ice" : /sidewalk|curb/.test(t) ? "sidewalk" : "";
    return say(await run(askData, { topic: "tickets", community, query: q }), (r) => `${r.matching} open ${q || "tickets"} in ${community}. Top: ${list((r.top as R[]).map((x) => `${x.id} ${x.type} p${x.priority} (${x.plannedAs})`), 4)}.`);
  }
  if (/\b(schedule|this week|week'?s plan)\b/.test(t)) return say(await run(askData, { topic: "schedule_311" }), (r) => `311 this week: ${list((r.week as R[]).map((d) => `${d.date} ${d.safetyJobs} safety jobs`), 8)}.`);
  if (/\b(fleet|bases|how many (crews|tankers|skimmers))\b/.test(t)) return say(await run(askData, { topic: "fleet" }), (r) => `${r.groundCrewsAfterCut} ground crews after the cut, ${r.airtankers} air tanker groups and ${r.skimmers} skimmer groups, at ${(r.bases as string[]).length} bases.`);
  if (/\b(data sources?|where does (the|your) data|what data)\b/.test(t)) return say(await run(askData, { topic: "data_sources" }), (r) => `My data: ${(r.sources as string[]).join("; ")}.`);
  if (/\b(how (do|does) (you|it|the) (rank|score|prioriti[sz]e|pick|choose|work))|methodology|why (that|this) order\b/.test(t)) {
    return say(await run(askData, { topic: "methodology" }), (r) => /311|ticket|pothole/.test(t) ? String(r.calgary311) : /dispatch|tanker|skimmer|helitack/.test(t) ? String(r.dispatch) : String(r.wildfire));
  }
  return null;
}

function say(r: R, ok: (r: R) => string): string {
  return r.error ? String(r.error) : r.result && !r.nextUp ? String(r.result) : ok(r);
}
