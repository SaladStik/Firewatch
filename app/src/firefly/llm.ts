/**
 * Firefly's reasoning for typed questions: a model on Databricks Model Serving (through the data
 * server, server/ai.ts) that plans, calls Firefly's tools against the map's live state, reads the
 * results and answers. The same tools the ElevenLabs voice agent uses (tools.ts), defined here as
 * function schemas, so nothing has to be configured in a dashboard. Spoken questions stay on the
 * voice agent.
 */
import { apiUrl, usingDataServer } from "../data/liveData";
import { DATA_TOPICS, DISPATCH_ACTIONS } from "./topics";
import type { makeTools } from "./tools";

type Tools = ReturnType<typeof makeTools>;
type Json = Record<string, unknown>;
export interface LlmMessage { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }
interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }

/** Model round trips per question (each can call several tools). */
const MAX_STEPS = 6;
/** Tool results are compact JSON already; cap anything unusually long. */
const MAX_RESULT = 6000;

const str = (description: string, extra: Json = {}) => ({ type: "string", description, ...extra });
const int = (description: string, extra: Json = {}) => ({ type: "integer", description, ...extra });
const fn = (name: string, description: string, properties: Json = {}, required: string[] = []) => ({
  type: "function" as const, function: { name, description, parameters: { type: "object", properties, required } },
});

/** Firefly's tools (the same functions as the voice agent's client tools; see AGENT.md). */
export const TOOL_SPECS = [
  fn("ask_data", "Answer any question about the app's data: smoke, highways, values at risk near a fire or place, real firefighting aircraft in the air now, the fleet and bases, the wildfire crew queue (who's next, who lost a crew, vs biggest-first, the duty-officer paragraph) or one fire (rank, reason, resources, ETAs), 311 tickets (search, or one ticket with its priority breakdown), 311 crews and routes, the week's 311 schedule, methodology, data sources.", {
    topic: str("What to look up.", { enum: [...DATA_TOPICS] }),
    fire_id: str("A fire id like HWF121 (fire, values_at_risk)."), place: str("A community name (values_at_risk)."),
    ticket_id: str("A 311 ticket id like 26-00216320 (ticket)."), community: str("Calgary community, e.g. Beltline (tickets)."),
    query: str("Ticket search, e.g. pothole, sign, ice, sidewalk (tickets)."), unit: str("Crew unit (tickets).", { enum: ["Roads", "WRS", "Other"] }), limit: int("How many tickets (tickets)."),
  }, ["topic"]),
  fn("do_dispatch", "Act on the dispatch queues, only when the user asks: dispatch or skip a fire (its crews and aircraft go), move to the next fire, set crews / cut / air tankers / skimmers / source / season; dispatch a 311 crew, mark a ticket urgent, hold or clear it, change 311 crews or the disruption or source, put a crew's stops in the shortest order, open the ticket list, show a day.", {
    action: str("What to do.", { enum: [...DISPATCH_ACTIONS] }),
    fire_id: str("Fire id; omit for the one up next."), crew: str("311 crew id like R1 or W2; omit for the next one."), ticket_id: str("311 ticket id."),
    source: str("Wildfire: live or history. 311: live or sample."), disruption: str("311 noon disruption.", { enum: ["none", "blizzard", "sick"] }),
    crews: int("Wildfire ground crews (1–120)."), cut_percent: int("Percent of crews cut (0–90)."), airtankers: int("Air tanker groups (0–20)."), skimmers: int("Skimmer groups (0–10)."),
    year: int("2023, 2024 or 2025 (history only); 0 = all."), roads_crews: int("311 roads crews."), waste_crews: int("311 waste crews."), jobs_per_crew: int("311 jobs per crew."),
    day: int("Day of the week to show, 0 = today … 7."), on: { type: "boolean", description: "shortest_route: true to reorder, false to undo." },
  }, ["action"]),
  fn("get_briefing", "Current situation for the regions in focus: active fires, satellite hotspots in the last 24 h, biggest fires, threatened communities, the worst forecast day."),
  fn("get_place_report", "Fire weather and threats for one community across today and the next 7 days.", { place: str("Community name, e.g. Slave Lake.") }, ["place"]),
  fn("list_fires", "Active mapped fires and satellite hotspot clusters with id, nearest community, size and growth."),
  fn("get_fire_details", "One active fire in detail, including which communities its projected spread reaches within `days` days. Moves the map's forecast to that day.", { fire_id: str("Id from list_fires."), days: int("1–7, default 3.") }, ["fire_id"]),
  fn("explain_location", "Why a place (or the selected hex) has its risk: land cover and fuel, the Fire Weather Index, nearby fire, projected spread.", { place: str("Community; omit for the selected hex.") }),
  fn("plan_crews", "Rank fires for N wildfire crews (size × spread × people × crown), compare with biggest-first, cut crews and list who lost one, with a duty-officer paragraph. Opens Dispatch.", {
    crews: int("1–120."), cut_percent: int("Default 20."), source: str("live or history (Alberta 2023–2025).", { enum: ["live", "history"] }), year: int("History only; 0 = all."),
  }, ["crews"]),
  fn("plan_311", "Plan Calgary 311 crews for the day against oldest-first, with a noon disruption and replan; what to tell the supervisor at 8 a.m. and noon. Opens Dispatch.", {
    roads_crews: int("Default 5."), waste_crews: int("Default 3."), jobs_per_crew: int("Default 5."), disruption: str("Noon disruption.", { enum: ["none", "blizzard", "sick"] }),
  }),
  fn("open_dispatch", "Open the Dispatch panel on a tab.", { tab: str("Which tab.", { enum: ["crews", "311"] }) }, ["tab"]),
  fn("find_risk_areas", "Find the map's High and Extreme danger zones for a forecast day (unnamed areas of the risk layer), worst first, each with its nearest town, size, peak risk and cause; shows the worst one.", { day: int("0–7; omit for the day on the map.") }),
  fn("fly_to", "Move the map to a community, fire or danger zone (and Firefly with it). Give one.", { place: str("Community."), fire_id: str("Fire id from list_fires."), zone: int("Zone number from find_risk_areas.") }),
  fn("set_forecast_day", "Show a forecast day on the map (0 = today, 1–7 days ahead).", { day: int("0–7.") }, ["day"]),
  fn("set_layer", "Show or hide a map layer.", { layer: str("Layer.", { enum: ["risk", "fires", "spread", "air", "traffic", "beacons", "wind", "rain", "bloom"] }), on: { type: "boolean" } }, ["layer", "on"]),
  fn("set_regions", "Set which provinces are in focus. \"only\" replaces the set (\"just BC\"), \"add\" turns more on, \"remove\" turns some off (at least one stays).", {
    regions: str("Province names or codes, e.g. \"BC\" or \"Alberta, Saskatchewan\"."), mode: str("Default only.", { enum: ["only", "add", "remove"] }),
  }, ["regions"]),
  fn("flag_patrol", "Flag the hex at a community or fire for patrol.", { place: str("Community."), fire_id: str("Fire id.") }),
  fn("set_demo_mode", "Turn the labelled demo scenario (simulated fires, heatwave, rainstorm) on or off.", { on: { type: "boolean" } }, ["on"]),
];

const SYSTEM = `You are Firefly, the AI duty assistant on FIRE//WATCH, a wildfire risk map of western Canada with two dispatch desks: wildfire crews and aircraft (Alberta), and Calgary 311 field crews.

You reason with tools over the app's live data and act on the map. Rules:
- Facts come only from tool results. Never guess numbers, fires, tickets, towns or weather. Call a tool before answering any question about data; call several when the question needs them (e.g. a fire's rank, then what's near it).
- Act when asked: dispatching, skipping, marking tickets urgent, changing crews or settings go through do_dispatch. Never take those actions unless the user asked for them. "It", "that one", "this fire" mean the fire or ticket last discussed, or the one up next.
- Read before you open: ask_data answers what something IS right now (a crew's stops today, the queue, a ticket, smoke). open_dispatch and plan_311 / plan_crews open or re-plan a desk — use those only when the user wants the panel or a new plan, not to answer a question.
- Show things: fly_to a place or fire you talk about; set_forecast_day before answering about a future day; set_regions when asked to focus or limit provinces ("just BC" is mode only).
- Projected spread is a scenario model, not an official forecast: say "projected" or "could reach".
- Answer in plain language, Canadian units, 1–4 short sentences, no markdown, no lists unless asked. Name ids (fires like HWF121, tickets like 26-00216320, crews like R1) so the dispatcher can act on them.
- When a tool returns an error, say what's missing briefly and offer what you can do.
- For emergencies, point to official alerts (Alberta Emergency Alert, BC Wildfire Service) and 911.`;

let status: Promise<{ available: boolean; model: string | null }> | null = null;
/** Whether the data server has a model configured (asked once). */
export function llmStatus() {
  if (!usingDataServer) return Promise.resolve({ available: false, model: null });
  return (status ??= fetch(apiUrl("/ai")).then((r) => (r.ok ? r.json() : { available: false, model: null })).catch(() => ({ available: false, model: null })));
}

async function chat(messages: LlmMessage[], withTools: boolean): Promise<{ message: LlmMessage; model: string }> {
  const res = await fetch(apiUrl("/ai/chat"), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, ...(withTools ? { tools: TOOL_SPECS } : {}) }),
  });
  const body = (await res.json().catch(() => ({}))) as { message?: LlmMessage; model?: string; error?: string };
  if (!res.ok || !body.message) throw new Error(body.error || `AI ${res.status}`);
  return { message: body.message, model: body.model ?? "" };
}

/** Text of a message whose content may come as parts. */
const textOf = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (typeof p === "string" ? p : (p as Json)?.text ?? "")).join("") : "";

/** Some models write the call as JSON text instead of a tool call: recover it. */
function inlineCall(text: string): ToolCall | null {
  const m = text.trim().match(/^\{[\s\S]*\}$/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as Json;
    const name = String(j.name ?? j.function ?? ""), args = (j.parameters ?? j.arguments ?? {}) as Json;
    return TOOL_SPECS.some((t) => t.function.name === name) ? { id: `inline-${Date.now()}`, type: "function", function: { name, arguments: JSON.stringify(args) } } : null;
  } catch { return null; }
}

/** What a tool call is doing, in a dispatcher's words ("Marking 26-00216320 urgent"). */
export function describeCall(name: string, a: Json): string {
  const s = (k: string) => (a[k] == null || a[k] === "" ? "" : String(a[k]));
  const topic: Record<string, string> = {
    air_quality: "Checking smoke", highways: "Checking highways", values_at_risk: `Checking what's near ${s("fire_id") || s("place") || "the fire"}`,
    aircraft: "Checking aircraft in the air", fleet: "Checking the fleet", wildfire_queue: "Reading the wildfire queue", fire: `Looking up ${s("fire_id") || "the fire"}`,
    tickets: `Searching 311 tickets${s("community") ? ` in ${s("community")}` : ""}`, ticket: `Looking up ticket ${s("ticket_id")}`, crews_311: "Reading the 311 crews",
    schedule_311: "Reading the week's 311 schedule", methodology: "Reading the methodology", data_sources: "Reading the data sources",
  };
  const action: Record<string, string> = {
    dispatch_fire: `Dispatching to ${s("fire_id") || "the next fire"}`, skip_fire: `Skipping ${s("fire_id") || "the fire"}`, next_fire: "Moving to the next fire",
    set_crews: "Changing the crews", dispatch_crew_311: `Dispatching crew ${s("crew") || "next"}`, next_crew_311: "Moving to the next crew",
    ticket_urgent: `Marking ${s("ticket_id")} urgent`, ticket_hold: `Holding ${s("ticket_id")}`, ticket_clear: `Clearing ${s("ticket_id")}`,
    set_311: "Changing the 311 plan", shortest_route: `Re-routing crew ${s("crew")}`, show_tickets: "Opening the ticket list", show_day: "Changing the day",
  };
  if (name === "ask_data") return topic[s("topic")] ?? "Looking it up";
  if (name === "do_dispatch") return action[s("action")] ?? "Updating dispatch";
  const other: Record<string, string> = {
    get_briefing: "Reading the situation", get_place_report: `Checking ${s("place")}`, list_fires: "Listing fires", get_fire_details: `Projecting ${s("fire_id")}`,
    explain_location: "Explaining the risk", find_risk_areas: "Finding the danger areas", plan_crews: "Ranking fires for crews", plan_311: "Planning 311 crews", open_dispatch: "Opening Dispatch",
    fly_to: `Flying to ${s("place") || s("fire_id")}`, set_forecast_day: "Changing the forecast day", set_layer: "Changing the map", set_regions: "Changing the provinces in focus", flag_patrol: "Flagging for patrol", set_demo_mode: "Switching the demo",
  };
  return other[name] ?? name;
}

export interface LlmAnswer { text: string; tools: string[]; model: string }

/**
 * Answer one question: the model calls tools (run here, on the map's state) until it has what it
 * needs, then answers. `history` is the conversation so far (user and assistant text turns);
 * `context` is what's on screen (llmContext in tools.ts).
 */
export async function askLlm(tools: Tools, history: LlmMessage[], question: string, opts: { context?: string; onStep?: (what: string) => void } = {}): Promise<LlmAnswer> {
  const { context = "", onStep } = opts;
  const messages: LlmMessage[] = [{ role: "system", content: `${SYSTEM}\n\nNow: ${context}` }, ...history.slice(-12), { role: "user", content: question }];
  const used: string[] = [];
  let model = "";
  for (let step = 0; step < MAX_STEPS; step++) {
    const r = await chat(messages, true);
    model = r.model;
    const msg = r.message, text = textOf(msg.content);
    const calls = msg.tool_calls?.length ? msg.tool_calls : (() => { const c = inlineCall(text); return c ? [c] : []; })();
    if (!calls.length) return { text: text.trim() || "I don't have an answer for that.", tools: used, model };
    messages.push({ role: "assistant", content: msg.tool_calls?.length ? (text || null) : null, tool_calls: calls });
    for (const call of calls) {
      const name = call.function.name as keyof Tools;
      let args: Json = {};
      try { args = call.function.arguments ? (JSON.parse(call.function.arguments) as Json) : {}; } catch { /* model sent bad JSON: run with none */ }
      const label = `${String(name)}${args.topic ? `: ${String(args.topic)}` : args.action ? `: ${String(args.action)}` : ""}`;
      used.push(label);
      onStep?.(describeCall(String(name), args));
      const run = tools[name] as ((p: Json) => Promise<string>) | undefined;
      const out = run ? await run(args) : JSON.stringify({ error: `No tool ${String(name)}.` });
      messages.push({ role: "tool", tool_call_id: call.id, content: out.length > MAX_RESULT ? `${out.slice(0, MAX_RESULT)}…` : out });
    }
  }
  // Out of steps: answer from what it has.
  const r = await chat([...messages, { role: "user", content: "Answer now from the tool results above." }], false);
  return { text: textOf(r.message.content).trim() || "I couldn't finish that one.", tools: used, model: r.model };
}
