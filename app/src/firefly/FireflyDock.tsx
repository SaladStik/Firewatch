/** Bottom-left: talk to Firefly. Input pill (type or hold the mic), suggestion chips, history drawer. */
import { MessageSquare, Mic, Send, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Engine } from "../engine";
import { useFireflyAgent } from "./useFireflyAgent";

const CHIPS = ["What's burning right now?", "How risky is Slave Lake this weekend?", "I have 3 crews. Where should they go?", "Why is this area red?"];

export function FireflyDock({ engine }: { engine: Engine | null }) {
  const ff = useFireflyAgent(engine);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [holding, setHolding] = useState(false);
  const micRef = useRef<HTMLButtonElement>(null);
  const { inputLevel } = ff;

  // While holding, a ring around the mic follows the input level, so you can see it hears you.
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

  if (!ff.available) {
    return <div className="panel pointer-events-auto px-3 py-2 text-[10.5px] text-ink-mute">Firefly is offline (set VITE_ELEVENLABS_AGENT_ID in app/.env.local).</div>;
  }
  const submit = () => { ff.send(text); setText(""); };
  const talk = (down: boolean) => { setHolding(down); ff.holdTalk(down); };

  return (
    <div className="pointer-events-auto flex w-[340px] max-w-[calc(100vw-32px)] flex-col gap-1.5" data-tour="firefly">
      {open && (
        <div className="panel scroll-thin flex max-h-[40vh] flex-col gap-1 overflow-y-auto px-3 py-2 text-[11px]">
          {ff.history.length === 0 && <div className="text-ink-mute">No messages yet.</div>}
          {ff.history.map((l, i) => (
            <div key={i} className={l.from === "you" ? "text-ink" : l.from === "alert" ? "text-risk-high" : "text-ink-dim"}>
              <span className="label-xs mr-1">{l.from === "you" ? "You" : l.from === "alert" ? "Alert" : "Firefly"}</span>{l.text}
            </div>
          ))}
        </div>
      )}
      {ff.pendingAlert && (
        <button onClick={ff.askAboutAlert} className="panel px-3 py-1.5 text-left text-[10.5px] text-risk-high">
          ⚠ {ff.pendingAlert.text} <span className="text-ink-dim underline">Tell me more</span>
        </button>
      )}
      {!ff.connected && ff.history.length === 0 && (
        <div className="flex flex-wrap gap-1">
          {CHIPS.map((c) => (
            <button key={c} onClick={() => ff.send(c)} className="border border-line bg-[var(--color-panel)] px-2 py-1 text-[10px] text-ink-dim transition hover:border-phos hover:text-phos-glow">{c}</button>
          ))}
        </div>
      )}
      <div className="panel flex items-center gap-1.5 px-2 py-1.5">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder={holding ? "Listening…" : "Ask Firefly, or hold the mic to talk"}
          className="min-w-0 flex-1 bg-transparent text-[11.5px] text-ink outline-none placeholder:text-ink-mute"
        />
        <button aria-label="Send" onClick={submit} className="p-1 text-ink-dim hover:text-phos"><Send size={14} /></button>
        <button
          ref={micRef}
          aria-label="Hold to talk"
          onPointerDown={() => talk(true)} onPointerUp={() => talk(false)} onPointerLeave={() => { if (holding) talk(false); }}
          className={`grid h-7 w-7 touch-none select-none place-items-center rounded-full transition ${holding ? "bg-[var(--color-fire)] text-white" : "bg-[var(--color-phos)] text-black"}`}
        ><Mic size={14} /></button>
        <button aria-label={ff.voiceOn ? "Mute Firefly's voice" : "Unmute Firefly's voice"} onClick={ff.toggleVoice} className="p-1 text-ink-dim hover:text-phos">
          {ff.voiceOn ? <Volume2 size={14} /> : <VolumeX size={14} />}
        </button>
        <button aria-label="History" onClick={() => setOpen((o) => !o)} className={`p-1 hover:text-phos ${open ? "text-phos" : "text-ink-dim"}`}><MessageSquare size={14} /></button>
      </div>
      <div className="label-xs px-1 text-ink-mute">
        {ff.connected ? (ff.speaking ? "Firefly is speaking" : holding ? "Firefly is listening" : "Firefly · connected") : ff.status === "connecting" ? "Firefly is waking up…" : "Firefly"}
      </div>
    </div>
  );
}
