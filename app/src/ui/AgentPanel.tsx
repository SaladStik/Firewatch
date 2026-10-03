/** Chat operator: one message becomes a short plan of map actions, answered from data already loaded. */
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { buildBrief, threatList } from "../agent/brief";
import { renderReply } from "../agent/reply";
import { ruleBrain } from "../agent/rules";
import { runPlan } from "../agent/tools";
import type { BriefThreat } from "../agent/types";
import type { Engine } from "../engine";
import { app } from "../state/app";
import { useStore } from "../state/store";

interface Turn {
  id: number;
  text: string;
  actions: string[];
  reply: string;
}

let nextId = 1;

const threatKey = (t: BriefThreat) => `${t.name}:${t.lat}:${t.lng}`;

export function AgentPanel({ engine }: { engine: Engine | null }) {
  const booted = useStore(app, (s) => s.boot.done);
  const places = useStore(app, (s) => s.places);
  const hotspots = useStore(app, (s) => s.hotspots);
  const perimeters = useStore(app, (s) => s.perimeters);
  const weather = useStore(app, (s) => s.weather);
  const forecastDay = useStore(app, (s) => s.forecastDay);
  const focus = useStore(app, (s) => s.focus);
  const spread = useStore(app, (s) => s.spread);
  const simulation = useStore(app, (s) => s.simulation);
  const growth = useStore(app, (s) => s.fireGrowth);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showThreats, setShowThreats] = useState(false);
  const ready = booted && !!engine && !busy;
  const threats = useMemo(
    () => (showThreats ? threatList() : []),
    [showThreats, places, hotspots, perimeters, weather, forecastDay, focus, spread, simulation, growth],
  );
  const selectedAt = selectedKey ? threats.findIndex((t) => threatKey(t) === selectedKey) : -1;
  const current = selectedAt >= 0 ? threats[selectedAt] : null;

  const stepThreat = (dir: 1 | -1) => {
    if (!engine || !threats.length) return;
    const next = selectedAt < 0
      ? (dir > 0 ? 0 : threats.length - 1)
      : (selectedAt + dir + threats.length) % threats.length;
    const threat = threats[next];
    setSelectedKey(threatKey(threat));
    engine.flyToLatLng(threat.lat, threat.lng, 25);
  };

  const ask = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !engine || !ready) return;
    setDraft("");
    setBusy(true);
    const brief = buildBrief(engine);
    const plan = ruleBrain.plan(text, brief);
    let actions: string[] = [];
    let reply = "";
    try {
      if (plan.calls.length && plan.reply !== "ambiguous" && plan.reply !== "unknown") {
        const ran = runPlan(engine, plan);
        actions = ran.results.map((r) => r.summary).filter(Boolean);
        reply = ran.reply;
      } else {
        reply = renderReply(plan, []);
      }
    } catch (err) {
      reply = err instanceof Error ? err.message : "That did not run.";
    }
    const askedForThreats = plan.reply === "threats";
    if (askedForThreats) setSelectedKey(null);
    setShowThreats(askedForThreats);
    setTurns((prev) => [...prev, { id: nextId++, text, actions, reply }].slice(-20));
    setBusy(false);
  };

  return (
    <section className="panel pointer-events-auto w-full" data-tour="agent">
      {turns.length > 0 && (
      <div className="scroll-thin max-h-52 overflow-y-auto px-3 py-2">
        {turns.map((turn) => (
          <div key={turn.id} className="mb-2.5 last:mb-0">
            <p className="text-[11px] text-ink">{turn.text}</p>
            {turn.actions.map((action, index) => (
              <p key={`${turn.id}-${index}`} className="mt-0.5 text-[10px] tracking-wide text-ink-mute">{action}</p>
            ))}
            {turn.reply !== turn.actions.join(" ") && (
              <p className="mt-0.5 text-[11px] leading-relaxed text-phos">{turn.reply}</p>
            )}
          </div>
        ))}
      </div>
      )}
      {showThreats && <div className={`px-2 py-2 ${turns.length > 0 ? "border-t border-line" : ""}`}>
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <span className="label-xs">Communities at risk</span>
          <span className="text-[10px] text-ink-mute">
            {threats.length === 0 ? "None" : current ? `${selectedAt + 1} of ${threats.length}` : String(threats.length)}
          </span>
        </div>
        <p className="mb-1.5 min-h-[2rem] text-[11px] leading-snug text-ink">
          {current ? (
            <>
              {current.name}
              <span className="mt-0.5 block text-[10px] text-ink-dim">{current.reason}</span>
            </>
          ) : threats.length === 0 ? (
            <span className="text-ink-mute">No communities are in danger from live fires and weather.</span>
          ) : (
            <span className="text-ink-mute">Previous and Next zoom the map to each one.</span>
          )}
        </p>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => stepThreat(-1)}
            disabled={!engine || !booted || threats.length === 0}
            aria-label="Previous community at risk"
            className="flex flex-1 items-center justify-center gap-1 border border-line py-1.5 text-[10px] tracking-wide text-ink-dim transition hover:border-phos hover:text-phos disabled:opacity-40"
          >
            <ChevronLeft size={13} /> Previous
          </button>
          <button
            type="button"
            onClick={() => stepThreat(1)}
            disabled={!engine || !booted || threats.length === 0}
            aria-label="Next community at risk"
            className="flex flex-1 items-center justify-center gap-1 border border-line py-1.5 text-[10px] tracking-wide text-ink-dim transition hover:border-phos hover:text-phos disabled:opacity-40"
          >
            Next <ChevronRight size={13} />
          </button>
        </div>
      </div>}
      <form onSubmit={ask} className={`p-2 ${turns.length > 0 || showThreats ? "border-t border-line" : ""}`}>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={!ready}
          placeholder={booted ? "Ask the map…" : "Waiting for the map"}
          aria-label="Ask the map"
          className="w-full border border-line bg-transparent px-2 py-1.5 text-[11px] text-ink outline-none placeholder:text-ink-mute disabled:opacity-50"
        />
      </form>
    </section>
  );
}
