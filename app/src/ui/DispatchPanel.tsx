/**
 * Dispatch: the hackathon cases on the map.
 *  - Wildfire crews: rank fires for N crews (live, or the Alberta 2023–2025 table that the demo
 *    scenario replays), beat "biggest first", cut 20% and see who lost a crew.
 *  - Calgary 311: score tickets, plan crews for the day, apply a disruption, replan.
 */
import { Flame, Snowflake, UserX, X } from "lucide-react";
import type { ReactNode } from "react";
import { HAND_WEIGHTS, label, type Grade, type Scored, type Weights } from "../dispatch/crews";
import { calgarySnowForecast, closeDispatch, flyTo, set311Options, setCrewOptions } from "../dispatch/controller";
import { dutyBriefing } from "../dispatch/crews";
import { priority, supervisor8am, supervisorNoon, typeOf, type Disruption, type Score311, type Ticket } from "../dispatch/ops311";
import { crewColor } from "../dispatch/colors";
import { dispatch, type DispatchTab } from "../dispatch/store";
import type { Engine } from "../engine";
import { fireflyController } from "../firefly/mascot";
import { app } from "../state/app";
import { useStore } from "../state/store";


const fmt = (n: number) => Math.round(n).toLocaleString("en-CA");

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

function Stepper({ label: name, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  const set = (v: number) => onChange(Math.min(max, Math.max(min, v)));
  return (
    <label className="flex items-center justify-between gap-2 text-[11px] text-ink-dim">
      <span>{name}</span>
      <span className="flex items-center border border-line">
        <button type="button" onClick={() => set(value - 1)} className="px-2 py-0.5 text-ink-mute hover:text-phos">−</button>
        <input value={value} onChange={(e) => set(Number(e.target.value) || min)} inputMode="numeric" className="w-10 bg-transparent text-center tabular-nums text-ink outline-none" aria-label={name} />
        <button type="button" onClick={() => set(value + 1)} className="px-2 py-0.5 text-ink-mute hover:text-phos">+</button>
      </span>
    </label>
  );
}

const say = (text: string) => fireflyController().say(text, Math.max(6, Math.min(16, text.length * 0.045)));

// ------------------------------------------------------------ wildfire crews
const wTxt = (w: Weights) => `size^${w.size} · spread^${w.growth} · people^${w.people} · crown×${w.crown}`;

function GradeRow({ name, g, n, strong }: { name: string; g: Grade; n: number; strong?: boolean }) {
  return (
    <tr className={strong ? "text-ink" : "text-ink-dim"}>
      <td className="py-0.5 pr-2">{name}</td>
      <td className="py-0.5 pr-2 text-right tabular-nums">{n}</td>
      <td className="py-0.5 pr-2 text-right tabular-nums">{g.escapesCaught}</td>
      <td className="py-0.5 text-right tabular-nums">{fmt(g.growthHa / 1000)}k</td>
    </tr>
  );
}

function FireRow({ s, rank, lost }: { s: Scored; rank: number; lost?: boolean }) {
  return (
    <button type="button" onClick={() => flyTo(s.fire.lat, s.fire.lng, 40)} className={`block w-full border-l-2 px-2 py-1.5 text-left transition hover:bg-[color-mix(in_srgb,var(--color-phos)_8%,transparent)] ${lost ? "border-risk-high" : "border-transparent"}`}>
      <div className="flex items-baseline gap-2 text-[12px] text-ink">
        <span className="w-6 shrink-0 tabular-nums text-ink-mute">{rank}</span>
        <span className="truncate">{label(s)}{s.fire.year ? <span className="text-ink-mute"> · {s.fire.year}</span> : null}</span>
        {lost && <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-risk-high">lost crew</span>}
      </div>
      <div className="pl-8 text-[11px] leading-snug text-ink-dim">{s.reason}</div>
    </button>
  );
}

function CrewsTab({ engine }: { engine: Engine | null }) {
  const d = useStore(dispatch, (s) => s);
  const simulation = useStore(app, (s) => s.simulation);
  const plan = d.plan;
  const lostIds = new Set(plan?.lostCrew.map((s) => `${s.fire.year}:${s.fire.id}`));
  const learned = d.learned;
  const w = plan?.weights ?? HAND_WEIGHTS;
  const list = plan ? plan.picked : [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <Seg value={d.source} options={[["history", "Alberta 2023–2025"], ["live", "Live fires"]]} onChange={(source) => setCrewOptions({ source })} />
        {d.source === "history" && (
          <Seg value={d.year} options={[[0, "All seasons"], [2023, "2023"], [2024, "2024"], [2025, "2025"]]} onChange={(year) => setCrewOptions({ year })} />
        )}
        <Stepper label="Crews" value={d.crews} min={1} max={120} onChange={(crews) => setCrewOptions({ crews })} />
        <Stepper label="Crew cut %" value={d.cutPct} min={0} max={90} onChange={(cutPct) => setCrewOptions({ cutPct })} />
        {d.source === "history" && !simulation && (
          <button type="button" onClick={() => engine?.setSimulation(true)} className="border border-line px-2 py-1.5 text-[11px] text-ink-dim transition hover:border-phos hover:text-phos">
            Show these fires on the map (demo scenario)
          </button>
        )}
      </div>

      {d.status === "loading" && <p className="text-[12px] text-ink-mute">Loading the case data…</p>}
      {d.status === "learning" && <p className="text-[12px] text-ink-mute">Learning from past seasons…</p>}
      {d.status === "error" && <p className="text-[12px] text-risk-high">Couldn't load the case data: {d.error}</p>}
      {d.source === "live" && plan === null && d.status === "ready" && <p className="text-[12px] text-ink-mute">No active fires in the regions in focus right now. Switch to Alberta 2023–2025 to rank a real season.</p>}

      {d.source === "history" && d.history && (
        <section>
          <div className="label-xs mb-1">1 · Data</div>
          <p className="text-[11px] leading-snug text-ink-dim">
            {d.history.rows} fires (Government of Alberta). Dropped for missing size or coordinates: <span className="text-ink">{d.history.dropped}</span>. Filled in: {Object.entries(d.history.imputed).map(([k, v]) => `${k} ${v}`).join(", ")}.
          </p>
        </section>
      )}

      <section>
        <div className="label-xs mb-1">2 · Score (one line)</div>
        <p className="font-mono text-[10.5px] leading-snug text-ink">priority = size × spread × people × crown</p>
        <p className="mt-1 text-[11px] leading-snug text-ink-dim">Spread = the faster of the observed rate and the FBP rate for that fuel, temperature, humidity and wind. People = towns, hospitals, schools and plants within 30 km.</p>
      </section>

      {learned && d.source === "history" && (
        <section>
          <div className="label-xs mb-1">3 · Improvement round</div>
          <Seg value={d.useLearned ? "2" : "1"} options={[["1", "Round 1: hand weights"], ["2", "Round 2: learned"]]} onChange={(v) => setCrewOptions({ useLearned: v === "2" })} />
          <p className="mt-1.5 text-[11px] leading-snug text-ink-dim">
            Fit on two seasons, tested on the third it never saw: escapes reached {learned.heldOut.baseline} (biggest first) → {learned.heldOut.hand} (round 1) → <span className="text-ink">{learned.heldOut.tuned}</span> (round 2) of {learned.heldOut.total}. {learned.kept ? "Kept, refit on all seasons." : "Not better, so round 1 stays."}
          </p>
          <p className="mt-1 font-mono text-[10px] text-ink-mute">{wTxt(w)}</p>
        </section>
      )}

      {plan && (
        <section>
          <div className="label-xs mb-1">4 · {plan.crews} crews, then {plan.cutCrews}</div>
          {plan.grades ? (
            <table className="w-full text-[11px]">
              <thead className="text-ink-mute"><tr><th className="text-left font-normal">Plan</th><th className="text-right font-normal">crews</th><th className="text-right font-normal" title="Fires still catchable when assessed (≤ 200 ha) that went on to escape past 200 ha">escapes</th><th className="text-right font-normal" title="Hectares those fires burned after assessment">later ha</th></tr></thead>
              <tbody>
                <GradeRow name="Biggest first" g={plan.grades.baseline} n={plan.crews} />
                <GradeRow name="FIRE//WATCH" g={plan.grades.ours} n={plan.crews} strong />
                <GradeRow name="Biggest first, cut" g={plan.grades.baselineCut} n={plan.cutCrews} />
                <GradeRow name="FIRE//WATCH, cut" g={plan.grades.cut} n={plan.cutCrews} strong />
              </tbody>
            </table>
          ) : (
            <p className="text-[11px] text-ink-dim">{plan.ranked.length} live fires ranked. Outcomes aren't known yet, so there's no grade; the history tab shows how this score performs.</p>
          )}
        </section>
      )}

      {plan && plan.lostCrew.length > 0 && (
        <section>
          <div className="label-xs mb-1 text-risk-high">5 · Lost a crew in the cut ({plan.lostCrew.length})</div>
          <p className="text-[11px] leading-snug text-ink">{plan.lostCrew.map(label).join(", ")}</p>
        </section>
      )}

      {plan && (
        <section>
          <div className="mb-1 flex items-center justify-between">
            <span className="label-xs">Duty officer</span>
            <button type="button" onClick={() => say(dutyBriefing(plan, { live: d.source === "live" }))} className="text-[10px] uppercase tracking-wide text-ink-mute hover:text-phos">Firefly, read it</button>
          </div>
          <p className="text-[11.5px] leading-relaxed text-ink">{dutyBriefing(plan, { live: d.source === "live" })}</p>
        </section>
      )}

      {plan && (
        <section>
          <div className="label-xs mb-1">Crew list (click to fly)</div>
          <div className="-mx-2">
            {list.map((s, i) => <FireRow key={`${s.fire.year}:${s.fire.id}`} s={s} rank={i + 1} lost={lostIds.has(`${s.fire.year}:${s.fire.id}`)} />)}
          </div>
        </section>
      )}
    </div>
  );
}

// ------------------------------------------------------------ Calgary 311
function ScoreRow({ name, s, strong }: { name: string; s: Score311; strong?: boolean }) {
  return (
    <tr className={strong ? "text-ink" : "text-ink-dim"}>
      <td className="py-0.5 pr-2">{name}</td>
      <td className="py-0.5 pr-2 text-right tabular-nums">{s.jobs}</td>
      <td className="py-0.5 pr-2 text-right tabular-nums">{s.safetyJobs}</td>
      <td className="py-0.5 text-right tabular-nums">{fmt(s.km)}</td>
    </tr>
  );
}

const ticketLine = (t: Ticket, today: string) => `${typeOf(t.service).label} · ${t.community.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())} · p${priority(t, today)}`;

function Ops311Tab() {
  const d = useStore(dispatch, (s) => s);
  useStore(app, (s) => s.weather); // re-check the forecast hint when weather arrives
  const p = d.plan311;
  const snow = calgarySnowForecast();
  const view = d.at === "noon" && p?.noon ? p.noon : p?.morning;
  const crews = d.at === "noon" && p?.noon ? p.noonCrews : p?.crews ?? [];
  const movedIds = new Set(p?.moved.map((m) => m.ticket.id));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <Stepper label="Roads crews" value={d.roads} min={1} max={10} onChange={(roads) => set311Options({ roads })} />
        <Stepper label="Waste & Recycling crews" value={d.waste} min={0} max={8} onChange={(waste) => set311Options({ waste })} />
        <Stepper label="Jobs per crew" value={d.perCrew} min={1} max={12} onChange={(perCrew) => set311Options({ perCrew })} />
        <div className="text-[11px] text-ink-dim">Noon disruption</div>
        <Seg<Disruption> value={d.disruption} options={[["none", "None"], ["blizzard", "Blizzard"], ["sick", "Crew sick"]]} onChange={(disruption) => set311Options({ disruption, at: disruption === "none" ? "morning" : d.at })} />
        {snow && <p className="flex items-center gap-1.5 text-[11px] text-ink"><Snowflake size={12} /> Our forecast: {snow.mm.toFixed(1)} mm of snow in Calgary {snow.day === 0 ? "today" : snow.day === 1 ? "tomorrow" : "in 2 days"}. Plan for the blizzard.</p>}
        <button type="button" onClick={() => flyTo(51.045, -114.06, 22)} className="border border-line px-2 py-1.5 text-[11px] text-ink-dim transition hover:border-phos hover:text-phos">Show Calgary</button>
      </div>

      {d.load311 && (
        <section>
          <div className="label-xs mb-1">1 · Tickets</div>
          <p className="text-[11px] leading-snug text-ink-dim">{d.load311.rows} Calgary 311 tickets (Open Calgary): {d.load311.closed} closed, {d.load311.duplicates} duplicates, <span className="text-ink">{d.load311.open.length} open</span>. Planning {d.load311.today}.</p>
        </section>
      )}

      <section>
        <div className="label-xs mb-1">2 · Priority (one line)</div>
        <p className="font-mono text-[10.5px] leading-snug text-ink">priority = 10 × safety + 2 × days waiting</p>
        <p className="mt-1 text-[11px] leading-snug text-ink-dim">Safety: ice/snow 5, traffic control 4, potholes, debris and damaged signs 3, … Each crew takes its next job by priority minus travel, with a bonus for staying in the same community.</p>
      </section>

      {p && (
        <section>
          <div className="label-xs mb-1">3 · Plan vs oldest-first</div>
          <table className="w-full text-[11px]">
            <thead className="text-ink-mute"><tr><th className="text-left font-normal">Plan</th><th className="text-right font-normal">jobs</th><th className="text-right font-normal">safety</th><th className="text-right font-normal">km</th></tr></thead>
            <tbody>
              <ScoreRow name="Oldest first" s={p.scores.fifo} />
              <ScoreRow name="8 a.m. plan" s={p.scores.morning} strong />
              {p.scores.noon && <ScoreRow name="Noon replan" s={p.scores.noon} strong />}
            </tbody>
          </table>
        </section>
      )}

      {p?.noon && (
        <section>
          <div className="label-xs mb-1">4 · {p.disruption === "blizzard" ? <span className="inline-flex items-center gap-1"><Snowflake size={11} /> Blizzard</span> : <span className="inline-flex items-center gap-1"><UserX size={11} /> Crew sick</span>} → replan</div>
          <p className="text-[12px] text-ink"><span className="tabular-nums">{p.moved.length}</span> changed crew · <span className="tabular-nums">{p.dropped.length}</span> moved to tomorrow · <span className="tabular-nums">{p.newJobs.length}</span> new</p>
          <Seg value={d.at} options={[["morning", "8 a.m. plan"], ["noon", "Noon replan"]]} onChange={(at) => set311Options({ at })} />
        </section>
      )}

      {p && (
        <section>
          <div className="mb-1 flex items-center justify-between">
            <span className="label-xs">5 · Supervisor</span>
            <button type="button" onClick={() => say(`${supervisor8am(p)} ${supervisorNoon(p)}`)} className="text-[10px] uppercase tracking-wide text-ink-mute hover:text-phos">Firefly, read it</button>
          </div>
          <p className="text-[11.5px] leading-relaxed text-ink">{supervisor8am(p)}</p>
          {p.noon && <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink">{supervisorNoon(p)}</p>}
        </section>
      )}

      {p && view && (
        <section>
          <div className="label-xs mb-1">Crew sheets ({d.at === "noon" && p.noon ? "noon" : "8 a.m."}, click to fly)</div>
          {crews.map((c) => {
            const i = p.crews.findIndex((x) => x.id === c.id);
            const jobs = view.routes.get(c.id) ?? [];
            return (
              <div key={c.id} className="mb-1.5">
                <div className="flex items-center gap-2 text-[11px] text-ink"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: crewColor(i) }} />{c.id} · {c.unit === "WRS" ? "Waste & Recycling" : "Roads"}</div>
                {jobs.map((t) => (
                  <button key={t.id} type="button" onClick={() => flyTo(t.lat, t.lng, 2.5)} className="block w-full truncate pl-4 text-left text-[11px] text-ink-dim hover:text-phos">
                    {t.simulated && <Snowflake size={10} className="mr-1 inline" />}{ticketLine(t, p.today)}{movedIds.has(t.id) && d.at === "noon" ? " · moved" : ""}
                  </button>
                ))}
              </div>
            );
          })}
          {d.at === "noon" && p.dropped.length > 0 && (
            <div className="mt-1 text-[11px] text-risk-high">To tomorrow: {p.dropped.map((x) => ticketLine(x.ticket, p.today)).join("; ")}</div>
          )}
        </section>
      )}
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
          <p className="mt-0.5 text-[12px] text-ink-dim">Who gets the next crew</p>
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
