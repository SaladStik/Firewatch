/**
 * The pitch page (/pitch): the real map, driven step by step for a three-minute talk. No app
 * chrome, only the story: captions, the 311 call, wildfires, weather, then all of Canada.
 *
 * Presenter controls: → / Space / PageDown / click = next, ← / PageUp / right-click = back,
 * Home = start, F = fullscreen, M = free map (clicks go to the map, for questions).
 */
import { useEffect, useRef, useState } from "react";
import { dispatch } from "../dispatch/store";
import { Engine } from "../engine";
import { app } from "../state/app";
import { useStore } from "../state/store";
import { AircraftLayer } from "../ui/AircraftLayer";
import { CallLayer } from "./CallLayer";
import { pitch, type Caption } from "./store";
import { BASE_LAYERS, fireflyLine, go, prepare, STEPS } from "./story";
import { TicketCard } from "./TicketCard";

export function Pitch() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const ready = useStore(pitch, (s) => s.ready);
  const step = useStore(pitch, (s) => s.step);
  const [free, setFree] = useState(false);
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    // The pitch always starts the same way: dark, Alberta in focus, quiet layers.
    app.set({ theme: "dark", focus: ["alberta"], layers: { ...BASE_LAYERS }, simulation: false, forecastDay: 0 });
    document.documentElement.dataset.theme = "dark";
    const e = new Engine();
    Object.assign(window, { engine: e, app, dispatch, pitch, pitchGo: (n: number) => go(e, n), fireflyLine }); // for rehearsals and tests
    void e.boot(canvasRef.current!, labelsRef.current!).then(async () => {
      setEngine(e);
      await prepare(e);
      go(e, 0);
    });
    return () => e.dispose();
  }, []);

  // Presenter controls.
  useEffect(() => {
    if (!engine || !ready) return;
    const next = () => go(engine, pitch.get().step + 1), back = () => go(engine, pitch.get().step - 1);
    const onKey = (ev: KeyboardEvent) => {
      if (["ArrowRight", "PageDown", " ", "Enter"].includes(ev.key)) { ev.preventDefault(); next(); }
      else if (["ArrowLeft", "PageUp", "Backspace"].includes(ev.key)) { ev.preventDefault(); back(); }
      else if (ev.key === "Home") go(engine, 0);
      else if (ev.key === "End") go(engine, STEPS.length - 1);
      else if (ev.key === "f" || ev.key === "F") { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen().catch(() => {}); }
      else if (ev.key === "m" || ev.key === "M") setFree((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine, ready]);

  // Hide the cursor while it's still.
  useEffect(() => {
    let t = 0;
    const move = () => { setIdle(false); clearTimeout(t); t = window.setTimeout(() => setIdle(true), 2200); };
    window.addEventListener("pointermove", move);
    move();
    return () => { window.removeEventListener("pointermove", move); clearTimeout(t); };
  }, []);

  return (
    <main className="pitch-root relative h-full w-full overflow-hidden bg-[#070c0a]" data-idle={idle}>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none outline-none" />
      <div className="screen-fx" />
      <div ref={labelsRef} className="pointer-events-none absolute inset-0 z-[1] overflow-hidden" />
      <CallLayer engine={engine} />
      <AircraftLayer engine={engine} />
      <Captions />
      <TicketCard />
      <ReplayBadge />
      <AskBar />
      <Progress step={step} />
      {/* Clicks advance the story unless the map is in free mode (M). */}
      {engine && ready && !free && (
        <div
          className="absolute inset-0 z-[15]"
          onClick={() => go(engine, pitch.get().step + 1)}
          onContextMenu={(ev) => { ev.preventDefault(); go(engine, pitch.get().step - 1); }}
        />
      )}
      {free && <div className="pointer-events-none absolute left-1/2 top-5 z-30 -translate-x-1/2 rounded-full border border-white/15 bg-black/50 px-3 py-1 text-[11px] uppercase tracking-[0.16em] text-white/70">Free map · press M to return</div>}
      <Loader />
    </main>
  );
}

/** How long a caption takes to leave while the next one comes in (ms). */
const LEAVE_MS = 700;

/** The current caption, and the one before it fading out underneath (a crossfade, never a cut). */
function Captions() {
  const caption = useStore(pitch, (s) => s.caption);
  const step = useStore(pitch, (s) => s.step);
  const ticker = useStore(pitch, (s) => s.ticker);
  const layout = caption?.layout ?? "caption";
  const key = caption ? `${step}:${caption.title}:${caption.body ?? ""}` : "";
  const [shown, setShown] = useState<{ key: string; c: Caption; leaving: boolean }[]>([]);
  useEffect(() => {
    // Adjusting to a new caption is a state transition driven by the store (an external system).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShown((list) => [...list.filter((x) => x.key !== key).map((x) => ({ ...x, leaving: true })), ...(caption ? [{ key, c: caption, leaving: false }] : [])]);
    const t = window.setTimeout(() => setShown((list) => list.filter((x) => !x.leaving)), LEAVE_MS);
    return () => clearTimeout(t);
  }, [key, caption]);
  return (
    <>
      <div className="pitch-scrim pointer-events-none absolute inset-0 z-[4]" style={{ opacity: layout === "caption" ? 0 : 1 }} />
      <div className="pitch-shade pointer-events-none absolute inset-x-0 bottom-0 z-[4] h-[45vh]" style={{ opacity: layout === "caption" ? 1 : 0 }} />
      {shown.map((x) => (
        <div key={x.key} className={x.leaving ? "pitch-leave" : ""}>
          <CaptionView c={x.c} ticker={x.leaving ? "" : ticker} />
        </div>
      ))}
    </>
  );
}

function CaptionView({ c, ticker }: { c: Caption; ticker: string }) {
  if (c.layout === "title") {
    return (
      <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center px-8 text-center">
        <h1 className="pitch-reveal text-[clamp(56px,9vw,148px)] font-black leading-none tracking-[-0.01em] text-white" style={{ textShadow: "0 0 40px rgb(255 120 60 / 0.35)" }}>
          <Logo />
        </h1>
        {c.body && <p className="pitch-reveal-late mt-6 max-w-3xl text-[clamp(18px,1.8vw,28px)] text-[#cfe3d8]">{c.body}</p>}
      </div>
    );
  }
  if (c.layout === "statement") {
    return (
      <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center px-10 text-center">
        <h2 className="pitch-reveal max-w-5xl text-[clamp(40px,5.6vw,92px)] font-bold leading-[1.05] text-white">{c.title}</h2>
      </div>
    );
  }
  return (
    <div className="pitch-rise pointer-events-none absolute bottom-20 left-12 z-20 max-w-[min(46rem,52vw)]">
      {c.kicker && <div className="text-[13px] font-semibold uppercase tracking-[0.22em] text-[#ff8a5c]">{c.kicker}</div>}
      <h2 className="mt-2 text-[clamp(32px,3.6vw,60px)] font-bold leading-[1.05] text-white">{c.title}</h2>
      {c.body && <p className="mt-3 text-[clamp(16px,1.35vw,22px)] leading-snug text-[#cfe3d8]">{c.body}</p>}
      {ticker && <div key={ticker} className="pitch-ticker mt-4 inline-block rounded-full border border-[#b06cff]/50 bg-[#b06cff]/15 px-3 py-1 text-[14px] text-[#e3ccff]">{ticker}</div>}
    </div>
  );
}

/** The question to Firefly, typing itself out like a chat message. */
function AskBar() {
  const ask = useStore(pitch, (s) => s.ask);
  return (
    <div className="pitch-fade pointer-events-none absolute bottom-24 right-[18vw] z-20 max-w-[min(34rem,40vw)]" style={{ opacity: ask ? 1 : 0 }}>
      {ask && (
        <div className="rounded-2xl rounded-br-sm border border-white/15 bg-[rgb(9_15_13/0.85)] px-5 py-3.5 shadow-[0_18px_50px_-20px_rgb(0_0_0/0.9)] backdrop-blur-md">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8fb3a2]">You</div>
          <div className="mt-1 text-[clamp(18px,1.5vw,24px)] text-white">
            {ask.q.slice(0, ask.shown)}
            {ask.shown < ask.q.length && <span className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[3px] animate-pulse bg-white/80" />}
          </div>
        </div>
      )}
    </div>
  );
}

function ReplayBadge() {
  const replay = useStore(pitch, (s) => s.replay);
  return (
    <div className="pitch-fade pointer-events-none absolute left-12 top-8 z-20 rounded-full border border-[#ffd23f]/40 bg-black/40 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#ffd23f]" style={{ opacity: replay ? 1 : 0 }}>
      Replay · Alberta 2023–2025 fires
    </div>
  );
}

function Progress({ step }: { step: number }) {
  return (
    <div className="pointer-events-none absolute bottom-7 left-12 z-20 flex items-center gap-1.5">
      {STEPS.map((_, i) => (
        <span key={i} className="pitch-dot h-1.5 rounded-full" style={{ width: i === step ? 22 : 6, background: i <= step ? "#ff6a3d" : "rgb(255 255 255 / 0.25)" }} />
      ))}
    </div>
  );
}

/**
 * FIRE//WATCH: the slashes overlap the E's foot and the W's top by the same amount (measured in
 * Lato Black at −0.01 em letter-spacing, which both the loading screen and the title end on).
 */
function Logo() {
  return <>FIRE<span className="ml-[-0.07em] mr-[-0.02em] text-[#ff6a3d]">//</span>WATCH</>;
}

function Loader() {
  const boot = useStore(app, (s) => s.boot);
  const ready = useStore(pitch, (s) => s.ready);
  const prep = useStore(pitch, (s) => s.prep);
  const built = useStore(pitch, (s) => s.built);
  // Booting the map is the first 40 %; building every scene of the story ahead is the rest.
  const progress = boot.done ? 0.4 + 0.6 * built : (boot.progress ?? 0) * 0.4;
  return (
    <div className="pitch-loader absolute inset-0 z-50 flex flex-col items-center justify-center bg-[#070c0a]" data-done={ready}>
      <div className="text-[clamp(40px,6vw,96px)] font-black tracking-[-0.01em] text-white"><Logo /></div>
      <div className="mt-8 h-[3px] w-[min(28rem,70vw)] overflow-hidden rounded-full bg-white/10">
        <div className="pitch-loader-bar h-full w-full bg-[#ff6a3d]" style={{ transform: `scaleX(${progress})` }} />
      </div>
      <div className="mt-4 h-5 text-[13px] text-white/50">{boot.error ? `Couldn't start: ${boot.error}` : prep || boot.stage}</div>
    </div>
  );
}
