/** Full-height Ask chat. Map questions are answered locally; anything else goes to Firefly. */
import { ChevronLeft, ChevronRight, Mic, Send, Volume2, VolumeX, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { threatList } from "../agent/brief";
import type { BriefThreat } from "../agent/types";
import type { Engine } from "../engine";
import { app } from "../state/app";
import { useStore } from "../state/store";
import { flyFireflyHome } from "./mascot";
import { useFireflyAgent } from "./useFireflyAgent";

const PROMPTS = [
  "Which communities are at risk?",
  "Where is the largest fire?",
  "How risky is Calgary?",
  "I have 3 crews. Where should they go?",
];

const threatKey = (t: BriefThreat) => `${t.name}:${t.lat}:${t.lng}`;

export function FireflyDock({ engine, open, onClose }: { engine: Engine | null; open: boolean; onClose: () => void }) {
  const ff = useFireflyAgent(engine);
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
  const [text, setText] = useState("");
  const [holding, setHolding] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const micRef = useRef<HTMLButtonElement>(null);
  const { inputLevel } = ff;
  const threats = useMemo(
    () => (ff.showThreats ? threatList() : []),
    [ff.showThreats, places, hotspots, perimeters, weather, forecastDay, focus, spread, simulation, growth],
  );
  const selectedAt = selectedKey ? threats.findIndex((t) => threatKey(t) === selectedKey) : -1;
  const current = selectedAt >= 0 ? threats[selectedAt] : null;

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [ff.history, ff.showThreats]);

  useEffect(() => {
    void flyFireflyHome();
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    const mic = micRef.current;
    if (!holding || !mic) return;
    let raf = 0;
    const tick = () => {
      const lvl = Math.min(1, inputLevel() * 4);
      mic.style.boxShadow = `0 0 0 ${2 + lvl * 7}px color-mix(in srgb, var(--color-fire) ${35 + lvl * 50}%, transparent)`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); mic.style.boxShadow = ""; };
  }, [holding, inputLevel]);

  const submit = () => { ff.send(text); setText(""); };
  const talk = (down: boolean) => { setHolding(down); ff.holdTalk(down); };
  const stepThreat = (dir: 1 | -1) => {
    if (!engine || !threats.length) return;
    const next = selectedAt < 0
      ? (dir > 0 ? 0 : threats.length - 1)
      : (selectedAt + dir + threats.length) % threats.length;
    const threat = threats[next];
    setSelectedKey(threatKey(threat));
    engine.flyToLatLng(threat.lat, threat.lng, 25);
  };

  return (
    <aside data-ask-chat className="flex h-full flex-col border-r border-line bg-[var(--color-panel)] shadow-[8px_0_24px_rgb(16_24_32/0.12)] backdrop-blur-md" data-tour="firefly">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <div className="label-xs">Ask</div>
          <p className="mt-0.5 text-[12px] text-ink-dim">Firefly</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close ask" className="text-ink-mute transition hover:text-phos">
          <X size={16} />
        </button>
      </header>
      <div ref={logRef} className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        {ff.history.length === 0 && (
          <div className="m-auto w-full max-w-[18rem]">
            <div className="flex flex-col gap-1.5">
              {PROMPTS.map((prompt) => (
                <button key={prompt} type="button" onClick={() => ff.send(prompt)} disabled={!booted || !engine} className="border border-line px-3 py-2 text-left text-[12px] text-ink transition hover:border-phos hover:text-phos disabled:opacity-40">
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}
        {ff.history.map((line, i) => (
          <div key={i} className={line.from === "you" ? "max-w-[85%] self-end border border-line bg-[color-mix(in_srgb,var(--color-phos)_8%,transparent)] px-3 py-2" : "max-w-[92%]"}>
            <p className="label-xs mb-1">{line.from === "you" ? "You" : line.from === "alert" ? "Alert" : "Firefly"}</p>
            <p className={`text-[13px] leading-relaxed ${line.from === "alert" ? "text-risk-high" : "text-ink"}`}>{line.text}</p>
          </div>
        ))}
      </div>
      {ff.pendingAlert && (
        <button type="button" onClick={ff.askAboutAlert} className="mx-4 mb-2 border border-risk-high px-3 py-2 text-left text-[12px] text-risk-high">
          {ff.pendingAlert.text} <span className="text-ink-dim underline">Tell me more</span>
        </button>
      )}
      {ff.showThreats && (
        <div className="border-t border-line px-4 py-3">
          <div className="mb-1.5 flex items-baseline justify-between gap-2">
            <span className="label-xs">Communities at risk</span>
            <span className="text-[10px] text-ink-mute">
              {threats.length === 0 ? "None" : current ? `${selectedAt + 1} of ${threats.length}` : String(threats.length)}
            </span>
          </div>
          <p className="mb-2 min-h-[2rem] text-[12px] leading-snug text-ink">
            {current ? (
              <>
                {current.name}
                <span className="mt-0.5 block text-[11px] text-ink-dim">{current.reason}</span>
              </>
            ) : threats.length === 0 ? (
              <span className="text-ink-mute">No communities are in danger from live fires and weather.</span>
            ) : (
              <span className="text-ink-mute">Previous and Next zoom the map to each one.</span>
            )}
          </p>
          <div className="flex gap-1">
            <button type="button" onClick={() => stepThreat(-1)} disabled={!engine || !booted || threats.length === 0} aria-label="Previous community at risk" className="flex flex-1 items-center justify-center gap-1 border border-line py-1.5 text-[11px] text-ink-dim transition hover:border-phos hover:text-phos disabled:opacity-40">
              <ChevronLeft size={13} /> Previous
            </button>
            <button type="button" onClick={() => stepThreat(1)} disabled={!engine || !booted || threats.length === 0} aria-label="Next community at risk" className="flex flex-1 items-center justify-center gap-1 border border-line py-1.5 text-[11px] text-ink-dim transition hover:border-phos hover:text-phos disabled:opacity-40">
              Next <ChevronRight size={13} />
            </button>
          </div>
        </div>
      )}
      <form
        className="border-t border-line p-3"
        onSubmit={(event) => { event.preventDefault(); submit(); }}
      >
        <div className="flex items-center gap-1.5 border border-line px-2 py-1.5">
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={!booted || !engine}
            placeholder={holding ? "Listening…" : ff.status === "connecting" ? "Firefly is waking up…" : booted ? "Ask the map…" : "Waiting for the map"}
            aria-label="Ask"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-mute disabled:opacity-50"
          />
          <button type="submit" aria-label="Send" disabled={!text.trim() || !booted || !engine} className="p-1 text-ink-dim hover:text-phos disabled:opacity-40"><Send size={15} /></button>
          <button
            ref={micRef}
            type="button"
            aria-label="Hold to talk"
            disabled={!ff.available}
            onPointerDown={() => talk(true)} onPointerUp={() => talk(false)} onPointerLeave={() => { if (holding) talk(false); }}
            className={`grid h-7 w-7 touch-none select-none place-items-center rounded-full transition disabled:opacity-40 ${holding ? "bg-[var(--color-fire)] text-white" : "bg-[var(--color-phos)] text-black"}`}
          ><Mic size={14} /></button>
          <button type="button" aria-label={ff.voiceOn ? "Mute Firefly's voice" : "Unmute Firefly's voice"} onClick={ff.toggleVoice} className="p-1 text-ink-dim hover:text-phos">
            {ff.voiceOn ? <Volume2 size={15} /> : <VolumeX size={15} />}
          </button>
        </div>
      </form>
    </aside>
  );
}
