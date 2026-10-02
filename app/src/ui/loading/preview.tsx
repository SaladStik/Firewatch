/**
 * Loading screen test page — /loading.html. Replays the EMBER//WATCH loading screen as often
 * as you like: simulated loads at any speed, or scrub the progress by hand.
 */
import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import "../../index.css";
import { LoadingScreen } from "./LoadingScreen";

/** The app's real boot stages, in order (what the label shows as progress passes each). */
const STAGES: [number, string][] = [
  [0, "initialising"], [0.08, "loading alberta"], [0.25, "loading british columbia"], [0.45, "loading canada"],
  [0.7, "places"], [0.8, "fire data"], [0.9, "building the map"], [1, "online"],
];
const stageAt = (p: number) => STAGES.reduce((s, [at, name]) => (p >= at ? name : s), STAGES[0][1]);

function Preview() {
  const [progress, setProgress] = useState(0);
  const [seconds, setSeconds] = useState(6);
  const [running, setRunning] = useState(true);
  const [loop, setLoop] = useState(true);
  const [firefly, setFirefly] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [error, setError] = useState(false);
  const [light, setLight] = useState(false);
  const [run, setRun] = useState(0); // bump to restart (remounts the screen, like a fresh page load)
  const start = useRef(performance.now());

  useEffect(() => { document.documentElement.dataset.theme = light ? "light" : "dark"; }, [light]);

  const replay = () => { setProgress(0); setRun((r) => r + 1); setRunning(true); };

  // Simulated load: a little uneven, like the real thing (fast start, a slow stretch, a quick finish).
  useEffect(() => {
    if (!running) return;
    start.current = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const u = Math.min(1, (now - start.current) / (seconds * 1000));
      const p = u < 0.4 ? u * 1.4 : u < 0.8 ? 0.56 + (u - 0.4) * 0.6 : 0.8 + (u - 0.8);
      setProgress(Math.min(1, p));
      if (u < 1) raf = requestAnimationFrame(tick);
      else if (loop) setTimeout(() => replay(), 1800);
      else setRunning(false);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running, seconds, loop, run]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-full w-full items-center justify-center bg-void">
      <LoadingScreen key={run} progress={progress} stage={stageAt(progress)} error={error ? "Couldn't load the map data. Retrying…" : null} firefly={firefly} orbitSpeed={speed} />

      <div className="panel absolute top-4 right-4 flex w-[260px] flex-col gap-2 p-3 text-[11px] text-ink-dim">
        <div className="label-xs text-phos">LOADING SCREEN · TEST</div>
        <Row><Btn onClick={replay}>↻ Replay</Btn><Btn on={running} onClick={() => setRunning((r) => !r)}>{running ? "❚❚ Pause" : "▶ Play"}</Btn></Row>
        <Range label={`Load time ${seconds}s`} min={1} max={30} step={1} value={seconds} set={setSeconds} />
        <Range label={`Progress ${Math.round(progress * 100)}%`} min={0} max={1} step={0.005} value={progress} set={(v) => { setRunning(false); setProgress(v); }} />
        <Range label={`Firefly speed ×${speed.toFixed(1)}`} min={0.2} max={3} step={0.1} value={speed} set={setSpeed} />
        <Check on={loop} set={setLoop}>Loop</Check>
        <Check on={firefly} set={setFirefly}>Firefly</Check>
        <Check on={error} set={setError}>Error state</Check>
        <Check on={light} set={setLight}>Light theme</Check>
      </div>
    </div>
  );
}

function Row({ children }: { children: ReactNode }) { return <div className="flex gap-2">{children}</div>; }
function Btn({ children, onClick, on }: { children: ReactNode; onClick: () => void; on?: boolean }) {
  return <button onClick={onClick} className={`flex-1 border px-2 py-1 tracking-widest transition ${on ? "border-phos text-phos-glow" : "border-line hover:border-phos"}`}>{children}</button>;
}
function Range({ label, min, max, step, value, set }: { label: string; min: number; max: number; step: number; value: number; set: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-1">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => set(+e.target.value)} />
    </label>
  );
}
function Check({ on, set, children }: { on: boolean; set: (v: boolean) => void; children: ReactNode }) {
  return <label className="flex items-center gap-2"><input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />{children}</label>;
}

createRoot(document.getElementById("root")!).render(<Preview />);
