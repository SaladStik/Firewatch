/**
 * Typed Ask without the model: recognises questions and commands about the data and the dispatch
 * queues, runs them through the same ask_data / do_dispatch functions the voice agent uses, and
 * answers in a sentence or two. Anything it doesn't recognise goes on to the other local answers.
 */
import type { Engine } from "../engine";
import { askData, doDispatch } from "./knowledge";

type R = Record<string, unknown> & { error?: string };
const TICKET = /\b(\d{2}-\d{8})\b/;
const FIRE = /\b([A-Z]{3}\d{3})\b/i;
const CREW = /\b([RW]\d{1,2})\b/i;
const list = (xs: string[], n = 5) => (xs.length > n ? `${xs.slice(0, n).join("; ")}; and ${xs.length - n} more` : xs.join("; "));
const go = (xs: R[]) => list(xs.map((x) => `${x.resource} from ${x.from} (ETA ${x.etaMin} min)`), 3);

/** The fire and ticket the conversation is about, for "why is that one first?", "what's near it?". */
let lastFire = "", lastTicket = "";
const fireId = (r: R) => { const n = r.nextUp; return String((n && typeof n === "object" ? (n as R).fire : n) ?? r.fire ?? ""); };
const remember = (r: R) => { const f = fireId(r); if (f && !r.error) lastFire = f; return r; };

/** An answer, or null when this isn't a data / dispatch question. */
export async function answerKnowledge(engine: Engine, raw: string): Promise<string | null> {
  const text = raw.trim(), t = text.toLowerCase();
  const fire = text.match(FIRE)?.[1]?.toUpperCase(), crew = text.match(CREW)?.[1]?.toUpperCase();
  let ticket = text.match(TICKET)?.[1];
  if (!ticket && lastTicket && /\b(that|this|the) ticket\b|\bit\b/.test(t) && /\b(urgent|hold|clear|why|priority)\b/.test(t)) ticket = lastTicket;
  if (ticket) lastTicket = ticket;
  const run = async (fn: typeof askData, p: Record<string, unknown>) => {
    if (p.action === "set_crews") lastFire = ""; // a new list: "that fire" means its first one now
    return remember((await fn(engine, p)) as R);
  };
  // "that fire", "it", "this one": the fire last talked about, else the next one up.
  const refersToFire = /\b(that|this|the|it'?s|its) (fire|one)\b|\bit\b|\bthere\b/.test(t);
  const current = async () => {
    // The list may have changed since (crews, season, live): only keep a fire that's still on it.
    if (lastFire && !((await askData(engine, { topic: "fire", fire_id: lastFire })) as R).error) return lastFire;
    return fireId(await run(askData, { topic: "wildfire_queue" }));
  };
  const is311 = /\b311\b|tickets?\b|pothole|calgary crew|\b[rw]\d\b/.test(t);

  // ---- actions
  if (ticket && /\burgent\b/.test(t)) return say(await run(doDispatch, { action: "ticket_urgent", ticket_id: ticket }), (r) => `Ticket ${ticket} is marked urgent: priority ${(r.ticket as R).priority}, ${(r.ticket as R).plannedAs}.`);
  if (ticket && /\bhold\b/.test(t)) return say(await run(doDispatch, { action: "ticket_hold", ticket_id: ticket }), () => `Ticket ${ticket} is on hold: it stays out of today's plan.`);
  if (ticket && /\b(clear|unmark|remove the (hold|urgent))\b/.test(t)) return say(await run(doDispatch, { action: "ticket_clear", ticket_id: ticket }), () => `Ticket ${ticket} is back to its normal priority.`);
  if (/\bskip\b/.test(t) && (fire || /\bfire\b|\bit\b|this one/.test(t))) return say(await run(doDispatch, { action: "skip_fire", fire_id: fire ?? "" }), (r) => `Skipped ${r.fire}.${r.nextUp ? ` Next up: ${r.nextUp}.` : ""}`);
  if (/\b(dispatch|send)\b/.test(t) && (fire || /\b(this|next|the|that) fire\b|\b(dispatch|send) (it|this one)\b/.test(t)) && !is311) {
    return say(await run(doDispatch, { action: "dispatch_fire", fire_id: fire ?? "" }), (r) => `Dispatched to ${r.fire}: ${go((r.resources as R[]) ?? []) || "no resources free"}.${r.nextUp ? ` Next up: ${r.nextUp}.` : ""}`);
  }
  if (/\b(dispatch|send)\b/.test(t) && (crew || /\b(this|next|the)( 311)? crew\b/.test(t)) && /\b(311|crew|r\d|w\d)\b/.test(t)) {
    return say(await run(doDispatch, { action: "dispatch_crew_311", crew: crew ?? "" }), (r) => `Crew ${r.dispatched} is dispatched${r.route ? `: ${(r.route as R).km} km, ${(r.route as R).minutes} min of driving` : ""}.${r.nextUp ? ` Next: ${r.nextUp}.` : ""}`);
  }
  if (crew && /\b(shortest|optimi[sz]e|re-?route|reorder|best route)\b/.test(t)) return say(await run(doDispatch, { action: "shortest_route", crew }), (r) => `Crew ${crew}'s stops are in the shortest order${Number(r.minutesSaved) > 0 ? `, saving ${r.minutesSaved} min` : " (already the shortest)"}${r.route ? `: ${(r.route as R).km} km, ${(r.route as R).minutes} min` : ""}.`);
  if (/\b(all|every|list( of)?|show( me)?( the)?) tickets?\b|\bticket (list|queue)\b/.test(t) && !/\b(in|at|for)\s+[a-z]/.test(t)) {
    await run(doDispatch, { action: "show_tickets" });
    return say(await run(askData, { topic: "tickets" }), (r) => `${r.matching} open tickets (${r.source}); the list is open. Highest priority: ${list((r.top as R[]).slice(0, 3).map((x) => `${x.id} ${x.type} in ${x.community} (p${x.priority})`), 3)}.`);
  }
  const day = /\btoday\b/.test(t) ? 0 : /\btomorrow\b/.test(t) ? 1 : Number(t.match(/\bin (\d) days?\b|\bday (\d)\b/)?.slice(1).find(Boolean) ?? NaN);
  if (/\b(show|go to|switch to|plan for)\b/.test(t) && Number.isFinite(day) && !/\bweather\b/.test(t)) return say(await run(doDispatch, { action: "show_day", day }), (r) => `Showing ${r.date}: the forecast, the fires and that day's 311 plan.`);
  if (/\b(switch|use|change|load)\b.*\b(live|sample|real)\b/.test(t) && is311) {
    const source = /\b(live|real)\b/.test(t) ? "live" : "sample";
    return say(await run(doDispatch, { action: "set_311", source }), (r) => `311 is on the ${r.source === "live" ? "live Open Calgary queue" : "case sample"}: ${r.roads} roads crews and ${r.waste} waste crews, ${r.jobsPerCrew} jobs each.`);
  }
  if (/\b(switch|use|change|load)\b.*\b(live|history|historical|sample|case)\b/.test(t) && /\bfires?\b|wildfire/.test(t)) {
    const source = /\blive\b/.test(t) ? "live" : "history";
    return say(await run(doDispatch, { action: "set_crews", source }), (r) => `Ranking ${r.source === "live" ? "today's live fires" : "Alberta's 2023–2025 fires"}: ${r.crews} crews, ${r.crewsAfterCut ?? "?"} after the cut. First: ${list((r.firstFires as string[]) ?? [], 3) || "no fires"}.`);
  }
  if (/\b(what'?s|who'?s) next\b|\bnext fire\b/.test(t) && !is311) return say(await run(doDispatch, { action: "next_fire" }), (r) => r.result ? String(r.result) : `Next up: ${(r.nextUp as R).fire}, rank ${(r.nextUp as R).rank}: ${(r.nextUp as R).reason}.`);

  // ---- wildfire crew questions
  if (!is311 && /\b(lost|lose|loses) (a |their |its )?crews?\b|\bwho lost\b/.test(t)) {
    return say(await run(askData, { topic: "wildfire_queue" }), (r) => { const l = r.lostCrewInCut as string[]; return l.length ? `Cutting ${r.crews} crews to ${r.crewsAfterCut}, ${l.length} fire${l.length === 1 ? "" : "s"} lose${l.length === 1 ? "s its crew" : " their crews"}, the lowest priorities on the list: ${list(l, 8)}.` : `No fire loses a crew going from ${r.crews} to ${r.crewsAfterCut}.`; });
  }
  if (!is311 && /\bescap|\b(biggest|largest)[- ]first\b|\bbaseline\b|\bcompare|\bbetter than\b/.test(t)) {
    return say(await run(askData, { topic: "wildfire_queue" }), (r) => {
      const v = r.vsBiggestFirst as R | undefined;
      if (!v) return `Escapes are graded on the 2023–2025 seasons, where final sizes are known. Ask me to switch to the historical fires.`;
      return `Of ${v.escapesTotal} fires that were small when assessed and later grew past 200 ha, our ranking reaches ${v.ours} with ${r.crews} crews; biggest-first reaches ${v.biggestFirst}. After the cut to ${r.crewsAfterCut} crews it's ${v.oursAfterCut} vs ${v.biggestFirstAfterCut}. Graded on final sizes the ranking never saw.`;
    });
  }
  if (!is311 && /\bduty[- ]officer|\bbriefing\b|\bsummar(y|i[sz]e)\b|\bparagraph\b/.test(t)) return say(await run(askData, { topic: "wildfire_queue" }), (r) => String(r.dutyOfficer));
  if (!is311 && /\bwhy\b/.test(t) && (fire || refersToFire || /\bfirst\b|\branked\b|\bpriority\b/.test(t))) {
    const id = fire ?? await current();
    return say(await run(askData, { topic: "fire", fire_id: id }), (r) => `${r.fire} is rank ${r.rank} because of ${String(r.reason).replace(/ · /g, ", ")}.${(r.peopleWithin30km as number) > 0 ? ` About ${r.peopleWithin30km} people within 30 km.` : ""}${(r.criticalSites as string[]).length ? ` Critical sites: ${list(r.criticalSites as string[], 3)}.` : ""}`);
  }

  // ---- questions
  if (ticket) return say(await run(askData, { topic: "ticket", ticket_id: ticket }), (r) => `Ticket ${ticket}: ${r.type} in ${r.community}, priority ${r.priority} (${(r.why as string[]).slice(1, 4).join("; ") || "severity only"}). ${r.plannedAs === "waiting" ? "It's waiting." : `Planned as ${r.plannedAs}.`}`);
  if (fire || (/\b(tell me about|what about|details|status of)\b/.test(t) && refersToFire && !is311)) {
    const id = fire ?? await current();
    return say(await run(askData, { topic: "fire", fire_id: id }), (r) => `${r.fire} is rank ${r.rank}${r.crewedAfterCut ? "" : r.lostCrewInCut ? ", and it lost its crew in the cut" : ", below the crew line"}: ${r.reason}. ${(r.resources as R[]).length ? `Going: ${go(r.resources as R[])}.` : r.decision === "not yet" ? "Not dispatched yet." : `Decision: ${r.decision}.`}`);
  }
  if (/\b(aircraft|planes?|air ?tankers?|water ?bombers?|skimmers?|bombers?)\b/.test(t) && !/\bhow many\b/.test(t)) {
    const air = await run(askData, { topic: "aircraft" });
    if (air.error) return String(air.error);
    const live = air.live as R[];
    const now = live.length ? `${live.length} firefighting aircraft in the air: ${list(live.map((a) => `${a.reg || a.callsign} (${a.type}) at ${a.altFt ?? 0} ft`))}.` : String(air.note).startsWith("Live aircraft need") ? String(air.note) : "None of the skimmer or air tanker fleet is in the air right now (ADS-B, adsb.lol).";
    const fleet = await run(askData, { topic: "fleet" });
    const kind = /skimmer|scoop/.test(t) ? "Skimmer" : /tanker|bomber/.test(t) ? "Air tanker" : "";
    const ours = ((fleet.resources as R[]) ?? []).filter((x) => (kind ? String(x.kind).startsWith(kind) : /Skimmer|Air tanker/.test(String(x.kind))));
    const at = new Map<string, number>(); ours.forEach((x) => at.set(String(x.base), (at.get(String(x.base)) ?? 0) + 1));
    const sent = ours.filter((x) => x.assignedTo).map((x) => `${x.id} → ${x.assignedTo}`);
    return `${now} In the plan: ${ours.length} ${kind ? kind.toLowerCase() : "aircraft"} group${ours.length === 1 ? "" : "s"} at ${list([...at].map(([b, n]) => `${b}${n > 1 ? ` (${n})` : ""}`), 6)}${sent.length ? `; sent: ${list(sent, 4)}` : "; none sent yet"}.`;
  }
  if (/\b(smoke|air quality|aqhi|smoky)\b/.test(t)) {
    const place = text.match(/\b(?:in|at|near|for|around)\s+([A-Z][\w'.-]*(?: [A-Z][\w'.-]*)*)/)?.[1];
    return say(await run(askData, { topic: "air_quality" }), (r) => {
      const all = r.advisories as R[], fmt = (a: R) => `${a.place} ${a.level} (AQHI ${a.aqhi}, ${a.reason})`;
      if (place) {
        const hit = all.find((a) => String(a.place).toLowerCase() === place.toLowerCase());
        if (hit) return `${fmt(hit)}. ${r.note}`;
        return `No smoke advisory for ${place} that day.${all.length ? ` The worst elsewhere: ${list(all.slice(0, 3).map(fmt), 3)}.` : ""}`;
      }
      return all.length ? `Smoke advisories: ${list(all.map(fmt))}.` : "No smoke advisories for that day.";
    });
  }
  if (/\b(highways?|traffic|roads? (at risk|closed))\b/.test(t) && !is311) return say(await run(askData, { topic: "highways" }), (r) => (r.corridors as R[]).length ? `Highways at risk: ${list((r.corridors as R[]).map((c) => `Hwy ${c.highway} (${c.reason}${c.closed ? ", closed" : ""})`))}.` : "No highway corridors at risk that day.");
  const nearFire = /\b(near|around|close to|threatened by|at risk (from|near))\b/.test(t) && refersToFire;
  if (nearFire || (/\b(values at risk|critical (sites|infrastructure)|schools?|hospitals?|what'?s at risk)\b/.test(t) && /\b(near|around|at risk)\b/.test(t))) {
    const place = nearFire ? undefined : text.match(/\b(?:near|around)\s+([A-Z][\w'.-]*(?: [A-Z][\w'.-]*)*)/)?.[1]?.trim();
    const p = place ? { place } : { fire_id: fire ?? await current() };
    return say(await run(askData, { topic: "values_at_risk", ...p }), (r) => (r.assets as R[]).length ? `Near ${r.around}: ${list((r.assets as R[]).map((a) => `${a.name} ${a.km} km ${a.direction} (${a.reason})`))}.` : `Nothing critical within reach of ${r.around}.`);
  }
  if (/\b(tickets?|potholes?|work orders?|sidewalks?|signs?)\b/.test(t) && /\b(in|at|for)\s+[a-z]/.test(t) && !/\bfor (crew|today|tomorrow)\b/.test(t)) {
    const community = text.match(/\b(?:in|at|for)\s+([A-Za-z][\w'/ -]+?)(?:\?|$|\.)/)?.[1]?.trim() ?? "";
    const q = /pothole/.test(t) ? "pothole" : /sign/.test(t) ? "sign" : /ice|snow/.test(t) ? "ice" : /sidewalk|curb/.test(t) ? "sidewalk" : "";
    return say(await run(askData, { topic: "tickets", community, query: q }), (r) => {
      const top = r.top as R[];
      if (top[0]) lastTicket = String(top[0].id);
      return `${r.matching} open ${q ? `${q} tickets` : "tickets"} in ${community}.${top.length ? ` Highest priority: ${list(top.map((x) => `${x.id} ${x.type} p${x.priority} (${x.plannedAs})`), 4)}.` : ""}`;
    });
  }
  if (/\bhow many\b.*\b(tickets?|311)\b|\b(tickets?|311)\b.*\bopen\b/.test(t)) {
    return say(await run(askData, { topic: "tickets" }), (r) => `${r.matching} open 311 tickets in the ${r.source === "live" ? "live Open Calgary queue" : "case sample"}. Highest priority: ${list((r.top as R[]).slice(0, 3).map((x) => `${x.id} ${x.type} in ${x.community} (p${x.priority})`), 3)}.`);
  }
  if (crew || /\b(311 )?crews?\b.*\b(today|doing|route|stops|plan)\b/.test(t) && is311) {
    return say(await run(askData, { topic: "crews_311" }), (r) => {
      const all = r.crews as R[], one = crew ? all.find((c) => c.crew === crew) : undefined;
      if (crew && !one) return `No crew ${crew}. Crews: ${all.map((c) => c.crew).join(", ")}.`;
      const show = (c: R) => `${c.crew}${c.dispatched ? " (dispatched)" : ""}: ${(c.stops as string[]).length} stops${c.route ? `, ${(c.route as R).km} km, ${(c.route as R).minutes} min` : ""}${(c.stops as string[]).length ? `, first ${(c.stops as string[])[0]}` : ""}`;
      if (one) return `Crew ${show(one)}. Stops: ${list(one.stops as string[], 12)}.`;
      return `${r.day}: ${list(all.map(show), 8)}.`;
    });
  }
  if (/\b(schedule|this week|week'?s plan|rest of the week)\b/.test(t)) return say(await run(askData, { topic: "schedule_311" }), (r) => `311 this week: ${list((r.week as R[]).map((d) => `${d.date} ${d.safetyJobs} safety jobs`), 8)}.`);
  if (/\b(fleet|bases|how many (crews|tankers|air ?tankers|skimmers|aircraft|planes))\b/.test(t) && !is311) return say(await run(askData, { topic: "fleet" }), (r) => `${r.groundCrewsAfterCut} ground crews after the cut, ${r.airtankers} air tanker groups and ${r.skimmers} skimmer groups, at ${(r.bases as string[]).length} bases.`);
  if (/\b(data sources?|where does (the|your) data|what data)\b/.test(t)) return say(await run(askData, { topic: "data_sources" }), (r) => `My data: ${(r.sources as string[]).join("; ")}.`);
  if (/\bhow (do|does|did) (you|it|the \w+) (rank|score|prioriti[sz]e|pick|choose|decide|work)|\bmethodology\b|\bwhy (that|this) order\b/.test(t)) {
    return say(await run(askData, { topic: "methodology" }), (r) => /311|ticket|pothole|calgary/.test(t) ? String(r.calgary311) : /dispatch|tanker|skimmer|helitack|aircraft|resource/.test(t) ? String(r.dispatch) : String(r.wildfire));
  }
  return null;
}

function say(r: R, ok: (r: R) => string): string {
  return r.error ? String(r.error) : r.result && !r.nextUp ? String(r.result) : ok(r);
}
