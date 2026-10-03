/**
 * Dispatch: the hackathon cases on the map, answer first.
 *  - Wildfire crews: who gets the next crew (live fires, or Alberta 2023–2025 replayed in the demo),
 *    how that compares with "biggest first", and who loses a crew when crews are cut.
 *  - Calgary 311: today's crew plan vs oldest-first, and the noon replan after a disruption.
 * Method, data notes and the improvement round sit in "How it works", folded away.
 */
import { Check, ChevronDown, ChevronLeft, ChevronRight, Flame, Map as MapIcon, Minus, Navigation, Route, Send, Snowflake, Ticket as TicketIcon, Volume2, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { crewColor } from "../dispatch/colors";
import { calgarySnowForecast, closeDispatch, flyTo, openTickets, recomputeRoutes, set311Options, setCrewOptions, setShortestOrder } from "../dispatch/controller";
import { dutyBriefing, EXPOSURE_KM, HAND_WEIGHTS, label, type Scored } from "../dispatch/crews";
import { priorityParts, supervisor8am, supervisorNoon, typeOf, type Disruption, type Plan311, type Ticket, type Weather311 } from "../dispatch/ops311";
import { dispatch, type DispatchTab } from "../dispatch/store";
import type { Engine } from "../engine";
import { fireflyController } from "../firefly/mascot";
import { app } from "../state/app";
import { useStore } from "../state/store";

const say = (text: string) => fireflyController().say(text, Math.max(6, Math.min(16, text.length * 0.045)));
const title = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

// ------------------------------------------------------------ small parts
function Tab({ id, active, children }: { id: DispatchTab; active: boolean; children: ReactNode }) {
  return (
    <button type="button" onClick={() => dispatch.set({ tab: id })} className={`flex-1 border-b-2 px-3 py-2 text-[11px] uppercase tracking-[0.08em] transition ${active ? "border-phos text-ink" : "border-transparent text-ink-mute hover:text-ink"}`}>
      {children}
    </button>
  );
}

function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="flex border border-line">
      {options.map(([v, text]) => (
        <button key={String(v)} type="button" onClick={() => onChange(v)} className={`flex-1 px-2 py-1 text-[11px] transition ${v === value ? "bg-[color-mix(in_srgb,var(--color-phos)_18%,transparent)] text-ink" : "text-ink-mute hover:text-ink"}`}>{text}</button>
      ))}
    </div>
  );
}

function Num({ label: name, value, min, max, onChange, suffix }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void; suffix?: string }) {
  const set = (v: number) => onChange(Math.min(max, Math.max(min, v)));
  return (
    <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-[0.06em] text-ink-mute">
      {name}
      <span className="flex items-center border border-line text-[12px] normal-case tracking-normal">
        <button type="button" onClick={() => set(value - 1)} className="px-1.5 py-0.5 text-ink-mute hover:text-phos" aria-label={`Fewer ${name}`}>−</button>
        <input value={value} onChange={(e) => set(Number(e.target.value) || min)} inputMode="numeric" className="w-full min-w-0 bg-transparent text-center tabular-nums text-ink outline-none" aria-label={name} />
        {suffix && <span className="pr-1 text-ink-mute">{suffix}</span>}
        <button type="button" onClick={() => set(value + 1)} className="px-1.5 py-0.5 text-ink-mute hover:text-phos" aria-label={`More ${name}`}>+</button>
      </span>
    </label>
  );
}

/** A folded section: closed by default, so the panel shows the answer and not the method. */
function Fold({ title: name, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="border-t border-line pt-2">
      <div className="flex items-center justify-between">
        <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1 text-[11px] uppercase tracking-[0.08em] text-ink-mute hover:text-ink">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{name}
        </button>
        {right}
      </div>
      {open && <div className="mt-2 flex flex-col gap-2 text-[11.5px] leading-relaxed text-ink-dim">{children}</div>}
    </section>
  );
}

/** Headline: our number big, the baseline's beside it. */
function Versus({ ours, base, oursLabel, baseLabel, caption }: { ours: string | number; base: string | number; oursLabel: string; baseLabel: string; caption: ReactNode }) {
  return (
    <div className="border border-line bg-[color-mix(in_srgb,var(--color-phos)_6%,transparent)] px-3 py-2.5">
      <div className="flex items-end gap-4">
        <div><div className="text-[26px] font-semibold leading-none tabular-nums text-ink">{ours}</div><div className="mt-1 text-[10px] uppercase tracking-[0.06em] text-phos">{oursLabel}</div></div>
        <div className="pb-0.5"><div className="text-[18px] leading-none tabular-nums text-ink-mute">{base}</div><div className="mt-1 text-[10px] uppercase tracking-[0.06em] text-ink-mute">{baseLabel}</div></div>
      </div>
      <p className="mt-2 text-[12px] leading-snug text-ink-dim">{caption}</p>
    </div>
  );
}

const ROW = "block w-full px-2 py-1 text-left transition hover:bg-[color-mix(in_srgb,var(--color-phos)_8%,transparent)]";

/** Keyboard for the work queue: Enter = send, S = skip, J / K = next / previous (arrows move the camera). */
function useQueueKeys(on: boolean, keys: { send: () => void; skip?: () => void; next: () => void; prev: () => void }) {
  useEffect(() => {
    if (!on) return;
    const down = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey || (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable))) return;
      const k = e.key.toLowerCase();
      if (k === "enter") keys.send();
      else if (k === "s" && keys.skip) keys.skip();
      else if (k === "j") keys.next();
      else if (k === "k") keys.prev();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, [on, keys]);
}

/** The work queue's current item: what it is, why, and the decision buttons. */
function QueueCard({ step, total, done, title: name, sub, why, sendLabel, state, onSend, onSkip, onPrev, onNext }: {
  step: number; total: number; done: number; title: ReactNode; sub: ReactNode; why: ReactNode; sendLabel: string;
  state?: "sent" | "skipped"; onSend: () => void; onSkip?: () => void; onPrev: () => void; onNext: () => void;
}) {
  return (
    <div className="border border-phos/60 bg-[color-mix(in_srgb,var(--color-phos)_7%,transparent)]">
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5 text-[10px] uppercase tracking-[0.08em] text-ink-mute">
        <span>Next up · {step} of {total}</span>
        <span>{done} of {total} done</span>
      </div>
      <div className="h-0.5 bg-[var(--color-line)]"><div className="h-full bg-[var(--color-phos)] transition-all" style={{ width: `${(done / Math.max(1, total)) * 100}%` }} /></div>
      <div className="px-3 py-2.5">
        <div className="flex items-baseline gap-2">
          <div className="text-[15px] font-semibold leading-tight text-ink">{name}</div>
          {state && <span className={`ml-auto shrink-0 text-[10px] uppercase tracking-wide ${state === "sent" ? "text-phos" : "text-ink-mute"}`}>{state}</span>}
        </div>
        <div className="mt-0.5 text-[12px] text-ink-dim">{sub}</div>
        <div className="mt-1.5 text-[11.5px] leading-snug text-ink-dim">{why}</div>
        <div className="mt-2.5 flex gap-1.5">
          <button type="button" onClick={onSend} className="flex flex-1 items-center justify-center gap-1.5 bg-[var(--color-phos)] px-2 py-1.5 text-[12px] font-semibold text-black transition hover:brightness-110"><Send size={12} /> {sendLabel}</button>
          {onSkip && <button type="button" onClick={onSkip} className="border border-line px-2.5 py-1.5 text-[12px] text-ink-dim hover:border-phos hover:text-ink">Skip</button>}
          <button type="button" onClick={onPrev} aria-label="Previous" className="border border-line px-1.5 text-ink-dim hover:border-phos hover:text-ink"><ChevronLeft size={14} /></button>
          <button type="button" onClick={onNext} aria-label="Next" className="border border-line px-1.5 text-ink-dim hover:border-phos hover:text-ink"><ChevronRight size={14} /></button>
        </div>
        <div className="mt-1.5 text-[10px] text-ink-mute">Enter {sendLabel.toLowerCase()}{onSkip ? " · S skip" : ""} · J / K next / previous</div>
      </div>
    </div>
  );
}

const fireKey = (s: Scored) => `${s.fire.year}:${s.fire.id}`;

// ------------------------------------------------------------ wildfire crews
/** "330 ha · 6 m/min · 23 km from Rainbow Lake" */
function shortReason(s: Scored): string {
  const ha = s.fire.sizeHa >= 10 ? Math.round(s.fire.sizeHa).toLocaleString("en-CA") : +s.fire.sizeHa.toFixed(1);
  const parts = [`${ha} ha`, `${s.ros >= 10 ? Math.round(s.ros) : s.ros.toFixed(1)} m/min${s.fire.crown ? " crown" : ""}`];
  const n = s.exposure.nearest;
  if (n && n.km < EXPOSURE_KM) parts.push(`${Math.round(n.km)} km from ${n.name}`);
  return parts.join(" · ");
}

function FireRow({ s, rank, lost, state, current, onPick }: { s: Scored; rank: number; lost?: boolean; state?: "sent" | "skipped"; current?: boolean; onPick?: () => void }) {
  return (
    <button type="button" title={s.reason} onClick={() => { flyTo(s.fire.lat, s.fire.lng, 40); onPick?.(); }} className={`${ROW} ${current ? "bg-[color-mix(in_srgb,var(--color-phos)_12%,transparent)]" : ""}`}>
      <div className="flex items-baseline gap-2 text-[12px]">
        <span className={`w-5 shrink-0 text-right tabular-nums ${lost ? "text-risk-high" : "text-ink-mute"}`}>{rank}</span>
        <span className="w-3 shrink-0">{state === "sent" ? <Check size={11} className="text-phos" /> : state === "skipped" ? <Minus size={11} className="text-ink-mute" /> : null}</span>
        <span className={`truncate ${state === "skipped" ? "text-ink-mute line-through" : "text-ink"}`}>{label(s)}</span>
        {s.fire.year ? <span className="ml-auto shrink-0 text-[10px] text-ink-mute">{s.fire.year}</span> : null}
      </div>
      <div className="pl-12 text-[11px] text-ink-mute">{shortReason(s)}</div>
    </button>
  );
}

function CrewsTab({ engine }: { engine: Engine | null }) {
  const d = useStore(dispatch, (s) => s);
  const simulation = useStore(app, (s) => s.simulation);
  const [showAll, setShowAll] = useState(false);
  const plan = d.plan, g = plan?.grades, learned = d.learned;
  const crewed = plan?.pickedCut ?? [];
  const shown = showAll ? crewed : crewed.slice(0, 8);
  // The work queue walks the crewed fires in priority order.
  const at = Math.min(d.cursor, Math.max(0, crewed.length - 1));
  const cur = crewed[at];
  const done = crewed.filter((s) => d.decided[fireKey(s)]).length;
  const go = (i: number) => {
    if (!crewed.length) return;
    const j = (i + crewed.length) % crewed.length;
    dispatch.set({ cursor: j });
    flyTo(crewed[j].fire.lat, crewed[j].fire.lng, 40);
  };
  const decide = (v: "sent" | "skipped") => {
    if (!cur) return;
    dispatch.set({ decided: { ...dispatch.get().decided, [fireKey(cur)]: v } });
    // On to the next undecided fire.
    const next = crewed.findIndex((s, i) => i > at && !dispatch.get().decided[fireKey(s)]);
    go(next >= 0 ? next : at + 1);
  };
  useQueueKeys(!!cur, { send: () => decide("sent"), skip: () => decide("skipped"), next: () => go(at + 1), prev: () => go(at - 1) });

  return (
    <div className="flex flex-col gap-3">
      <Seg value={d.source} options={[["history", "Alberta 2023–2025"], ["live", "Live fires"]]} onChange={(source) => setCrewOptions({ source })} />
      <div className="grid grid-cols-2 gap-2">
        <Num label="Crews" value={d.crews} min={1} max={120} onChange={(crews) => setCrewOptions({ crews })} />
        <Num label="Cut" value={d.cutPct} min={0} max={90} suffix="%" onChange={(cutPct) => setCrewOptions({ cutPct })} />
      </div>

      {d.status === "loading" && <p className="text-[12px] text-ink-mute">Loading the fires…</p>}
      {d.status === "learning" && <p className="text-[12px] text-ink-mute">Learning from past seasons…</p>}
      {d.status === "error" && <p className="text-[12px] text-risk-high">Couldn't load the case data: {d.error}</p>}
      {d.source === "live" && !plan && d.status === "ready" && <p className="text-[12px] text-ink-mute">No active fires in focus right now. Try Alberta 2023–2025.</p>}

      {plan && g && (
        <Versus
          ours={g.cut.escapesCaught} base={g.baselineCut.escapesCaught}
          oursLabel="FIRE//WATCH" baseLabel="Biggest first"
          caption={<>With <b className="text-ink">{plan.cutCrews}</b> crews, the fires that went on to escape that get a crew. At the full {plan.crews}: {g.ours.escapesCaught} vs {g.baseline.escapesCaught}.</>}
        />
      )}
      {plan && !g && (
        <Versus ours={plan.cutCrews} base={plan.ranked.length} oursLabel="Crews" baseLabel="Fires" caption={<>Ranked by size, spread for today's fuel and weather, and people nearby.</>} />
      )}

      {cur && (
        <QueueCard
          step={at + 1} total={crewed.length} done={done}
          title={label(cur)}
          sub={<>{shortReason(cur)}{cur.fire.year ? ` · ${cur.fire.year}` : ""}</>}
          why={<>Priority #{at + 1}: {cur.reason}.{cur.exposure.sites[0] ? ` Nearest critical site: ${cur.exposure.sites[0].name}.` : ""}</>}
          sendLabel="Send crew" state={d.decided[fireKey(cur)]}
          onSend={() => decide("sent")} onSkip={() => decide("skipped")} onPrev={() => go(at - 1)} onNext={() => go(at + 1)}
        />
      )}

      {d.source === "history" && plan && !simulation && (
        <button type="button" onClick={() => engine?.setSimulation(true)} className="flex items-center justify-center gap-1.5 border border-line px-2 py-1.5 text-[11px] text-ink-dim transition hover:border-phos hover:text-phos">
          <MapIcon size={12} /> Show these fires on the map
        </button>
      )}

      {plan && (
        <section>
          <div className="label-xs mb-1">Crews go to</div>
          <div className="-mx-2">{shown.map((s, i) => <FireRow key={fireKey(s)} s={s} rank={i + 1} state={d.decided[fireKey(s)]} current={i === at} onPick={() => dispatch.set({ cursor: i })} />)}</div>
          {crewed.length > 8 && (
            <button type="button" onClick={() => setShowAll(!showAll)} className="mt-1 text-[11px] text-ink-mute hover:text-phos">{showAll ? "Show fewer" : `Show all ${crewed.length}`}</button>
          )}
        </section>
      )}

      {plan && plan.lostCrew.length > 0 && (
        <section>
          <div className="label-xs mb-1 text-risk-high">Lose a crew in the cut ({plan.lostCrew.length})</div>
          <div className="-mx-2">{plan.lostCrew.map((s) => <FireRow key={`${s.fire.year}:${s.fire.id}`} s={s} rank={plan.picked.indexOf(s) + 1} lost />)}</div>
        </section>
      )}

      {plan && (
        <Fold title="Duty-officer briefing" right={<button type="button" onClick={() => say(dutyBriefing(plan, { live: d.source === "live" }))} className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-ink-mute hover:text-phos"><Volume2 size={11} /> Read aloud</button>}>
          <p className="text-ink">{dutyBriefing(plan, { live: d.source === "live" })}</p>
        </Fold>
      )}

      <Fold title="How it works">
        <p><span className="font-mono text-ink">priority = size × spread × people × crown</span>. Spread is the faster of the observed rate and the FBP rate for the fuel, temperature, humidity and wind. People are towns, hospitals, schools and plants within 30 km.</p>
        <p>An <span className="text-ink">escape</span> is a fire still under 200 ha when assessed that grew past 200 ha. The final size only grades the ranking afterwards; it never feeds it. Baseline: biggest fire first, by the size known at the time.</p>
        {d.source === "history" && (
          <>
            <Seg value={d.year} options={[[0, "All seasons"], [2023, "2023"], [2024, "2024"], [2025, "2025"]]} onChange={(year) => setCrewOptions({ year })} />
            {d.history && <p>{d.history.rows} fires, {d.history.dropped} dropped for missing size or location; filled in: {Object.entries(d.history.imputed).map(([k, v]) => `${k} ${v}`).join(", ")}.</p>}
            {learned && (
              <>
                <p className="text-ink">Improvement round: weights learned on two seasons, tested on the third. Escapes reached on unseen seasons: biggest first {learned.heldOut.baseline} → hand weights {learned.heldOut.hand} → learned {learned.heldOut.tuned} (of {learned.heldOut.total}).</p>
                <Seg value={d.useLearned ? "2" : "1"} options={[["1", "Hand weights"], ["2", "Learned weights"]]} onChange={(v) => setCrewOptions({ useLearned: v === "2" })} />
                <p className="font-mono text-[10px] text-ink-mute">size^{(plan?.weights ?? HAND_WEIGHTS).size} · spread^{(plan?.weights ?? HAND_WEIGHTS).growth} · people^{(plan?.weights ?? HAND_WEIGHTS).people} · crown×{(plan?.weights ?? HAND_WEIGHTS).crown}</p>
              </>
            )}
          </>
        )}
      </Fold>
    </div>
  );
}

// ------------------------------------------------------------ Calgary 311
function CrewLine({ id, unit, color, jobs, moved, sent, current, onPick }: { id: string; unit: string; color: string; jobs: Ticket[]; moved: Set<string>; sent?: boolean; current?: boolean; onPick?: () => void }) {
  const [open, setOpen] = useState(false);
  const first = jobs[0];
  return (
    <div>
      <button type="button" onClick={() => { setOpen(!open); onPick?.(); }} className={`${ROW} ${current ? "bg-[color-mix(in_srgb,var(--color-phos)_12%,transparent)]" : ""}`}>
        <div className="flex items-center gap-2 text-[12px] text-ink">
          <span className="w-3 shrink-0">{sent ? <Check size={11} className="text-phos" /> : null}</span>
          <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
          <span className="w-6 shrink-0">{id}</span>
          <span className="truncate text-ink-dim">{first ? `${typeOf(first.service).label}, ${title(first.community)}` : "no jobs"}</span>
          <span className="ml-auto shrink-0 text-[11px] text-ink-mute">{jobs.length} job{jobs.length === 1 ? "" : "s"}{unit === "WRS" ? " · waste" : ""}</span>
        </div>
      </button>
      {open && jobs.map((t, i) => (
        <button key={t.id} type="button" onClick={() => flyTo(t.lat, t.lng, 1.5)} className="block w-full truncate py-0.5 pl-10 text-left text-[11px] text-ink-dim hover:text-phos">
          {i + 1}. {t.simulated && <Snowflake size={10} className="mr-0.5 inline" />}{typeOf(t.service).label}, {title(t.community)}{moved.has(t.id) ? " · moved here" : ""}
        </button>
      ))}
    </div>
  );
}

/** "Calgary today: 4 °C, 6 mm snow, wind 30 km/h: ice ×1.6, potholes ×1.2" */
function weatherLine(p: Plan311 | null, noon: boolean): string {
  const ctx = p ? (noon ? p.noonCtx : p.ctx) : null, w: Weather311 | null = ctx?.weather ?? null;
  const routes = p ? (noon && p.noon ? p.noon : p.morning).routes : null;
  if (!w) return "Calgary weather isn't loaded yet, so priorities don't include it.";
  const cond = `${Math.round(w.tempC)} °C${w.precipMm >= 1 ? `, ${w.precipMm.toFixed(0)} mm ${w.tempC <= 1 ? "snow" : "rain"}` : ", dry"}, wind ${Math.round(w.windKmh)} km/h`;
  const adj = p && routes ? [...new Set([...routes.values()].flat().flatMap((t) => priorityParts(t, p.today, ctx!).why.slice(1).filter((x) => !/waiting|similar|urgent/.test(x))))] : [];
  return `Calgary today: ${cond}. ${adj.length ? `Raised for the weather: ${adj.join(", ")}.` : "No weather adjustments today."}`;
}

function Ops311Tab() {
  const d = useStore(dispatch, (s) => s);
  useStore(app, (s) => s.weather); // re-check the snow hint when the forecast arrives
  const p = d.plan311;
  const snow = calgarySnowForecast();
  const noon = d.at === "noon" && p?.noon ? p : null;
  const view = noon ? p!.noon! : p?.morning;
  const crews = noon ? p!.noonCrews : p?.crews ?? [];
  const moved = new Set(p?.moved.map((m) => m.ticket.id));
  useEffect(() => { if (p && (d.roadStatus === "idle" || d.roadStatus === "ready") && !Object.keys(d.routes).length) recomputeRoutes(); }, [p, d.roadStatus, d.routes]);
  const [saved, setSaved] = useState<Record<string, number>>({});
  // The work queue walks the crews: review a crew's run, send it out.
  const at = Math.min(d.cursor311, Math.max(0, crews.length - 1));
  const crew = crews[at];
  const planned = crew && view ? view.routes.get(crew.id) ?? [] : [];
  const route = crew ? d.routes[crew.id] : undefined;
  // Stops in driving order (the route planner may have re-ordered them for less driving).
  const jobs = route && route.order.length === planned.length ? route.order.map((i) => planned[i]) : planned;
  const shortest = !!(crew && d.routeOrder[crew.id]);
  const totalKm = Object.values(d.routes).reduce((t, r) => t + r.km, 0);
  const sentCount = crews.filter((c) => d.dispatched[c.id]).length;
  const goCrew = (i: number) => {
    if (!crews.length || !view) return;
    const j = (i + crews.length) % crews.length;
    dispatch.set({ cursor311: j });
    const first = view.routes.get(crews[j].id)?.[0];
    if (first) flyTo(first.lat, first.lng, 6);
  };
  const sendCrew = () => {
    if (!crew) return;
    dispatch.set({ dispatched: { ...dispatch.get().dispatched, [crew.id]: true } });
    const next = crews.findIndex((c, i) => i > at && !dispatch.get().dispatched[c.id]);
    goCrew(next >= 0 ? next : at + 1);
  };
  useQueueKeys(!!crew, { send: sendCrew, next: () => goCrew(at + 1), prev: () => goCrew(at - 1) });

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2">
        <Num label="Roads crews" value={d.roads} min={1} max={10} onChange={(roads) => set311Options({ roads })} />
        <Num label="Waste crews" value={d.waste} min={0} max={8} onChange={(waste) => set311Options({ waste })} />
        <Num label="Jobs each" value={d.perCrew} min={1} max={12} onChange={(perCrew) => set311Options({ perCrew })} />
      </div>
      <div>
        <div className="mb-1 text-[10px] uppercase tracking-[0.06em] text-ink-mute">At noon</div>
        <Seg<Disruption> value={d.disruption} options={[["none", "Normal day"], ["blizzard", "Blizzard"], ["sick", "Crew sick"]]} onChange={(disruption) => set311Options({ disruption, at: disruption === "none" ? "morning" : d.at })} />
        {snow && <p className="mt-1 flex items-center gap-1.5 text-[11px] text-ink"><Snowflake size={12} /> Forecast: snow in Calgary {snow.day === 0 ? "today" : snow.day === 1 ? "tomorrow" : "in 2 days"}. Plan for the blizzard.</p>}
        <p className="mt-1 text-[11px] leading-snug text-ink-mute">{weatherLine(p ?? null, !!noon)}</p>
      </div>

      {p && (
        <Versus
          ours={p.scores.morning.safetyJobs} base={p.scores.fifo.safetyJobs}
          oursLabel="FIRE//WATCH" baseLabel="Oldest first"
          caption={<>Safety jobs done today (ice, traffic control, potholes, debris, damaged signs), with <b className="text-ink">{Math.round(p.scores.morning.km)} km</b> of driving instead of {Math.round(p.scores.fifo.km)} km.</>}
        />
      )}

      {p?.noon && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[12px] leading-snug text-ink">
            {p.disruption === "blizzard" ? `Blizzard: ${p.added.length} ice calls come in.` : `Crew ${p.crews.find((c) => !p.noonCrews.includes(c))?.id} calls in sick.`}{" "}
            The replan moves <b>{p.dropped.length}</b> job{p.dropped.length === 1 ? "" : "s"} to tomorrow{p.moved.length ? ` and ${p.moved.length} to another crew` : ""}.
          </p>
          <Seg value={d.at} options={[["morning", "8 a.m. plan"], ["noon", "Noon replan"]]} onChange={(at) => set311Options({ at })} />
        </div>
      )}

      {crew && view && (
        <QueueCard
          step={at + 1} total={crews.length} done={sentCount}
          title={<span className="inline-flex items-center gap-2"><span className="inline-block h-3 w-3 rounded-full" style={{ background: crewColor(p!.crews.findIndex((x) => x.id === crew.id)) }} />Crew {crew.id} · {crew.unit === "WRS" ? "Waste & Recycling" : "Roads"}</span>}
          sub={route
            ? <span className="inline-flex items-center gap-1.5"><Route size={12} /> {jobs.length} stops · <b className="text-ink">{route.km.toFixed(1)} km</b> · {Math.round(route.minutes)} min driving{shortest ? " · shortest order" : ""}</span>
            : `${jobs.length} job${jobs.length === 1 ? "" : "s"}${d.roadStatus === "loading" ? " · planning the route…" : ""}`}
          why={jobs.length ? (
            <ol className="flex flex-col gap-0.5">
              {route && <li className="text-ink-mute"><Navigation size={10} className="mr-1 inline" />Depot, Roads &amp; WRS yard</li>}
              {jobs.map((t, i) => {
                const pp = priorityParts(t, p!.today, noon ? p!.noonCtx : p!.ctx);
                const leg = route?.legs[i];
                return (
                  <li key={t.id}>
                    {leg && <div className="pl-3 text-[10.5px] text-ink-mute">↓ {leg.km < 0.05 ? "same block" : `${leg.km.toFixed(1)} km, ${Math.max(1, Math.round(leg.minutes))} min${leg.mainRoadShare > 0.5 ? ", mostly main roads" : ""}`}</div>}
                    <button type="button" onClick={() => flyTo(t.lat, t.lng, 1.5)} className="text-left hover:text-phos">
                      <span className="tabular-nums text-ink-mute">{i + 1}.</span> {t.simulated && <Snowflake size={10} className="inline" />} <span className="text-ink">{typeOf(t.service).label}</span>, {title(t.community)} <span className="text-ink-mute">· p{pp.total}{pp.why.length > 1 ? ` · ${pp.why.slice(1, 3).join(", ")}` : ""}{moved.has(t.id) && noon ? " · moved here" : ""}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          ) : "No jobs for this crew."}
          sendLabel="Dispatch crew" state={d.dispatched[crew.id] ? "sent" : undefined}
          onSend={sendCrew} onPrev={() => goCrew(at - 1)} onNext={() => goCrew(at + 1)}
        />
      )}

      {crew && route && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          <button type="button" onClick={() => { const s = setShortestOrder(crew.id, !shortest); setSaved({ ...saved, [crew.id]: s }); }} className={`border px-2 py-1 transition hover:border-phos ${shortest ? "border-phos text-ink" : "border-line text-ink-dim"}`}>
            {shortest ? "Back to priority order" : "Shortest order"}
          </button>
          <label className="flex cursor-pointer items-center gap-1.5 text-ink-dim"><input type="checkbox" checked={d.showAllRoutes} onChange={(e) => dispatch.set({ showAllRoutes: e.target.checked })} /> All crews' routes</label>
          <span className="text-ink-mute">
            {shortest && saved[crew.id] > 0.5 ? `Saves ${Math.round(saved[crew.id])} min. ` : shortest ? "Already the shortest. " : ""}All crews: {totalKm.toFixed(0)} km by road
          </span>
        </div>
      )}
      {d.roadStatus === "error" && <p className="text-[11px] text-risk-high">Couldn't load Calgary's streets for routing.</p>}

      <div className="grid grid-cols-2 gap-1.5">
        <button type="button" onClick={() => flyTo(51.045, -114.06, 12)} className="flex items-center justify-center gap-1.5 border border-line px-2 py-1.5 text-[11px] text-ink-dim transition hover:border-phos hover:text-phos"><MapIcon size={12} /> Show Calgary</button>
        <button type="button" onClick={() => openTickets(!d.ticketsOpen)} className={`flex items-center justify-center gap-1.5 border px-2 py-1.5 text-[11px] transition hover:border-phos hover:text-phos ${d.ticketsOpen ? "border-phos text-ink" : "border-line text-ink-dim"}`}><TicketIcon size={12} /> All tickets</button>
      </div>

      {p && view && (
        <section>
          <div className="label-xs mb-1">Crews {noon ? "after the replan" : "this morning"}</div>
          <div className="-mx-2">
            {crews.map((c, i) => <CrewLine key={c.id} id={c.id} unit={c.unit} color={crewColor(p.crews.findIndex((x) => x.id === c.id))} jobs={view.routes.get(c.id) ?? []} moved={noon ? moved : new Set()} sent={!!d.dispatched[c.id]} current={i === at} onPick={() => dispatch.set({ cursor311: i })} />)}
          </div>
        </section>
      )}

      {p && (
        <Fold title="Tell the supervisor" right={<button type="button" onClick={() => say(`${supervisor8am(p)} ${supervisorNoon(p)}`)} className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-ink-mute hover:text-phos"><Volume2 size={11} /> Read aloud</button>}>
          <p className="text-ink">{supervisor8am(p)}</p>
          {p.noon && <p className="text-ink">{supervisorNoon(p)}</p>}
        </Fold>
      )}

      <Fold title="How it works">
        <p><span className="font-mono text-ink">priority = 10 × safety + 2 × days waiting</span>. Safety: ice/snow 5, traffic signs 4, potholes, debris and damaged signs 3, the rest 1–2.</p>
        <p>Each crew takes its next job by priority minus travel, with a bonus for staying in the same community, so crews work a neighbourhood. Roads crews do Roads work, Waste crews do WRS. Baseline: oldest ticket first, ignoring type.</p>
        <p>The noon replan keeps jobs on their morning crew where it can, so most crews' afternoons don't change. Open "All tickets" to mark a ticket urgent or hold it; the day replans.</p>
        {d.load311 && <p>{d.load311.rows} Open Calgary tickets: {d.load311.closed} closed, {d.load311.duplicates} duplicates, {d.load311.open.length} open. Planning {d.load311.today}.</p>}
      </Fold>
    </div>
  );
}

// ------------------------------------------------------------ panel
export function DispatchPanel({ engine }: { engine: Engine | null }) {
  const tab = useStore(dispatch, (s) => s.tab);
  return (
    <aside className="flex h-full flex-col border-r border-line bg-[var(--color-panel)] shadow-[8px_0_24px_rgb(16_24_32/0.12)] backdrop-blur-md" data-tour="dispatch">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <div className="label-xs">Dispatch</div>
          <p className="mt-0.5 text-[12px] text-ink-dim">{tab === "crews" ? "Which fires get the next crew" : "Who 311 sends next"}</p>
        </div>
        <button type="button" onClick={closeDispatch} aria-label="Close dispatch" className="text-ink-mute transition hover:text-phos"><X size={16} /></button>
      </header>
      <nav className="flex border-b border-line">
        <Tab id="crews" active={tab === "crews"}><span className="inline-flex items-center gap-1.5"><Flame size={12} /> Wildfire crews</span></Tab>
        <Tab id="311" active={tab === "311"}><span className="inline-flex items-center gap-1.5"><Snowflake size={12} /> Calgary 311</span></Tab>
      </nav>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {tab === "crews" ? <CrewsTab engine={engine} /> : <Ops311Tab />}
      </div>
    </aside>
  );
}
